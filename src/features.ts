import { BuildToolError } from "./errors.ts";

/**
 * Maps a friendly feature name (what a Configurator checkbox would be labelled)
 * to the set of `USE_XXX` compile-time defines it enables. These names are
 * passed to `make` as `OPTIONS="USE_A USE_B"`, which the firmware Makefile turns
 * into `-DUSE_A -DUSE_B` (see `$(addprefix -D,$(OPTIONS))` in Makefile).
 *
 * This is intentionally a small, curated starting set. It is NOT the full list
 * of flags the firmware supports — Phase 0 of the scope doc calls for a complete
 * inventory of helicopter-relevant `USE_XXX` flags, which will grow this map.
 * Anything not listed here can still be passed through verbatim via
 * `extraOptions` as long as it looks like a `USE_` token.
 */
export const FEATURE_DEFINES: Readonly<Record<string, readonly string[]>> = {
  GPS: ["USE_GPS", "USE_GPS_RESCUE"],
  LED_STRIP: ["USE_LED_STRIP"],
  DSHOT: ["USE_DSHOT"],
  DSHOT_TELEMETRY: ["USE_DSHOT", "USE_DSHOT_TELEMETRY"],
  RPM_FILTER: ["USE_RPM_FILTER"],
  BLACKBOX: ["USE_BLACKBOX"],
  TELEMETRY_CRSF: ["USE_TELEMETRY", "USE_TELEMETRY_CRSF"],
  TELEMETRY_GHST: ["USE_TELEMETRY", "USE_TELEMETRY_GHST"],
  TELEMETRY_SMARTPORT: ["USE_TELEMETRY", "USE_TELEMETRY_SMARTPORT"],
  TELEMETRY_SBUS2: ["USE_TELEMETRY", "USE_TELEMETRY_SBUS2"],
  TELEMETRY_CASTLE: ["USE_TELEMETRY", "USE_TELEMETRY_CASTLE"],
  SERVO_GEOMETRY_CORRECTION: ["USE_SERVO_GEOMETRY_CORRECTION"],
  ACC: ["USE_ACC"],
  MAG: ["USE_MAG"],
  BARO: ["USE_BARO"],
  RANGEFINDER: ["USE_RANGEFINDER"],
  VTX: ["USE_VTX_CONTROL", "USE_VTX_COMMON"],
  CAMERA_CONTROL: ["USE_CAMERA_CONTROL"],
} as const;

export const KNOWN_FEATURES = Object.keys(FEATURE_DEFINES).sort();

/** A define to add (`USE_X`) or a guard flag that removes one (`DISABLE_X`, see probe.ts). */
const USE_TOKEN = /^(USE|DISABLE|ENABLE)_[A-Z0-9_]+$/;

export interface ResolveResult {
  /** Deduped, sorted list of `USE_XXX` tokens to pass as OPTIONS. */
  options: string[];
  /** The friendly feature names that were expanded. */
  features: string[];
}

/**
 * Turn a mix of friendly feature names and raw `USE_` tokens into the final
 * OPTIONS list. Order-independent and idempotent so that "the same selection"
 * always produces byte-identical build flags (the §6.2 reproducibility concern).
 */
export function resolveFeatures(
  features: readonly string[] = [],
  extraOptions: readonly string[] = [],
): ResolveResult {
  const options = new Set<string>();
  const usedFeatures: string[] = [];

  for (const raw of features) {
    const name = raw.trim().toUpperCase();
    if (!name) continue;
    const defines = FEATURE_DEFINES[name];
    if (!defines) {
      throw new BuildToolError(
        "UNKNOWN_FEATURE",
        `Unknown feature "${raw}". Known features: ${KNOWN_FEATURES.join(", ")}. ` +
          `Pass a raw define via --options if it is not yet mapped.`,
      );
    }
    usedFeatures.push(name);
    for (const d of defines) options.add(d);
  }

  for (const raw of extraOptions) {
    const token = raw.trim().toUpperCase();
    if (!token) continue;
    if (!USE_TOKEN.test(token)) {
      throw new BuildToolError(
        "UNKNOWN_FEATURE",
        `--options value "${raw}" is not a valid define (expected USE_X, or a DISABLE_X / ENABLE_X guard flag).`,
      );
    }
    options.add(token);
  }

  return {
    options: [...options].sort(),
    features: [...new Set(usedFeatures)].sort(),
  };
}

/** Split a comma/space/semicolon separated CLI value into trimmed tokens. */
export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
