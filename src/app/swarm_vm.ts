import type { PlanMicrotask, PlanProjection, PlanTask } from "../plan/types";
import type { RoomEvent } from "../agents/types";
import { deriveActivity } from "./activity";

export type SwarmRegistration = Readonly<{
  lifecycle?: "deployed" | "alive" | "finished" | "failed";
  run_id?: string; swarm?: string; harness?: string;
}>;
// Structural seam until lifecycle becomes part of the shared projection contract.
type LifecycleRegistration = SwarmRegistration & Readonly<{ reason?: string }>;
type LifecycleProjection = PlanProjection & Readonly<{
  agent_lifecycle?: Readonly<Record<string, LifecycleRegistration>>;
}>;

export type SwarmAgentVM = SwarmRegistration & Readonly<{
  agent: string; tasks: readonly PlanTask[];
  current_task_id: string | null; active_micro_id: string | null;
  micro_done: number | null; micro_total: number | null;
  activity: ReturnType<typeof deriveActivity>;
  last_beat_ts: number | null; last_beat_age_ms: number | null;
  waiting_on: readonly Readonly<{
    task_id: string; upstream_id: string;
    owner: string | null; missing: boolean;
  }>[];
  unanswered_questions: number;
}>;
export type SwarmViewModel = Readonly<{
  room: string; agents: readonly SwarmAgentVM[];
  progress: PlanProjection["rollup"] | null;
  refresh_at_ms: number | null;
}>;

export function deriveSwarmViewModel(input: {
  room: string;
  projection: PlanProjection | null;
  events: readonly RoomEvent[];
  nowMs: number;
  connected: boolean;
  agents?: Readonly<Record<string, SwarmRegistration>>;
}): SwarmViewModel {
  const tasksById = new Map<string, PlanTask>();
  const tasksByAgent = new Map<string, PlanTask[]>();
  const registrations = new Map<string, LifecycleRegistration>(Object.entries(input.agents ?? {}));
  const committed = (input.projection as LifecycleProjection | null)?.agent_lifecycle;
  for (const [slug, registration] of Object.entries(committed ?? {})) {
    // A committed record replaces every compatibility field, including omissions.
    registrations.set(slug, registration);
  }
  for (const task of input.projection?.tasks ?? []) {
    tasksById.set(task.id, task);
    if (task.assignee == null) continue;
    const owned = tasksByAgent.get(task.assignee) ?? [];
    owned.push(task);
    tasksByAgent.set(task.assignee, owned);
  }
  const members = new Set([...tasksByAgent.keys(), ...registrations.keys()]);
  const questions = unansweredQuestions(input.room, input.events);
  let refreshAt: number | null = null;

  const agents = [...members].sort(compareIds).map((agent): SwarmAgentVM => {
    const registration = registrations.get(agent);
    const tasks = (tasksByAgent.get(agent) ?? []).sort((a, b) => compareIds(a.id, b.id));
    const unfinished = tasks.filter(task => !finished(task));
    const selected = unfinished.find(task => task.microtasks.some(micro => micro.state === "active"))
      ?? unfinished[0] ?? tasks[0];
    const active = selected?.microtasks.filter(micro => micro.state === "active")
      .sort((a, b) => compareIds(a.id, b.id))[0];
    let lastBeat: number | null = null;
    // Preserve the original projection in each row; sanitize only the activity input.
    const sanitized: PlanTask | undefined = selected && {
      ...selected,
      microtasks: selected.microtasks.map(micro => {
        if (validBeat(micro.live, selected.assignee, input.nowMs, registration)) {
          const ts = micro.live.beat_ts;
          if (lastBeat === null || ts > lastBeat) lastBeat = ts;
          if (input.nowMs - ts <= FRESHNESS_MS) return micro;
        }
        const { live: _live, ...withoutLive } = micro;
        return withoutLive;
      }),
    };
    const activity = sanitized
      ? deriveActivity(sanitized, undefined, input.nowMs, { connected: input.connected })
      : "idle";
    if (input.connected === true && activity === "working" && sanitized) {
      for (const micro of sanitized.microtasks) {
        if (micro.state !== "active" || !micro.live) continue;
        const expiry = micro.live.beat_ts + FRESHNESS_MS + 1;
        if (refreshAt === null || expiry < refreshAt) refreshAt = expiry;
      }
    }

    const waitingOn: SwarmAgentVM["waiting_on"][number][] = [];
    for (const task of unfinished) {
      for (const upstreamId of [...task.deps].sort(compareIds)) {
        const upstream = tasksById.get(upstreamId);
        if (upstream && finished(upstream)) continue;
        waitingOn.push({ task_id: task.id, upstream_id: upstreamId,
          owner: upstream?.assignee ?? null, missing: upstream === undefined });
      }
    }
    return {
      ...registration,
      agent, tasks,
      current_task_id: selected?.id ?? null,
      active_micro_id: active?.id ?? null,
      micro_done: selected ? selected.microtasks.filter(micro => micro.state === "done").length : null,
      micro_total: selected ? selected.microtasks.length : null,
      activity,
      last_beat_ts: lastBeat,
      last_beat_age_ms: lastBeat === null ? null : input.nowMs - lastBeat,
      waiting_on: waitingOn,
      unanswered_questions: questions.get(agent) ?? 0,
    };
  });
  return { room: input.room, agents,
    progress: input.projection ? { ...input.projection.rollup } : null,
    refresh_at_ms: refreshAt };
}

const FRESHNESS_MS = 90_000;

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function finished(task: PlanTask): boolean {
  return task.state === "done" || task.state === "cancelled";
}

/** Stale evidence remains observable, but future or malformed evidence never does. */
function validBeat(
  live: PlanMicrotask["live"], owner: string | null, nowMs: number,
  registration: SwarmRegistration | undefined,
): live is NonNullable<PlanMicrotask["live"]> {
  if (!live || owner === null || live.agent !== owner || !Number.isFinite(nowMs)
    || typeof live.run_id !== "string" || live.run_id.length === 0 || live.run_id.length > 64
    || /[^A-Za-z0-9_-]/.test(live.run_id) || !Number.isFinite(live.beat_ts) || live.beat_ts < 0
    || !Number.isSafeInteger(live.beat_lamport) || live.beat_lamport <= 0) return false;
  if (registration !== undefined && (registration.lifecycle === "failed"
    || registration.lifecycle === "finished" || live.run_id !== registration.run_id)) return false;
  const age = nowMs - live.beat_ts;
  return Number.isFinite(age) && age >= 0;
}

/** Count only loaded same-room history; recipients never establish membership. */
function unansweredQuestions(room: string, events: readonly RoomEvent[]): ReadonlyMap<string, number> {
  const byId = new Map<string, RoomEvent>();
  for (const event of events) {
    if (event.room === room && !byId.has(event.id)) byId.set(event.id, event);
  }
  const cleared = new Set<string>();
  for (const answer of byId.values()) {
    if (answer.act !== "answer") continue;
    const visited = new Set([answer.id]);
    const addressed: string[] = [];
    let reference = answer.re;
    let cyclic = false;
    while (reference !== undefined) {
      if (visited.has(reference)) {
        cyclic = true;
        break;
      }
      const parent = byId.get(reference);
      if (!parent) break;
      visited.add(reference);
      if (parent.act === "question" && parent.to === answer.agent) addressed.push(parent.id);
      reference = parent.re;
    }
    // Missing older history cannot invalidate a reached question; cycles still do.
    if (!cyclic) for (const id of addressed) cleared.add(id);
  }
  const counts = new Map<string, number>();
  for (const question of byId.values()) {
    if (question.act !== "question" || question.to === undefined || cleared.has(question.id)) continue;
    counts.set(question.to, (counts.get(question.to) ?? 0) + 1);
  }
  return counts;
}
