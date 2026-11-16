import type { PlanProjectionResult } from "./agent_store";
import type { RoomPlanSnapshot } from "./plan_wiring";
import type { PlanMicrotask, PlanTask } from "../plan";
import { getTemplateMemorySections } from "./starter_templates";

export function buildPlanSnapshots(plans: readonly PlanProjectionResult[]): readonly RoomPlanSnapshot[] {
  try {
    const out: RoomPlanSnapshot[] = [];
    for (const entry of Array.isArray(plans) ? plans : []) {
      try {
        const projection = entry.projection;
        const plan = projection?.plan ?? null;
        const srcTasks: readonly PlanTask[] = Array.isArray(projection?.tasks) ? projection.tasks : [];
        let doneMicrotasks = 0;
        let totalMicrotasks = 0;
        const tasks = srcTasks.map((t: PlanTask) => {
          const micros: readonly PlanMicrotask[] = Array.isArray(t.microtasks) ? t.microtasks : [];
          totalMicrotasks += micros.length;
          for (const m of micros) if (m?.state === "done") doneMicrotasks += 1;
          return {
            id: t.id,
            title: t.title,
            type: t.type,
            phase: t.phase,
            accept: t.accept,
            status: t.state,
            deps: Array.isArray(t.deps) ? [...t.deps] : [],
            rev: typeof t.rev === "number" ? t.rev : 0,
            microtasks: micros.map((m: PlanMicrotask) => {
              const micro: { id: string; text: string; state: PlanMicrotask["state"]; accept?: string; outcome?: string } = {
                id: m.id,
                text: m.text,
                state: m.state,
              };
              if (typeof m.accept === "string" && m.accept.length > 0) micro.accept = m.accept;
              if (typeof m.outcome === "string" && m.outcome.length > 0) micro.outcome = m.outcome;
              return micro;
            }),
          };
        });
        const snap: RoomPlanSnapshot = {
          room: entry.room,
          planId: plan?.id ?? "p1",
          title: plan?.title ?? "",
          phase: plan?.phase ?? "plan",
          status: plan?.state ?? "active",
          // Task and microtask ops advance the projection, not the plan header.
          rev: projection.last_lamport,
          doneMicrotasks,
          totalMicrotasks,
          tasks,
        };
        const mem = projection?.memory;
        if (mem !== null && typeof mem === "object") {
          const ids = Object.keys(mem).sort();
          if (ids.length > 0) {
            const first = mem[ids[0] as string];
            if (first !== undefined) {
              const meta = plan?.template_id !== undefined ? getTemplateMemorySections(plan.template_id)?.find((s) => s.id === first.id) : undefined;
              snapWithMemory(snap, { id: first.id, label: meta?.label ?? first.id, text: first.text, rev: typeof first.rev === "number" ? first.rev : 0 });
            }
          }
        }
        out.push(snap);
      } catch {
        /* skip malformed plan entries */
      }
    }
    return out;
  } catch {
    return [];
  }
}
function snapWithMemory(snap: RoomPlanSnapshot, memory: NonNullable<RoomPlanSnapshot["memorySection"]>): void {
  (snap as unknown as Record<string, unknown>)["memorySection"] = memory;
}
