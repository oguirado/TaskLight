import type { PlanMicrotask, PlanTask } from "../plan/types";

export function deriveActivity(
  task: PlanTask,
  micro: PlanMicrotask | undefined,
  nowMs: number,
  opts?: { connected?: boolean; needsYou?: boolean },
): "idle" | "working" | "done" | "blocked" | "waiting" | "needs_you" | "unknown" | "cancelled" {
  if (task.state === "cancelled" || task.explicit_state === "cancelled") return "cancelled";
  const children = task.microtasks;
  if (micro?.state === "done" || (micro === undefined && (task.state === "done" || (children.length > 0 && children.every((m) => m.state === "done"))))) return "done";
  if (task.state === "blocked" || task.explicit_state === "blocked" || micro?.state === "blocked"
    || (micro === undefined && children.some((m) => m.state === "blocked"))) return "blocked";
  if (task.ready === false) return "waiting";
  if (opts?.needsYou === true) return "needs_you";

  const active = micro === undefined ? children.filter((m) => m.state === "active") : micro.state === "active" ? [micro] : [];
  if (active.length === 0) return "idle";
  if (opts?.connected === false || !task.assignee || !Number.isFinite(nowMs)) return "unknown";
  const working = active.some((m) => {
    const live = m.live;
    if (!live || live.agent !== task.assignee || typeof live.run_id !== "string"
      || /^[A-Za-z0-9_-]{1,64}$/.exec(live.run_id)?.[0] !== live.run_id || !Number.isFinite(live.beat_ts)
      || live.beat_ts < 0 || !Number.isSafeInteger(live.beat_lamport)) return false;
    const age = nowMs - live.beat_ts;
    return Number.isFinite(age) && age >= 0 && age <= 90_000;
  });
  return working ? "working" : "unknown";
}
