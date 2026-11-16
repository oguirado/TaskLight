import type { DriftVerdict } from "../agents/types";
import type { JsonSchema } from "../schema/types";
import { PLANAI_LIMITS } from "./types";

export const TASK_REVIEW_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["on_track", "drift", "needs_user"] },
    reason: { type: "string" },
  },
  required: ["verdict", "reason"],
};

export const PLAN_BRIEF_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    brief: { type: "string" },
  },
  required: ["brief"],
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cleanOutputText(value: string, maxLen: number): string {
  const spaced = value.replace(/[\x00-\x1f\x7f]/g, " ");
  const collapsed = spaced.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "";
  if (collapsed.length <= maxLen) return collapsed;
  return collapsed.slice(0, maxLen - 3) + "...";
}

export function parseTaskReviewOutput(
  raw: string,
): { ok: true; value: { verdict: DriftVerdict["verdict"]; reason: string } } | { ok: false; code: "bad_json" | "schema_reject" } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw as string);
  } catch {
    return { ok: false, code: "bad_json" };
  }
  if (!isRecord(parsed)) return { ok: false, code: "schema_reject" };
  const verdict = parsed["verdict"];
  const reason = parsed["reason"];
  if (typeof verdict !== "string" || typeof reason !== "string") return { ok: false, code: "schema_reject" };
  if (verdict !== "on_track" && verdict !== "drift" && verdict !== "needs_user") return { ok: false, code: "schema_reject" };
  const cleaned = cleanOutputText(reason, PLANAI_LIMITS.REASON_MAX);
  if (cleaned === "") return { ok: false, code: "schema_reject" };
  return { ok: true, value: { verdict, reason: cleaned } };
}

export function parsePlanBriefOutput(
  raw: string,
): { ok: true; value: { brief: string } } | { ok: false; code: "bad_json" | "schema_reject" } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw as string);
  } catch {
    return { ok: false, code: "bad_json" };
  }
  if (!isRecord(parsed)) return { ok: false, code: "schema_reject" };
  const brief = parsed["brief"];
  if (typeof brief !== "string") return { ok: false, code: "schema_reject" };
  const cleaned = cleanOutputText(brief, PLANAI_LIMITS.BRIEF_LINE_MAX);
  if (cleaned === "") return { ok: false, code: "schema_reject" };
  return { ok: true, value: { brief: cleaned } };
}
