// Test-local reference of SPEC_U46 section 3, installed as the mock of assertProviderAllowed so that U47 is
// tested independently of U46's implementation. U47 must call it (spy) and must not re-implement it.
import type { PrivacyTier, TaskId } from "../../../src/schema";
import type { ProviderGateOpts, ProviderKind, ProviderPolicyResult } from "../../../src/privacy/types";

export interface PolicyCall { task: unknown; tier: unknown; kind: unknown; opts: ProviderGateOpts }
export const policyCalls: PolicyCall[] = [];
type Override = (task: TaskId, tier: PrivacyTier, kind: ProviderKind, opts: ProviderGateOpts) => ProviderPolicyResult;
let override: Override | null = null;
export function setPolicyOverride(f: Override | null): void { override = f; }
export function resetPolicy(): void { policyCalls.length = 0; override = null; }

const KINDS = ["firebase-hybrid", "firebase-ondevice", "firebase-cloud", "local-openai-compatible", "remote-openai-compatible"];
const TASKS = ["status", "summary", "next_action", "plan", "digest"];

export function refAssert(task: TaskId, tier: PrivacyTier, kind: ProviderKind, opts: ProviderGateOpts): ProviderPolicyResult {
  const t = (tier as string) === "standard" || (tier as string) === "shared" ? (tier as string) : "private";
  const k = TASKS.includes(task as string) ? (task as string) : "screenshot";
  const o = (typeof opts === "object" && opts !== null ? opts : ({} as ProviderGateOpts));
  const loopback = o.loopback === true, allowPrivate = o.allowPrivate === true, enabled = o.endpointEnabled === true;
  if (!KINDS.includes(kind as string)) return { ok: false, violation: "PROVIDER_KIND_UNKNOWN" };
  if (kind === "firebase-ondevice") return { ok: true };
  if (kind === "firebase-cloud" || kind === "firebase-hybrid") {
    if (k === "screenshot") return { ok: false, violation: "CLOUD_PROVIDER_FOR_SCREENSHOT" };
    if (t === "private") return { ok: false, violation: "CLOUD_PROVIDER_FOR_PRIVATE" };
    return { ok: true };
  }
  if (kind === "local-openai-compatible") {
    if (k === "screenshot") return { ok: false, violation: "LOCAL_FOR_SCREENSHOT" };
    if (!loopback) return { ok: false, violation: "LOCAL_NOT_LOOPBACK" };
    if (!enabled) return { ok: false, violation: "LOCAL_ENDPOINT_DISABLED" };
    if (t === "private" && !allowPrivate) return { ok: false, violation: "LOCAL_PRIVATE_NOT_ALLOWED" };
    return { ok: true };
  }
  if (k === "screenshot") return { ok: false, violation: "REMOTE_FOR_SCREENSHOT" };
  if (t === "private") return { ok: false, violation: "REMOTE_FOR_PRIVATE" };
  if (t === "shared") return { ok: false, violation: "REMOTE_FOR_SHARED" };
  if (!enabled) return { ok: false, violation: "REMOTE_ENDPOINT_DISABLED" };
  return { ok: true };
}

export function policyProxy(task: TaskId, tier: PrivacyTier, kind: ProviderKind, opts: ProviderGateOpts): ProviderPolicyResult {
  policyCalls.push({ task, tier, kind, opts });
  return override ? override(task, tier, kind, opts) : refAssert(task, tier, kind, opts);
}
