import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { FIRMWARE_REPO_URL, sourcesDir } from "./config.ts";
import { BuildToolError } from "./errors.ts";
import { exec, execCapture, type ExecEvent } from "./exec.ts";

export interface SourceOptions {
  /** Tag or branch to build, e.g. "release/4.6.0" or "master". */
  ref: string;
  /**
   * Clone from this repository (an https URL, see parseRepo()) instead of the
   * official one, e.g. someone's fork. Cached separately per repository.
   */
  repo?: string;
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

/** A firmware repository other than the official one. */
export interface RepoSpec {
  /** What git clones: https://host/path(.git). */
  url: string;
  /** For display: "owner/repo" on GitHub, else host/path. */
  name: string;
}

/**
 * Accept "owner/repo" (GitHub), or an https:// URL to any git host, with or
 * without ".git" and a trailing slash. Only https: no ssh or local paths, so
 * nothing needs keys or credentials, and a typo cannot reach the file system.
 */
export function parseRepo(input: string): RepoSpec {
  const s = input.trim().replace(/\/+$/, "");
  const short = s.match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/);
  if (short) return { url: `https://github.com/${short[1]}/${short[2]}.git`, name: `${short[1]}/${short[2]}` };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new BuildToolError("INVALID_ARGS", `"${input}" is not a repository. Use owner/repo for GitHub, or an https:// git URL.`);
  }
  const path = u.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || !/^\/[\w.-]+(\/[\w.-]+)+$/.test(path)) {
    throw new BuildToolError("INVALID_ARGS", `"${input}" is not a supported repository URL (https:// only, no credentials).`);
  }
  const host = u.host.toLowerCase();
  return { url: `https://${host}${path}.git`, name: host === "github.com" ? path.slice(1) : `${host}${path}` };
}

/** Is this the official firmware repository (so release sizes and the shared cache apply)? */
export function isOfficialRepo(url: string): boolean {
  const norm = (x: string) => x.toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
  return norm(url) === norm(FIRMWARE_REPO_URL);
}

/**
 * Where the cached checkout of `ref` lives (it may not exist yet). Official refs
 * keep their readable folders; another repository gets a short hashed folder,
 * because the firmware's deepest build paths must stay under Windows' path limit.
 */
export function cachedSourcePath(ref: string, repo?: string): string {
  if (!repo || isOfficialRepo(repo)) return join(sourcesDir(), slug(ref));
  const id = createHash("sha1").update(`${repo.toLowerCase()}#${ref}`).digest("hex").slice(0, 10);
  return join(sourcesDir(), "forks", `f-${id}`);
}

/**
 * Git must never stop to ask for a login: a private or mistyped repository
 * (GitHub answers "not found" with an authentication challenge) would otherwise
 * open Git Credential Manager's window, or hang a terminal prompt.
 */
const GIT_NET_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
const GIT_NET_ARGS = ["-c", "credential.helper=", "-c", "core.askPass="];

export interface RemoteRefs {
  /** The branch the repository's HEAD points at, e.g. "master". */
  defaultBranch?: string;
  /** Default branch first, then the rest by name. */
  branches: string[];
  /** Newest-looking first. */
  tags: string[];
}

/** The branches and tags of a repository, without cloning it (works with any git host). */
export async function listRemoteRefs(url: string): Promise<RemoteRefs> {
  let out: string;
  try {
    out = (await exec("git", [...GIT_NET_ARGS, "ls-remote", "--symref", url, "HEAD", "refs/heads/*", "refs/tags/*"],
      { env: GIT_NET_ENV, timeoutMs: 60_000 })).stdout;
  } catch (err) {
    throw repoError(url, err);
  }
  return parseRemoteRefs(out);
}

/** Parse `git ls-remote --symref` output. */
export function parseRemoteRefs(out: string): RemoteRefs {
  let defaultBranch: string | undefined;
  const branches: string[] = [];
  const tags = new Set<string>();
  for (const line of out.split(/\r?\n/)) {
    const sym = line.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/);
    if (sym) { defaultBranch = sym[1]; continue; }
    const m = line.match(/^[0-9a-f]{40,}\s+refs\/(heads|tags)\/(.+?)(\^\{\})?$/);
    if (!m) continue;
    if (m[1] === "heads") branches.push(m[2]!);
    else tags.add(m[2]!);
  }
  const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  branches.sort((a, b) => (a === defaultBranch ? -1 : b === defaultBranch ? 1 : natural(a, b)));
  // Release tags first (what people usually build), then the rest; newest first in each.
  const rank = (t: string) => (/^release\//.test(t) ? 0 : 1);
  const sortedTags = [...tags].sort((a, b) => rank(a) - rank(b) || natural(b, a));
  return { ...(defaultBranch ? { defaultBranch } : {}), branches, tags: sortedTags };
}

/** A clear message for the usual repository failures. */
function repoError(url: string, err: unknown): BuildToolError {
  const detail = err instanceof BuildToolError ? err.detail ?? err.message : String(err);
  if (/not found|could not read Username|Authentication failed|terminal prompts disabled|403|401/i.test(detail)) {
    return new BuildToolError("CLONE_FAILED", `${url} was not found, or is private (only public repositories can be used).`, detail);
  }
  if (/Could not resolve host|unable to access|timed out|did not finish/i.test(detail)) {
    return new BuildToolError("CLONE_FAILED", `Could not reach ${url}. Check the address and your internet connection.`, detail);
  }
  return new BuildToolError("CLONE_FAILED", `Could not read ${url}.`, detail);
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

  const remote = opts.repo && !isOfficialRepo(opts.repo) ? opts.repo : FIRMWARE_REPO_URL;
  const dir = cachedSourcePath(ref, remote);
  if (opts.fresh && (await exists(dir))) await rm(dir, { recursive: true, force: true });

  if (await exists(join(dir, ".git"))) {
    // A tag never moves: the cached checkout is it, and no network is needed.
    if (await isTag(dir, ref)) return describe(dir, ref);
    // A branch may have advanced: fetch it. Offline, keep building the cached copy
    // rather than deleting it (a re-clone would fail too).
    let fetched = false;
    try {
      await exec("git", [...GIT_NET_ARGS, "-C", dir, "fetch", "--depth", "1", "origin", ref], { onEvent: opts.onEvent, env: GIT_NET_ENV });
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

  await mkdir(join(dir, ".."), { recursive: true });
  try {
    await exec(
      "git",
      // core.longpaths: some library files in the firmware exceed Windows' 260-character limit.
      [...GIT_NET_ARGS, "-c", "core.longpaths=true", "clone", "--depth", "1", "--branch", ref, remote, dir],
      { onEvent: opts.onEvent, env: GIT_NET_ENV },
    );
  } catch (err) {
    const detail = err instanceof BuildToolError ? err.detail ?? "" : String(err);
    if (/could not find remote branch|Remote branch .* not found/i.test(detail)) {
      throw new BuildToolError(
        "CHECKOUT_FAILED",
        `Branch or tag "${ref}" not found in ${remote}.`,
        detail,
      );
    }
    if (/No space left on device|not enough space/i.test(detail)) {
      throw new BuildToolError("DISK_SPACE", "Ran out of disk space while cloning.", detail);
    }
    if (remote !== FIRMWARE_REPO_URL) throw repoError(remote, err);
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
