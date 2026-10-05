#!/usr/bin/env node
/**
 * The app server: a local web UI with one toggle per firmware option, a flash
 * budget, builds and flashing. Zero dependencies — a node:http server driving
 * the same `buildFirmware()` the CLI uses.
 *
 * The desktop (Electron) app runs it in-process on a free port. `npm run app`
 * runs it standalone for a browser: on Windows it builds natively when Git for
 * Windows and GNU make are present, and otherwise hands itself off to WSL
 * (which forwards localhost, so the Windows browser still reaches it).
 */

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, type WriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { detectBuildEnv, installBuildTools, type BuildEnv } from "../buildenv.ts";
import {
  buildFirmware,
  ensureSource,
  ensureToolchain,
  isBuildToolError,
  KNOWN_UNIFIED_TARGETS,
  guardMap,
  previewSelection,
  probeOptions,
  selectionOptions,
  TargetPreprocessor,
  validTargetsFromSource,
  type ProbeResult,
  type Selection,
} from "../index.ts";
import { boardConfig, boardTarget, listBoards } from "../boards.ts";
import { cacheRoot, DEFAULT_OUTPUT_DIR } from "../config.ts";
import { exec } from "../exec.ts";
import { insertConfig, parseHex, prepareBoardConfig } from "../hex.ts";
import { annotateOptions, loadOptionInfo } from "../option-info.ts";
import { sweepProbeTemp } from "../probe.ts";
import { listReleases, nearestRelease, releaseHexSize, treeVersion, type ReleaseSize } from "../releases.ts";
import { buildSizeModel, estimateRemoval, type MemoryRegion, type SizeModel } from "../size.ts";
import { cachedSourcePath } from "../source.ts";
import { listDirs, normalisePath } from "./dirs.ts";
import { renderMarkdown } from "./markdown.ts";
import { needsMirror, syncMirror } from "./mirror.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const PAGE = join(ROOT, "app", "index.html");
const OPTION_INFO = join(ROOT, "data", "option-info.json");
const MANUAL = join(ROOT, "docs", "Rotorflight-firmware-build-manual.md");
/** The app's version, from package.json (the same one the installers are named after). */
const VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: string }).version ?? "";
  } catch {
    return "";
  }
})();

interface Session {
  ref: string;
  commit: string;
  sourceDir: string;
  /** True when building a local tree as-is (no checkout). */
  local: boolean;
  /** The user's own folder when sourceDir is a WSL mirror of it. */
  origin?: string;
  /** Source files changed in the folder since it was probed (re-probe to pick up new guards). */
  staleFiles?: string[];
  target: string;
  makeVars: Record<string, string>;
  pp: TargetPreprocessor;
  probe: ProbeResult;
  binDir: string;
  sizes: SizeInfo;
  /** Removal-estimate model from the baseline ELF (server-side only). */
  model?: SizeModel;
}

interface BaselineRecord {
  /** text + data, as arm-none-eabi-size reports it. */
  flash: number;
  /** data + bss (unknown for an official release: it publishes no ELF). */
  ram?: number;
  /**
   * "build" = measured locally; "official" = this exact release's published hex;
   * "nearest" = a local tree approximated by the nearest release's hex.
   */
  source?: "build" | "official" | "nearest" | "previous";
  /** For a "previous" baseline: the commit it was built at. */
  commit?: string;
  /** For an official baseline: the release tag and asset it came from. */
  tag?: string;
  asset?: string;
  memory?: MemoryRegion[];
  elfPath?: string;
  at: string;
}

interface SizeInfo {
  /** TARGET_FLASH_SIZE in KB. */
  flashKb?: number;
  baseline?: BaselineRecord;
  /** Share of baseline flash the estimator could locate in the source. */
  located?: number;
  /** Size of the official release build, from the hex published on GitHub. */
  official?: ReleaseSize;
  /** For a local tree not at a release tag: the nearest earlier release, for reference. */
  nearest?: ReleaseSize;
  /** A local tree at a release tag but with uncommitted edits. */
  modifiedFromTag?: boolean;
  /** Firmware/RAM region sizes for this target from any earlier local build (capacity only). */
  capacity?: MemoryRegion[];
}

/** The most recent baseline build of the same folder, target and make vars, at any commit. */
function latestBaselineOfTree(
  records: Record<string, BaselineRecord>,
  s: Pick<Session, "commit" | "target" | "makeVars" | "local" | "sourceDir">,
): [BaselineRecord, string] | [] {
  const [, target, vars, dir] = baselineKey(s).split("|");
  const hits = Object.entries(records)
    .filter(([k, r]) => {
      const p = k.split("|");
      return p[1] === target && p[2] === vars && p[3] === dir && !!r.elfPath && existsSync(r.elfPath);
    })
    .sort(([, a], [, b]) => b.at.localeCompare(a.at));
  return hits[0] ? [hits[0][1], hits[0][0]] : [];
}

/** Official size as a baseline, comparable with builds that do or don't carry the erase marker. */
function officialBaseline(o: ReleaseSize, makeVars: Record<string, string>): BaselineRecord {
  const withMarker = makeVars.FLASH_CONFIG_ERASE === "yes";
  return {
    flash: withMarker ? o.flash : o.flash - o.marker,
    source: "official",
    tag: o.tag,
    asset: o.asset,
    at: new Date().toISOString(),
  };
}

/** git in a tree, best effort ("" on failure). Reads refs only, so it is quick even via a mirror. */
async function git(dir: string, args: string[]): Promise<string> {
  try {
    const r = await exec("git", ["-C", dir, ...args], { allowNonZero: true });
    return r.code === 0 ? r.stdout.trim() : "";
  } catch {
    return "";
  }
}

/** Baselines survive restarts, keyed by what produced them. */
const SIZES_FILE = () => join(cacheRoot(), "baselines.json");
const baselineKey = (s: Pick<Session, "commit" | "target" | "makeVars" | "local" | "sourceDir">) =>
  [s.commit, s.target, JSON.stringify(Object.entries(s.makeVars).sort()), s.local ? s.sourceDir : ""].join("|");

async function readBaselines(): Promise<Record<string, BaselineRecord>> {
  try {
    return JSON.parse(await readFile(SIZES_FILE(), "utf8")) as Record<string, BaselineRecord>;
  } catch {
    return {};
  }
}

async function saveBaseline(s: Session, rec: BaselineRecord) {
  const all = await readBaselines();
  all[baselineKey(s)] = rec;
  await mkdir(cacheRoot(), { recursive: true });
  await writeFile(SIZES_FILE(), JSON.stringify(all, null, 2));
}

async function attachModel(s: Session) {
  const elf = s.sizes.baseline?.elfPath;
  if (!elf || !existsSync(elf)) return;
  s.model = await buildSizeModel(s.sourceDir, elf, join(s.binDir, process.platform === "win32" ? "arm-none-eabi-nm.exe" : "arm-none-eabi-nm"));
  s.sizes.located = s.model.locatedFlash / s.model.flash;
}

interface HistoryEntry {
  at: string;
  target: string;
  commit: string;
  options: string[];
  ok: boolean;
  error?: string;
  flash?: number;
  text?: number;
  data?: number;
  bss?: number;
  hexPath?: string;
  durationMs: number;
  /** Make variables the build used (e.g. FLASH_CONFIG_ERASE). */
  makeVars?: Record<string, string>;
  /** Where the source came from, for the flash confirmation. */
  source?: string;
  /** User-given name, e.g. "OMP M4" or "x feature test". */
  name?: string;
}

let session: Session | undefined;
let busy: string | undefined;
/** Builds survive restarts (the .hex files are kept in output/ anyway). */
const HISTORY_FILE = () => join(cacheRoot(), "history.json");
const history: HistoryEntry[] = (() => {
  try {
    return JSON.parse(readFileSync(HISTORY_FILE(), "utf8")) as HistoryEntry[];
  } catch {
    return [];
  }
})();
function saveHistory() {
  mkdir(cacheRoot(), { recursive: true })
    .then(() => writeFile(HISTORY_FILE(), JSON.stringify(history.slice(-200), null, 1)))
    .catch(() => {});
}
const clients = new Set<ServerResponse>();

function emit(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(payload);
}

/** Recent log lines, replayed to a page opened mid-job. */
const logTail: { line: string; stream: string }[] = [];
const log = (line: string, stream = "info") => {
  logTail.push({ line, stream });
  if (logTail.length > 400) logTail.splice(0, logTail.length - 400);
  emit("log", { line, stream });
  logFile?.write(`${new Date().toISOString()} ${stream === "info" ? "" : `[${stream}] `}${line}\n`);
};

/**
 * The log, also kept on disk (cacheRoot()/app.log, previous run's in app.log.1)
 * so that what happened survives a restart — e.g. a setup that seemed stuck.
 */
export const LOG_FILE = () => join(cacheRoot(), "app.log");
let logFile: WriteStream | undefined;
function openLogFile() {
  try {
    mkdirSync(cacheRoot(), { recursive: true });
    const file = LOG_FILE();
    if (existsSync(file) && statSync(file).size > 2 * 1024 * 1024) renameSync(file, `${file}.1`);
    logFile = createWriteStream(file, { flags: "a" });
    logFile.on("error", () => { logFile = undefined; });
    logFile.write(`\n${new Date().toISOString()} ---- Rotorflight Firmware Builder ${VERSION} started (${process.platform}) ----\n`);
  } catch {
    logFile = undefined; // logging to disk is a convenience, never a reason to fail
  }
}

/** What the running job is doing, for the page's progress banner. */
interface JobState {
  name: string;
  title: string;
  step: string;
  done?: number;
  total?: number;
  started: number;
}
let job: JobState | null = null;
let lastJobEmit = 0;
function step(text: string, done?: number, total?: number) {
  if (!job) return;
  const changed = job.step !== text;
  job = { ...job, step: text, ...(done !== undefined ? { done, total } : { done: undefined, total: undefined }) };
  // Throttle counter updates; always send step changes.
  if (changed || Date.now() - lastJobEmit > 250) {
    lastJobEmit = Date.now();
    emit("job", job);
  }
}
/** Files compiled per (tree, target) last time, to turn the compile count into a percentage. */
const compileTotals = new Map<string, number>();

/** Run one long job at a time, reporting its outcome over SSE. */
function startJob(name: string, title: string, run: () => Promise<void>): boolean {
  if (busy) return false;
  busy = name;
  job = { name, title, step: "Starting…", started: Date.now() };
  emit("busy", { busy });
  emit("job", job);
  run()
    .catch((err) => {
      const message = isBuildToolError(err) ? `[${err.code}] ${err.message}` : String(err);
      log(message, "error");
      if (isBuildToolError(err) && err.detail) {
        for (const l of err.detail.split("\n").slice(-40)) log(l, "stderr");
      }
      emit("job-error", { job: name, message });
    })
    .finally(() => {
      busy = undefined;
      job = null;
      emit("busy", { busy: null });
      emit("job", null);
    });
  return true;
}

interface LoadRequest {
  target: string;
  ref: string;
  sourceDir?: string;
  configErase?: boolean;
}

async function load(req: LoadRequest) {
  const onEvent = (e: { stream: string; line: string }) => log(e.line, e.stream);
  log(`Resolving source ${req.sourceDir ? `${req.sourceDir} (as-is)` : req.ref}…`);
  let buildDir = req.sourceDir || undefined;
  let origin: string | undefined;
  if (buildDir && needsMirror(buildDir)) {
    step("Copying the local tree into WSL (first time: a minute or two)");
    const m = await syncMirror(buildDir);
    log(`Mirrored ${buildDir} to ${m.dir}${m.firstSync ? "" : ` (${m.changed.length} source file(s) changed)`}.`);
    origin = buildDir;
    buildDir = m.dir;
  } else {
    step(req.sourceDir ? "Reading the local tree" : "Fetching source from GitHub (first time: about a minute)");
  }
  const source = await ensureSource({
    ref: req.ref,
    sourceDir: buildDir,
    asIs: Boolean(req.sourceDir),
    onEvent,
  });

  const targets = await validTargetsFromSource(source.dir);
  if (!targets.includes(req.target)) throw new Error(`Unknown target ${req.target}`);

  log("Checking toolchain…");
  step("Checking toolchain (first time: downloads about 180 MB)");
  const toolchain = await ensureToolchain(source.dir, onEvent, { borrow: Boolean(req.sourceDir) });
  if (toolchain.borrowed) log(`Using the cached ${toolchain.version} toolchain at ${toolchain.binDir} (this tree's own tools/ does not run here).`);

  const makeVars: Record<string, string> = req.configErase ? { FLASH_CONFIG_ERASE: "yes" } : {};
  log(`Probing ${req.target} options with arm-none-eabi-gcc ${toolchain.version} -E…`);
  const ctx = { sourceDir: source.dir, target: req.target, binDir: toolchain.binDir, extraMakeVars: makeVars };
  // One preprocessor serves the probe and then the session's previews.
  const pp = await TargetPreprocessor.create(ctx);
  let probe: ProbeResult;
  try {
    probe = await probeOptions(ctx, (done, total) => step("Probing options with the preprocessor", done, total), pp);
  } catch (err) {
    await pp.dispose();
    throw err;
  }
  log(`Probed ${probe.options.length} options in ${(probe.durationMs / 1000).toFixed(1)}s.`);

  await session?.pp.dispose();
  session = {
    ref: req.ref,
    commit: source.commit,
    sourceDir: source.dir,
    local: Boolean(req.sourceDir),
    ...(origin ? { origin } : {}),
    target: req.target,
    makeVars,
    pp,
    // Re-read each load so edits to the data file show up without a restart.
    probe: { ...probe, options: annotateOptions(await loadOptionInfo(OPTION_INFO), probe) },
    binDir: toolchain.binDir,
    sizes: probe.flashKb ? { flashKb: probe.flashKb } : {},
  };
  step("Reading the official release size");
  try {
    // A release source, or a local tree whose HEAD is exactly a release tag.
    let tag = session.local ? "" : req.ref;
    if (session.local) {
      tag = (await git(source.dir, ["tag", "--points-at", "HEAD"])).split("\n").find((t) => /^(release|snapshot)\//.test(t)) ?? "";
      if (tag) {
        session.sizes.modifiedFromTag = (await git(source.dir, ["diff", "--shortstat", "HEAD", "--", "src", "make", "Makefile"])) !== "";
      } else {
        const version = await treeVersion(source.dir);
        const near = version ? await nearestRelease(version) : undefined;
        const nearest = near ? await releaseHexSize(near, req.target) : null;
        if (nearest) session.sizes.nearest = nearest;
      }
    }
    const official = tag ? await releaseHexSize(tag, req.target) : null;
    if (official) {
      session.sizes.official = official;
      log(`Official ${official.asset}: ${official.flash.toLocaleString()} bytes of flash${session.local ? ` (this tree is at ${tag}${session.sizes.modifiedFromTag ? ", with local edits" : ""})` : ""}.`);
    }
  } catch (err) {
    log(`Official release size unavailable: ${err}`, "stderr");
  }
  const records = await readBaselines();
  const known = records[baselineKey(session)];
  // A local tree moves on with every commit: its last baseline build is a far
  // better reference than any release, and its ELF still drives the estimates.
  const [, prevKey] = session.local && !known ? latestBaselineOfTree(records, session) : [];
  if (known) {
    session.sizes.baseline = { ...known, source: "build" };
    await attachModel(session).catch((err) => log(`Size model unavailable: ${err}`, "stderr"));
  } else if (prevKey) {
    session.sizes.baseline = { ...records[prevKey]!, source: "previous", commit: prevKey.split("|")[0] };
    log(`Using this tree's last baseline build (commit ${prevKey.split("|")[0]!.slice(0, 9)}) until it is rebuilt at ${session.commit.slice(0, 9)}.`);
    await attachModel(session).catch((err) => log(`Size model unavailable: ${err}`, "stderr"));
  } else if (session.sizes.official) {
    session.sizes.baseline = officialBaseline(session.sizes.official, makeVars);
  } else if (session.sizes.nearest) {
    // Approximate until the tree's own baseline is built: good enough for the budget bar.
    session.sizes.baseline = { ...officialBaseline(session.sizes.nearest, makeVars), source: "nearest" };
  }
  // Region sizes are fixed per target: borrow them from any earlier build of it.
  const withRegions = Object.entries(records).find(([k, r]) => k.split("|")[1] === req.target && r.memory?.length);
  if (withRegions) session.sizes.capacity = withRegions[1].memory!.map((m) => ({ ...m, used: 0 }));
  emit("session", publicSession());
}

/** `at` identifies the build: its history entry and output folder carry it. */
async function build(sel: Selection, at: string, name?: string) {
  const s = session!;
  const options = selectionOptions(sel, guardMap(s.probe));
  if (s.origin) {
    // Pick up edits made in the user's own folder since the last build.
    step("Syncing changes from your folder");
    const m = await syncMirror(s.origin);
    if (m.changed.length) {
      log(`Synced ${m.changed.length} changed file(s) from ${s.origin}: ${m.changed.slice(0, 8).join(", ")}${m.changed.length > 8 ? " …" : ""}`);
      s.staleFiles = [...new Set([...(s.staleFiles ?? []), ...m.changed])];
      emit("session", publicSession());
    }
  }
  log(`Building ${s.target} with OPTIONS="${options.join(" ")}"…`);
  const totalKey = `${s.sourceDir}|${s.target}`;
  let compiled = 0;
  try {
    const r = await buildFirmware({
      target: s.target,
      ref: s.ref,
      sourceDir: s.sourceDir,
      sourceAsIs: true,
      extraOptions: options,
      extraMakeVars: s.makeVars,
      outputDir: join(DEFAULT_OUTPUT_DIR, `${s.target}-${at.replace(/[:.]/g, "-")}`),
      onEvent: (e) => {
        log(e.line, e.stream);
        // The firmware Makefile prints "%% file.c" per compiled file.
        if (e.line.startsWith("%% ")) {
          compiled++;
          step("Compiling", compiled, compileTotals.get(totalKey));
        } else if (/^Linking /.test(e.line)) step("Linking");
      },
      onStage: (stage) => {
        log(`[${stage}]`);
        const label: Record<string, string> = {
          "resolving-source": "Preparing source",
          "installing-toolchain": "Checking toolchain",
          "compiling": "Compiling",
          "collecting-artifacts": "Collecting artifacts",
        };
        step(label[stage] ?? stage);
      },
    });
    if (compiled > 50) compileTotals.set(totalKey, compiled);
    history.push({
      at,
      target: s.target,
      commit: r.commit,
      options,
      ok: true,
      makeVars: s.makeVars,
      ...(name ? { name } : {}),
      source: s.local ? s.origin ?? s.sourceDir : s.ref,
      ...r.size,
      hexPath: r.hexPath,
      durationMs: r.durationMs,
    });
    if (!options.length && r.size) {
      const rec: BaselineRecord = {
        flash: r.size.flash,
        ram: r.size.data + r.size.bss,
        source: "build",
        ...(r.memory ? { memory: r.memory } : {}),
        ...(r.elfPath ? { elfPath: r.elfPath } : {}),
        at,
      };
      s.sizes.baseline = rec;
      await saveBaseline(s, rec);
      await attachModel(s).catch((err) => log(`Size model unavailable: ${err}`, "stderr"));
      emit("session", publicSession());
    }
  } catch (err) {
    history.push({
      at,
      target: s.target,
      commit: s.commit,
      options,
      ok: false,
      ...(name ? { name } : {}),
      error: isBuildToolError(err) ? err.message : String(err),
      durationMs: Date.now() - Date.parse(at),
    });
    throw err;
  } finally {
    saveHistory();
    emit("history", history);
  }
}

function publicSession() {
  if (!session) return null;
  const { pp: _pp, model: _model, ...rest } = session;
  return rest;
}

function validSelection(body: unknown): Selection | undefined {
  const b = body as Partial<Selection> | null;
  const ok = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string" && /^USE_[A-Z0-9_]+$/.test(x));
  if (!b || !ok(b.add) || !ok(b.remove) || !session) return undefined;
  const byName = new Map(session.probe.options.map((o) => [o.name, o.state]));
  if (!b.add.every((n) => byName.get(n) === "off-addable")) return undefined;
  if (!b.remove.every((n) => byName.get(n) === "on-removable")) return undefined;
  return { add: b.add, remove: b.remove };
}

/** A request the client got wrong: answered with 400 rather than 500. */
class BadRequest extends Error {}

const MAX_BODY = 1024 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new BadRequest("request body too large");
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new BadRequest("request body is not valid JSON");
  }
}

/**
 * Only this machine's own page may use the API. Without these checks any
 * website open in the browser could drive it: a cross-site form-style POST
 * (text/plain) needs no CORS preflight, and DNS rebinding lets a foreign
 * hostname resolve to 127.0.0.1 and read the replies.
 * - Host must be a loopback name, so a rebound hostname is refused.
 * - A POST must be JSON, which a cross-site page cannot send without a
 *   preflight this server never approves, and any Origin must be our own.
 */
function refuseForeign(req: IncomingMessage): string | undefined {
  const port = req.socket.localPort;
  const local = ["localhost", "127.0.0.1", "[::1]"].map((h) => `${h}:${port}`);
  if (!local.includes(req.headers.host ?? "")) return "unexpected Host header";
  if (req.method === "POST") {
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return "POST must be application/json";
    const origin = req.headers.origin;
    if (origin && !local.some((h) => origin === `http://${h}`)) return "cross-origin request";
  }
  return undefined;
}

/** Is `dir` inside the app's own output folder (and not the folder itself)? */
function insideOutputDir(dir: string): boolean {
  const rel = relative(DEFAULT_OUTPUT_DIR, dir);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = `${req.method} ${url.pathname}`;

  // The manual's pictures (docs/images/*.png); plain names only, so no path escapes.
  const manualImage = req.method === "GET" && url.pathname.match(/^\/docs\/images\/([a-z0-9-]+\.png)$/);
  if (manualImage) {
    const file = join(ROOT, "docs", "images", manualImage[1]!);
    if (!existsSync(file)) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
    res.end(await readFile(file));
    return;
  }

  switch (route) {
    case "GET /":
      // Never cache the app: a stale tab would run old flashing code.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(await readFile(PAGE));
      return;

    case "GET /assets/rotorflight-logo.svg":
    case "GET /assets/rotorflight-logo-compact.svg":
      // The Rotorflight logo, from the Configurator (white + Rotorflight blue, for the dark header bar).
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=86400" });
      res.end(await readFile(join(ROOT, "app", url.pathname.slice(1))));
      return;

    case "GET /assets/fonts/open-sans-latin.woff2":
    case "GET /assets/fonts/jetbrains-mono-latin.woff2":
      // Bundled so the page never waits on Google Fonts (or fails offline).
      res.writeHead(200, { "content-type": "font/woff2", "cache-control": "max-age=31536000, immutable" });
      res.end(await readFile(join(ROOT, "app", url.pathname.slice(1))));
      return;

    case "GET /api/manual": {
      // The user manual, rendered for the in-app Manual window. It ships with the app.
      const md = await readFile(MANUAL, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderMarkdown(md, { imageBase: "/docs/" }));
      return;
    }

    case "GET /flasher.js":
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(await readFile(join(ROOT, "app", "flasher.js")));
      return;

    case "GET /api/events":
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;

    case "GET /api/state":
      return send(res, 200, {
        busy: busy ?? null,
        job,
        log: logTail,
        session: publicSession(),
        history,
        targets: KNOWN_UNIFIED_TARGETS,
        version: VERSION,
      });

    case "GET /api/targets": {
      // MCU targets for a ref, read from its checkout when one is already on disk.
      const ref = url.searchParams.get("ref") ?? "";
      const dir = url.searchParams.get("sourceDir") || (ref ? cachedSourcePath(ref) : "");
      const fromSource = Boolean(dir) && existsSync(join(dir, "src", "main", "target"));
      const targets = fromSource ? await validTargetsFromSource(dir) : [...KNOWN_UNIFIED_TARGETS];
      return send(res, 200, { targets, fromSource });
    }

    case "GET /api/env":
      // Which build environment this server uses, and what is missing.
      return send(res, 200, publicEnv(buildEnv ?? (await detectBuildEnv())));

    case "POST /api/env/install": {
      // "Load build environment": install the missing tools with winget, then re-check.
      const env = buildEnv ?? (await detectBuildEnv());
      if (!env.canInstall) return send(res, 400, { error: env.ok ? "Nothing to install." : "winget is not available to install the tools." });
      const started = startJob("setup", "Loading build environment", async () => {
        step(`Installing ${env.installable!.map((p) => p.name).join(" and ")}`);
        // winget's live download/progress text goes to the banner, its messages to the log.
        await installBuildTools(env.installable!, (line, stream) => log(line, stream), (text) => step(text));
        step("Checking the build tools");
        buildEnv = await detectBuildEnv(true);
        if (buildEnv.ok) {
          process.env.PATH = buildEnv.path;
          log("Build environment ready.");
        } else {
          for (const p of buildEnv.problems) log(p, "error");
        }
        emit("env", publicEnv(buildEnv));
      });
      return send(res, started ? 202 : 409, started ? { ok: true } : { error: `busy: ${busy}` });
    }

    case "GET /api/releases":
      return send(res, 200, { releases: await listReleases() });

    case "GET /api/release-size": {
      const tag = url.searchParams.get("tag") ?? "";
      const target = url.searchParams.get("target") ?? "";
      if (!tag || !/^[A-Z0-9_]+$/.test(target)) return send(res, 400, { error: "tag and target required" });
      return send(res, 200, { size: await releaseHexSize(tag, target) });
    }

    case "GET /api/dirs":
      return send(res, 200, await listDirs(url.searchParams.get("path") ?? ""));

    case "GET /api/flash-image": {
      // The exact bytes to flash: the build's hex with the board config inserted,
      // as the Configurator would do it.
      const i = Number(url.searchParams.get("i"));
      const entry = history[i];
      if (!entry?.ok || !entry.hexPath || !existsSync(entry.hexPath)) return send(res, 404, { error: "no such build" });
      const image = parseHex(await readFile(entry.hexPath, "utf8"));
      const key = url.searchParams.get("board") ?? "";
      let configInserted = false;
      if (key) {
        const cfg = await boardConfig(key);
        if (!cfg) return send(res, 400, { error: `Unknown board ${key}.` });
        if (cfg.target && cfg.target !== entry.target) {
          return send(res, 409, { error: `${key} is an ${cfg.target} board, but this build is for ${entry.target}. Refusing to flash.` });
        }
        const text = prepareBoardConfig(cfg.raw, {
          fileName: cfg.board.path.split("/").pop()!,
          boardKey: key,
          manufacturer: cfg.board.manufacturer,
          commitHash: cfg.commitHash,
          date: cfg.date,
        });
        configInserted = insertConfig(image, text);
      }
      return send(res, 200, {
        index: i,
        target: entry.target,
        board: key || null,
        configInserted,
        options: entry.options,
        name: entry.name ?? null,
        makeVars: entry.makeVars ?? {},
        source: entry.source ?? "",
        bytesTotal: image.bytesTotal,
        blocks: image.blocks.map((b) => ({ address: b.address, data: Buffer.from(b.data).toString("base64") })),
      });
    }

    case "GET /api/hex": {
      // Download a built .hex by its history index, to load into the Configurator.
      const entry = history[Number(url.searchParams.get("i"))];
      if (!entry?.ok || !entry.hexPath || !existsSync(entry.hexPath)) return send(res, 404, { error: "no such build" });
      const suffix = entry.name
        ? `_${fileSafe(entry.name)}`
        : entry.options.length
          ? `_custom-${entry.at.slice(0, 19).replace(/[-:T]/g, "")}`
          : "_baseline";
      const name = basename(entry.hexPath).replace(/\.hex$/, `${suffix}.hex`);
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${name}"`,
      });
      res.end(await readFile(entry.hexPath));
      return;
    }

    case "GET /api/option-info": {
      const { levels, features } = await loadOptionInfo(OPTION_INFO);
      return send(res, 200, { levels, features });
    }

    case "GET /api/boards":
      return send(res, 200, { boards: await listBoards() });

    case "GET /api/board-target": {
      const key = url.searchParams.get("key") ?? "";
      return send(res, 200, { key, target: (await boardTarget(key)) ?? null });
    }

    case "POST /api/load": {
      const body = (await readJson(req)) as Partial<LoadRequest>;
      if (typeof body.target !== "string" || typeof body.ref !== "string" || !body.ref.trim()) {
        return send(res, 400, { error: "target and ref are required" });
      }
      const what = typeof body.sourceDir === "string" && body.sourceDir.trim() ? body.sourceDir.trim() : body.ref!.trim();
      const started = startJob("load", `Loading ${what} for ${body.target}`, () =>
        load({
          target: body.target!,
          ref: body.ref!.trim(),
          sourceDir: typeof body.sourceDir === "string" && body.sourceDir.trim() ? normalisePath(body.sourceDir) : undefined,
          configErase: Boolean(body.configErase),
        }),
      );
      return send(res, started ? 202 : 409, started ? { ok: true } : { error: `busy: ${busy}` });
    }

    case "POST /api/preview": {
      const sel = validSelection(await readJson(req));
      if (!sel) return send(res, 400, { error: "invalid selection for the loaded target" });
      const preview = await previewSelection(session!.pp, session!.probe.baseline, sel, guardMap(session!.probe));
      const estimate = session!.model ? estimateRemoval(session!.model, preview.removed) : undefined;
      return send(res, 200, { ...preview, ...(estimate ? { estimate } : {}) });
    }

    case "POST /api/rename-build": {
      const body = (await readJson(req)) as { at?: string; name?: unknown };
      const entry = history.find((h) => h.at === body.at);
      if (!entry) return send(res, 404, { error: "no such build" });
      const name = cleanName(body.name);
      if (name) entry.name = name;
      else delete entry.name;
      saveHistory();
      emit("history", history);
      return send(res, 200, { ok: true, name: name ?? null });
    }

    case "POST /api/delete-build": {
      // Identified by timestamp, not index: indices shift as builds come and go.
      const { at } = (await readJson(req)) as { at?: string };
      const i = history.findIndex((h) => h.at === at);
      if (i < 0) return send(res, 404, { error: "no such build" });
      // (A running build is not in the history until it finishes, so it cannot be picked here.)
      const [entry] = history.splice(i, 1);
      const removed: string[] = [];
      // Only ever delete the app's own output folder for this build.
      const dir = entry!.hexPath ? dirname(entry!.hexPath) : "";
      if (dir && insideOutputDir(dir) && existsSync(dir)) {
        await rm(dir, { recursive: true, force: true });
        removed.push(dir);
      }
      // A deleted baseline build takes its ELF with it: forget the measured baseline.
      const inDir = (p?: string) => !!p && !!dir && dirname(p) === dir;
      const records = await readBaselines();
      const stale = Object.keys(records).filter((k) => inDir(records[k]!.elfPath));
      if (stale.length) {
        for (const k of stale) delete records[k];
        await writeFile(SIZES_FILE(), JSON.stringify(records, null, 2));
        if (session && inDir(session.sizes.baseline?.elfPath)) {
          session.model = undefined;
          session.sizes.located = undefined;
          session.sizes.baseline = session.sizes.official
            ? officialBaseline(session.sizes.official, session.makeVars)
            : session.sizes.nearest
              ? { ...officialBaseline(session.sizes.nearest, session.makeVars), source: "nearest" }
              : undefined;
          emit("session", publicSession());
        }
      }
      log(`Deleted build ${entry!.options.join(" ") || "baseline"} (${entry!.target})${removed.length ? `, removed ${removed[0]}` : ""}.`);
      saveHistory();
      emit("history", history);
      return send(res, 200, { ok: true, baselineForgotten: stale.length > 0 });
    }

    case "POST /api/build": {
      const body = await readJson(req);
      const sel = validSelection(body);
      if (!sel) return send(res, 400, { error: "invalid selection for the loaded target" });
      const name = cleanName((body as { name?: unknown }).name);
      const n = sel.add.length + sel.remove.length;
      const what = name ? `"${name}"` : `${session!.target}${n ? ` with ${n} change${n > 1 ? "s" : ""}` : " baseline"}`;
      // Returned so the page can follow this exact build (e.g. to flash it when done).
      const at = new Date().toISOString();
      const started = startJob("build", `Building ${what}`, () => build(sel, at, name));
      return send(res, started ? 202 : 409, started ? { ok: true, at } : { error: `busy: ${busy}` });
    }
  }
  send(res, 404, { error: "not found" });
}

/** The build environment found at start-up (make, git, shell), reported to the page. */
let buildEnv: BuildEnv | undefined;

export interface StartedServer {
  port: number;
  url: string;
  close(): void;
}

/**
 * Start the app server: used by `npm run app` and, in-process, by the desktop
 * (Electron) app. Port 0 picks any free port.
 */
export async function startServer(opts: { port?: number; host?: string } = {}): Promise<StartedServer> {
  buildEnv = await detectBuildEnv();
  // Every build process (make, git, sh, gcc) inherits this PATH.
  if (buildEnv.ok) process.env.PATH = buildEnv.path;
  for (const p of buildEnv.problems) process.stderr.write(`Build environment: ${p}\n`);
  // Preprocessor scratch folders left behind by earlier runs.
  sweepProbeTemp().catch(() => {});
  openLogFile();
  for (const p of buildEnv.problems) log(`Build environment: ${p}`, "stderr");

  const host = opts.host ?? "127.0.0.1";
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      const refused = refuseForeign(req);
      if (refused) return send(res, 403, { error: `Forbidden: ${refused}.` });
      handle(req, res).catch((err) => {
        if (res.headersSent) res.end();
        else send(res, err instanceof BadRequest ? 400 : 500, { error: err instanceof BadRequest ? err.message : String(err) });
      });
    });
    server.once("error", reject);
    server.listen(opts.port ?? 4780, host, () => {
      const port = (server.address() as AddressInfo).port;
      const close = () => {
        server.close();
        session?.pp.dispose().catch(() => {});
      };
      resolvePromise({ port, url: `http://localhost:${port}`, close });
    });
  });
}

/** A build name: trimmed, single-line, at most 60 characters; empty means none. */
function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.replace(/[\r\n\t]+/g, " ").trim().slice(0, 60);
  return v || undefined;
}

/** For file names: "OMP M4 / test" -> "OMP-M4-test". */
function fileSafe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "build";
}

/** What the page is told about the build environment (no PATH). */
function publicEnv(env: BuildEnv) {
  const { path: _path, ...rest } = env;
  return { platform: process.platform, ...rest };
}

/** Command-line entry: `npm run app` / `node dist/app/server.js [--port n] [--host h]`. */
async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      port: { type: "string", default: "4780" },
      host: { type: "string", default: "127.0.0.1" },
    },
  });
  const port = Number(values.port);
  const host = values.host!;

  // Windows: build natively when Git for Windows and GNU make are present;
  // otherwise fall back to WSL, which is how this app first ran.
  if (process.platform === "win32" && !process.env.RFB_NO_WSL) {
    const env = await detectBuildEnv();
    if (!env.ok) {
      process.stdout.write(`Native Windows build tools are incomplete:\n${env.problems.map((p) => `  - ${p}`).join("\n")}\n`);
      return relaunchInWsl(port, host);
    }
    process.stdout.write("Windows: building natively with Git for Windows + GNU make.\n");
  }
  try {
    const s = await startServer({ port, host });
    process.stdout.write(`Rotorflight Firmware Builder: ${s.url}\n`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    process.stderr.write(
      `Port ${port} is already in use — the app is probably already running.\n` +
        `Open http://localhost:${port}, or start another with --port <n>.\n`,
    );
    process.exit(1);
  }
}

const isMain = !!process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

/**
 * Without native tools on Windows, hand off to WSL (whose localhost is
 * forwarded to the Windows browser). WSL's Node 22 does not strip TypeScript,
 * so the compiled dist/ copy is what runs there.
 */
function relaunchInWsl(port: number, host: string) {
  const wslRoot = spawnSync("wsl", ["-e", "wslpath", "-a", ROOT.replace(/\\/g, "/")], {
    encoding: "utf8",
  });
  if (wslRoot.status !== 0) {
    process.stderr.write(
      "No native build tools and no WSL either. Install Git for Windows and GNU make\n" +
        "(winget install Git.Git, winget install ezwinports.make), or set up WSL.\n",
    );
    process.exit(1);
  }
  const dir = wslRoot.stdout.trim();
  const script = `cd ${shQuote(dir)} && exec node dist/app/server.js --port ${port} --host ${shQuote(host)}`;
  process.stdout.write("Starting the app inside WSL instead…\n");
  const child = spawn("wsl", ["-e", "bash", "-lc", script], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
