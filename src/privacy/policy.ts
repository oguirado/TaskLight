import type { InferenceSource, PrivacyTier, TaskId } from "../schema";
import type { ModeName } from "../ai";
import type { PolicyResult } from "./types";

const VALID_MODES: ReadonlySet<string> = new Set<string>([
  "PREFER_ON_DEVICE",
  "ONLY_ON_DEVICE",
  "PREFER_IN_CLOUD",
  "ONLY_IN_CLOUD",
]);

const VALID_SOURCES: ReadonlySet<string> = new Set<string>(["ON_DEVICE", "IN_CLOUD"]);

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
  if (m === "ONLY_ON_DEVICE" && s === "IN_CLOUD") {
    return { ok: false, violation: "CLOUD_SOURCE_FOR_ON_DEVICE_ONLY" };
  }
  return { ok: true };
}
