import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfigTarget } from "../src/boards.ts";

test("reads the MCU target from a Rotorflight board config header", () => {
  const text =
    "# Rotorflight / STM32F7X2 (S7X2) 4.5.0 Apr 21 2025 / 09:25:36 (9a7bc0d) MSP API: 12.8\n\nboard_name FLYDRAGON_V2\n";
  assert.equal(parseConfigTarget(text), "STM32F7X2");
});

test("reads the MCU target from a legacy (Betaflight-era) config header", () => {
  const text = "# Betaflight / STM32F405 (S405) 4.0.0 Mar  2 2019 / 07:01:01 (29db27584) MSP API: 1.4\n";
  assert.equal(parseConfigTarget(text), "STM32F405");
});

test("returns undefined when the header names no target", () => {
  assert.equal(parseConfigTarget("board_name FOO\n"), undefined);
});
