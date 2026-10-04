import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Static configuration for the build pipeline. Anything that could drift against
 * the firmware repo (the required GCC version, the toolchain URL) is deliberately
 * NOT hard-coded here — it is read out of the checked-out source tree at build
 * time (see toolchain.ts). Keeping that logic dynamic is the §6.4 "drift
 * detection" concern handled at the source rather than in a constant.
 */

/** Upstream firmware repository. Anonymous HTTPS clone — no credentials needed. */
export const FIRMWARE_REPO_URL =
  process.env.RFB_FIRMWARE_REPO ??
  "https://github.com/rotorflight/rotorflight-firmware.git";

/**
 * Root cache directory. Holds one shallow checkout per tag under `sources/`.
 * Override with RFB_CACHE_DIR (used by tests and CI).
 */
export function cacheRoot(): string {
  if (process.env.RFB_CACHE_DIR) return process.env.RFB_CACHE_DIR;
  const base =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
      : process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "rotorflight-firmware-builder");
}

export const sourcesDir = () => join(cacheRoot(), "sources");

/** Default directory the finished artifacts are copied into. */
export const DEFAULT_OUTPUT_DIR = process.env.RFB_OUTPUT_DIR ?? join(process.cwd(), "output");

/** Firmware fork name — used to locate the produced `<forkname>_<ver>_<target>.hex`. */
export const FORK_NAME = "rotorflight";
