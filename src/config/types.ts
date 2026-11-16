// STUB (oracle phase U16): public types per SPEC_U16 section 2 plus SPEC_AMEND_C (mode_plan, mode_template).
// Divergence recorded in tests/unit/u16/ORACLE.md: AMEND_C redefines `ConfigSnapshot` and `CONFIG_DEFAULTS`
// with a different shape; the base SPEC_U16 shape is kept for those names, the AMEND_C parser/resolver
// use `ModeSnapshot` / `parseConfig` / `resolveMode` (see modes.ts).
import type { AiConfig, ModeName } from "../ai/types";
import type { ReconcileConfig } from "../reconcile/types";
import type { Tier } from "../perf/types";

export interface WallConfig {
  mode_status: ModeName; mode_summary: ModeName; mode_next_action: ModeName;
  mode_screenshot: ModeName; mode_digest: ModeName;
  mode_plan: ModeName; mode_template: ModeName;   // AMEND_C B26
  max_output_tokens: number; ondevice_max_input_tokens: number;
  prompt_version: string; model_name: string; kill_switch_cloud: boolean;
  ondevice_concurrency: number; cloud_concurrency: number;
  min_inference_interval_ms: number; queue_max_depth_factor: number;
  inference_timeout_ms: number;
  max_patches_per_frame: number; frame_js_budget_ms: number;
  governor_tier_override: "none" | Tier;
}
export type ConfigKey = keyof WallConfig;
export type KeySpec =
  | { kind: "enum"; values: readonly string[] }
  | { kind: "int"; min: number; max: number }
  | { kind: "bool" }
  | { kind: "pattern"; re: RegExp; maxLen: number };

export type WarnCode = "CLAMPED" | "INVALID_KEPT" | "PINNED" | "SINK_FAILED";
export interface ConfigWarning { key: string; code: WarnCode; raw?: string }
export type LiveState = "defaults" | "realtime" | "polling" | "throttled";
export interface ConfigSnapshot {
  cfg: Readonly<WallConfig>; gen: number; hash: string; // 8 lowercase hex
  activatedAt: number | null;
}
export interface BadgeModel {
  text: string;            // <= 64 chars
  gen: number; hash: string; promptVersion: string; cloudOff: boolean; live: LiveState;
}

export interface RemoteConfigPort {
  setDefaults(d: Readonly<Record<string, string>>): void;
  setMinimumFetchIntervalMillis(ms: number): void;
  fetchAndActivate(): Promise<boolean>;
  activate(): Promise<boolean>;
  getString(key: string): string;
  onConfigUpdate(o: { next(updatedKeys: ReadonlySet<string>): void;
    error(e: unknown): void; complete(): void }): () => void;
}
export interface AiSink { applyConfig(c: Partial<AiConfig>): { configGen: number; warnings: string[] } }
export interface ReconcileSink { updateConfig(c: ReconcileConfig): void }
export interface GovernorSink { setOverride(t: Tier | null): void }
export interface Timers { now(): number; setTimer(ms: number, fn: () => void): () => void }

export interface LiveConfigDeps {
  rc: RemoteConfigPort; ai: AiSink; reconcile: ReconcileSink; governor?: GovernorSink;
  timers: Timers; mode: "dev" | "prod";
}
export interface LiveConfig {
  start(): Promise<ConfigSnapshot>;          // never rejects
  current(): ConfigSnapshot;
  badge(): BadgeModel;
  subscribe(fn: (s: ConfigSnapshot, w: readonly ConfigWarning[]) => void): () => void;
  onVisibility(visible: boolean): void;
  dispose(): void;
}

// U50 (Amendment W0-R) provider flags.
export interface ProviderFlags {
  external_providers_enabled: boolean;   // gate for every non-Firebase provider (local and remote)
  remote_providers_enabled: boolean;     // additional gate for remote-openai-compatible only
}
export type ProviderFlagKey = keyof ProviderFlags;
export interface ExternalProvidersPolicy { local: boolean; remote: boolean }
