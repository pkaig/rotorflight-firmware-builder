import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { annotateOptions, describeOption, loadOptionInfo } from "../src/option-info.ts";
import type { ProbedOption, ProbeResult } from "../src/probe.ts";

const DATA = fileURLToPath(new URL("../data/option-info.json", import.meta.url));

const opt = (o: Partial<ProbedOption> & { name: string }): ProbedOption => ({
  state: "off-addable",
  consumers: 1,
  scope: "generic",
  ...o,
});
const probe = (options: ProbedOption[]): ProbeResult => ({
  target: "STM32F405",
  family: "F4",
  baseline: [],
  options,
  durationMs: 0,
});

test("hand-written entries win over patterns", async () => {
  const data = await loadOptionInfo(DATA);
  assert.equal(describeOption(data, "USE_HAL_DRIVER")?.level, "platform");
  assert.equal(describeOption(data, "USE_UART")?.level, "core");
});

test("patterns fill captures into readable text", async () => {
  const data = await loadOptionInfo(DATA);
  const gyro = describeOption(data, "USE_GYRO_SPI_ICM42688P");
  assert.equal(gyro?.title, "ICM42688P gyro/accelerometer driver");
  assert.equal(gyro?.generic, true);
  assert.equal(describeOption(data, "USE_UART7")?.title, "UART7");
});

test("platform options are never toggleable, even when the preprocessor allows it", async () => {
  const data = await loadOptionInfo(DATA);
  const [hal] = annotateOptions(data, probe([opt({ name: "USE_HAL_DRIVER", scope: "other-mcu" })]));
  assert.equal(hal!.state, "off-locked");
});

test("another MCU's hardware is locked; a shared feature on by default elsewhere is not", async () => {
  const data = await loadOptionInfo(DATA);
  const [uart7, sbus2] = annotateOptions(
    data,
    probe([
      opt({ name: "USE_UART7", scope: "mcu-default", families: ["F7", "H7"] }),
      opt({ name: "USE_TELEMETRY_SBUS2", scope: "mcu-default", families: ["F7", "H7"] }),
    ]),
  );
  assert.equal(uart7!.state, "off-locked");
  assert.match(uart7!.reason!, /F7\/H7 hardware/);
  assert.equal(sbus2!.state, "off-addable");
});

test("every feature in the setup list names real-looking USE_ options", async () => {
  const data = await loadOptionInfo(DATA);
  for (const g of data.features) {
    for (const it of g.items) {
      assert.ok(it.options.length > 0, it.id);
      for (const o of it.options) assert.match(o, /^USE_[A-Z0-9_]+$/);
    }
  }
});
