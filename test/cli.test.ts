import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execCapture, exec } from "../src/exec.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const NODE = process.execPath;

test("`features` lists known feature -> define mappings", async () => {
  const out = await execCapture(NODE, [CLI, "features"]);
  assert.match(out, /GPS\s+USE_GPS USE_GPS_RESCUE/);
  assert.match(out, /TELEMETRY_CRSF\s+USE_TELEMETRY USE_TELEMETRY_CRSF/);
});

test("`targets` lists the known unified MCUs", async () => {
  const out = await execCapture(NODE, [CLI, "targets"]);
  assert.match(out, /STM32F405/);
  assert.match(out, /STM32H743/);
});

test("`build` without --target/--tag exits 2 with usage", async () => {
  const r = await exec(NODE, [CLI, "build"], { allowNonZero: true });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--target and --tag are required/);
});

test("`--help` exits 0 and prints usage", async () => {
  const r = await exec(NODE, [CLI, "--help"], { allowNonZero: true });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /rf-buildtool/);
});

test("unknown command exits 2", async () => {
  const r = await exec(NODE, [CLI, "frobnicate"], { allowNonZero: true });
  assert.equal(r.code, 2);
});
