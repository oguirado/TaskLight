import type { AgentLifecycleRecord, AgentResult, PlanMicrotask, PlanProjection, PlanTask } from "../plan/types";
import type { RoomEvent } from "../agents/types";
import { deriveActivity } from "./activity";
import { inventoryEvidenceFor } from "../plan/reducer";

export type SwarmRegistration = Readonly<{
  lifecycle?: "deployed" | "alive" | "finished" | "failed";
  run_id?: string; swarm?: string; harness?: string;
}>;
// Compatibility registrations may omit the replay metadata of complete lifecycle records.
type LifecycleRegistration = SwarmRegistration & Readonly<Partial<AgentLifecycleRecord>>;
type LifecycleProjection = PlanProjection & Readonly<{
  agent_lifecycle?: Readonly<Record<string, LifecycleRegistration>>;
}>;

export type AgentInventoryState = "working" | "waiting" | "idle" | "registered" | "finished" | "failed" | "unknown";
export type AgentInventoryRow = Readonly<{
  agent: string; state: AgentInventoryState; run_id: string | null; harness: string | null;
  last_result?: Readonly<{ verdict: AgentResult["verdict"]; summary: string | null; receipt: string | null;
    evidence?: readonly { path: string; sha256: string }[] }> | null;
  parent: Readonly<{ agent: string; run_id: string | null }> | null;
  children: readonly string[]; last_seen_lamport: number | null; last_seen_ts: number | null;
  current: Readonly<{ task_id: string; micro_id: string | null }> | null;
  counts: Readonly<{ tasks_owned: number; micros_done: number; micros_total: number }>;
}>;
export type AgentInventoryTotals = Readonly<Record<AgentInventoryState | "total", number>>;
// Preserve the display interface for existing consumers. The inventory's
// additive runtime fields are described separately by AgentInventoryRow.
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
  const inventory = deriveInventory(input, registrations);
  const members = inventory.agents;
  const questions = unansweredQuestions(input.room, input.events);
  let refreshAt: number | null = inventory.refresh_at_ms;
  const inventorySnapshot = inventory.complete || input.projection === null
    || input.projection.plan === null
    || input.events.some(event => event.room === input.room && event.op?.kind === "plan.open"
      && event.lamport === input.projection?.plan?.opened_lamport)
    || [...registrations.values()].some(value => Number.isSafeInteger(value.lamport) && Number.isFinite(value.ts));

  const agents = members.map((row): SwarmAgentVM => {
    const agent = row.agent;
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
    const display: SwarmAgentVM = {
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
    // Real replay projections expose the complete nullable inventory contract.
    // Older display-only compatibility snapshots keep their optional metadata.
    const { run_id: _run, harness: _harness, ...metadata } = row;
    return Object.assign(display, inventorySnapshot ? row : metadata);
  });
  const view = { room: input.room, agents,
    progress: input.projection ? { ...input.projection.rollup } : null,
    refresh_at_ms: refreshAt };
  // Existing display snapshots compare enumerable fields exactly. Totals remain
  // a directly accessible additive property without changing those snapshots.
  return Object.defineProperty(view, "totals", { value: inventory.totals, enumerable: false });
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


/** A-C2a: lifecycle records and folded task assignees establish membership.
 * Replay evidence retains past assignees without registering authors or beats. */
function deriveInventory(input: Parameters<typeof deriveSwarmViewModel>[0],
  records: ReadonlyMap<string, LifecycleRegistration>,
): { agents: AgentInventoryRow[]; totals: AgentInventoryTotals; refresh_at_ms: number | null; complete: boolean } {
  const first = new Map<string, number>();
  const last = new Map<string, { lamport: number; ts: number }>();
  const deployments = new Map<string, number>();
  const results = new Map<string, { run_id: string; result: AgentResult }>();
  const beats = new Map<string, { run_id: string; ts: number }>();
  const rejected = new Set(input.projection?.rejected.map(event => event.id) ?? []);
  const member = (agent: unknown, lamport: number, compatibility = false) => {
    if (typeof agent === "string" && (compatibility || /^[a-z0-9][a-z0-9._-]{0,47}$/.test(agent))
      && !first.has(agent)) first.set(agent, lamport);
  };
  const ids = new Set<string>();
  const events = input.events.filter(event => event.room === input.room
    && typeof event.id === "string" && Number.isSafeInteger(event.lamport) && event.lamport > 0)
    .slice().sort((a, b) => a.lamport - b.lamport || compareIds(a.id, b.id))
    .filter(event => { if (ids.has(event.id)) return false; ids.add(event.id); return true; });
  const synced = input.connected && events.every((event, i) => event.lamport === i + 1);
  const evidence = inventoryEvidenceFor(input.projection, events);
  for (const event of events) {
    if (rejected.has(event.id)) continue;
    // Cache copies retain the canonical watermark, rejection receipts and
    // current lifecycle metadata even when transient replay provenance is lost.
    if (event.act === "op" && (evidence ? !evidence.admitted.has(event.id)
      : input.projection === null || event.lamport > input.projection.last_lamport
        || event.lamport === input.projection.plan?.opened_lamport && event.op?.kind !== "plan.open")) continue;
    const { agent, lamport, ts } = event;
    if (!/^[a-z0-9][a-z0-9._-]{0,47}$/.test(agent)) continue;
    const op = event.op as Record<string, unknown> | undefined;
    if (event.act === "op" && evidence && !evidence.effective.has(event.id)) continue;
    if (!evidence && op) {
      const receipt = typeof op["op_id"] === "string"
        ? input.projection?.replayed_ops[JSON.stringify([agent, op["op_id"]])] as Record<string, unknown> | undefined
        : undefined;
      if (receipt?.["noop"] === true || receipt?.["ignored"] === true
        || typeof receipt?.["lamport"] === "number" && receipt["lamport"] !== lamport) continue;
      const record = records.get(agent);
      if (op["kind"] === "activity.beat" && (record && (op["run_id"] !== record.run_id
        || record.lifecycle === "failed" || record.lifecycle === "finished")
        || receipt?.["kind"] !== "activity.beat" || receipt["agent"] !== agent || receipt["beat_ts"] !== ts)) continue;
    }
    // A-C2a: admission/effectiveness checks above exclude rejected or replayed
    // claims; an admitted task.claim actually assigns its author to the task.
    if (event.act === "op") {
      if (op?.["kind"] === "agent.lifecycle" || op?.["kind"] === "task.claim") member(agent, lamport);
      if (op?.["kind"] === "task.add") member(op["assignee"], lamport);
    }
    if (op?.["kind"] === "agent.lifecycle") {
      if (op["state"] === "deployed") {
        deployments.set(agent, lamport);
        results.delete(agent);
      } else if ((op["state"] === "finished" || op["state"] === "failed") && op["result"] !== undefined) {
        results.set(agent, { run_id: op["run_id"] as string, result: op["result"] as AgentResult });
      }
    }
    if (op?.["kind"] === "activity.beat" && typeof op["run_id"] === "string") {
      beats.set(agent, { run_id: op["run_id"], ts });
    }
    last.set(agent, { lamport, ts });
  }
  for (const [agent, record] of records) member(agent, record.lamport ?? Number.MAX_SAFE_INTEGER, true);
  const tasks = input.projection?.tasks ?? [];
  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const task of tasks) member(task.assignee, Number.MAX_SAFE_INTEGER, true);
  const fresh = (ts: number | undefined | null): boolean => typeof ts === "number"
    && Number.isFinite(ts) && ts >= 0 && input.nowMs >= ts && input.nowMs - ts <= FRESHNESS_MS;
  const rows = new Map<string, AgentInventoryRow>();
  let refreshAt: number | null = null;
  for (const agent of first.keys()) {
    const record = records.get(agent);
    let runId = record?.run_id ?? beats.get(agent)?.run_id ?? null;
    const owned = tasks.filter(task => task.assignee === agent).slice().sort((a, b) => compareIds(a.id, b.id));
    const unfinished = owned.filter(task => !finished(task));
    const selected = unfinished.find(task => task.microtasks.some(micro => micro.state === "active")) ?? unfinished[0];
    const active = selected?.microtasks.filter(micro => micro.state === "active").slice()
      .sort((a, b) => compareIds(a.id, b.id))[0];
    const lives = unfinished.flatMap(task => task.microtasks.filter(micro => micro.state === "active")
      .map(micro => micro.live).filter((live): live is NonNullable<PlanMicrotask["live"]> =>
        validBeat(live, agent, input.nowMs, record)));
    if (runId === null) runId = lives.slice().sort((a, b) => b.beat_lamport - a.beat_lamport)[0]?.run_id ?? null;
    const beatFresh = lives.some(live => live.run_id === runId && fresh(live.beat_ts));
    const aliveBeat = beats.get(agent);
    const aliveFresh = aliveBeat?.run_id === runId && fresh(aliveBeat?.ts);
    const seen = last.get(agent);
    const lamport = seen?.lamport ?? record?.lamport ?? null;
    const ts = seen?.ts ?? record?.ts ?? null;
    const blocked = unfinished.some(task => task.deps.some(dep => !byId.has(dep) || !finished(byId.get(dep)!)));
    const deployedAt = deployments.get(agent) ?? record?.lamport ?? Number.MAX_SAFE_INTEGER;
    const newWork = unfinished.some(task => Math.max(task.rev, task.claim_lamport ?? 0,
      ...task.microtasks.map(micro => micro.rev)) > deployedAt);
    let state: AgentInventoryState;
    if (record?.lifecycle === "finished" || record?.lifecycle === "failed") state = record.lifecycle;
    else if (!synced || runId === null || !fresh(ts) || !(fresh(record?.ts) || aliveFresh)) state = "unknown";
    else if (record?.lifecycle === "deployed" && !newWork && !aliveFresh) state = "registered";
    else if (blocked) state = "waiting";
    else if (beatFresh) state = "working";
    else if (unfinished.some(task => task.state === "active")) state = "unknown";
    else if (record?.lifecycle === "alive" || aliveFresh) state = "idle";
    else if (record?.lifecycle === "deployed") state = "registered";
    else state = "unknown";
    if (state !== "unknown" && state !== "finished" && state !== "failed" && ts !== null) {
      const evidenceTs = Math.max(record?.ts ?? -Infinity,
        aliveBeat?.run_id === runId ? aliveBeat.ts : -Infinity);
      const expiry = Math.min(ts, evidenceTs) + FRESHNESS_MS + 1;
      if (Number.isFinite(expiry) && (refreshAt === null || expiry < refreshAt)) refreshAt = expiry;
    }
    const source = results.get(agent);
    const result = source?.run_id === runId ? source.result : undefined;
    const lastResult: AgentInventoryRow["last_result"] = result ? {
      verdict: result.verdict, summary: result.summary === undefined ? null : Array.from(result.summary).slice(0, 200).join(""),
      receipt: result.receipt ?? null,
      ...(result.evidence === undefined ? {} : { evidence: result.evidence.slice(0, 8).map(item => ({ ...item })) }),
    } : null;
    rows.set(agent, { agent, state, run_id: runId, harness: record?.harness ?? null, last_result: lastResult,
      parent: record?.parent_agent === undefined ? null
        : { agent: record.parent_agent, run_id: record.parent_run_id ?? null }, children: [],
      last_seen_lamport: lamport, last_seen_ts: ts,
      current: selected ? { task_id: selected.id, micro_id: active?.id ?? null } : null,
      counts: { tasks_owned: owned.length,
        micros_done: owned.reduce((n, task) => n + task.microtasks.filter(micro => micro.state === "done").length, 0),
        micros_total: owned.reduce((n, task) => n + task.microtasks.length, 0) },
    });
  }
  const children = new Map<string, string[]>();
  for (const row of rows.values()) {
    if (row.parent && rows.has(row.parent.agent)) {
      const siblings = children.get(row.parent.agent) ?? [];
      siblings.push(row.agent); children.set(row.parent.agent, siblings);
    }
  }
  for (const [agent, siblings] of children) rows.set(agent, { ...rows.get(agent)!, children: siblings.slice().sort(compareIds) });
  const order = (a: string, b: string) => first.get(a)! - first.get(b)! || compareIds(a, b);
  const roots = [...rows.values()].filter(row => !row.parent || !rows.has(row.parent.agent)).map(row => row.agent).sort(order);
  const stack = roots.reverse();
  const agents: AgentInventoryRow[] = [];
  const visited = new Set<string>();
  while (stack.length) {
    const agent = stack.pop()!;
    if (visited.has(agent)) continue;
    visited.add(agent); agents.push(rows.get(agent)!);
    stack.push(...(children.get(agent) ?? []).slice().sort(order).reverse());
  }
  for (const agent of [...rows.keys()].sort(order)) if (!visited.has(agent)) agents.push(rows.get(agent)!);
  const totals: Record<AgentInventoryState | "total", number> = {
    working: 0, waiting: 0, idle: 0, registered: 0, finished: 0, failed: 0, unknown: 0, total: agents.length,
  };
  for (const row of agents) totals[row.state] += 1;
  return { agents, totals, refresh_at_ms: refreshAt, complete: evidence !== undefined };
}
