// STUB (oracle phase U19): public types per SPEC_U19 section 2. Behaviour modules are wrong on purpose.
import type { CapsuleState, PrivacyTier, InferenceSource, TaskId, Reject } from "../schema";
import type { ModeName } from "../ai";

export type PolicyViolation =
  | "PRIVATE_MODE_NOT_ON_DEVICE" | "SCREENSHOT_MODE_NOT_ON_DEVICE"
  | "CLOUD_SOURCE_FOR_ON_DEVICE_ONLY" | "PRIVATE_TEXT";
export type PolicyResult = { ok: true } | { ok: false; violation: PolicyViolation };

export type SyncCapsule = Readonly<Omit<CapsuleState, "headline" | "summary" | "next_action">>
  & Partial<Pick<CapsuleState, "headline" | "summary" | "next_action">>;
export type GuardResult = { ok: true; value: SyncCapsule } | { ok: false; rejects: Reject[] };

export type MultimodalState = "available" | "downloadable" | "downloading" | "unavailable";
export interface MultimodalProbe { probe(): Promise<MultimodalState> } // binding AUSENTE
export type ScreenshotRefuse =
  | "MULTIMODAL_UNAVAILABLE" | "DEVICE_NOT_READY" | "INPUT_REJECTED";
export type ScreenshotGate =
  | { allow: true; mode: "ONLY_ON_DEVICE" }
  | { allow: false; reason: ScreenshotRefuse };

export type AssertModeAllowed = (task: TaskId, tier: PrivacyTier, mode: ModeName) => PolicyResult;
export type AssertSourceAllowed = (mode: ModeName, source: InferenceSource) => PolicyResult;

// SPEC_U46 section 2: frozen provider-gate contract (behaviour in policy.ts).
export type ProviderKind =
  | "firebase-hybrid" | "firebase-ondevice" | "firebase-cloud"
  | "local-openai-compatible" | "remote-openai-compatible";
export interface ProviderGateOpts {
  readonly loopback: boolean;
  readonly allowPrivate: boolean;
  readonly endpointEnabled: boolean;
}
export type ProviderViolation =
  | "PROVIDER_KIND_UNKNOWN"
  | "CLOUD_PROVIDER_FOR_PRIVATE" | "CLOUD_PROVIDER_FOR_SCREENSHOT"
  | "LOCAL_FOR_SCREENSHOT" | "LOCAL_NOT_LOOPBACK" | "LOCAL_PRIVATE_NOT_ALLOWED" | "LOCAL_ENDPOINT_DISABLED"
  | "REMOTE_FOR_SCREENSHOT" | "REMOTE_FOR_PRIVATE" | "REMOTE_FOR_SHARED" | "REMOTE_ENDPOINT_DISABLED";
export type ProviderPolicyResult = { ok: true } | { ok: false; violation: ProviderViolation };
export type AssertProviderAllowed =
  (task: TaskId, tier: PrivacyTier, kind: ProviderKind, opts: ProviderGateOpts) => ProviderPolicyResult;
