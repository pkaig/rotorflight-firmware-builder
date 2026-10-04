import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Fallback list of unified MCU targets, matching `UNIFIED_TARGETS` in
 * make/targets_list.mk as of release/4.6.0. Used only when a source tree has not
 * been checked out yet; once it has, `validTargetsFromSource()` is authoritative.
 */
export const KNOWN_UNIFIED_TARGETS = [
  "STM32F405",
  "STM32F411",
  "STM32F7X2",
  "STM32F745",
  "STM32G47X",
  "STM32H743",
] as const;

/**
 * Reproduce the firmware Makefile's `VALID_TARGETS` derivation from a checked-out
 * source tree (make/targets_list.mk):
 *
 *   BASE_TARGETS  = every src/main/target/<X>/ that contains target.mk
 *   ALT_TARGETS   = every src/main/target/<X>/<Y>.mk where <Y> != "target"
 *   NOBUILD       = every src/main/target/<X>/<Y>.nomk  (e.g. STM32_UNIFIED itself)
 *   VALID_TARGETS = sort(BASE ∪ ALT) - NOBUILD
 *
 * The alt targets are the ones users actually pick — STM32F405, STM32H743, … —
 * so an inventory that stops at base targets (as an earlier version of this file
 * did) wrongly rejects every unified MCU.
 */
export async function validTargetsFromSource(sourceDir: string): Promise<string[]> {
  const targetRoot = join(sourceDir, "src", "main", "target");
  let dirs;
  try {
    dirs = await readdir(targetRoot, { withFileTypes: true });
  } catch {
    return [...KNOWN_UNIFIED_TARGETS];
  }

  const base = new Set<string>();
  const alt = new Set<string>();
  const nobuild = new Set<string>();

  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files: string[];
    try {
      files = await readdir(join(targetRoot, d.name));
    } catch {
      continue;
    }
    for (const f of files) {
      if (f === "target.mk") base.add(d.name);
      else if (f.endsWith(".mk")) alt.add(f.slice(0, -3));
      else if (f.endsWith(".nomk")) nobuild.add(f.slice(0, -5));
    }
  }

  const valid = new Set<string>([...base, ...alt]);
  for (const n of nobuild) valid.delete(n);
  return [...valid].sort();
}
