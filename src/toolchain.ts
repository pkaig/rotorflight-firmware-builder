import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BuildToolError } from "./errors.ts";
import { sourcesDir } from "./config.ts";
import { exec, execCapture, type ExecEvent } from "./exec.ts";
import { prefetchToolchain } from "./download.ts";

export interface ToolchainInfo {
  /** Directory containing `arm-none-eabi-gcc` etc. */
  binDir: string;
  /** Resolved compiler version, e.g. "9.3.1". */
  version: string;
  /** The version the source tree demands (GCC_REQUIRED_VERSION). */
  requiredVersion: string;
  /**
   * True when the toolchain lives outside the source tree. The firmware
   * Makefile then has to be pointed at it with ARM_SDK_PREFIX, because it
   * prefers the tree's own tools/ directory whenever that exists.
   */
  borrowed?: boolean;
}

/**
 * Read `GCC_REQUIRED_VERSION` and `ARM_SDK_DIR` out of make/tools.mk in a
 * checked-out source tree. Doing this dynamically (rather than pinning a
 * constant) is what keeps the pipeline honest as upstream bumps its toolchain —
 * the §6.4 "pipeline silently drifting out of sync" risk.
 */
export async function readToolchainSpec(
  sourceDir: string,
): Promise<{ requiredVersion: string; sdkDirName: string }> {
  const toolsMk = join(sourceDir, "make", "tools.mk");
  let text: string;
  try {
    text = await readFile(toolsMk, "utf8");
  } catch {
    throw new BuildToolError(
      "TOOLCHAIN_INSTALL_FAILED",
      `Could not read ${toolsMk} — is this a Rotorflight firmware checkout?`,
    );
  }
  const ver = text.match(/GCC_REQUIRED_VERSION\s*\??=\s*(\S+)/);
  const sdk = text.match(/ARM_SDK_DIR\s*\??=\s*\$\(TOOLS_DIR\)\/(\S+)/);
  if (!ver) {
    throw new BuildToolError(
      "TOOLCHAIN_INSTALL_FAILED",
      `GCC_REQUIRED_VERSION not found in ${toolsMk}.`,
    );
  }
  return {
    requiredVersion: ver[1]!,
    sdkDirName: sdk?.[1] ?? `gcc-arm-none-eabi-${ver[1]!.split(".")[0]}`,
  };
}

/**
 * Ensure the ARM toolchain the source tree requires is installed and on hand.
 *
 * The archive is downloaded and SHA-256-verified by prefetchToolchain() first:
 * the firmware's own `make arm_sdk_install` downloads with `curl -L -k` and
 * checks nothing. arm_sdk_install then only unpacks the verified archive. We
 * then independently confirm `arm-none-eabi-gcc -dumpversion` matches
 * `GCC_REQUIRED_VERSION` exactly (the same equality check make itself
 * enforces) and fail loudly otherwise.
 */
export async function ensureToolchain(
  sourceDir: string,
  onEvent?: (e: ExecEvent) => void,
  opts: { borrow?: boolean } = {},
): Promise<ToolchainInfo> {
  const { requiredVersion, sdkDirName } = await readToolchainSpec(sourceDir);
  const binDir = join(sourceDir, "tools", sdkDirName, "bin");
  const gcc = join(binDir, gccName());

  let version = await tryGccVersion(gcc);
  if (version !== requiredVersion && opts.borrow) {
    // A user's own clone may hold a toolchain for another OS (e.g. a Windows
    // one when building under WSL). Reuse a matching one from a cached release
    // checkout rather than installing into their tree.
    const borrowed = await findCachedToolchain(sdkDirName, requiredVersion);
    if (borrowed) return { binDir: borrowed, version: requiredVersion, requiredVersion, borrowed: true };
  }
  if (version !== requiredVersion) {
    // Download and verify the archive ourselves; arm_sdk_install then only unpacks it.
    await prefetchToolchain(sourceDir, onEvent);
    try {
      await exec("make", ["arm_sdk_install"], { cwd: sourceDir, onEvent });
    } catch (err) {
      const detail = err instanceof BuildToolError ? err.detail ?? "" : String(err);
      if (/sha1|sha256|checksum|hash mismatch/i.test(detail)) {
        throw new BuildToolError(
          "CHECKSUM_MISMATCH",
          "Toolchain archive failed checksum verification during `make arm_sdk_install`.",
          detail,
        );
      }
      if (/No space left on device/i.test(detail)) {
        throw new BuildToolError("DISK_SPACE", "Ran out of disk space installing the toolchain.", detail);
      }
      throw new BuildToolError(
        "TOOLCHAIN_INSTALL_FAILED",
        "`make arm_sdk_install` failed.",
        detail,
      );
    }
    version = await tryGccVersion(gcc);
  }

  if (version !== requiredVersion) {
    throw new BuildToolError(
      "TOOLCHAIN_VERSION_MISMATCH",
      `Installed arm-none-eabi-gcc is ${version || "missing"}, but the source tree requires ${requiredVersion}.`,
    );
  }

  return { binDir, version, requiredVersion };
}

async function findCachedToolchain(sdkDirName: string, requiredVersion: string): Promise<string | undefined> {
  let refs: string[];
  try {
    refs = await readdir(sourcesDir());
  } catch {
    return undefined;
  }
  for (const ref of refs) {
    const bin = join(sourcesDir(), ref, "tools", sdkDirName, "bin");
    if ((await tryGccVersion(join(bin, gccName()))) === requiredVersion) return bin;
  }
  return undefined;
}

function gccName(): string {
  return process.platform === "win32" ? "arm-none-eabi-gcc.exe" : "arm-none-eabi-gcc";
}

async function tryGccVersion(gccPath: string): Promise<string> {
  try {
    return await execCapture(gccPath, ["-dumpversion"]);
  } catch {
    return "";
  }
}
