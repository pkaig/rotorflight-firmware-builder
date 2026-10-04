/**
 * Public API for the headless build module.
 *
 * Phase 2 (Tauri/NW.js integration) is meant to be a thin adapter over this
 * single function — no logic should move into the shell layer.
 */

import { DEFAULT_OUTPUT_DIR } from "./config.ts";
import { runBuild, type BuildResult } from "./build.ts";
import { resolveFeatures } from "./features.ts";
import { ensureSource } from "./source.ts";
import { ensureToolchain } from "./toolchain.ts";
import { validTargetsFromSource } from "./targets.ts";
import { BuildToolError } from "./errors.ts";
import type { ExecEvent } from "./exec.ts";

export interface BuildFirmwareOptions {
  target: string;
  ref: string;
  features?: string[];
  /** Raw USE_ tokens not (yet) in the feature map. */
  extraOptions?: string[];
  outputDir?: string;
  sourceDir?: string;
  /** Use `sourceDir` as-is, without checking out `ref` (see SourceOptions.asIs). */
  sourceAsIs?: boolean;
  fresh?: boolean;
  jobs?: number;
  /** Skip the safety `make clean` on an option-set change (dev only, may be stale). */
  incremental?: boolean;
  /** Extra `KEY=VALUE` make variables, e.g. `{ FLASH_CONFIG_ERASE: "yes" }`. */
  extraMakeVars?: Record<string, string>;
  /** Progress callback — one call per line of tool output. */
  onEvent?: (e: ExecEvent) => void;
  /** Higher-level lifecycle callback. */
  onStage?: (stage: BuildStage) => void;
}

export type BuildStage =
  | "resolving-source"
  | "installing-toolchain"
  | "compiling"
  | "collecting-artifacts";

export interface BuildFirmwareResult extends BuildResult {
  ref: string;
  commit: string;
  requiredToolchain: string;
  features: string[];
}

export async function buildFirmware(
  opts: BuildFirmwareOptions,
): Promise<BuildFirmwareResult> {
  const { options, features } = resolveFeatures(opts.features, opts.extraOptions);

  opts.onStage?.("resolving-source");
  const source = await ensureSource({
    ref: opts.ref,
    sourceDir: opts.sourceDir,
    asIs: opts.sourceAsIs,
    fresh: opts.fresh,
    onEvent: opts.onEvent,
  });

  const targets = await validTargetsFromSource(source.dir);
  if (!targets.includes(opts.target)) {
    throw new BuildToolError(
      "UNKNOWN_TARGET",
      `Unknown target "${opts.target}" for ${opts.ref}. Valid targets: ${targets.join(", ")}`,
    );
  }

  opts.onStage?.("installing-toolchain");
  const toolchain = await ensureToolchain(source.dir, opts.onEvent, { borrow: opts.sourceAsIs });

  opts.onStage?.("compiling");
  const result = await runBuild({
    sourceDir: source.dir,
    target: opts.target,
    options,
    binDir: toolchain.binDir,
    outputDir: opts.outputDir ?? DEFAULT_OUTPUT_DIR,
    jobs: opts.jobs,
    incremental: opts.incremental,
    extraMakeVars: toolchain.borrowed
      ? { ...opts.extraMakeVars, ARM_SDK_PREFIX: `${toolchain.binDir}/arm-none-eabi-` }
      : opts.extraMakeVars,
    onEvent: opts.onEvent,
  });

  opts.onStage?.("collecting-artifacts");
  return {
    ...result,
    ref: source.ref,
    commit: source.commit,
    requiredToolchain: toolchain.requiredVersion,
    features,
  };
}

export { BuildToolError, isBuildToolError } from "./errors.ts";
export { FEATURE_DEFINES, KNOWN_FEATURES, resolveFeatures } from "./features.ts";
export { KNOWN_UNIFIED_TARGETS, validTargetsFromSource } from "./targets.ts";
export {
  DISABLE_PREFIX,
  TargetPreprocessor,
  disableFlag,
  guardMap,
  previewSelection,
  probeOptions,
  selectionOptions,
} from "./probe.ts";
export type { OptionState, PreviewResult, ProbeResult, ProbedOption, Selection } from "./probe.ts";
export { ensureSource } from "./source.ts";
export { ensureToolchain } from "./toolchain.ts";
export type { BuildResult, SizeReport } from "./build.ts";
export type { ExecEvent } from "./exec.ts";
