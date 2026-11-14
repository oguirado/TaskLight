// Public types for the U06 hybrid inference module (SPEC_U06 section 2).
import type { TaskId, TaskOutputMap, InferenceSource, PrivacyTier,
  Reject, ValidateCtx, TaskSchema } from "../schema";

export type ModeName = "PREFER_ON_DEVICE" | "ONLY_ON_DEVICE" | "PREFER_IN_CLOUD" | "ONLY_IN_CLOUD";

export interface AiConfig {
  mode_status: ModeName;
  mode_summary: ModeName;
  mode_next_action: ModeName;
  mode_screenshot: ModeName;
  mode_digest: ModeName;
  max_output_tokens: number;
  ondevice_max_input_tokens: number;
  prompt_version: string;
  model_name: string;
  kill_switch_cloud: boolean;
}
export const AI_DEFAULTS: Readonly<AiConfig> = {
  mode_status: "PREFER_ON_DEVICE", mode_summary: "PREFER_ON_DEVICE", mode_next_action: "PREFER_ON_DEVICE",
  mode_screenshot: "ONLY_ON_DEVICE", mode_digest: "PREFER_IN_CLOUD",
  max_output_tokens: 200, ondevice_max_input_tokens: 7300, prompt_version: "v1", model_name: "gemini-3.5-flash-lite",
  kill_switch_cloud: false,
};

export interface ImagePart { mimeType: string; data: string }

export interface TaskRequest<K extends TaskId> {
  task: K; projectId: string; tier: PrivacyTier;
  prompt: string;
  image?: ImagePart;
  ctx?: ValidateCtx;
}

export type AiErrorCode =
  | "INPUT_OVER_BUDGET" | "INPUT_REJECTED" | "DEVICE_NOT_INITIALISED"
  | "ON_DEVICE_UNAVAILABLE" | "CLOUD_UNAVAILABLE" | "CLOUD_DISABLED"
  | "APP_CHECK_REJECTED" | "SDK_ERROR" | "BAD_SOURCE" | "SCHEMA_REJECT"
  | "PRIVACY_VIOLATION";

export interface RunMeta {
  task: TaskId; mode: ModeName; configGen: number;
  prompt_version: string; called: boolean;
}
export type TaskResult<K extends TaskId> =
  | { ok: true; value: TaskOutputMap[K]; source: InferenceSource; fallback: boolean; meta: RunMeta }
  | { ok: false; code: AiErrorCode; source?: InferenceSource; rejects?: Reject[];
      fallback: boolean; detail?: string; meta: RunMeta };

export type DeviceStatus =
  | { state: "not_initialised" } | { state: "downloading"; progress: number }
  | { state: "ready" } | { state: "needs_gesture" } | { state: "failed"; detail: string };

export interface SdkResponse { text(): string; inferenceSource?: unknown }
export type SdkPart = string | { inlineData: { data: string; mimeType: string } };
export interface ModelHandle {
  generateContent(req: string | SdkPart[]): Promise<{ response: SdkResponse }>;
  initializeDeviceModel(onProgress?: (p: number) => void): Promise<void>;
}
export interface HybridParamsShape {
  mode: unknown;
  inCloudParams: { model: string; generationConfig: {
    responseMimeType: TaskSchema["mimeType"]; responseSchema: object; maxOutputTokens: number } };
  onDeviceParams: { promptOptions: { responseConstraint: object } };
}
export interface ModelFactory {
  modeConst(m: ModeName): unknown;
  sourceConst: { ON_DEVICE: unknown; IN_CLOUD: unknown };
  create(params: HybridParamsShape): ModelHandle;
}

export interface Hybrid {
  run<K extends TaskId>(req: TaskRequest<K>): Promise<TaskResult<K>>;
  initDevice(onProgress?: (p: number) => void): Promise<DeviceStatus>;
  deviceStatus(): DeviceStatus;
  applyConfig(cfg: Partial<AiConfig>): { configGen: number; warnings: string[] };
}
export class HostForbiddenError extends Error {}

export interface ParityCase { task: TaskId; prompt: string; image?: ImagePart; ctx?: ValidateCtx }
export interface ParityRow {
  task: TaskId; source: InferenceSource; n: number; rejects: number;
  rate: number; t4: boolean;
  /**
   * Whether the `onDeviceParams.promptOptions.responseConstraint` reference submitted to
   * `factory.create` for this parity pair equalled `TASK_SCHEMAS[task].schema`.
   *
   * Verifiable scope: this observes only the parameters as submitted to the factory.
   * When a handle exposes the params it actually forwarded (test harness `params`),
   * the check compares that forwarded value; otherwise it compares the locally built
   * submitted params. It does NOT prove the provider or SDK retained, honoured, or
   * enforced the constraint at generation time. A harness wrapper that drops
   * `onDeviceParams` before delegating is detectable only when the wrapper propagates
   * a handle that still exposes the stripped params; a fully opaque handle
   * without any params receipt cannot be distinguished by this field.
   */
  constraintPresent: boolean;
}
