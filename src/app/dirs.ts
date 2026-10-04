import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A small server-side folder browser for "Open directory". The browser's own
 * directory picker only hands the page a handle, not a path the build (running
 * in WSL) can use, so the page browses through the server instead.
 */

export interface DirEntry {
  name: string;
  path: string;
  isFirmware: boolean;
}

export interface DirListing {
  path: string;
  parent: string | null;
  isFirmware: boolean;
  dirs: DirEntry[];
  /** Handy starting points. */
  roots: string[];
  error?: string;
}

/** Looks like a Rotorflight firmware checkout. */
export function isFirmwareTree(dir: string): boolean {
  return (
    existsSync(join(dir, "Makefile")) &&
    existsSync(join(dir, "make", "tools.mk")) &&
    existsSync(join(dir, "src", "main", "target"))
  );
}

/** Accept Windows paths when running under WSL: C:\Projects\x -> /mnt/c/Projects/x. */
export function normalisePath(input: string): string {
  const p = input.trim().replace(/^"|"$/g, "");
  const win = p.match(/^([A-Za-z]):[\\/]?(.*)$/);
  if (win && process.platform !== "win32") {
    return `/mnt/${win[1]!.toLowerCase()}/${win[2]!.replace(/\\/g, "/")}`.replace(/\/+$/, "") || "/";
  }
  return p;
}

function defaultStart(): string {
  for (const p of ["/mnt/c/Projects/Rotorflight", "/mnt/c/Projects", homedir()]) if (existsSync(p)) return p;
  return homedir();
}

export async function listDirs(input: string): Promise<DirListing> {
  const path = input ? normalisePath(input) : defaultStart();
  const roots = [homedir(), "/mnt/c/Projects", "/mnt/c"].filter((r) => existsSync(r));
  const parent = dirname(path) === path ? null : dirname(path);
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !/^\$|^System Volume/.test(e.name))
      .map((e) => ({ name: e.name, path: join(path, e.name), isFirmware: isFirmwareTree(join(path, e.name)) }))
      .sort((a, b) => Number(b.isFirmware) - Number(a.isFirmware) || a.name.localeCompare(b.name));
    return { path, parent, isFirmware: isFirmwareTree(path), dirs, roots };
  } catch (err) {
    return { path, parent, isFirmware: false, dirs: [], roots, error: (err as Error).message };
  }
}
