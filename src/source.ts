import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { FIRMWARE_REPO_URL, sourcesDir } from "./config.ts";
import { BuildToolError } from "./errors.ts";
import { exec, execCapture, type ExecEvent } from "./exec.ts";

export interface SourceOptions {
  /** Tag or branch to build, e.g. "release/4.6.0" or "master". */
  ref: string;
  /** Use an existing local clone instead of the cache (checkout still runs). */
  sourceDir?: string;
  /**
   * With `sourceDir`: build the working tree exactly as it is, without checking
   * out `ref`. For trying uncommitted firmware-side edits.
   */
  asIs?: boolean;
  /** Force a fresh clone even if a cached checkout exists. */
  fresh?: boolean;
  onEvent?: (e: ExecEvent) => void;
}

export interface SourceInfo {
  dir: string;
  ref: string;
  commit: string;
}

/** Where the cached checkout of `ref` lives (it may not exist yet). */
export function cachedSourcePath(ref: string): string {
  return join(sourcesDir(), slug(ref));
}

/** Filesystem-safe slug for a git ref so "release/4.6.0" -> "release-4.6.0". */
function slug(ref: string): string {
  return ref.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a checkout of `ref` exists on disk and return where. A shallow
 * (`--depth 1`) clone per ref is cached under RFB_CACHE_DIR/sources; switching
 * feature sets for the same ref reuses it, matching the scope doc's "cached
 * locally so switching feature sets doesn't mean re-cloning".
 */
export async function ensureSource(opts: SourceOptions): Promise<SourceInfo> {
  const { ref } = opts;
  if (!ref || /\s/.test(ref)) {
    throw new BuildToolError("INVALID_ARGS", `Invalid git ref: ${JSON.stringify(ref)}`);
  }

  if (opts.sourceDir) {
    if (!(await exists(join(opts.sourceDir, ".git")))) {
      throw new BuildToolError(
        "CHECKOUT_FAILED",
        `${opts.sourceDir} is not a git working tree.`,
      );
    }
    if (!opts.asIs) await checkout(opts.sourceDir, ref, opts.onEvent);
    return describe(opts.sourceDir, ref);
  }

  const dir = join(sourcesDir(), slug(ref));
  if (opts.fresh && (await exists(dir))) await rm(dir, { recursive: true, force: true });

  if (await exists(join(dir, ".git"))) {
    // A tag never moves: the cached checkout is it, and no network is needed.
    if (await isTag(dir, ref)) return describe(dir, ref);
    // A branch may have advanced: fetch it. Offline, keep building the cached copy
    // rather than deleting it (a re-clone would fail too).
    let fetched = false;
    try {
      await exec("git", ["-C", dir, "fetch", "--depth", "1", "origin", ref], { onEvent: opts.onEvent });
      fetched = true;
    } catch {
      opts.onEvent?.({ stream: "stderr", line: `Could not update ${ref} (offline?); using the cached checkout.` });
    }
    if (!fetched) {
      try {
        return await describe(dir, ref);
      } catch {
        // The cache is broken as well: fall through to a fresh clone.
      }
    } else {
      try {
        await checkout(dir, "FETCH_HEAD", opts.onEvent);
        return await describe(dir, ref);
      } catch {
        // A damaged checkout: start again from a fresh clone.
      }
    }
    await rm(dir, { recursive: true, force: true });
  }

  await mkdir(sourcesDir(), { recursive: true });
  try {
    await exec(
      "git",
      // core.longpaths: some library files in the firmware exceed Windows' 260-character limit.
      ["-c", "core.longpaths=true", "clone", "--depth", "1", "--branch", ref, FIRMWARE_REPO_URL, dir],
      { onEvent: opts.onEvent },
    );
  } catch (err) {
    const detail = err instanceof BuildToolError ? err.detail ?? "" : String(err);
    if (/could not find remote branch|Remote branch .* not found/i.test(detail)) {
      throw new BuildToolError(
        "CHECKOUT_FAILED",
        `Ref "${ref}" not found in ${FIRMWARE_REPO_URL}.`,
        detail,
      );
    }
    if (/No space left on device|not enough space/i.test(detail)) {
      throw new BuildToolError("DISK_SPACE", "Ran out of disk space while cloning.", detail);
    }
    throw new BuildToolError("CLONE_FAILED", `git clone failed for ref "${ref}".`, detail);
  }
  return describe(dir, ref);
}

async function checkout(dir: string, ref: string, onEvent?: (e: ExecEvent) => void): Promise<void> {
  try {
    await exec("git", ["-C", dir, "checkout", "--detach", ref], { onEvent });
  } catch (err) {
    const detail = err instanceof BuildToolError ? err.detail ?? "" : String(err);
    throw new BuildToolError("CHECKOUT_FAILED", `Could not check out "${ref}".`, detail);
  }
}

/** Is `ref` a tag in this checkout? (`clone --branch <tag>` keeps the tag ref.) */
async function isTag(dir: string, ref: string): Promise<boolean> {
  try {
    return (await execCapture("git", ["-C", dir, "tag", "--list", ref])) === ref;
  } catch {
    return false;
  }
}

async function describe(dir: string, ref: string): Promise<SourceInfo> {
  const commit = await execCapture("git", ["-C", dir, "rev-parse", "HEAD"]);
  return { dir, ref, commit };
}
