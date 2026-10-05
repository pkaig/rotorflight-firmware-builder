import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { BuildToolError } from "./errors.ts";
import { exec } from "./exec.ts";

/**
 * Ask the real preprocessor which `USE_XXX` options a target can actually change.
 *
 * Reading the headers by eye is unreliable: `common_pre.h` gates features on
 * TARGET_FLASH_SIZE / FEATURE_CUT_LEVEL, the target's `target.h` then `#undef`s
 * some of them again (F405 drops VTX/OSD/camera control), and `common_post.h`
 * cascades further `#undef`s. So instead we take the exact CFLAGS make would use
 * for the target and run `arm-none-eabi-gcc -E` over `platform.h` — the header
 * every compilation unit includes — once for the baseline and once per candidate.
 *
 * Two preprocessor modes are needed because `-dM` suppresses the
 * `"USE_X" redefined` diagnostic: a plain `-E` pass catches collisions, and a
 * `-dM` pass reads the final define set.
 */

/**
 * Guard conventions. -D can only add a define, so a baseline feature is
 * removable only when the firmware headers guard it, in either style:
 *
 *   #ifndef DISABLE_USE_LED_STRIP        #if defined(DISABLE_GPS)
 *   #define USE_LED_STRIP                #undef USE_GPS
 *   #endif                               #endif
 *
 * and the build passes the flag (-DDISABLE_USE_LED_STRIP, -DDISABLE_GPS). The
 * reverse, an opt-in, is an ENABLE_ guard around a feature that is otherwise
 * removed: `#if !defined(ENABLE_CMS) ... #undef USE_CMS`. Stock Rotorflight 4.6
 * has no such guards, so there every baseline feature probes as locked.
 */
export const DISABLE_PREFIX = "DISABLE_";
export const disableFlag = (use: string) => `${DISABLE_PREFIX}${use}`;

export type OptionState = "on-removable" | "on-locked" | "off-addable" | "off-locked";

export interface ProbedOption {
  name: string;
  state: OptionState;
  /** Why a locked option cannot change, or a caveat for a changeable one. */
  reason?: string;
  /** Number of source files that test this define in an #if/#ifdef. */
  consumers: number;
  /** Other defines that must be added with this one (it is #undef'd without them). */
  requires?: string[];
  /** The flag that toggles it: DISABLE_X removes a baseline option, ENABLE_X opts one in. */
  guard?: string;
  /** Baseline options whose removal takes this one with it (via #ifndef ... #undef). */
  follows?: string[];
  /** Where this define comes from, which decides whether it is a feature at all. */
  scope: OptionScope;
  /** MCU families whose code or build defines it, when that is MCU-specific. */
  families?: string[];
  /** Where it is #define'd or -D'd (first few). */
  sites?: DefineSite[];
  /** Files that test it in an #if/#ifdef (first few). */
  consumerFiles?: string[];
}

/**
 * - generic:        defined by shared headers (a real feature, possibly flash-gated)
 * - this-mcu:       defined only for this target's MCU family (its hardware)
 * - other-mcu:      another MCU family's hardware or platform code — not applicable here
 * - mcu-default:    a shared feature only switched on by default for other MCU families
 * - board-only:     only a developer / legacy board target enables it
 * - build:          set by the build system (Makefile / make/*.mk), not a feature
 * - never-defined:  no target or build defines it; tested in code only (debug / dead / experimental)
 */
export type OptionScope =
  | "generic"
  | "this-mcu"
  | "other-mcu"
  | "mcu-default"
  | "board-only"
  | "build"
  | "never-defined";

export interface DefineSite {
  file: string;
  line: number;
  /** Trailing comment on the #define line, if any. */
  comment?: string;
  /** MCU families this site is specific to (from its file or enclosing #if). */
  families?: string[];
  /** A -D flag set by the build system rather than a #define in the source. */
  build?: boolean;
}

export interface ProbeContext {
  sourceDir: string;
  target: string;
  binDir: string;
  extraMakeVars?: Record<string, string>;
}

export interface ProbeResult {
  target: string;
  /** MCU family of the target: F4, F7, H7, G4 or SITL. */
  family?: string;
  /** TARGET_FLASH_SIZE: the MCU's flash in KB, before bootloader/config regions. */
  flashKb?: number;
  baseline: string[];
  options: ProbedOption[];
  durationMs: number;
}

export interface Selection {
  /** Off-by-default defines to add (passed as -DUSE_X). */
  add: string[];
  /** Baseline defines to remove (passed as -DDISABLE_USE_X). */
  remove: string[];
}

export interface PreviewResult {
  ok: boolean;
  errors: string[];
  /** Defines present after the selection that are not in the baseline. */
  added: string[];
  /** Baseline defines no longer present — includes cascades (e.g. via common_post.h). */
  removed: string[];
  /** The OPTIONS tokens a build of this selection passes to make. */
  options: string[];
}

/** Scratch files live in the OS temp folder, never in the firmware tree. */
const TEMP_PREFIX = "rfb-";
const STUB_NAME = "probe.c";
const MK_NAME = "probe.mk";
const STUB_TEXT = '#include "platform.h"\n';

/**
 * Remove scratch folders that earlier runs left behind (a crash, or versions
 * before dispose() existed). Only folders holding nothing but our own scratch
 * files and older than a day. An instance that has been running longer than
 * that simply recreates its stub on the next preview (see run()).
 */
export async function sweepProbeTemp(maxAgeMs = 24 * 3600 * 1000): Promise<number> {
  let removed = 0;
  for (const name of await readdir(tmpdir())) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const dir = join(tmpdir(), name);
    try {
      const files = await readdir(dir);
      if (!files.every((f) => f === STUB_NAME || f === MK_NAME)) continue;
      if (Date.now() - (await stat(dir)).mtimeMs < maxAgeMs) continue;
      await rm(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // Not a folder, or in use: leave it.
    }
  }
  return removed;
}

/** Null device for the compiler's output (gcc on Windows has no /dev/null). */
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const USE_TOKEN = /\bUSE_[A-Z0-9_]+\b/g;
const CONDITIONAL = /^\s*#\s*(?:if|ifdef|ifndef|elif)\b/;

/** Preprocessor runner bound to one target's CFLAGS. */
export class TargetPreprocessor {
  private readonly sourceDir: string;
  private readonly command: string;
  /** The one-line stub that is preprocessed; kept out of the firmware tree. */
  private readonly stub: string;

  private constructor(sourceDir: string, command: string, stub: string) {
    this.sourceDir = sourceDir;
    this.command = command;
    this.stub = stub;
  }

  static async create(ctx: ProbeContext): Promise<TargetPreprocessor> {
    const cflags = await targetCflags(ctx);
    // platform.h is found through the target's -I paths, so the stub can live anywhere.
    const stub = join(await mkdtemp(join(tmpdir(), TEMP_PREFIX)), STUB_NAME);
    await writeFile(stub, STUB_TEXT);
    const gcc = join(ctx.binDir, process.platform === "win32" ? "arm-none-eabi-gcc.exe" : "arm-none-eabi-gcc");
    return new TargetPreprocessor(ctx.sourceDir, `${shellQuote(posixPath(gcc))} -E ${cflags}`, stub);
  }

  /** Remove the stub's temp folder. Safe to call more than once. */
  async dispose(): Promise<void> {
    await rm(dirname(this.stub), { recursive: true, force: true });
  }

  /** Diagnostics-only pass: returns the error lines (empty when clean). */
  async diagnose(flags: string[]): Promise<string[]> {
    const r = await this.run(`${this.flags(flags)} -o ${NULL_DEVICE}`);
    return r.code === 0 ? [] : errorLines(r.stderr);
  }

  /** Final set of USE_ defines with these flags applied. */
  async defines(flags: string[]): Promise<Set<string>> {
    return new Set([...(await this.macros(flags)).keys()].filter((m) => m.startsWith("USE_")));
  }

  /** Every macro defined with these flags applied, name -> value. */
  async macros(flags: string[]): Promise<Map<string, string>> {
    const r = await this.run(`-dM ${this.flags(flags)}`);
    const out = new Map<string, string>();
    // (.*?)\r?$ — gcc on Windows ends lines with \r\n.
    for (const m of r.stdout.matchAll(/^#define ([A-Za-z_][A-Za-z0-9_]*)(?:\([^)]*\))? ?(.*?)\r?$/gm)) out.set(m[1]!, m[2]!);
    return out;
  }

  private flags(flags: string[]): string {
    for (const f of flags) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(f)) {
        throw new BuildToolError("INVALID_ARGS", `Refusing to pass malformed define "${f}".`);
      }
    }
    return [...flags.map((f) => `-D${f}`), shellQuote(posixPath(this.stub))].join(" ");
  }

  private async run(args: string) {
    // A temp cleaner (or dispose() during a reload) may have removed the stub.
    if (!existsSync(this.stub)) {
      await mkdir(dirname(this.stub), { recursive: true });
      await writeFile(this.stub, STUB_TEXT);
    }
    // Through sh, exactly as make itself invokes the compiler, so CFLAGS quoting
    // (e.g. -D'__FORKNAME__="rotorflight"') is interpreted identically.
    return exec("sh", ["-c", `${this.command} ${args}`], {
      cwd: this.sourceDir,
      allowNonZero: true,
    });
  }
}

/**
 * Classify every USE_ define the source tests, for one target. Pass `shared`
 * to reuse a preprocessor the caller keeps (and disposes); otherwise one is
 * created and removed here.
 */
export async function probeOptions(
  ctx: ProbeContext,
  onProgress?: (done: number, total: number) => void,
  shared?: TargetPreprocessor,
): Promise<ProbeResult> {
  const pp = shared ?? (await TargetPreprocessor.create(ctx));
  try {
    return await probeWith(pp, ctx, onProgress);
  } finally {
    if (!shared) await pp.dispose();
  }
}

async function probeWith(
  pp: TargetPreprocessor,
  ctx: ProbeContext,
  onProgress?: (done: number, total: number) => void,
): Promise<ProbeResult> {
  const start = Date.now();

  const baselineErrors = await pp.diagnose([]);
  if (baselineErrors.length) {
    throw new BuildToolError(
      "BUILD_FAILED",
      `The unmodified ${ctx.target} configuration does not preprocess cleanly.`,
      baselineErrors.join("\n"),
    );
  }
  const macros = await pp.macros([]);
  const baseline = new Set([...macros.keys()].filter((m) => m.startsWith("USE_")));
  const flashKb = Number(macros.get("TARGET_FLASH_SIZE")) || undefined;
  // The MCU makefiles pass -DSTM32F4 / -DSTM32H7 etc.
  const family = macros.has("SIMULATOR_BUILD")
    ? "SITL"
    : ["F4", "F7", "H7", "G4"].find((f) => macros.has(`STM32${f}`));
  const scan = await scanSource(ctx.sourceDir);

  const candidates = [...new Set([...baseline, ...scan.consumers.keys()])].sort();
  let done = 0;
  const options = await pool(candidates, async (name): Promise<ProbedOption> => {
    const sites = scan.sites.get(name) ?? [];
    const { scope, families } = defineScope(sites, scan.consumers.get(name) ?? [], family);
    const facts = {
      consumers: scan.consumers.get(name)?.length ?? 0,
      consumerFiles: scan.consumers.get(name)?.slice(0, 12),
      scope,
      ...(families.length ? { families } : {}),
      ...(sites.length ? { sites: sites.slice(0, 6) } : {}),
    };
    const option =
      !baseline.has(name) && (scope === "other-mcu" || scope === "build")
        ? notApplicable(name, scope, families, family, sites)
        : await classify(pp, name, baseline, [...(scan.guards.get(name) ?? [])], scan.undefDeps, [...(scan.enables.get(name) ?? [])]);
    onProgress?.(++done, candidates.length);
    return { ...option, ...facts };
  });

  // Options that only appear once an opt-in flag is passed (e.g. the CMS
  // failsafe menu with ENABLE_CMS) are knock-ons of that option, not locked.
  // One owner per flag: the option the flag is named after (ENABLE_CMS -> USE_CMS), else the first.
  const owners = new Map<string, string>();
  for (const o of options) {
    if (o.state !== "off-addable" || !o.guard?.startsWith("ENABLE_")) continue;
    if (!owners.has(o.guard) || o.name === `USE_${o.guard.slice("ENABLE_".length)}`) owners.set(o.guard, o.name);
  }
  for (const [flag, owner] of owners) {
    const brought = await pp.defines([flag]);
    for (const o of options) {
      if (o.state !== "off-locked" || o.follows || !brought.has(o.name)) continue;
      o.follows = [owner];
      o.reason = `Added automatically with ${owner} (${flag}). No flag of its own needed.`;
    }
  }

  return {
    target: ctx.target,
    ...(family ? { family } : {}),
    ...(flashKb ? { flashKb } : {}),
    baseline: [...baseline].sort(),
    options,
    durationMs: Date.now() - start,
  };
}

type Classified = Pick<ProbedOption, "name" | "state" | "reason" | "requires" | "guard" | "follows">;

/** Preprocessing would accept these, but they are someone else's hardware or the build's job. */
function notApplicable(
  name: string,
  scope: OptionScope,
  families: string[],
  family: string | undefined,
  sites: DefineSite[],
): Classified {
  if (scope === "build") {
    return {
      name,
      state: "off-locked",
      reason: `Set by the build system (${sites[0]!.file}), not a feature toggle.`,
    };
  }
  return {
    name,
    state: "off-locked",
    reason: `Only defined for ${families.join("/")}${family ? `; this is an ${family} target` : ""}. Not applicable here.`,
  };
}

async function classify(
  pp: TargetPreprocessor,
  name: string,
  baseline: Set<string>,
  guards: string[],
  undefDeps: Map<string, string[][]>,
  enables: string[] = [],
): Promise<Classified> {
  if (baseline.has(name)) {
    if (!guards.length) {
      // `#ifndef USE_A ... #undef USE_X` (common_post.h): X needs no guard of its
      // own, it goes whenever A goes. Each set lists what keeps X alive.
      const sets = (undefDeps.get(name) ?? []).map((s) => s.filter((d) => baseline.has(d))).filter((s) => s.length);
      if (sets.length) {
        const follows = [...new Set(sets.flat())];
        const how = sets.length === 1
          ? sets[0]!.length === 1
            ? `Removed automatically with ${sets[0]![0]}.`
            : `Removed automatically when any of ${sets[0]!.join(", ")} is removed.`
          : `Removed automatically once ${follows.join(" and ")} are all removed.`;
        return { name, state: "on-locked", follows, reason: `${how} No guard of its own needed.` };
      }
      return {
        name,
        state: "on-locked",
        reason: `Defined by the headers for this target with no DISABLE_ guard (e.g. #ifndef ${disableFlag(name)}).`,
      };
    }
    let why = "";
    for (const guard of guards) {
      const errors = await pp.diagnose([guard]);
      if (errors.length) { why = errors[0]!; continue; }
      if ((await pp.defines([guard])).has(name)) {
        why = `A ${guard} guard exists but ${name} is still defined: another header defines it unguarded.`;
        continue;
      }
      return { name, state: "on-removable", guard };
    }
    return { name, state: "on-locked", reason: why };
  }

  // Opt-in guards (e.g. #if !defined(ENABLE_CMS) ... #undef USE_CMS): the flag brings it back.
  for (const flag of enables) {
    if ((await pp.diagnose([flag])).length) continue;
    if ((await pp.defines([flag])).has(name)) {
      return { name, state: "off-addable", guard: flag, reason: `Opt-in: added by passing ${flag} (an ENABLE_ guard in the firmware).` };
    }
  }
  const errors = await pp.diagnose([name]);
  if (errors.some((e) => e.includes(`"${name}" redefined`))) {
    return {
      name,
      state: "off-locked",
      reason: "The headers define it and later #undef it for this target, so -D collides (-Werror).",
    };
  }
  if (errors.length) return { name, state: "off-locked", reason: errors[0] };
  if (!(await pp.defines([name])).has(name)) {
    // Often a dependency rather than a block: common_post.h drops
    // USE_RANGEFINDER_HCSR04 unless USE_RANGEFINDER is also defined.
    for (const deps of dependencySets(name, undefDeps)) {
      const extra = deps.filter((d) => !baseline.has(d));
      if (!extra.length) continue;
      const flags = [name, ...extra];
      if ((await pp.diagnose(flags)).length) continue;
      if ((await pp.defines(flags)).has(name)) {
        return {
          name,
          state: "off-addable",
          requires: extra,
          reason: `Needs ${extra.join(", ")} (switched on with it). Not yet proven to compile or link.`,
        };
      }
    }
    return { name, state: "off-locked", reason: "Removed again by an #undef in the target headers." };
  }
  return {
    name,
    state: "off-addable",
    reason: "Preprocesses cleanly; not yet proven to compile or link.",
  };
}

/** Preprocess a whole selection together to show its real effect, cascades included. */
export async function previewSelection(
  pp: TargetPreprocessor,
  baseline: readonly string[],
  sel: Selection,
  guards: Record<string, string> = {},
): Promise<PreviewResult> {
  const options = selectionOptions(sel, guards);
  const errors = await pp.diagnose(options);
  const after = await pp.defines(options);
  const base = new Set(baseline);
  return {
    ok: errors.length === 0,
    errors,
    added: [...after].filter((d) => !base.has(d)).sort(),
    removed: [...base].filter((d) => !after.has(d)).sort(),
    options,
  };
}

/** OPTIONS tokens for a selection; removals use each option's own guard flag. */
export function selectionOptions(sel: Selection, guards: Record<string, string> = {}): string[] {
  return [...new Set([...sel.add.map((n) => guards[n] ?? n), ...sel.remove.map((n) => guards[n] ?? disableFlag(n))])].sort();
}

/** USE_X -> its guard flag, for every removable option of a probe. */
export function guardMap(probe: Pick<ProbeResult, "options">): Record<string, string> {
  return Object.fromEntries(probe.options.filter((o) => o.guard).map((o) => [o.name, o.guard!]));
}

/** Get the exact CFLAGS the firmware Makefile would compile this target with. */
async function targetCflags(ctx: ProbeContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const mk = join(dir, MK_NAME);
  let r;
  try {
    await writeFile(mk, "rfb-print-cflags:\n\t$(info RFB_CFLAGS=$(CFLAGS))\n\t@:\n");
    const vars = Object.entries(ctx.extraMakeVars ?? {}).map(([k, v]) => `${k}=${v}`);
    r = await exec(
      "make",
      ["-f", "Makefile", "-f", mk, `TARGET=${ctx.target}`, ...vars, "rfb-print-cflags"],
      { cwd: ctx.sourceDir },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith("RFB_CFLAGS="));
  if (!line) {
    throw new BuildToolError("BUILD_FAILED", "Could not read CFLAGS from the firmware Makefile.", r.stdout);
  }
  // Dependency-file generation would write .d files next to the stub.
  return line
    .slice("RFB_CFLAGS=".length)
    .replace(/(^|\s)-(MMD|MP)(?=\s|$)/g, " ")
    .trim();
}

interface SourceScan {
  /** Files (relative) that test each USE_ define in a conditional. */
  consumers: Map<string, string[]>;
  /** USE_X -> the DISABLE_* flags whose guards remove it. */
  guards: Map<string, Set<string>>;
  /** USE_X -> the ENABLE_* flags whose guards opt it in. */
  enables: Map<string, Set<string>>;
  /**
   * For `#if !defined(A) && !defined(B)` ... `#undef X` blocks: X -> the
   * alternative define sets that keep X alive ([[A], [B]] for &&, [[A, B]] for ||).
   */
  undefDeps: Map<string, string[][]>;
  /** Every `#define USE_X` in the source and `-DUSE_X` in the makefiles. */
  sites: Map<string, DefineSite[]>;
}

interface Frame {
  /** Dependency sets when this branch is a plain !defined() test (see undefDeps). */
  deps: string[][] | null;
  /** MCU families this branch is positively restricted to. */
  families: string[];
  /** A removal guard: `#ifndef DISABLE_X` (around a #define) or `#ifdef DISABLE_X` (around an #undef). */
  disable?: { flag: string; mode: "ifndef" | "ifdef" };
  /** An opt-in guard: `#if !defined(ENABLE_X)` (around an #undef) or `#ifdef ENABLE_X` (around a #define). */
  enable?: { flag: string; mode: "ifndef" | "ifdef" };
}

/** Recognise `DISABLE_X`, `defined(DISABLE_X)` and `!defined(DISABLE_X)` conditions. */
function flagGuard(prefix: "DISABLE_" | "ENABLE_", directive: string, rest: string): Frame["disable"] {
  const e = rest.replace(/\/\/.*$|\/\*.*?\*\//g, "").trim();
  if (directive === "ifndef" || directive === "ifdef") {
    const flag = e.split(/\s/)[0]!;
    return flag.startsWith(prefix) && /^[A-Z0-9_]+$/.test(flag) ? { flag, mode: directive } : undefined;
  }
  const m = e.match(/^(!?)\s*defined\s*\(?\s*([A-Z0-9_]+)\s*\)?$/);
  return m && m[2]!.startsWith(prefix) ? { flag: m[2]!, mode: m[1] ? "ifndef" : "ifdef" } : undefined;
}
const disableGuard = (d: string, r: string) => flagGuard("DISABLE_", d, r);
const enableGuard = (d: string, r: string) => flagGuard("ENABLE_", d, r);

async function scanSource(sourceDir: string): Promise<SourceScan> {
  const scan: SourceScan = { consumers: new Map(), guards: new Map(), enables: new Map(), undefDeps: new Map(), sites: new Map() };
  const addGuard = (name: string, flag: string) => scan.guards.set(name, new Set([...(scan.guards.get(name) ?? []), flag]));
  const addEnable = (name: string, flag: string) => scan.enables.set(name, new Set([...(scan.enables.get(name) ?? []), flag]));
  const enablesAround = (stack: Frame[], mode: "ifndef" | "ifdef") =>
    stack.filter((f) => f.enable?.mode === mode).map((f) => f.enable!.flag);
  const guardsAround = (stack: Frame[], mode: "ifndef" | "ifdef") =>
    stack.filter((f) => f.disable?.mode === mode).map((f) => f.disable!.flag);
  const addSite = (name: string, site: DefineSite) =>
    scan.sites.set(name, [...(scan.sites.get(name) ?? []), site]);

  for await (const file of walk(join(sourceDir, "src", "main"))) {
    const rel = relative(sourceDir, file).replace(/\\/g, "/");
    const fromFile = fileFamilies(rel);
    const text = await readFile(file, "utf8");
    const seen = new Set<string>();
    const stack: Frame[] = [];
    text.split("\n").forEach((line, i) => {
      if (CONDITIONAL.test(line)) {
        for (const m of line.matchAll(USE_TOKEN)) seen.add(m[0]);
      }
      const d = line.match(/^\s*#\s*(ifndef|ifdef|if|elif|else|endif|undef|define)\b\s*(.*)$/);
      if (!d) return;
      const [, directive, rest] = d as unknown as [string, string, string];
      const first = rest.trim().split(/[\s(]/)[0]!;
      if (directive === "endif") stack.pop();
      else if (directive === "else") stack[stack.length - 1] = { deps: null, families: [] };
      else if (directive === "elif") stack[stack.length - 1] = { deps: null, families: exprFamilies(rest), disable: disableGuard("if", rest), enable: enableGuard("if", rest) };
      else if (directive === "ifndef") stack.push({ deps: [[first]], families: [], disable: disableGuard("ifndef", rest), enable: enableGuard("ifndef", rest) });
      else if (directive === "ifdef") stack.push({ deps: null, families: exprFamilies(`defined(${first})`), disable: disableGuard("ifdef", rest), enable: enableGuard("ifdef", rest) });
      else if (directive === "if") stack.push({ deps: parseNotDefined(rest), families: exprFamilies(rest), disable: disableGuard("if", rest), enable: enableGuard("if", rest) });
      else if (directive === "undef") {
        const deps = stack.at(-1)?.deps;
        if (deps && first.startsWith("USE_")) {
          scan.undefDeps.set(first, [...(scan.undefDeps.get(first) ?? []), ...deps]);
        }
        if (first.startsWith("USE_")) for (const g of guardsAround(stack, "ifdef")) addGuard(first, g);
        // Undone only while ENABLE_X is absent: ENABLE_X opts the define in.
        if (first.startsWith("USE_")) for (const g of enablesAround(stack, "ifndef")) addEnable(first, g);
      } else if (directive === "define" && /^USE_[A-Z0-9_]+$/.test(first)) {
        for (const g of guardsAround(stack, "ifndef")) addGuard(first, g);
        for (const g of enablesAround(stack, "ifdef")) addEnable(first, g);
        const enclosing = [...stack].reverse().find((f) => f.families.length)?.families ?? [];
        const families = [...new Set([...fromFile, ...enclosing])];
        const comment = rest.match(/\/\/\s*(.+?)\s*$|\/\*\s*(.+?)\s*\*\//);
        addSite(first, {
          file: rel,
          line: i + 1,
          ...(comment ? { comment: (comment[1] ?? comment[2])! } : {}),
          ...(families.length ? { families } : {}),
        });
      }
    });
    for (const name of seen) scan.consumers.set(name, [...(scan.consumers.get(name) ?? []), rel]);
  }

  // Defines the build passes on the command line, e.g. -DUSE_HAL_DRIVER in make/mcu/STM32H7.mk.
  for (const rel of ["Makefile", ...(await listMakefiles(sourceDir))]) {
    let text: string;
    try {
      text = await readFile(join(sourceDir, rel), "utf8");
    } catch {
      continue;
    }
    const mcu = rel.match(/^make\/mcu\/(\w+)\.mk$/)?.[1];
    const families = mcu ? familiesOf(mcu) : [];
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/-D(USE_[A-Z0-9_]+)\b/g)) {
        addSite(m[1]!, { file: rel, line: i + 1, build: true, ...(families.length ? { families } : {}) });
      }
    });
  }
  return scan;
}

/** Developer / legacy board targets (anything but the unified target) — weak evidence. */
const isBoardSite = (s: DefineSite) =>
  /^src\/main\/target\/(?!STM32_UNIFIED\/)[^/]+\//.test(s.file);

/** Decide whether a define is a feature, this MCU's hardware, another MCU's, or the build's. */
function defineScope(
  allSites: DefineSite[],
  consumerFiles: string[],
  family: string | undefined,
): { scope: OptionScope; families: string[] } {
  const union = (xs: string[][]) => [...new Set(xs.flat())];
  // Code that only exists for other MCUs (e.g. *_stm32h7xx.c, *_hal.c) settles it.
  const consumerFams = consumerFiles.map(fileFamilies);
  const consumersForeign =
    consumerFiles.length > 0 &&
    consumerFams.every((f) => f.length > 0) &&
    !!family &&
    !consumerFams.some((f) => f.includes(family));

  const sites = allSites.filter((s) => !isBoardSite(s));
  if (!sites.length) {
    if (consumersForeign) return { scope: "other-mcu", families: union(consumerFams) };
    const boards = allSites.filter(isBoardSite);
    return boards.length
      ? { scope: "board-only", families: union(boards.map((s) => s.families ?? [])) }
      : { scope: "never-defined", families: [] };
  }

  const families = union(sites.map((s) => s.families ?? []));
  if (sites.some((s) => !s.build && !s.families)) return { scope: "generic", families: [] };
  if (sites.every((s) => s.build && !s.families)) return { scope: "build", families: [] };
  if (family && families.includes(family)) {
    return { scope: sites.every((s) => s.build) ? "build" : "this-mcu", families };
  }
  // Defined by MCU build files or MCU startup code, or only consumed by MCU code: hardware.
  const mcuOnly = sites.some((s) => s.build || fileFamilies(s.file).length > 0);
  return { scope: mcuOnly || consumersForeign ? "other-mcu" : "mcu-default", families };
}

/** Positive MCU tests in a conditional: `defined(STM32H7) || defined(STM32F7)` -> [H7, F7]. */
function exprFamilies(expr: string): string[] {
  const positive = expr
    .replace(/\/\/.*$|\/\*.*?\*\//g, "")
    .replace(/!\s*defined\s*\(\s*\w+\s*\)|!\s*defined\s+\w+|!\s*\w+/g, "");
  const out = new Set<string>();
  for (const m of positive.matchAll(/\b(STM32[A-Z0-9]+|SIMULATOR_BUILD)\b/g)) {
    for (const f of familiesOf(m[1]!)) out.add(f);
  }
  return [...out];
}

/** Family of an MCU-ish name: STM32H743 / STM32H7 / MATEKH743 / stm32h7xx -> H7. */
function familiesOf(name: string): string[] {
  if (/SITL|SIMULATOR/i.test(name)) return ["SITL"];
  const m = name.toUpperCase().match(/(?:STM32|^[A-Z]*?)(F4|F7|H7|G4)/);
  return m ? [m[1]!] : [];
}

/** Families a whole file is specific to, from its path. */
function fileFamilies(rel: string): string[] {
  const target = rel.match(/^src\/main\/target\/([^/]+)\//)?.[1];
  if (target && target !== "STM32_UNIFIED") {
    const f = familiesOf(target);
    return f.length ? f : [`target ${target}`];
  }
  const base = rel.split("/").pop()!.toLowerCase();
  const m = base.match(/stm32(f4|f7|h7|g4)|(f4|f7|h7|g4)xx|_(f4|f7|h7|g4)\b/) ?? rel.match(/\/vcp(f4)\//);
  const f = m?.slice(1).find(Boolean);
  if (f) return [f.toUpperCase()];
  // F4 builds use the StdPeriph library; F7/H7/G4 use ST's HAL and LL drivers.
  if (/_stdperiph\b/.test(base)) return ["F4"];
  if (/(_hal|_ll)(_\w+)?\.[ch]$/.test(base) || rel.includes("/vcp_hal/")) return ["F7", "H7", "G4"];
  return [];
}

async function listMakefiles(sourceDir: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string) => {
    let entries;
    try {
      entries = await readdir(join(sourceDir, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) await visit(`${dir}/${e.name}`);
      else if (e.name.endsWith(".mk")) out.push(`${dir}/${e.name}`);
    }
  };
  await visit("make");
  return out;
}

/** `!defined(A) && !defined(B)` -> [[A], [B]];  `!defined(A) || !defined(B)` -> [[A, B]]. */
function parseNotDefined(expr: string): string[][] | null {
  const e = expr.replace(/\/\/.*$|\/\*.*?\*\//g, "").trim();
  const term = /^\(?\s*!\s*defined\s*\(\s*(USE_[A-Z0-9_]+)\s*\)\s*\)?$/;
  for (const [op, shape] of [["&&", "any"], ["||", "all"]] as const) {
    const parts = e.split(op).map((p) => p.trim().match(term)?.[1]);
    if (parts.every(Boolean)) {
      const names = parts as string[];
      return shape === "any" || names.length === 1 ? names.map((n) => [n]) : [names];
    }
  }
  return null;
}

/** Candidate dependency sets for `name`, expanded one level transitively. */
function dependencySets(name: string, undefDeps: Map<string, string[][]>): string[][] {
  const out: string[][] = [];
  for (const set of undefDeps.get(name) ?? []) {
    const expanded = new Set(set);
    for (const dep of set) for (const s of undefDeps.get(dep)?.slice(0, 1) ?? []) s.forEach((x) => expanded.add(x));
    expanded.delete(name);
    out.push([...expanded]);
  }
  return out;
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (/\.[ch]$/.test(entry.name)) yield p;
  }
}

async function pool<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: availableParallelism() }, worker));
  return results;
}

function errorLines(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .filter((l) => /\berror:/.test(l))
    .map((l) => l.replace(/^.*?error:\s*/, "").replace(/\s*\[-Werror\]$/, "").trim());
}

/** Forward slashes: understood by the MSYS shell and by gcc on Windows alike. */
function posixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
