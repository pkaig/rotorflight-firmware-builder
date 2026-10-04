import { readFile } from "node:fs/promises";
import type { ProbedOption, ProbeResult } from "./probe.ts";

/**
 * Human context for USE_ options (data/option-info.json): what each one is,
 * why you would keep or strip it, and how important it is. The probe works out
 * what the preprocessor allows; this layer adds judgement the source cannot
 * express — e.g. that USE_HAL_DRIVER is platform plumbing, not a feature.
 */

export type OptionLevel = "core" | "recommended" | "optional" | "niche" | "hardware" | "platform" | "dev";

export interface OptionInfo {
  title: string;
  category: string;
  level: OptionLevel;
  summary: string;
  enable?: string;
  disable?: string;
  /** True when the text came from a name pattern rather than a hand-written entry. */
  generic?: boolean;
}

export interface FeatureItem {
  id: string;
  label: string;
  options: string[];
}

export interface FeatureGroup {
  group: string;
  hint?: string;
  items: FeatureItem[];
}

export interface OptionInfoData {
  levels: Record<OptionLevel, string>;
  patterns: (Partial<OptionInfo> & { match: string })[];
  options: Record<string, OptionInfo>;
  features: FeatureGroup[];
}

export async function loadOptionInfo(path: string): Promise<OptionInfoData> {
  return JSON.parse(await readFile(path, "utf8")) as OptionInfoData;
}

/** Resolve the context for one option: a hand-written entry, else the first matching pattern. */
export function describeOption(data: OptionInfoData, name: string): OptionInfo | undefined {
  const exact = data.options[name];
  if (exact) return exact;
  for (const p of data.patterns) {
    const m = name.match(new RegExp(p.match));
    if (!m) continue;
    const fill = (s?: string) =>
      s?.replace(/\$(\d)/g, (_, i: string) => (m[Number(i)] ?? "").replace(/_$/, "").replace(/_/g, " ")).trim();
    return {
      title: fill(p.title) ?? name,
      category: p.category ?? "Other",
      level: p.level ?? "optional",
      summary: fill(p.summary) ?? "",
      enable: fill(p.enable),
      disable: fill(p.disable),
      generic: true,
    };
  }
  return undefined;
}

export type AnnotatedOption = ProbedOption & { info?: OptionInfo };

/**
 * Attach context and lock what is not a user choice. The preprocessor happily
 * accepts -DUSE_HAL_DRIVER or -DUSE_UART7 on an F405, so it alone would call
 * them "addable"; platform plumbing and another MCU's hardware are not features.
 */
export function annotateOptions(data: OptionInfoData, probe: ProbeResult): AnnotatedOption[] {
  const fam = probe.family ? `an ${probe.family}` : "this";
  return probe.options.map((o): AnnotatedOption => {
    const info = describeOption(data, o.name);
    const out: AnnotatedOption = info ? { ...o, info } : { ...o };
    const changeable = o.state === "off-addable" || o.state === "on-removable";
    if (!changeable || !info) return out;

    if (info.level === "platform") {
      return {
        ...out,
        state: o.state === "on-removable" ? "on-locked" : "off-locked",
        reason: "Platform setting, chosen by the build and MCU. Not a feature to toggle.",
      };
    }
    if (o.state === "off-addable" && info.level === "hardware") {
      const where = o.families?.length ? `${o.families.join("/")} hardware` : "Hardware no target enables";
      if (o.scope === "mcu-default" || o.scope === "board-only" || o.scope === "never-defined") {
        return { ...out, state: "off-locked", reason: `${where}; this is ${fam} target. Set by the board design, not per build.` };
      }
    }
    return out;
  });
}
