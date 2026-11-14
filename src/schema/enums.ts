export const CAPSULE_STATUS = Object.freeze(["running", "waiting_input", "blocked", "failed", "done", "idle"] as const);
export type CapsuleStatus = (typeof CAPSULE_STATUS)[number];
export const ATTENTION = Object.freeze(["none", "low", "high", "now"] as const);
export type Attention = (typeof ATTENTION)[number];
export const PRIVACY_TIER = Object.freeze(["private", "standard", "shared"] as const);
export type PrivacyTier = (typeof PRIVACY_TIER)[number];
export const INFERENCE_SOURCE = Object.freeze(["ON_DEVICE", "IN_CLOUD"] as const);
export type InferenceSource = (typeof INFERENCE_SOURCE)[number];
export type TaskId = "status" | "summary" | "next_action" | "screenshot" | "digest" | "plan";

export const STEP_STATE = Object.freeze(["todo", "doing", "done"] as const);
export type StepState = (typeof STEP_STATE)[number];
export const LENS_ID_RE = /^[a-z][a-z0-9-]{0,15}$/;
export const STATUS_RE = /^[a-z][a-z_]{0,23}$/;
