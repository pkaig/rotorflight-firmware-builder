import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cacheRoot } from "./config.ts";
import { parseHex } from "./hex.ts";

/**
 * Firmware releases on GitHub, for the source picker. Same endpoint the
 * Configurator's flasher uses; tags look like `release/4.6.0`,
 * `release/4.6.0-RC3` and `snapshot/4.6.0-20260208` (marked pre-release).
 */

export interface Release {
  tag: string;
  name: string;
  prerelease: boolean;
  date: string;
}

const URL = "https://api.github.com/repos/rotorflight/rotorflight-firmware/releases?per_page=50";
const TTL_MS = 3600 * 1000;
let memo: { at: number; releases: Release[] } | undefined;

export interface ReleaseSize {
  tag: string;
  target: string;
  /** Data bytes in the official hex: flash used, including the config-erase marker release builds carry. */
  flash: number;
  /**
   * Bytes of that marker (a lone 0xFFFFFFFF word in .flash_config, from
   * FLASH_CONFIG_ERASE=yes). Subtract it to compare with a build without it.
   */
  marker: number;
  asset: string;
  url: string;
}

const sizeMemo = new Map<string, ReleaseSize | null>();

/**
 * Flash size of an official release build, read from the .hex attached to the
 * GitHub release, with no local build. Matches a local build of the same tag
 * exactly, apart from the config-erase marker. Releases publish no ELF, so RAM
 * use and the removal estimates still need one local baseline build.
 */
export async function releaseHexSize(tag: string, target: string): Promise<ReleaseSize | null> {
  const key = `${tag}|${target}`;
  if (sizeMemo.has(key)) return sizeMemo.get(key)!;
  const file = join(cacheRoot(), "release-hex", `${tag.replace(/[^A-Za-z0-9._-]+/g, "-")}_${target}.hex`);
  let text: string | undefined;
  let asset = "";
  let url = "";
  // The asset's real name and URL are kept beside the cached hex.
  const meta = `${file}.json`;
  if (existsSync(file)) {
    text = await readFile(file, "utf8");
    try {
      ({ asset, url } = JSON.parse(await readFile(meta, "utf8")) as { asset: string; url: string });
    } catch {
      asset = file.split(/[\\/]/).pop()!; // cached before the metadata was kept
    }
  } else {
    const res = await fetch(`https://api.github.com/repos/rotorflight/rotorflight-firmware/releases/tags/${tag}`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (res.status === 404) return remember(key, null); // e.g. master, or a tag without a release
    if (!res.ok) throw new Error(`GitHub release lookup failed: HTTP ${res.status}`);
    const rel = (await res.json()) as { assets: { name: string; browser_download_url: string }[] };
    const a = rel.assets.find((x) => x.name.endsWith(`_${target}.hex`));
    if (!a) return remember(key, null); // e.g. a legacy target releases do not publish
    asset = a.name;
    url = a.browser_download_url;
    const hex = await fetch(url);
    if (!hex.ok) throw new Error(`Download of ${a.name} failed: HTTP ${hex.status}`);
    text = await hex.text();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
    await writeFile(meta, JSON.stringify({ asset, url }));
  }
  const img = parseHex(text);
  const marker = img.blocks
    .filter((b) => b.data.length === 4 && b.data.every((x) => x === 0xff))
    .reduce((n, b) => n + b.data.length, 0);
  return remember(key, { tag, target, flash: img.bytesTotal, marker, asset, url });
}

function remember(key: string, v: ReleaseSize | null): ReleaseSize | null {
  sizeMemo.set(key, v);
  return v;
}

/** FC_VERSION_* from a tree's src/main/build/version.h, e.g. [4, 7, 0]. */
export async function treeVersion(sourceDir: string): Promise<[number, number, number] | undefined> {
  try {
    const text = await readFile(join(sourceDir, "src", "main", "build", "version.h"), "utf8");
    const v = ["MAJOR", "MINOR", "PATCH_LEVEL"].map((k) => Number(text.match(new RegExp(`FC_VERSION_${k}\\s+(\\d+)`))?.[1]));
    return v.every((n) => Number.isFinite(n)) ? (v as [number, number, number]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The release a local tree is closest to, by its declared version: that exact
 * release if it exists, else the newest final release below it. Release tags
 * live on release branches, so `git describe` from master finds none.
 */
export async function nearestRelease(version: [number, number, number]): Promise<string | undefined> {
  const num = (t: string) => t.match(/^release\/(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  const cmp = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
  const finals = (await listReleases())
    .map((r) => ({ tag: r.tag, v: num(r.tag) }))
    .filter((r): r is { tag: string; v: number[] } => !!r.v && cmp(r.v, version) <= 0)
    .sort((a, b) => cmp(b.v, a.v));
  return finals[0]?.tag;
}

export async function listReleases(): Promise<Release[]> {
  if (memo && Date.now() - memo.at < TTL_MS) return memo.releases;
  try {
    const res = await fetch(URL, { headers: { accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { tag_name: string; name: string; prerelease: boolean; draft: boolean; published_at: string }[];
    const releases = json
      .filter((r) => !r.draft)
      .map((r) => ({ tag: r.tag_name, name: r.name, prerelease: r.prerelease, date: r.published_at }));
    memo = { at: Date.now(), releases };
    return releases;
  } catch (err) {
    if (memo) return memo.releases; // stale beats nothing when rate-limited
    throw err;
  }
}
