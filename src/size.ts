import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { execCapture } from "./exec.ts";

/**
 * Flash/RAM accounting for the sample app.
 *
 * - Capacity and usage come from the linker itself: the firmware links with
 *   `--print-memory-usage`, so every build log carries a per-region table.
 * - Removal estimates come from the baseline ELF. The firmware is built with
 *   LTO, so the link map cannot tie code to source files; instead `nm -S` gives
 *   every function and variable with its size under its source name, each name
 *   is located in the source, and its size is charged to the `#if USE_X` blocks
 *   around its definition. Removing X then saves (at least) what those blocks
 *   hold. It is a lower bound: entries inside a shared table, and code that only
 *   becomes unreferenced once X is gone, are not counted.
 */

export interface MemoryRegion {
  name: string;
  used: number;
  size: number;
}

/** Parse ld's `--print-memory-usage` table out of build output. */
export function parseMemoryUsage(output: string): MemoryRegion[] {
  const unit: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
  const out: MemoryRegion[] = [];
  const re = /^\s*([A-Za-z0-9_]+):\s+(\d+)\s*(B|KB|MB|GB)\s+(\d+)\s*(B|KB|MB|GB)\s+[\d.]+%/gm;
  for (const m of output.matchAll(re)) {
    out.push({ name: m[1]!, used: Number(m[2]) * unit[m[3]!]!, size: Number(m[4]) * unit[m[5]!]! });
  }
  return out;
}

/** Regions that hold firmware code (not config, board defaults or system memory). */
export function isFirmwareFlash(r: MemoryRegion): boolean {
  // F7 maps the same flash twice (AXIM_FLASH* and ITCM_FLASH*); count it once.
  return /FLASH/.test(r.name) && !/CONFIG|CUSTOM_DEFAULTS|SYSTEM|^ITCM_/.test(r.name) && r.size > 0;
}

export function isRam(r: MemoryRegion): boolean {
  return /RAM|CCM|DTCM/.test(r.name) && !/FLASH/.test(r.name) && r.size > 0;
}

/** `all`: every token must survive (&& or a single test). `any`: one surviving token keeps it (||). */
export interface Condition {
  mode: "all" | "any";
  tokens: string[];
}

export interface SizedSymbol {
  name: string;
  /** Bytes of flash (code, constants, initial data values). */
  flash: number;
  /** Bytes of RAM (initialised + zeroed data). */
  ram: number;
  /** Indices into SizeModel.conditions of every #if block enclosing the definition. */
  conds: number[];
}

export interface SizeModel {
  conditions: Condition[];
  /** Only symbols inside at least one USE_ block. */
  symbols: SizedSymbol[];
  /** Totals over every sized symbol, and how much of it was located in the source. */
  flash: number;
  ram: number;
  locatedFlash: number;
}

interface Block {
  start: number;
  end: number;
  cond: number;
}

/** `#if`/`#ifdef` blocks with positive USE_ tests, by line range (the #else part excluded). */
function conditionBlocks(lines: string[], intern: (c: Condition) => number): Block[] {
  const blocks: Block[] = [];
  const stack: { start: number; cond: number | null }[] = [];
  const close = (line: number) => {
    const top = stack.at(-1);
    if (top && top.cond !== null) blocks.push({ start: top.start, end: line, cond: top.cond });
  };
  lines.forEach((raw, i) => {
    const d = raw.match(/^\s*#\s*(ifdef|ifndef|if|elif|else|endif)\b\s*(.*)$/);
    if (!d) return;
    const [, directive, rest] = d as unknown as [string, string, string];
    if (directive === "ifdef" || directive === "if") {
      const expr = directive === "ifdef" ? `defined(${rest.trim().split(/\s/)[0]})` : rest;
      stack.push({ start: i, cond: positiveCondition(expr, intern) });
    } else if (directive === "ifndef") {
      stack.push({ start: i, cond: null });
    } else if (directive === "elif" || directive === "else") {
      close(i);
      if (stack.length) stack[stack.length - 1] = { start: i, cond: null };
    } else if (directive === "endif") {
      close(i);
      stack.pop();
    }
  });
  return blocks;
}

function positiveCondition(expr: string, intern: (c: Condition) => number): number | null {
  const e = expr.replace(/\/\/.*$|\/\*.*?\*\//g, "").trim();
  if (/!/.test(e)) return null; // negated tests guard the *absence* of a feature
  const tokens = [...new Set([...e.matchAll(/\bUSE_[A-Z0-9_]+\b/g)].map((m) => m[0]))];
  if (!tokens.length) return null;
  const hasOr = e.includes("||");
  if (hasOr && e.includes("&&")) return null; // mixed expressions: do not guess
  return intern({ mode: hasOr ? "any" : "all", tokens });
}

/**
 * Names defined at file scope on each line: `type name(` for functions,
 * `type name[`/`=`/`;` for data, plus the symbols PG_REGISTER macros generate.
 */
function definitionsOf(lines: string[]): Map<string, number> {
  const out = new Map<string, number>();
  lines.forEach((l, i) => {
    if (!l || /^\s/.test(l) || /^(#|\/\/|\/\*|\*|extern\b|typedef\b|}|{)/.test(l)) return;
    const pg = l.match(/^PG_REGISTER\w*\(\s*\w+\s*,\s*(\w+)/);
    if (pg) {
      for (const n of [`${pg[1]}_System`, `${pg[1]}_Copy`, `${pg[1]}_Registry`, `pgResetTemplate_${pg[1]}`]) out.set(n, i);
      return;
    }
    const fn = l.match(/(\w+)\s*\([^;]*$/);
    if (fn && !/^(if|for|while|switch|return|sizeof)$/.test(fn[1]!)) {
      out.set(fn[1]!, i);
      return;
    }
    const data = l.match(/(\w+)\s*(?:\[[^\]]*\])*\s*(?:=|;)/);
    if (data) out.set(data[1]!, i);
  });
  return out;
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".c")) yield p;
  }
}

/** Build the removal-estimate model from a baseline build's ELF. */
export async function buildSizeModel(sourceDir: string, elfPath: string, nmPath: string): Promise<SizeModel> {
  const conditions: Condition[] = [];
  const index = new Map<string, number>();
  const intern = (c: Condition) => {
    const key = `${c.mode}:${c.tokens.join(",")}`;
    let i = index.get(key);
    if (i === undefined) index.set(key, (i = conditions.push(c) - 1));
    return i;
  };

  // name -> enclosing USE_ conditions at each place it is defined.
  const defs = new Map<string, number[][]>();
  for await (const file of walk(join(sourceDir, "src", "main"))) {
    if (/\/target\/(?!STM32_UNIFIED\/)[^/]+\//.test(relative(sourceDir, file).replace(/\\/g, "/"))) continue;
    const lines = (await readFile(file, "utf8")).split("\n");
    const blocks = conditionBlocks(lines, intern);
    for (const [name, line] of definitionsOf(lines)) {
      const conds = blocks.filter((b) => b.start < line && line < b.end).map((b) => b.cond);
      defs.set(name, [...(defs.get(name) ?? []), conds]);
    }
  }

  const nm = await execCapture(nmPath, ["-S", "--defined-only", elfPath]);
  const symbols: SizedSymbol[] = [];
  let flash = 0;
  let ram = 0;
  let locatedFlash = 0;
  for (const line of nm.split("\n")) {
    const m = line.match(/^[0-9a-f]+ ([0-9a-f]+) ([A-Za-z]) (\S+)$/);
    if (!m) continue;
    const size = parseInt(m[1]!, 16);
    const type = m[2]!.toUpperCase();
    if (!size || !"TWRDBV".includes(type)) continue;
    const isFlash = "TWRDV".includes(type);
    const isRam = "DBV".includes(type);
    const sym = { name: m[3]!, flash: isFlash ? size : 0, ram: isRam ? size : 0 };
    flash += sym.flash;
    ram += sym.ram;
    // LTO/GCC suffixes: foo.lto_priv.0, foo.part.0, foo.constprop.0, foo.isra.0
    const found = defs.get(sym.name.split(".")[0]!);
    if (!found) continue;
    locatedFlash += sym.flash;
    // A name defined in several files (static helpers): only trust conditions they all share.
    const shared = found.reduce((acc, c) => acc.filter((x) => c.includes(x)));
    if (shared.length) symbols.push({ ...sym, conds: shared });
  }
  return { conditions, symbols, flash, ram, locatedFlash };
}

/** Estimated bytes saved by removing these defines (pass the cascade-expanded set). */
export function estimateRemoval(model: SizeModel, removed: Iterable<string>): { flash: number; ram: number } {
  const gone = new Set(removed);
  const dead = model.conditions.map((c) =>
    c.mode === "all" ? c.tokens.some((t) => gone.has(t)) : c.tokens.every((t) => gone.has(t)),
  );
  let flash = 0;
  let ram = 0;
  for (const s of model.symbols) {
    if (s.conds.some((c) => dead[c])) {
      flash += s.flash;
      ram += s.ram;
    }
  }
  return { flash, ram };
}
