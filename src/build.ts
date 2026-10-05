import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { cacheRoot } from "./config.ts";
import { availableParallelism } from "node:os";
import { BuildToolError } from "./errors.ts";
import { exec, execCapture, type ExecEvent } from "./exec.ts";
import { parseMemoryUsage, type MemoryRegion } from "./size.ts";
import { toolchainEnv } from "./toolchain.ts";

/**
 * Rotorflight's Makefile (as of release/4.6.0) has NO dependency on the value of
 * `OPTIONS` — changing the feature defines does not invalidate any object file.
 * Building in a tree whose objects were compiled with a different feature set
 * therefore silently produces a stale binary. To stay correct we run
 * `make clean` whenever the target or option set differs from the previous build
 * in that source tree, tracked via this stamp file.
 */
/** Kept in the app's cache, keyed by tree, so nothing is written into the user's firmware clone. */
const stampFile = (sourceDir: string) =>
  join(cacheRoot(), "stamps", `${createHash("sha1").update(sourceDir).digest("hex").slice(0, 16)}.txt`);

export interface BuildInput {
  sourceDir: string;
  target: string;
  /** Final `USE_XXX` token list (already resolved from features). */
  options: string[];
  binDir: string;
  outputDir: string;
  jobs?: number;
  /**
   * Skip the safety `make clean` even when the option set changed. Faster for
   * iterative local dev, but can yield a stale binary — never use for a build
   * that will be flashed.
   */
  incremental?: boolean;
  /**
   * Extra `KEY=VALUE` variables passed to make, e.g.
   * `{ FLASH_CONFIG_ERASE: "yes" }`. The official release build uses
   * `FLASH_CONFIG_ERASE=yes` (see .github/workflows/release.yml), which adds the
   * config-erase marker — needed to reproduce an official artifact byte-for-byte
   * and generally wanted for a clean flash.
   */
  extraMakeVars?: Record<string, string>;
  onEvent?: (e: ExecEvent) => void;
}

export interface SizeReport {
  text: number;
  data: number;
  bss: number;
  /** text + data — the portion that consumes flash. */
  flash: number;
}

export interface BuildResult {
  target: string;
  options: string[];
  hexPath?: string;
  binPath?: string;
  elfPath?: string;
  size?: SizeReport;
  /** Per-region usage from the linker (capacity included). */
  memory?: MemoryRegion[];
  durationMs: number;
}

/**
 * Spawn the firmware's `make` with the selected target and OPTIONS, prepending
 * the resolved toolchain to PATH, then copy the produced artifacts into
 * outputDir. Feature toggles are passed as `OPTIONS="USE_A USE_B"`; the firmware
 * Makefile turns that into `-DUSE_A -DUSE_B`.
 */
export async function runBuild(input: BuildInput): Promise<BuildResult> {
  const { sourceDir, target, options, binDir, outputDir } = input;
  const jobs = input.jobs ?? availableParallelism();
  const start = Date.now();

  const env = toolchainEnv(binDir);
  const run = (extraArgs: string[]) =>
    exec("make", extraArgs, { cwd: sourceDir, env, onEvent: input.onEvent });

  const makeVars = Object.entries(input.extraMakeVars ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);

  // Clean when the target / options / make-vars differ from the last build here.
  const stampPath = stampFile(sourceDir);
  await mkdir(dirname(stampPath), { recursive: true });
  const stamp = `${target}\n${options.join(" ")}\n${makeVars.join(" ")}`;
  const previous = await readFile(stampPath, "utf8").catch(() => "");
  if (previous !== stamp && !input.incremental) {
    if (previous) await writeFile(stampPath, "").catch(() => {});
    await run(["clean", `TARGET=${target}`]);
  }

  const made = await run([`TARGET=${target}`, `OPTIONS=${options.join(" ")}`, ...makeVars, `-j${jobs}`]);
  await writeFile(stampPath, stamp).catch(() => {});

  const objDir = join(sourceDir, "obj");
  const hexPath = await newest(objDir, `_${target}.hex`);
  const binPath = await newest(objDir, `_${target}.bin`);
  const elfPath = await newest(join(objDir, "main"), `_${target}.elf`);

  if (!hexPath && !binPath) {
    throw new BuildToolError(
      "ARTIFACT_NOT_FOUND",
      `Build reported success but no .hex/.bin for ${target} was found in ${objDir}.`,
    );
  }

  await mkdir(outputDir, { recursive: true });
  const out: BuildResult = { target, options, durationMs: Date.now() - start };
  // The firmware links with --print-memory-usage; an up-to-date tree prints no table.
  const memory = parseMemoryUsage(made.stdout);
  if (memory.length) out.memory = memory;
  if (hexPath) out.hexPath = await place(hexPath, outputDir);
  if (binPath) out.binPath = await place(binPath, outputDir);
  if (elfPath) {
    out.elfPath = await place(elfPath, outputDir);
    out.size = await sizeReport(join(binDir, sizeName()), elfPath);
  }
  return out;
}

async function place(src: string, outDir: string): Promise<string> {
  const dest = join(outDir, basename(src));
  await copyFile(src, dest);
  return dest;
}

/** Newest file in `dir` whose name ends with `suffix`, or undefined. */
async function newest(dir: string, suffix: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return undefined;
  }
  const matches = entries.filter((f) => f.endsWith(suffix));
  let best: { path: string; mtime: number } | undefined;
  for (const f of matches) {
    const p = join(dir, f);
    const s = await stat(p);
    if (!best || s.mtimeMs > best.mtime) best = { path: p, mtime: s.mtimeMs };
  }
  return best?.path;
}

function sizeName(): string {
  return process.platform === "win32" ? "arm-none-eabi-size.exe" : "arm-none-eabi-size";
}

async function sizeReport(sizeBin: string, elf: string): Promise<SizeReport | undefined> {
  try {
    // `size`'s default (Berkeley) table: text data bss dec hex filename, last line.
    const out = await execCapture(sizeBin, [elf]);
    const line = out.trim().split("\n").at(-1) ?? "";
    const nums = line.trim().split(/\s+/).map(Number);
    if (nums.length < 3 || nums.slice(0, 3).some(Number.isNaN)) return undefined;
    const [text, data, bss] = nums as [number, number, number];
    return { text, data, bss, flash: text + data };
  } catch {
    return undefined;
  }
}
