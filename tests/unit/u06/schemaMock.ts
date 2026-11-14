// Deterministic stand-in for src/schema (U05 is still an oracle-phase STUB in the repo: accept-all validator,
// one shared schema object). U06 tests mock "../schema" with this so they exercise U06 only.
import { vi } from "vitest";

type Sch = { mimeType: "application/json" | "text/x.enum"; schema: Record<string, unknown> };
const STATUS = ["running", "waiting_input", "blocked", "failed", "done", "idle"];
const ATT = ["none", "low", "high", "now"];

export const TASK_SCHEMAS: Record<string, Sch> = {
  status: { mimeType: "text/x.enum", schema: { type: "string", enum: STATUS } },
  summary: { mimeType: "application/json", schema: { type: "object", properties: { headline: { type: "string" }, summary: { type: "string" } }, required: ["headline", "summary"] } },
  next_action: { mimeType: "application/json", schema: { type: "object", properties: { next_action: { type: "string" }, attention: { type: "string", enum: ATT } }, required: ["next_action", "attention"] } },
  screenshot: { mimeType: "application/json", schema: { type: "object", properties: { status: { type: "string", enum: STATUS }, note: { type: "string" } }, required: ["status", "note"] } },
  digest: { mimeType: "application/json", schema: { type: "object", properties: { needs_you: { type: "array" }, brief: { type: "string" } }, required: ["needs_you", "brief"] } },
};
const FIELDS: Record<string, string[]> = {
  summary: ["headline", "summary"], next_action: ["next_action", "attention"],
  screenshot: ["status", "note"], digest: ["needs_you", "brief"],
};
type Rej = { code: string; path: string };
export const validateTaskOutput = vi.fn((task: string, raw: string, _ctx?: unknown) => {
  if (task === "status") {
    const v = raw.trim();
    return STATUS.includes(v) ? { ok: true as const, value: { status: v } }
      : { ok: false as const, errors: [{ code: "ENUM_VIOLATION", path: "status" }] };
  }
  let o: Record<string, unknown>;
  try { o = JSON.parse(raw) as Record<string, unknown>; } catch {
    return { ok: false as const, errors: [{ code: "PARSE_ERROR", path: "" }] };
  }
  const errors: Rej[] = [];
  const allowed = FIELDS[task] ?? [];
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push({ code: "UNKNOWN_FIELD", path: k });
  for (const k of allowed) if (!(k in o)) errors.push({ code: "MISSING_FIELD", path: k });
  return errors.length ? { ok: false as const, errors } : { ok: true as const, value: o };
});
export const validateInferenceSource = vi.fn();
export const validateCapsuleState = vi.fn();
export const validatePatch = vi.fn();
export const LIMITS = {};
export const CAPSULE_STATUS = STATUS;
export const ATTENTION = ATT;
export const PRIVACY_TIER = ["private", "standard", "shared"];
export const INFERENCE_SOURCE = ["ON_DEVICE", "IN_CLOUD"];

export const VALID: Record<string, string> = {
  status: "running",
  summary: JSON.stringify({ headline: "h", summary: "s" }),
  next_action: JSON.stringify({ next_action: "do x", attention: "low" }),
  screenshot: JSON.stringify({ status: "idle", note: "n" }),
  digest: JSON.stringify({ needs_you: [], brief: "b" }),
};
