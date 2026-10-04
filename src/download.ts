import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BuildToolError } from "./errors.ts";
import type { ExecEvent } from "./exec.ts";

/**
 * Fetch the ARM toolchain archive ourselves, before the firmware Makefile's
 * `arm_sdk_install` runs. The Makefile's own download (`curl -L -k -z`) has no
 * retry, no checksum and TLS verification disabled; a dropped connection
 * leaves a truncated archive. Here the archive is downloaded with retries and
 * resume, verified against a pinned SHA-256, and placed where the Makefile
 * looks (downloads/), so `arm_sdk_install` only unpacks it.
 */

/**
 * SHA-256 of Arm's published archives. Computed from downloads whose MD5
 * matched Arm's published MD5 (184b3397414485f224e7ba950989aab6 for win32,
 * 2b9eeccc33470f9d3cda26983b9d2dc6 for x86_64-linux). Releases without an
 * entry are downloaded but reported as unverified.
 */
export const TOOLCHAIN_SHA256: Readonly<Record<string, string>> = {
  "gcc-arm-none-eabi-9-2020-q2-update-win32.zip": "49d6029ecd176deaa437a15b3404f54792079a39f3b23cb46381b0e6fbbe9070",
  "gcc-arm-none-eabi-9-2020-q2-update-x86_64-linux.tar.bz2": "5adc2ee03904571c2de79d5cfc0f7fe2a5c5f54f44da5b645c17ee57b217f11f",
};

/** The archive URL tools.mk would download on this OS. */
export async function toolchainUrl(sourceDir: string): Promise<string | undefined> {
  const text = await readFile(join(sourceDir, "make", "tools.mk"), "utf8").catch(() => "");
  const base = text.match(/ARM_SDK_URL_BASE\s*:?=\s*(\S+)/)?.[1];
  if (!base) return undefined;
  const family = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macosx" : "linux";
  // ifeq ($(OSFAMILY), windows)\n  ARM_SDK_URL := $(ARM_SDK_URL_BASE)-win32.zip
  const m = text.match(new RegExp(`ifeq \\(\\$\\(OSFAMILY\\),\\s*${family}\\)\\s*\\n\\s*ARM_SDK_URL\\s*:?=\\s*\\$\\(ARM_SDK_URL_BASE\\)(\\S+)`));
  return m ? base + m[1] : undefined;
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

/**
 * Make sure downloads/<archive> exists and is verified. Returns the path, or
 * undefined when tools.mk names no archive for this OS.
 */
export async function prefetchToolchain(sourceDir: string, onEvent?: (e: ExecEvent) => void): Promise<string | undefined> {
  const url = await toolchainUrl(sourceDir);
  if (!url) return undefined;
  const file = join(sourceDir, "downloads", basename(new URL(url).pathname));
  const want = TOOLCHAIN_SHA256[basename(file)];
  const say = (line: string) => onEvent?.({ stream: "stdout", line });
  await mkdir(join(sourceDir, "downloads"), { recursive: true });

  if (existsSync(file) && want && (await sha256File(file)) === want) {
    say(`Toolchain archive ${basename(file)} already downloaded and verified.`);
    return touch(file);
  }

  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await downloadResumable(url, file, say);
      break;
    } catch (err) {
      if (attempt === 6) {
        throw new BuildToolError("TOOLCHAIN_INSTALL_FAILED", `Downloading ${basename(file)} failed after ${attempt} attempts.`, String(err));
      }
      say(`Download interrupted (${(err as Error).message}); retrying (${attempt}/5)…`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }

  if (want) {
    const got = await sha256File(file);
    if (got !== want) {
      await rm(file, { force: true });
      throw new BuildToolError(
        "CHECKSUM_MISMATCH",
        `The toolchain archive ${basename(file)} failed its SHA-256 check, so it was deleted and not installed.`,
        `expected ${want}\ngot      ${got}`,
      );
    }
    say(`Verified ${basename(file)} (SHA-256 ${want.slice(0, 16)}…).`);
  } else {
    say(`Warning: no pinned checksum for ${basename(file)}; it was not verified.`);
  }
  return touch(file);
}

/** Newer than the server copy, so the Makefile's `curl -z` keeps ours. */
async function touch(file: string): Promise<string> {
  const now = new Date();
  await utimes(file, now, now);
  return file;
}

async function downloadResumable(url: string, file: string, say: (l: string) => void) {
  const have = existsSync(file) ? (await stat(file)).size : 0;
  const res = await fetch(url, { headers: have ? { range: `bytes=${have}-` } : {}, redirect: "follow" });
  if (res.status === 416) return; // already complete
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const resumed = res.status === 206;
  const total = Number(res.headers.get("content-length") ?? 0) + (resumed ? have : 0);
  say(`${resumed ? "Resuming" : "Downloading"} ${basename(file)}${total ? ` (${(total / 1048576).toFixed(0)} MB)` : ""} from ${new URL(url).host}…`);
  let done = resumed ? have : 0;
  let lastPct = -1;
  const body = Readable.fromWeb(res.body as never);
  body.on("data", (chunk: Buffer) => {
    done += chunk.length;
    const pct = total ? Math.floor((100 * done) / total / 10) * 10 : -1;
    if (pct > lastPct) { lastPct = pct; if (pct >= 0) say(`  ${pct}%`); }
  });
  await pipeline(body, createWriteStream(file, { flags: resumed ? "a" : "w" }));
}
