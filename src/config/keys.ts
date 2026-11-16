// Defaults and key specs: data from SPEC_U16 section 0 / B5 (+ AMEND_C B26). Constants are real; behaviour modules are stubs.
import type { ConfigKey, ConfigWarning, ExternalProvidersPolicy, KeySpec, ProviderFlagKey, ProviderFlags, WallConfig } from "./types";

const MODES = ["PREFER_ON_DEVICE", "ONLY_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD"] as const;
const mode: KeySpec = { kind: "enum", values: MODES };

export const CONFIG_DEFAULTS: Readonly<WallConfig> = Object.freeze({
  mode_status: "PREFER_ON_DEVICE", mode_summary: "PREFER_ON_DEVICE", mode_next_action: "PREFER_ON_DEVICE",
  mode_screenshot: "ONLY_ON_DEVICE", mode_digest: "PREFER_IN_CLOUD",
  mode_plan: "PREFER_ON_DEVICE", mode_template: "PREFER_ON_DEVICE",
  max_output_tokens: 200, ondevice_max_input_tokens: 7300, prompt_version: "v1", model_name: "gemini-3.5-flash-lite",
  kill_switch_cloud: false, ondevice_concurrency: 1, cloud_concurrency: 2,
  min_inference_interval_ms: 20000, queue_max_depth_factor: 2, inference_timeout_ms: 120000,
  max_patches_per_frame: 8, frame_js_budget_ms: 4, governor_tier_override: "none",
} as const);

export const KEY_SPECS: Readonly<Record<ConfigKey, KeySpec>> = Object.freeze({
  mode_status: mode, mode_summary: mode, mode_next_action: mode, mode_screenshot: mode,
  mode_digest: mode, mode_plan: mode, mode_template: mode,
  max_output_tokens: { kind: "int", min: 32, max: 1024 },
  ondevice_max_input_tokens: { kind: "int", min: 512, max: 7300 },
  ondevice_concurrency: { kind: "int", min: 1, max: 2 },
  cloud_concurrency: { kind: "int", min: 1, max: 4 },
  min_inference_interval_ms: { kind: "int", min: 5000, max: 600000 },
  queue_max_depth_factor: { kind: "int", min: 1, max: 4 },
  inference_timeout_ms: { kind: "int", min: 10000, max: 600000 },
  max_patches_per_frame: { kind: "int", min: 1, max: 8 },
  frame_js_budget_ms: { kind: "int", min: 1, max: 11 },
  kill_switch_cloud: { kind: "bool" },
  prompt_version: { kind: "pattern", re: /^v[0-9]{1,3}$/, maxLen: 4 },
  model_name: { kind: "pattern", re: /^gemini-[a-z0-9.-]{1,48}$/, maxLen: 55 },
  governor_tier_override: { kind: "enum", values: ["none", "T0", "T1", "T2", "T3"] },
} as Record<ConfigKey, KeySpec>);

// U50 (Amendment W0-R): provider flags live in their own table; WallConfig / CONFIG_DEFAULTS / KEY_SPECS above are untouched.
export const PROVIDER_FLAG_DEFAULTS: Readonly<ProviderFlags> =
  Object.freeze({ external_providers_enabled: true, remote_providers_enabled: true });
export const PROVIDER_FLAG_SPECS: Readonly<Record<ProviderFlagKey, KeySpec>> =
  Object.freeze({ external_providers_enabled: { kind: "bool" }, remote_providers_enabled: { kind: "bool" } });
export function parseProviderFlags(
  get: (k: ProviderFlagKey) => string,
  prev?: Readonly<ProviderFlags>,
): { flags: ProviderFlags; warnings: ConfigWarning[] } {
  const flags = { ...PROVIDER_FLAG_DEFAULTS } as ProviderFlags;
  const warnings: ConfigWarning[] = [];
  for (const key of Object.keys(PROVIDER_FLAG_SPECS) as ProviderFlagKey[]) {
    const fallback = prev ? prev[key] === true : PROVIDER_FLAG_DEFAULTS[key];
    let raw: unknown;
    try { raw = get(key); } catch {
      flags[key] = fallback;
      warnings.push({ key, code: "INVALID_KEPT" });
      continue;
    }
    if (raw === "true" || raw === "false") { flags[key] = raw === "true"; continue; }
    flags[key] = fallback;
    warnings.push(typeof raw === "string" ? { key, code: "INVALID_KEPT", raw } : { key, code: "INVALID_KEPT" });
  }
  return { flags, warnings };
}
export function externalProvidersPolicy(
  cfg: Readonly<Pick<WallConfig, "kill_switch_cloud">> & Readonly<ProviderFlags>,
): ExternalProvidersPolicy {
  const external = cfg.external_providers_enabled === true;
  const remote = external && cfg.remote_providers_enabled === true && cfg.kill_switch_cloud !== true;
  return Object.freeze({ local: external, remote });
}
