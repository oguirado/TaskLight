// Local minimal stand-in for U05's CapsulePatch (name AUSENTE until U05 freeze).
export type CapsulePatch = Readonly<Record<string, unknown>>;

export type InferenceMode = 'PREFER_ON_DEVICE' | 'ONLY_ON_DEVICE' | 'PREFER_IN_CLOUD' | 'ONLY_IN_CLOUD';
export type InferenceSource = 'ON_DEVICE' | 'IN_CLOUD';
export type CapsuleTask = 'status' | 'summary' | 'next_action' | 'screenshot';
export type PrivacyTier = 'private' | 'standard' | 'shared';
export type Lane = 'on_device' | 'cloud';
export type DeviceState = 'available' | 'downloadable' | 'downloading' | 'unavailable';
export type LedgerCounter = 'on_device' | 'in_cloud' | 'fallbacks' | 'refusals' | 'schema_rejects';

export interface JobKey {
  readonly projectId: string;
  readonly observedRev: number;
  readonly promptVersion: string;
  readonly templateHash: string;
}

export interface ReconcileConfig {
  readonly ondevice_concurrency: number;
  readonly cloud_concurrency: number;
  readonly min_inference_interval_ms: number;
  readonly queue_max_depth_factor: number;
  readonly prompt_version: string;
  readonly kill_switch_cloud: boolean;
  readonly mode_status: InferenceMode;
  readonly mode_summary: InferenceMode;
  readonly mode_next_action: InferenceMode;
  readonly mode_screenshot: InferenceMode;
  readonly inference_timeout_ms: number;
}

export interface ObservedEvent {
  readonly projectId: string;
  readonly incarnation: string;
  readonly observedRev: number;
  readonly templateHash: string;
  readonly tier: PrivacyTier;
  readonly task: CapsuleTask;
}

export interface Job {
  readonly key: JobKey;
  readonly task: CapsuleTask;
  readonly incarnation: string;
  readonly tier: PrivacyTier;
  readonly mode: InferenceMode;
  readonly lane: Lane;
  readonly enqueuedAt: number;
}

export type ThrottleReason = 'interval' | 'lane_full' | 'device_not_ready';
export type RefuseReason = 'queue_full' | 'kill_switch_cloud' | 'disposed' | 'unknown_project';
export type Admission =
  | { readonly kind: 'ADMIT'; readonly lane: Lane }
  | { readonly kind: 'THROTTLE'; readonly reason: ThrottleReason; readonly retryAt: number }
  | { readonly kind: 'REFUSE'; readonly reason: RefuseReason };

export interface PublishedCapsule {
  readonly rev: number;
  readonly observed_rev: number;
  readonly source_observed_rev: number;
  readonly incarnation: string;
  readonly inference_source: InferenceSource;
  readonly updated_at: number;
  readonly patch: CapsulePatch;
}

export type Freshness = 'fresh' | 'stale';

export interface InferenceRequest { readonly key: JobKey; readonly task: CapsuleTask; readonly mode: InferenceMode; }
export interface InferenceOutcome { readonly raw: string; readonly inferenceSource: InferenceSource; }

export interface InferencePort {
  run(req: InferenceRequest, signal: AbortSignal): Promise<InferenceOutcome>;
}
export interface ValidatorPort {
  validate(task: CapsuleTask, raw: string): { ok: true; patch: CapsulePatch } | { ok: false; reason: string };
}
export interface CapsuleStore {
  read(projectId: string): PublishedCapsule | undefined;
  currentIncarnation(projectId: string): string | undefined;
  compareAndPublish(projectId: string, expectedRev: number, next: PublishedCapsule): boolean;
}
export interface Clock {
  now(): number;
  setTimer(ms: number, fn: () => void): () => void;
}
export interface LedgerPort { inc(c: LedgerCounter): void; }

export interface ReconcilerDeps {
  readonly infer: InferencePort;
  readonly validator: ValidatorPort;
  readonly store: CapsuleStore;
  readonly clock: Clock;
  readonly ledger: LedgerPort;
}

export interface QueueSnapshot {
  readonly pending: readonly Job[];
  readonly inFlight: Readonly<Record<Lane, number>>;
  readonly bound: number;
}

export interface Reconciler {
  registerProject(projectId: string): void;
  unregisterProject(projectId: string): void;
  observe(ev: ObservedEvent): Admission;
  updateConfig(cfg: ReconcileConfig): void;
  setDeviceState(s: DeviceState): void;
  freshness(projectId: string): Freshness;
  snapshot(): QueueSnapshot;
  dispose(): void;
}
