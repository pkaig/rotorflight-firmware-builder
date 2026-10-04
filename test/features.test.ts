import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFeatures, splitList } from "../src/features.ts";
import { isBuildToolError } from "../src/errors.ts";

test("expands friendly features into deduped, sorted USE_ defines", () => {
  const { options, features } = resolveFeatures(["DSHOT_TELEMETRY", "dshot"]);
  assert.deepEqual(options, ["USE_DSHOT", "USE_DSHOT_TELEMETRY"]);
  assert.deepEqual(features, ["DSHOT", "DSHOT_TELEMETRY"]);
});

test("selection order does not affect the result (reproducibility, §6.2)", () => {
  const a = resolveFeatures(["GPS", "LED_STRIP", "TELEMETRY_CRSF"]).options;
  const b = resolveFeatures(["TELEMETRY_CRSF", "GPS", "LED_STRIP"]).options;
  assert.deepEqual(a, b);
});

test("merges raw --options passthrough tokens", () => {
  const { options } = resolveFeatures(["GPS"], ["USE_MSP_DISPLAYPORT", "use_gps"]);
  assert.deepEqual(options, ["USE_GPS", "USE_GPS_RESCUE", "USE_MSP_DISPLAYPORT"]);
});

test("rejects an unknown feature name with UNKNOWN_FEATURE", () => {
  try {
    resolveFeatures(["TOTALLY_NOT_A_FEATURE"]);
    assert.fail("expected throw");
  } catch (e) {
    assert.ok(isBuildToolError(e) && e.code === "UNKNOWN_FEATURE");
  }
});

test("rejects a malformed --options token", () => {
  try {
    resolveFeatures([], ["rm -rf /"]);
    assert.fail("expected throw");
  } catch (e) {
    assert.ok(isBuildToolError(e) && e.code === "UNKNOWN_FEATURE");
  }
});

test("empty selection yields empty options", () => {
  assert.deepEqual(resolveFeatures().options, []);
});

test("splitList handles comma, space and semicolon separators", () => {
  assert.deepEqual(splitList("GPS, LED_STRIP;BLACKBOX  RPM_FILTER"), [
    "GPS",
    "LED_STRIP",
    "BLACKBOX",
    "RPM_FILTER",
  ]);
  assert.deepEqual(splitList(undefined), []);
  assert.deepEqual(splitList(""), []);
});
