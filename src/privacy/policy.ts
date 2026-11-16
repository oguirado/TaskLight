import type { InferenceSource, PrivacyTier, TaskId } from "../schema";
import type { ModeName } from "../ai";
import type {
  PolicyResult, ProviderGateOpts, ProviderKind, ProviderPolicyResult, ProviderViolation,
} from "./types";

const VALID_MODES: ReadonlySet<string> = new Set<string>([
  "PREFER_ON_DEVICE",
  "ONLY_ON_DEVICE",
  "PREFER_IN_CLOUD",
  "ONLY_IN_CLOUD",
]);

const VALID_SOURCES: ReadonlySet<string> = new Set<string>(["ON_DEVICE", "IN_CLOUD", "LOCAL_SERVER", "REMOTE_PROVIDER"]);

export function assertModeAllowed(task: TaskId, tier: PrivacyTier, mode: ModeName): PolicyResult {
  const t = tier as string;
  const m = mode as string;
  const effectiveTier = t === "standard" || t === "shared" ? t : "private";
  if (effectiveTier === "private") {
    if (m !== "ONLY_ON_DEVICE") {
      return { ok: false, violation: "PRIVATE_MODE_NOT_ON_DEVICE" };
    }
    return { ok: true };
  }
  if ((task as string) === "screenshot") {
    if (m !== "ONLY_ON_DEVICE") {
      return { ok: false, violation: "SCREENSHOT_MODE_NOT_ON_DEVICE" };
    }
    return { ok: true };
  }
  if (!VALID_MODES.has(m)) {
    return { ok: false, violation: "PRIVATE_MODE_NOT_ON_DEVICE" };
  }
  return { ok: true };
}

export function assertSourceAllowed(mode: ModeName, source: InferenceSource): PolicyResult {
  const m = mode as string;
  const s = source as string;
  if (!VALID_MODES.has(m) || !VALID_SOURCES.has(s)) {
    return { ok: false, violation: "CLOUD_SOURCE_FOR_ON_DEVICE_ONLY" };
  }
  if (m === "ONLY_ON_DEVICE" && s !== "ON_DEVICE") {
    return { ok: false, violation: "CLOUD_SOURCE_FOR_ON_DEVICE_ONLY" };
  }
  return { ok: true };
}

export const PROVIDER_KINDS: readonly ProviderKind[] = Object.freeze([
  "firebase-hybrid", "firebase-ondevice", "firebase-cloud",
  "local-openai-compatible", "remote-openai-compatible",
] as const);

const PROVIDER_KIND_SET: ReadonlySet<string> = new Set<string>(PROVIDER_KINDS);
const NON_SCREENSHOT_TASKS: ReadonlySet<string> = new Set<string>(["status", "summary", "next_action", "digest", "plan"]);

export function isProviderKind(v: unknown): v is ProviderKind {
  return typeof v === "string" && PROVIDER_KIND_SET.has(v);
}

function deny(violation: ProviderViolation): ProviderPolicyResult {
  return { ok: false, violation };
}

function flag(opts: unknown, key: keyof ProviderGateOpts): boolean {
  if (opts === null || typeof opts !== "object") return false;
  try {
    return (opts as Record<string, unknown>)[key] === true;
  } catch {
    return false;
  }
}

// Fail-closed, pure, total provider gate (SPEC_U46 section 3; first match returns).
export function assertProviderAllowed(
  task: TaskId, tier: PrivacyTier, kind: ProviderKind, opts: ProviderGateOpts,
): ProviderPolicyResult {
  if (!isProviderKind(kind)) return deny("PROVIDER_KIND_UNKNOWN");
  const t: unknown = tier;
  const effTier = t === "standard" || t === "shared" ? t : "private";
  const tk: unknown = task;
  const screenshot = !(typeof tk === "string" && NON_SCREENSHOT_TASKS.has(tk));
  const loopback = flag(opts, "loopback");
  const allowPrivate = flag(opts, "allowPrivate");
  const endpointEnabled = flag(opts, "endpointEnabled");
  switch (kind) {
    case "firebase-ondevice":
      return { ok: true };
    case "firebase-cloud":
    case "firebase-hybrid":
      if (screenshot) return deny("CLOUD_PROVIDER_FOR_SCREENSHOT");
      if (effTier === "private") return deny("CLOUD_PROVIDER_FOR_PRIVATE");
      return { ok: true };
    case "local-openai-compatible":
      if (screenshot) return deny("LOCAL_FOR_SCREENSHOT");
      if (!loopback) return deny("LOCAL_NOT_LOOPBACK");
      if (!endpointEnabled) return deny("LOCAL_ENDPOINT_DISABLED");
      if (effTier === "private" && !allowPrivate) return deny("LOCAL_PRIVATE_NOT_ALLOWED");
      return { ok: true };
    case "remote-openai-compatible":
      if (screenshot) return deny("REMOTE_FOR_SCREENSHOT");
      if (effTier === "private") return deny("REMOTE_FOR_PRIVATE");
      if (effTier === "shared") return deny("REMOTE_FOR_SHARED");
      if (!endpointEnabled) return deny("REMOTE_ENDPOINT_DISABLED");
      return { ok: true };
    default:
      return deny("PROVIDER_KIND_UNKNOWN");
  }
}
