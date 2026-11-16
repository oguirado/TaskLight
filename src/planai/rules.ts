import type { DriftVerdict } from "../agents/types";
import type { PlanTaskInput, PlanBriefInput, PlanBrief } from "./types";
import { PLANAI_LIMITS } from "./types";

function cleanBriefPart(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
}

function fitBrief(value: string): string {
  const oneLine = value.replace(/[\r\n]+/g, " ");
  if (oneLine.length <= PLANAI_LIMITS.BRIEF_LINE_MAX) return oneLine;
  return oneLine.slice(0, PLANAI_LIMITS.BRIEF_LINE_MAX - 3) + "...";
}

export function reviewTaskRules(task: PlanTaskInput): DriftVerdict {
  const t = task as unknown as Record<string, unknown>;
  const taskId = typeof t["id"] === "string" && t["id"] !== "" ? t["id"] : "task";
  const status = typeof t["status"] === "string" ? t["status"] : "";
  const rawMicros: unknown[] = Array.isArray(t["microtasks"]) ? (t["microtasks"] as unknown[]) : [];

  if (status === "blocked") {
    return { verdict: "needs_user", reason: `Task ${taskId} is blocked and needs operator input`, source: "rules" };
  }

  for (const m of rawMicros) {
    const r = (m ?? {}) as Record<string, unknown>;
    if (r["state"] === "blocked") {
      const mid = typeof r["id"] === "string" && r["id"] !== "" ? r["id"] : "microtask";
      return { verdict: "needs_user", reason: `Microtask ${mid} is blocked and needs operator input`, source: "rules" };
    }
  }

  if (status === "cancelled") {
    return { verdict: "on_track", reason: `Task ${taskId} is cancelled`, source: "rules" };
  }

  if (rawMicros.length === 0) {
    return { verdict: "needs_user", reason: `Task ${taskId} has no microtasks to review`, source: "rules" };
  }

  const isDone = (m: unknown): boolean => (m as Record<string, unknown>)?.["state"] === "done";
  const outcomeOf = (m: unknown): string => {
    const r = (m ?? {}) as Record<string, unknown>;
    return typeof r["outcome"] === "string" ? r["outcome"] : "";
  };

  for (const m of rawMicros) {
    if (isDone(m) && outcomeOf(m).trim() === "") {
      const r = (m ?? {}) as Record<string, unknown>;
      const mid = typeof r["id"] === "string" && r["id"] !== "" ? r["id"] : "microtask";
      return { verdict: "drift", reason: `Microtask ${mid} is done without a recorded outcome`, source: "rules" };
    }
  }

  const acceptText = typeof t["accept"] === "string" ? t["accept"] : "";
  const allDone = rawMicros.every((m) => isDone(m));
  const anyOutcome = rawMicros.some((m) => outcomeOf(m).trim() !== "");
  if (acceptText.trim() !== "" && allDone && !anyOutcome) {
    return { verdict: "drift", reason: "All microtasks done but no outcomes recorded against acceptance", source: "rules" };
  }

  const doneCount = rawMicros.filter((m) => isDone(m)).length;
  if (allDone) {
    return { verdict: "on_track", reason: `All ${rawMicros.length} microtasks done with outcomes recorded`, source: "rules" };
  }
  return { verdict: "on_track", reason: `Progress ${doneCount} of ${rawMicros.length} done; on track`, source: "rules" };
}

export function briefPlanRules(plan: PlanBriefInput): PlanBrief {
  const p = plan as unknown as Record<string, unknown>;
  const status = typeof p["status"] === "string" ? p["status"] : "";
  const rawTasks: unknown[] = Array.isArray(p["tasks"]) ? (p["tasks"] as unknown[]) : [];

  interface Rollup {
    id: string;
    title: string;
    state: string;
    ready: boolean;
    waitsFor: string[];
  }
  const rollups: Rollup[] = rawTasks.map((t) => {
    const r = (t ?? {}) as Record<string, unknown>;
    const wfRaw = Array.isArray(r["waitsFor"]) ? (r["waitsFor"] as unknown[]) : [];
    return {
      id: typeof r["id"] === "string" ? cleanBriefPart(r["id"]) : "",
      title: typeof r["title"] === "string" ? cleanBriefPart(r["title"]) : "",
      state: typeof r["state"] === "string" ? r["state"] : "",
      ready: r["ready"] === true,
      waitsFor: wfRaw.filter((w): w is string => typeof w === "string").map((w) => cleanBriefPart(w)).filter((w) => w !== ""),
    };
  });

  if (status === "closed") {
    const blockedList = rollups.filter((r) => r.state !== "done" && r.state !== "cancelled" && (r.state === "blocked" || r.waitsFor.length > 0));
    const suffix = blockedList.length > 0
      ? blockedList.map((b) => `${b.id} waits for ${b.waitsFor.join(",") || "operator"}`).join("; ")
      : "0 blocked";
    return { brief: fitBrief(`Next: closed; ${suffix}`), source: "rules" };
  }

  const nextTask = rollups.find((r) => r.state === "active") ?? rollups.find((r) => r.ready && r.state !== "blocked" && r.state !== "done" && r.state !== "cancelled" && r.waitsFor.length === 0);
  const nextPart = nextTask !== undefined ? `${nextTask.id} ${nextTask.title}`.trim() : "none";
  const blockedList = rollups.filter((r) => r.state !== "done" && r.state !== "cancelled" && (r.state === "blocked" || r.waitsFor.length > 0));
  const blockedPart = blockedList.length > 0
    ? blockedList.map((b) => `${b.id} waits for ${b.waitsFor.join(",") || "operator"}`).join("; ")
    : "0 blocked";
  return { brief: fitBrief(`Next: ${nextPart}; ${blockedPart}`), source: "rules" };
}
