// U46 oracle fixtures: independent reference model of SPEC_U46 section 3 (written from the spec, not from code).
import type { PrivacyTier, TaskId } from "../../../src/schema/enums";
import type { ProviderGateOpts, ProviderKind, ProviderPolicyResult, ProviderViolation } from "../../../src/privacy/types";

export const TASKS: readonly TaskId[] = ["status", "summary", "next_action", "screenshot", "digest", "plan"];
export const TIERS: readonly PrivacyTier[] = ["private", "standard", "shared"];
export const KINDS: readonly ProviderKind[] = [
  "firebase-hybrid", "firebase-ondevice", "firebase-cloud", "local-openai-compatible", "remote-openai-compatible",
];
export const NEW_SOURCES = ["LOCAL_SERVER", "REMOTE_PROVIDER"] as const;
export const FOUR_SOURCES = ["ON_DEVICE", "IN_CLOUD", "LOCAL_SERVER", "REMOTE_PROVIDER"] as const;

/** All 8 combinations of the three boolean opts. */
export const OPTS8: readonly ProviderGateOpts[] = (() => {
  const out: ProviderGateOpts[] = [];
  for (const loopback of [false, true]) for (const allowPrivate of [false, true]) for (const endpointEnabled of [false, true])
    out.push({ loopback, allowPrivate, endpointEnabled });
  return out;
})();

const NON_SCREENSHOT = new Set(["status", "summary", "next_action", "digest", "plan"]);
const deny = (violation: ProviderViolation): ProviderPolicyResult => ({ ok: false, violation });
const OK: ProviderPolicyResult = { ok: true };

/** Reference model. Inputs are raw (possibly hostile); mirrors spec normalisation then first-match order. */
export function expected(task: unknown, tier: unknown, kind: unknown, opts: unknown): ProviderPolicyResult {
  const priv = !(tier === "standard" || tier === "shared");
  const shot = !(typeof task === "string" && NON_SCREENSHOT.has(task));
  const o = (typeof opts === "object" && opts !== null ? opts : {}) as Record<string, unknown>;
  const loopback = o.loopback === true, allowPrivate = o.allowPrivate === true, enabled = o.endpointEnabled === true;
  const shared = tier === "shared";
  switch (kind) {
    case "firebase-ondevice":
      return OK;
    case "firebase-cloud":
    case "firebase-hybrid":
      if (shot) return deny("CLOUD_PROVIDER_FOR_SCREENSHOT");
      if (priv) return deny("CLOUD_PROVIDER_FOR_PRIVATE");
      return OK;
    case "local-openai-compatible":
      if (shot) return deny("LOCAL_FOR_SCREENSHOT");
      if (!loopback) return deny("LOCAL_NOT_LOOPBACK");
      if (!enabled) return deny("LOCAL_ENDPOINT_DISABLED");
      if (priv && !allowPrivate) return deny("LOCAL_PRIVATE_NOT_ALLOWED");
      return OK;
    case "remote-openai-compatible":
      if (shot) return deny("REMOTE_FOR_SCREENSHOT");
      if (priv) return deny("REMOTE_FOR_PRIVATE");
      if (shared) return deny("REMOTE_FOR_SHARED");
      if (!enabled) return deny("REMOTE_ENDPOINT_DISABLED");
      return OK;
    default:
      return deny("PROVIDER_KIND_UNKNOWN");
  }
}

/** Pre-U46 assertModeAllowed table (policy.ts:14-34 behaviour), written as an explicit table. */
export const MODES = ["PREFER_ON_DEVICE", "ONLY_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD"] as const;
export function expectedMode(task: string, tier: string, mode: string) {
  const priv = !(tier === "standard" || tier === "shared");
  if (priv) return mode === "ONLY_ON_DEVICE" ? { ok: true } : { ok: false, violation: "PRIVATE_MODE_NOT_ON_DEVICE" };
  if (task === "screenshot") return mode === "ONLY_ON_DEVICE" ? { ok: true } : { ok: false, violation: "SCREENSHOT_MODE_NOT_ON_DEVICE" };
  return (MODES as readonly string[]).includes(mode) ? { ok: true } : { ok: false, violation: "PRIVATE_MODE_NOT_ON_DEVICE" };
}

/** Pre-schema-change export names of src/schema/index (snapshot, MEASURED at oracle time). */
export const SCHEMA_EXPORTS_PRE_U46 = [
  "ATTENTION", "CAPSULE_STATUS", "DEV_LENS", "INFERENCE_SOURCE", "LENS_ID_RE", "LIMITS", "PRIVACY_TIER", "STATUS_RE",
  "STEP_STATE", "TASK_SCHEMAS", "taskSchemasFor", "validateCapsuleState", "validateInferenceSource", "validateLensVocab",
  "validatePatch", "validateTaskOutput",
] as const;
