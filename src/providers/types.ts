// U47 stub (oracle phase). Types and constants are final (SPEC_U47 frozen API + Amendment W0-R); functions elsewhere throw.
import type { TaskId, PrivacyTier, InferenceSource, ValidateCtx } from "../schema";
import type { Hybrid, AiConfig, DeviceStatus, ModeName } from "../ai/types";
import type { ClassifierPort } from "../router/types";
import type { ProviderKind } from "../privacy";

export type ProviderId = string;                        // firebase ids fixed; external = host endpoint id
export const FIREBASE_IDS = ["firebase-hybrid", "firebase-ondevice", "firebase-cloud"] as const;
export const DEFAULT_PROVIDER: ProviderId = "firebase-hybrid";
export type TaskGroup = "capsule" | "digest" | "routing" | "drift";
export const TASK_GROUP: Readonly<Record<Exclude<TaskId, "screenshot">, TaskGroup>> =
  { status: "capsule", summary: "capsule", next_action: "capsule", plan: "capsule", digest: "digest" };
export type CallTask = TaskId | "route" | "drift";      // "route"/"drift" = non-TaskId groups

export interface EndpointInfo {                         // one entry of model_hello.endpoints (§4)
  id: string; kind: "local-openai-compatible" | "remote-openai-compatible";
  label: string; model: string; loopback: boolean; has_key: boolean; allow_private: boolean;
}
export type Rung = 1 | 2 | 3;
export type HealthState = "available" | "needs_setup" | "offline" | "blocked";
export type NackCode = string;                          // vocabulary owned by U48 (SPEC_U48 nack table)
export interface ChatMessage { role: "system" | "user"; content: string }
export interface ModelTransport {
  list(): Promise<EndpointInfo[]>;
  probe(id: string, signal: AbortSignal): Promise<{ state: HealthState; rung: Rung | null }>;
  generate(req: { id: string; messages: ChatMessage[]; maxTokens: number; schema?: object;
    rung: Rung; tier: PrivacyTier; signal: AbortSignal; room?: string }): Promise<{ ok: true; text: string } | { ok: false; nack: NackCode }>;
  cancel(id: string): void;
}
export interface Clock { now(): number; setTimeout(f: () => void, ms: number): unknown; clearTimeout(h: unknown): void }
export interface ProviderGates { externalEnabled?: boolean; remoteEnabled?: boolean; killSwitchCloud?: boolean }
export interface ModelSelection { all?: ProviderId; groups?: Partial<Record<TaskGroup, ProviderId>> }
export interface ProviderDescriptor {
  id: ProviderId; kind: ProviderKind; label: string; health: HealthState;
  blockedReason?: "policy" | "remote_config" | "unknown_id"; rung?: Rung | null;
}
export interface ResolvedChain { primary: ProviderId; hop: ProviderId | null; blocked: ProviderDescriptor["blockedReason"] }
export const TIMEOUTS_MS = { probe: 1500, local: 30000, remote: 60000, ceiling: 120000 } as const;
export const MAX_BODY_BYTES = 48 * 1024;
/** U52b (D-U47-1, SPEC_U52 section 3): initDevice returns `downloading` once this injected-clock bound expires. */
export const DEVICE_STATUS_BOUND_MS = 10_000;

export type ProviderErrorCode = "TIMEOUT" | "OFFLINE" | "NEEDS_SETUP" | "NACK" | "SCHEMA_REJECT"
  | "BLOCKED" | "BODY_TOO_LARGE" | "ABORTED" | "FIREBASE_FAILED";
export interface GenerateRequest { task: CallTask; tier: PrivacyTier; prompt: string; schema: object;
  signal: AbortSignal; ctx?: ValidateCtx; maxTokens?: number; room?: string }
export type GenerateResult =
  | { ok: true; text: string; source: InferenceSource; providerId: ProviderId; modelLabel: string; fallback: boolean }
  | { ok: false; code: ProviderErrorCode; providerId: ProviderId; fallback: boolean; detail?: string };
export type DriftSource = "device" | "cloud" | "local" | "remote";
export interface ProviderDriftPort {
  generate(prompt: string, schema: object, signal: AbortSignal, room?: string): Promise<{ text: string; source: DriftSource }>;
}
/** U52b (D-U47-2, SPEC_U52 section 3): optional Firebase text channel for route/drift (no Hybrid.run). */
export interface FirebaseTextRequest { task: "route" | "drift"; mode: ModeName; prompt: string; schema: object; signal: AbortSignal }
export type FirebaseTextFn = (req: FirebaseTextRequest) => Promise<{ text: string; source: "ON_DEVICE" | "IN_CLOUD" }>;
export interface ProviderDeps {
  hybrid: Hybrid;                                       // the existing default instance, used verbatim
  makeHybrid: (overlay: Partial<AiConfig>) => Hybrid;   // U52 wraps createHybrid (src/ai/hybrid.ts:38)
  transport?: ModelTransport;                           // absent => only Firebase group exists
  clock?: Clock; config?: Partial<AiConfig>; gates?: ProviderGates; selection?: ModelSelection;
  firebaseText?: FirebaseTextFn;                        // U52b (D-U47-2): route/drift on Firebase ids; absent => Hybrid.run
}
export interface ProviderRegistry {
  refresh(): Promise<ProviderDescriptor[]>;             // list() then probe() each, budget TIMEOUTS_MS.probe
  list(): readonly ProviderDescriptor[];
  select(sel: ModelSelection): void;                    // ids only; unknown ids kept but resolve to default
  applyRemoteConfig(cfg: Partial<AiConfig>, gates: ProviderGates): void;
  resolve(task: CallTask, tier: PrivacyTier): ResolvedChain;
  initDevice(onProgress?: (p: number) => void): Promise<DeviceStatus>;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  asHybrid(): Hybrid;
  asClassifierPort(tier: PrivacyTier): ClassifierPort;
  asDriftPort(tier: PrivacyTier): ProviderDriftPort;
}
