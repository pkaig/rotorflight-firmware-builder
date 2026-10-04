import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateRemoval, isFirmwareFlash, parseMemoryUsage, type SizeModel } from "../src/size.ts";

test("parses ld --print-memory-usage output", () => {
  const out = `Linking STM32F405
Memory region         Used Size  Region Size  %age Used
           FLASH:        9876 B        10 KB     96.45%
FLASH_CUSTOM_DEFAULTS:          0 GB         6 KB      0.00%
          FLASH1:      509014 B       992 KB     50.11%
             RAM:       70000 B       128 KB     53.41%
`;
  const r = parseMemoryUsage(out);
  assert.deepEqual(r.map((x) => x.name), ["FLASH", "FLASH_CUSTOM_DEFAULTS", "FLASH1", "RAM"]);
  assert.equal(r[2]!.size, 992 * 1024);
  assert.deepEqual(r.filter(isFirmwareFlash).map((x) => x.name), ["FLASH", "FLASH1"]);
});

test("removal estimate honours && and || conditions", () => {
  const model: SizeModel = {
    conditions: [
      { mode: "all", tokens: ["USE_A"] },
      { mode: "all", tokens: ["USE_A", "USE_B"] },
      { mode: "any", tokens: ["USE_A", "USE_C"] },
    ],
    symbols: [
      { name: "a", flash: 100, ram: 0, conds: [0] },
      { name: "ab", flash: 10, ram: 4, conds: [1] },
      { name: "aOrC", flash: 1, ram: 0, conds: [2] },
    ],
    flash: 111,
    ram: 4,
    locatedFlash: 111,
  };
  assert.deepEqual(estimateRemoval(model, ["USE_A"]), { flash: 110, ram: 4 });
  assert.deepEqual(estimateRemoval(model, ["USE_B"]), { flash: 10, ram: 4 });
  assert.deepEqual(estimateRemoval(model, ["USE_A", "USE_C"]), { flash: 111, ram: 4 });
});

test("F7's ITCM flash alias is not counted twice", () => {
  const names = ["ITCM_FLASH", "ITCM_FLASH1", "AXIM_FLASH", "AXIM_FLASH1", "AXIM_FLASH_CONFIG"];
  const fw = names.map((name) => ({ name, used: 0, size: 1024 })).filter(isFirmwareFlash);
  assert.deepEqual(fw.map((r) => r.name), ["AXIM_FLASH", "AXIM_FLASH1"]);
});
