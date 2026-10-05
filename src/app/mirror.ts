import { existsSync } from "node:fs";
import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheRoot, sourcesDir } from "../config.ts";
import { exec } from "../exec.ts";

/**
 * Local trees on a Windows drive (/mnt/c/... under WSL) are mirrored into WSL's
 * own filesystem before probing or building. Building in place is impractical:
 * the firmware Makefile runs `git diff --shortstat` on every make call, and WSL
 * git re-hashes every file of a Windows-written index over the slow /mnt
 * bridge, which takes minutes per call.
 *
 * The mirror:
 * - is an rsync copy (only changed files after the first sync),
 * - has a `.git` *file* pointing at the clone's real git dir, so the firmware
 *   still gets its revision and dirty flag, read from fast storage,
 * - links `tools/` to an already-installed Linux toolchain from a cached
 *   release checkout, so the user's own tree (which may hold a Windows
 *   toolchain) is never written to.
 */

export function needsMirror(dir: string): boolean {
  return process.platform === "linux" && /^\/mnt\/[a-z]\//.test(dir);
}

export function mirrorPath(dir: string): string {
  return join(cacheRoot(), "local", dir.replace(/^\/+/, "").replace(/[^A-Za-z0-9._-]+/g, "_"));
}

export interface MirrorResult {
  dir: string;
  /** Source files (src/, make/, Makefile) that changed in this sync. */
  changed: string[];
  firstSync: boolean;
}

export async function syncMirror(source: string): Promise<MirrorResult> {
  const dir = mirrorPath(source);
  const firstSync = !existsSync(dir);
  await mkdir(dir, { recursive: true });
  const r = await exec("rsync", [
    "-a", "--delete", "--itemize-changes",
    "--exclude=/.git", "--exclude=/obj", "--exclude=/tools", "--exclude=/downloads",
    `${source.replace(/\/+$/, "")}/`, `${dir}/`,
  ]);
  const changed = r.stdout
    .split("\n")
    .filter((l) => /^[<>c*]f|^\*deleting/.test(l))
    .map((l) => l.replace(/^\S+\s+/, ""))
    .filter((p) => /^(src\/|make\/|Makefile)/.test(p));

  await writeFile(join(dir, ".git"), `gitdir: ${join(source, ".git")}\n`);
  await linkToolchain(dir);
  return { dir, changed, firstSync };
}

/** Point tools/ at a cached release's installed toolchain, if there is one. */
async function linkToolchain(dir: string) {
  const tools = join(dir, "tools");
  if (existsSync(tools)) return;
  let refs: string[] = [];
  try {
    refs = await readdir(sourcesDir());
  } catch {
    return;
  }
  for (const ref of refs) {
    const candidate = join(sourcesDir(), ref, "tools");
    if (existsSync(candidate)) {
      await rm(tools, { force: true, recursive: true });
      await symlink(candidate, tools);
      return;
    }
  }
}
