import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheRoot } from "./config.ts";
import { BuildToolError } from "./errors.ts";

/**
 * Board list, from the same source the Configurator's firmware flasher uses:
 * the `rotorflight/rotorflight-targets` repo (branch `rotorflight`), where each
 * board is a `<MANUFACTURER>-<BOARD>.config` file under `configs/` (supported)
 * or `legacy/`. A board maps to an MCU build target via the config's first
 * line, e.g. `# Rotorflight / STM32F7X2 (S7X2) 4.5.0 ...`.
 */

const REPO = "rotorflight/rotorflight-targets";
const BRANCH = "rotorflight";
/** Same expiry the Configurator uses for its unifiedSourceCache. */
const CACHE_TTL_MS = 2 * 3600 * 1000;
const CONFIG_NAME = /^([^-]{1,4})-(.*)\.config$/;

export interface BoardEntry {
  /** `<manufacturerId>-<boardName>`, the key the Configurator's detect looks up. */
  key: string;
  manufacturer: string;
  board: string;
  supported: boolean;
  path: string;
}

interface BoardCache {
  fetchedAt: number;
  boards: BoardEntry[];
  /** key -> MCU target, filled in lazily as boards are resolved. */
  targets: Record<string, string>;
}

let memo: BoardCache | undefined;
const cacheFile = () => join(cacheRoot(), "boards.json");

export async function listBoards(): Promise<BoardEntry[]> {
  const cache = await loadCache();
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.boards;

  try {
    const [supported, legacy] = await Promise.all([listDir("configs"), listDir("legacy")]);
    const boards = [
      ...supported.map((f) => entry(f, true)),
      ...legacy.map((f) => entry(f, false)),
    ].filter((b): b is BoardEntry => b !== undefined);
    await saveCache({ fetchedAt: Date.now(), boards, targets: cache?.targets ?? {} });
    return boards;
  } catch (err) {
    // Stale beats nothing when GitHub is unreachable or rate-limited.
    if (cache) return cache.boards;
    throw new BuildToolError("BUILD_FAILED", `Could not fetch the board list from ${REPO}.`, String(err));
  }
}

/** Resolve a board key (e.g. "FDRC-FLYDRAGON_V2") to its MCU target ("STM32F7X2"). */
export async function boardTarget(key: string): Promise<string | undefined> {
  const boards = await listBoards();
  const cache = memo!;
  if (cache.targets[key]) return cache.targets[key];
  const board = boards.find((b) => b.key === key);
  if (!board) return undefined;

  const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/${board.path}`);
  if (!res.ok) throw new BuildToolError("BUILD_FAILED", `Could not fetch ${board.path} (HTTP ${res.status}).`);
  const target = parseConfigTarget(await res.text());
  if (target) {
    cache.targets[key] = target;
    await saveCache(cache);
  }
  return target;
}

export interface BoardConfig {
  board: BoardEntry;
  /** MCU target named in the config header. */
  target?: string;
  /** The raw file from rotorflight-targets. */
  raw: string;
  /** Last commit touching the file, as the Configurator records it in the inserted header. */
  commitHash: string;
  date: string;
}

/**
 * Fetch a board's config file fresh, with the commit info the Configurator puts
 * in the inserted header. Not cached: a config fix upstream must not be
 * shadowed by a stale copy when flashing real hardware.
 */
export async function boardConfig(key: string): Promise<BoardConfig | undefined> {
  const board = (await listBoards()).find((b) => b.key === key);
  if (!board) return undefined;
  const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/${board.path}`);
  if (!res.ok) throw new BuildToolError("BUILD_FAILED", `Could not fetch ${board.path} (HTTP ${res.status}).`);
  const raw = await res.text();

  let commitHash = "unknown";
  let date = new Date().toISOString();
  try {
    const c = await fetch(
      `https://api.github.com/repos/${REPO}/commits?sha=${BRANCH}&path=${encodeURIComponent(board.path)}`,
      { headers: { accept: "application/vnd.github+json" } },
    );
    const commits = (await c.json()) as { sha: string; commit: { author: { date: string } } }[];
    if (Array.isArray(commits) && commits[0]) {
      commitHash = commits[0].sha.substring(0, 8);
      date = commits[0].commit.author.date;
    }
  } catch {
    // Header metadata only; the config itself is what matters.
  }
  return { board, target: parseConfigTarget(raw), raw, commitHash, date };
}

/** `# Rotorflight / STM32F7X2 (S7X2) 4.5.0 ...` -> "STM32F7X2". */
export function parseConfigTarget(text: string): string | undefined {
  const first = text.split("\n", 1)[0] ?? "";
  return first.match(/^#\s*\S+\s*\/\s*([A-Z0-9_]+)\s/)?.[1];
}

function entry(file: { name: string; path: string }, supported: boolean): BoardEntry | undefined {
  const m = file.name.match(CONFIG_NAME);
  if (!m) return undefined;
  return { key: `${m[1]}-${m[2]}`, manufacturer: m[1]!, board: m[2]!, supported, path: file.path };
}

async function listDir(dir: string): Promise<{ name: string; path: string }[]> {
  const url = `https://api.github.com/repos/${REPO}/contents/${dir}?ref=${BRANCH}`;
  const res = await fetch(url, { headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as { name: string; path: string }[];
}

async function loadCache(): Promise<BoardCache | undefined> {
  if (memo) return memo;
  try {
    memo = JSON.parse(await readFile(cacheFile(), "utf8")) as BoardCache;
  } catch {
    memo = undefined;
  }
  return memo;
}

async function saveCache(cache: BoardCache): Promise<void> {
  memo = cache;
  await mkdir(cacheRoot(), { recursive: true });
  await writeFile(cacheFile(), JSON.stringify(cache));
}
