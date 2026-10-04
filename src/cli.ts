#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildFirmware } from "./index.ts";
import { KNOWN_FEATURES, FEATURE_DEFINES } from "./features.ts";
import { splitList } from "./features.ts";
import { KNOWN_UNIFIED_TARGETS, validTargetsFromSource } from "./targets.ts";
import { isBuildToolError } from "./errors.ts";

const USAGE = `rf-buildtool — local Rotorflight firmware build (Phase 1, CLI only)

Usage:
  rf-buildtool build --target <MCU> --tag <ref> [--features <list>] [--options <list>]
  rf-buildtool features
  rf-buildtool targets [--tag <ref>]

Options:
  --target <MCU>      Target board, e.g. STM32F405 (see 'rf-buildtool targets')
  --tag <ref>         Firmware tag or branch, e.g. release/4.6.0
  --features <list>   Comma/space separated friendly feature names
  --options <list>    Raw USE_ defines to pass through verbatim
  --out <dir>         Where to copy artifacts (default: ./output)
  --source-dir <dir>  Build from an existing local clone instead of the cache
  --jobs <n>          Parallel make jobs (default: CPU count)
  --fresh             Discard any cached checkout for this ref first
  --incremental       Skip the safety 'make clean' on an option change (may be stale)
  --config-erase      Build with FLASH_CONFIG_ERASE=yes (matches official releases)
  --make-var K=V      Extra make variable (repeatable), e.g. --make-var EXST=yes
  --json              Emit the result as JSON on stdout
  --quiet             Suppress streamed build output
  -h, --help          Show this help
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      target: { type: "string" },
      tag: { type: "string" },
      features: { type: "string" },
      options: { type: "string" },
      out: { type: "string" },
      "source-dir": { type: "string" },
      jobs: { type: "string" },
      fresh: { type: "boolean", default: false },
      incremental: { type: "boolean", default: false },
      "config-erase": { type: "boolean", default: false },
      "make-var": { type: "string", multiple: true },
      json: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const command = positionals[0] ?? "build";
  if (values.help || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === "features") {
    for (const f of KNOWN_FEATURES) {
      process.stdout.write(`${f.padEnd(28)} ${FEATURE_DEFINES[f]!.join(" ")}\n`);
    }
    return 0;
  }

  if (command === "targets") {
    const list = values["source-dir"]
      ? await validTargetsFromSource(values["source-dir"])
      : KNOWN_UNIFIED_TARGETS;
    for (const t of list) process.stdout.write(`${t}\n`);
    return 0;
  }

  if (command !== "build") {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }

  if (!values.target || !values.tag) {
    process.stderr.write("error: --target and --tag are required\n\n" + USAGE);
    return 2;
  }

  const extraMakeVars: Record<string, string> = {};
  if (values["config-erase"]) extraMakeVars.FLASH_CONFIG_ERASE = "yes";
  for (const kv of values["make-var"] ?? []) {
    const eq = kv.indexOf("=");
    if (eq < 1) {
      process.stderr.write(`error: --make-var must be KEY=VALUE, got "${kv}"\n`);
      return 2;
    }
    extraMakeVars[kv.slice(0, eq)] = kv.slice(eq + 1);
  }

  const result = await buildFirmware({
    target: values.target,
    ref: values.tag,
    features: splitList(values.features),
    extraOptions: splitList(values.options),
    outputDir: values.out,
    sourceDir: values["source-dir"],
    fresh: values.fresh,
    incremental: values.incremental,
    extraMakeVars,
    jobs: values.jobs ? Number(values.jobs) : undefined,
    onEvent: values.quiet
      ? undefined
      : (e) => process.stderr.write(`  ${e.line}\n`),
    onStage: (s) => process.stderr.write(`\n[${s}]\n`),
  });

  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      `\nBuilt ${result.target} @ ${result.ref} (${result.commit.slice(0, 9)})\n` +
        `  toolchain : arm-none-eabi-gcc ${result.requiredToolchain}\n` +
        `  features  : ${result.features.join(", ") || "(none)"}\n` +
        `  options   : ${result.options.join(" ") || "(none)"}\n` +
        (result.size
          ? `  size      : flash ${result.size.flash} B (text ${result.size.text} + data ${result.size.data}), bss ${result.size.bss} B\n`
          : "") +
        `  hex       : ${result.hexPath ?? "(none)"}\n` +
        (result.binPath ? `  bin       : ${result.binPath}\n` : "") +
        `  took      : ${(result.durationMs / 1000).toFixed(1)}s\n`,
    );
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    if (isBuildToolError(err)) {
      process.stderr.write(`\nerror [${err.code}]: ${err.message}\n`);
      if (err.detail) process.stderr.write(`\n${err.detail}\n`);
      process.exit(1);
    }
    process.stderr.write(`\nunexpected error: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
