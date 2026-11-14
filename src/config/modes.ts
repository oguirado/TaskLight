import { SOURCE_FLOORS, effectiveMode } from "../lens/floors";
import type { LensMode, LensSource } from "../lens/types";
import type { PrivacyTier } from "../schema";

export type ModeKey = "mode_status" | "mode_summary" | "mode_next_action" | "mode_screenshot"
  | "mode_digest" | "mode_plan" | "mode_template";
/** AMEND_C `ConfigSnapshot`, renamed to avoid clashing with the base SPEC_U16 `ConfigSnapshot`. */
export interface ModeSnapshot {
  modes: Readonly<Record<ModeKey, LensMode>>; kill_switch_cloud: boolean;
  min_inference_interval_ms: number; max_patches_per_frame: number; frame_js_budget_ms: number;
  ondevice_max_input_tokens: number; max_output_tokens: number; prompt_version: string;
  invalid: readonly ModeKey[];
}
export const MODE_KEYS: readonly ModeKey[] = Object.freeze([
  "mode_status", "mode_summary", "mode_next_action", "mode_screenshot", "mode_digest", "mode_plan", "mode_template",
]);
export const MODE_SNAPSHOT_DEFAULTS: ModeSnapshot = Object.freeze({
  modes: Object.freeze({
    mode_status: "PREFER_ON_DEVICE", mode_summary: "PREFER_ON_DEVICE", mode_next_action: "PREFER_ON_DEVICE",
    mode_screenshot: "ONLY_ON_DEVICE", mode_digest: "PREFER_IN_CLOUD",
    mode_plan: "PREFER_ON_DEVICE", mode_template: "PREFER_ON_DEVICE",
  } as const),
  kill_switch_cloud: false, min_inference_interval_ms: 20000, max_patches_per_frame: 8, frame_js_budget_ms: 4,
  ondevice_max_input_tokens: 7300, max_output_tokens: 200, prompt_version: "v1", invalid: Object.freeze([]),
});

const LENS_MODES: readonly string[] = [
  "PREFER_ON_DEVICE", "ONLY_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD",
];

function asInt(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && Number.isInteger(raw)) return raw;
  if (typeof raw === "string" && /^-?[0-9]+$/.test(raw)) {
    const big = BigInt(raw);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    if (big < BigInt(-Number.MAX_SAFE_INTEGER)) return null;
    return Number(big);
  }
  return null;
}

function clampInt(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

export function parseConfig(raw: Readonly<Record<string, unknown>>): ModeSnapshot {
  const modes = { ...MODE_SNAPSHOT_DEFAULTS.modes } as Record<ModeKey, LensMode>;
  const invalid: ModeKey[] = [];
  for (const key of MODE_KEYS) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || !LENS_MODES.includes(v)) {
      invalid.push(key);
      continue;
    }
    if (key === "mode_screenshot") {
      modes[key] = "ONLY_ON_DEVICE";
    } else {
      modes[key] = v as LensMode;
    }
  }
  const kill = raw["kill_switch_cloud"] === true;
  const minInt = asInt(raw["min_inference_interval_ms"]);
  const maxPatches = asInt(raw["max_patches_per_frame"]);
  const frameBudget = asInt(raw["frame_js_budget_ms"]);
  const ondeviceMax = asInt(raw["ondevice_max_input_tokens"]);
  const maxOut = asInt(raw["max_output_tokens"]);
  const pv = raw["prompt_version"];
  return {
    modes: Object.freeze(modes),
    kill_switch_cloud: kill,
    min_inference_interval_ms:
      minInt === null ? MODE_SNAPSHOT_DEFAULTS.min_inference_interval_ms : clampInt(minInt, 5000, 600000),
    max_patches_per_frame:
      maxPatches === null ? MODE_SNAPSHOT_DEFAULTS.max_patches_per_frame : clampInt(maxPatches, 1, 8),
    frame_js_budget_ms:
      frameBudget === null ? MODE_SNAPSHOT_DEFAULTS.frame_js_budget_ms : clampInt(frameBudget, 1, 11),
    ondevice_max_input_tokens:
      ondeviceMax === null ? MODE_SNAPSHOT_DEFAULTS.ondevice_max_input_tokens : clampInt(ondeviceMax, 512, 7300),
    max_output_tokens:
      maxOut === null ? MODE_SNAPSHOT_DEFAULTS.max_output_tokens : clampInt(maxOut, 32, 1024),
    prompt_version:
      typeof pv === "string" && /^v[0-9]{1,3}$/.test(pv) ? pv : MODE_SNAPSHOT_DEFAULTS.prompt_version,
    invalid: Object.freeze([...invalid]),
  };
}

const RANK: Record<LensMode, number> = {
  ONLY_IN_CLOUD: 0,
  PREFER_IN_CLOUD: 1,
  PREFER_ON_DEVICE: 2,
  ONLY_ON_DEVICE: 3,
};

export function resolveMode(
  key: ModeKey,
  source: LensSource | null,
  tier: PrivacyTier,
  c: Pick<ModeSnapshot, "modes" | "kill_switch_cloud">,
): { mode: LensMode; floor: LensMode | null; tightened: boolean } {
  const requested: LensMode =
    (c.modes as Readonly<Record<string, LensMode>>)[key] ?? MODE_SNAPSHOT_DEFAULTS.modes[key];
  if (c.kill_switch_cloud) {
    return {
      mode: "ONLY_ON_DEVICE",
      floor: "ONLY_ON_DEVICE",
      tightened: RANK["ONLY_ON_DEVICE"] > RANK[requested],
    };
  }
  if (key === "mode_screenshot") {
    return {
      mode: "ONLY_ON_DEVICE",
      floor: "ONLY_ON_DEVICE",
      tightened: RANK["ONLY_ON_DEVICE"] > RANK[requested],
    };
  }
  if (source === null) {
    if (tier === "private") {
      return {
        mode: "ONLY_ON_DEVICE",
        floor: "ONLY_ON_DEVICE",
        tightened: RANK["ONLY_ON_DEVICE"] > RANK[requested],
      };
    }
    return { mode: requested, floor: null, tightened: false };
  }
  const t: PrivacyTier = tier === "shared" ? "standard" : tier;
  const floor = SOURCE_FLOORS[source][t];
  const mode = effectiveMode(floor, requested);
  return { mode, floor, tightened: floor !== null && RANK[mode] > RANK[requested] };
}
