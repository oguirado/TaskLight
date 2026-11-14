import type { AiConfig, ModeName } from "../ai/types";
import type { ReconcileConfig } from "../reconcile/types";
import { CONFIG_DEFAULTS, KEY_SPECS } from "./keys";
import type { ConfigKey, ConfigWarning, WallConfig } from "./types";

const INT_PATTERN = /^-?[0-9]+$/;

function prevValue<K extends ConfigKey>(prev: Readonly<WallConfig>, key: K): WallConfig[K] {
  const v = prev[key];
  return (v === undefined ? CONFIG_DEFAULTS[key] : v) as WallConfig[K];
}

function parseIntClamped(raw: string, min: number, max: number): number {
  const big = BigInt(raw);
  const lo = BigInt(min);
  const hi = BigInt(max);
  if (big < lo) return min;
  if (big > hi) return max;
  return Number(big);
}

export function parseRemote(
  get: (k: ConfigKey) => string,
  prev: Readonly<WallConfig>,
): { cfg: WallConfig; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = [];
  const cfg = { ...prev } as WallConfig;
  const keys = Object.keys(KEY_SPECS) as ConfigKey[];
  for (const key of keys) {
    const spec = KEY_SPECS[key];
    let raw: string;
    try {
      raw = get(key);
    } catch {
      if (key === "mode_screenshot") {
        (cfg as unknown as Record<string, unknown>)[key] = "ONLY_ON_DEVICE";
        warnings.push({ key, code: "PINNED" });
      } else {
        (cfg as unknown as Record<string, unknown>)[key] = prevValue(prev, key);
        warnings.push({ key, code: "INVALID_KEPT" });
      }
      continue;
    }
    if (key === "mode_screenshot") {
      if (raw !== "ONLY_ON_DEVICE") {
        (cfg as unknown as Record<string, unknown>)[key] = "ONLY_ON_DEVICE";
        warnings.push({ key, code: "PINNED", raw });
      } else {
        (cfg as unknown as Record<string, unknown>)[key] = "ONLY_ON_DEVICE";
      }
      continue;
    }
    if (spec.kind === "enum") {
      if ((spec.values as readonly string[]).includes(raw)) {
        (cfg as unknown as Record<string, unknown>)[key] = raw;
      } else {
        (cfg as unknown as Record<string, unknown>)[key] = prevValue(prev, key);
        warnings.push({ key, code: "INVALID_KEPT", raw });
      }
    } else if (spec.kind === "int") {
      if (!INT_PATTERN.test(raw)) {
        (cfg as unknown as Record<string, unknown>)[key] = prevValue(prev, key);
        warnings.push({ key, code: "INVALID_KEPT", raw });
      } else {
        const clamped = parseIntClamped(raw, spec.min, spec.max);
        (cfg as unknown as Record<string, unknown>)[key] = clamped;
        if (clamped !== Number(BigInt(raw))) {
          warnings.push({ key, code: "CLAMPED", raw });
        }
      }
    } else if (spec.kind === "bool") {
      if (raw === "true" || raw === "false") {
        (cfg as unknown as Record<string, unknown>)[key] = raw === "true";
      } else {
        (cfg as unknown as Record<string, unknown>)[key] = prevValue(prev, key);
        warnings.push({ key, code: "INVALID_KEPT", raw });
      }
    } else {
      if (raw.length <= spec.maxLen && spec.re.test(raw)) {
        (cfg as unknown as Record<string, unknown>)[key] = raw;
      } else {
        (cfg as unknown as Record<string, unknown>)[key] = prevValue(prev, key);
        warnings.push({ key, code: "INVALID_KEPT", raw });
      }
    }
  }
  return { cfg, warnings };
}

const AI_KEYS = [
  "mode_status",
  "mode_summary",
  "mode_next_action",
  "mode_screenshot",
  "mode_digest",
  "max_output_tokens",
  "ondevice_max_input_tokens",
  "prompt_version",
  "model_name",
  "kill_switch_cloud",
] as const;

const RECONCILE_KEYS = [
  "ondevice_concurrency",
  "cloud_concurrency",
  "min_inference_interval_ms",
  "queue_max_depth_factor",
  "prompt_version",
  "kill_switch_cloud",
  "mode_status",
  "mode_summary",
  "mode_next_action",
  "mode_screenshot",
  "inference_timeout_ms",
] as const;

export function toAiConfig(c: Readonly<WallConfig>): AiConfig {
  const out = {} as Record<string, unknown>;
  for (const k of AI_KEYS) out[k] = c[k];
  return out as unknown as AiConfig;
}

export function toReconcileConfig(c: Readonly<WallConfig>): ReconcileConfig {
  const out = {} as Record<string, unknown>;
  for (const k of RECONCILE_KEYS) out[k] = c[k];
  return out as unknown as ReconcileConfig;
}

export type { ModeName as _ModeName };
