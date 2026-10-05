import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { exec, execCapture } from "./exec.ts";

/**
 * The tools the firmware build needs, found on this machine.
 *
 * Linux/macOS: whatever is on PATH (make, sh, git, curl...).
 *
 * Windows, natively (no WSL): the firmware Makefile needs a Unix-style shell
 * and tools, and recognises Windows by `uname` reporting MSYS/MINGW. Rather
 * than bundling unsigned tools — antivirus quarantines rarely seen
 * executables like a bundled busybox or make — the app uses:
 *   - Git for Windows: its signed usr\bin (sh, sed, awk, grep, find, uname...)
 *     plus git itself;
 *   - GNU make installed from a mainstream source, e.g.
 *     `winget install ezwinports.make`;
 *   - the Windows ARM toolchain, installed by the Makefile (arm_sdk_install).
 * Git's tools go ahead of C:\Windows\System32 on PATH so its `find` and `sort`
 * win over the Windows commands of the same name.
 */

export interface BuildEnv {
  ok: boolean;
  /** "native" on Linux/macOS or Windows-with-tools; "missing" when something is absent. */
  mode: "native" | "missing";
  /** PATH to give every build process. */
  path: string;
  make?: string;
  git?: string;
  shell?: string;
  /** What is missing and how to fix it. */
  problems: string[];
  /** Missing tools winget could install (Windows only). */
  installable?: WingetPackage[];
  /** True when winget is present and something is missing. */
  canInstall?: boolean;
}

const MAKE_INSTALL = "winget install ezwinports.make";
const GIT_INSTALL = "winget install Git.Git";

let cached: BuildEnv | undefined;

export async function detectBuildEnv(force = false): Promise<BuildEnv> {
  if (cached && !force) return cached;
  cached = process.platform === "win32" ? await detectWindows() : await detectPosix();
  return cached;
}

async function detectPosix(): Promise<BuildEnv> {
  const path = process.env.PATH ?? "";
  const problems: string[] = [];
  const make = await which("make", path);
  const git = await which("git", path);
  if (!make) problems.push("GNU make was not found on PATH.");
  if (!git) problems.push("git was not found on PATH.");
  return { ok: problems.length === 0, mode: problems.length ? "missing" : "native", path, make, git, shell: "/bin/sh", problems };
}

async function detectWindows(): Promise<BuildEnv> {
  const problems: string[] = [];
  const sysRoot = process.env.SystemRoot ?? "C:\\Windows";
  const userPath = process.env.PATH ?? process.env.Path ?? "";

  // Git for Windows: from git on PATH (...\Git\cmd\git.exe), else the usual install folders.
  let gitRoot: string | undefined;
  const gitOnPath = await which("git", userPath);
  if (gitOnPath) {
    const root = dirname(dirname(gitOnPath)); // ...\Git\cmd\git.exe -> ...\Git
    if (existsSync(join(root, "usr", "bin", "sh.exe"))) gitRoot = root;
  }
  for (const c of [
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Git"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Git"),
    "C:\\Program Files\\Git",
  ]) {
    if (!gitRoot && c && existsSync(join(c, "usr", "bin", "sh.exe"))) gitRoot = c;
  }
  if (!gitRoot) problems.push(`Git for Windows was not found. Install it with: ${GIT_INSTALL}`);

  // GNU make: on PATH (winget adds a link), or winget's link folder.
  const wingetLinks = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links") : "";
  let make = (await which("make", userPath)) ?? (wingetLinks && existsSync(join(wingetLinks, "make.exe")) ? join(wingetLinks, "make.exe") : undefined);
  if (make && !/GNU Make [4-9]/.test(await version(make))) {
    problems.push(`${make} is not GNU Make 4 or newer. Install it with: ${MAKE_INSTALL}`);
    make = undefined;
  }
  // Developer switch to exercise the "Load build environment" prompt on a machine that has everything.
  const simulate = (process.env.RFB_SIMULATE_MISSING ?? "").split(",");
  if (simulate.includes("make")) make = undefined;
  if (simulate.includes("git")) gitRoot = undefined;
  if (simulate.includes("git") && !problems.some((p) => p.startsWith("Git for Windows"))) {
    problems.push(`Git for Windows was not found. Install it with: ${GIT_INSTALL}`);
  }
  if (!make) problems.push(`GNU make was not found. Install it with: ${MAKE_INSTALL}`);

  const parts = [
    make ? dirname(make) : "",
    gitRoot ? join(gitRoot, "usr", "bin") : "",
    gitRoot ? join(gitRoot, "cmd") : "",
    join(sysRoot, "System32"),
    sysRoot,
    join(sysRoot, "System32", "WindowsPowerShell", "v1.0"),
  ].filter(Boolean);
  const path = [...new Set(parts)].join(delimiter);

  if (gitRoot && make) {
    const uname = await version(join(gitRoot, "usr", "bin", "uname.exe"), ["-s"]);
    if (!/MSYS|MINGW/.test(uname)) problems.push(`Git's uname reports "${uname}", which the firmware Makefile does not recognise as Windows.`);
  }
  // What winget can install for us (Windows' own package manager, present on Windows 10 1809+).
  // winget.exe is an app execution alias (a zero-byte reparse point) that file
  // checks cannot see, so detect it by running it.
  const winget = /^v\d/.test(await version("winget", ["--version"]));
  const installable: WingetPackage[] = [
    ...(!gitRoot ? [{ id: "Git.Git", name: "Git for Windows" }] : []),
    ...(!make ? [{ id: "ezwinports.make", name: "GNU make" }] : []),
  ];
  return {
    ok: problems.length === 0,
    mode: problems.length ? "missing" : "native",
    path,
    make,
    git: gitRoot ? join(gitRoot, "cmd", "git.exe") : undefined,
    shell: gitRoot ? join(gitRoot, "usr", "bin", "sh.exe") : undefined,
    problems,
    installable,
    canInstall: !!winget && installable.length > 0,
  };
}

export interface WingetPackage {
  id: string;
  name: string;
}

/**
 * Install the missing tools with winget, one package at a time. Windows may ask
 * for permission (Git for Windows installs machine-wide). Returns per-package
 * results; the caller re-detects the environment afterwards.
 */
export async function installBuildTools(
  packages: WingetPackage[],
  onLine: (line: string, stream?: string) => void,
): Promise<{ id: string; ok: boolean }[]> {
  const results: { id: string; ok: boolean }[] = [];
  for (const p of packages) {
    onLine(`Installing ${p.name} (${p.id}) with winget…`);
    const r = await exec(
      "winget",
      ["install", "--id", p.id, "--exact", "--source", "winget", "--silent", "--accept-package-agreements", "--accept-source-agreements"],
      { allowNonZero: true, onEvent: (e) => onLine(e.line, e.stream) },
    );
    // 0x8A15002B (APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE): already installed, nothing newer.
    const already = r.code === 0x8a15002b;
    const ok = r.code === 0 || already;
    onLine(
      r.code === 0 ? `${p.name} installed.` : already ? `${p.name} is already installed.` : `winget exited with code ${r.code} for ${p.name}.`,
      ok ? "info" : "stderr",
    );
    results.push({ id: p.id, ok });
  }
  return results;
}

async function which(cmd: string, path: string): Promise<string | undefined> {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, cmd + ext);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

async function version(exe: string, args = ["--version"]): Promise<string> {
  try {
    return (await execCapture(exe, args)).split("\n")[0]!.trim();
  } catch {
    return "";
  }
}
