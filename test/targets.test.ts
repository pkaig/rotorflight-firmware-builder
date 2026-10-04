import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validTargetsFromSource } from "../src/targets.ts";

/**
 * Regression fixture for the release/4.6.0 target layout: alt targets live as
 * <BASE>/<ALT>.mk files, and the base dir that only hosts them is marked
 * NOBUILD with a .nomk file. An earlier implementation scanned only for
 * target.mk and wrongly rejected STM32F405 / STM32H743 / ….
 */
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rfb-targets-"));
  const t = join(root, "src", "main", "target");

  const mk = async (dir: string, files: Record<string, string>) => {
    await mkdir(join(t, dir), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(t, dir, name), body);
    }
  };

  await mk("STM32_UNIFIED", {
    "target.mk": "# defaults",
    "STM32_UNIFIED.nomk": "",
    "STM32F405.mk": "F405_TARGETS += $(TARGET)",
    "STM32H743.mk": "H743xI_TARGETS += $(TARGET)",
  });
  await mk("MATEKF405", { "target.mk": "F405_TARGETS += $(TARGET)" });
  await mk("SITL", { "target.mk": "SIMULATOR_BUILD = yes" });

  return root;
}

test("derives alt targets and drops the NOBUILD base", async () => {
  const targets = await validTargetsFromSource(await fixture());
  assert.deepEqual(targets, ["MATEKF405", "SITL", "STM32F405", "STM32H743"]);
  assert.ok(!targets.includes("STM32_UNIFIED"));
});

test("falls back to the known unified list when the tree is absent", async () => {
  const targets = await validTargetsFromSource(join(tmpdir(), "rfb-does-not-exist"));
  assert.ok(targets.includes("STM32F405"));
  assert.ok(targets.includes("STM32H743"));
});
