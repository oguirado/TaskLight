// Independent full-history oracle. Deliberately never reads candidate events().
import { readFileSync } from "node:fs";
import { foldPlan } from "../../../src/plan";
import { foldRoomWithStats } from "../../../src/agents";
import { createAgentStore } from "../../../src/app/agent_store";
import type { AgentStore, AgentStoreOptions, PlanProjectionResult, TemplateResolver } from "../../../src/app/agent_store";
import type { RoomEvent } from "../../../src/agents/types";
import type { PlanningTemplate } from "../../../src/plan";

const frozenFixture = readFileSync(new URL("../u85/fixture.json", import.meta.url), "utf8");
export const template: PlanningTemplate = (JSON.parse(frozenFixture) as { template: PlanningTemplate }).template;
export const fixture = (): RoomEvent[] => (JSON.parse(frozenFixture) as { events: RoomEvent[] }).events;
export const BASE = 1_700_000_000_000;
export const id = (n: number): string => `e-${n.toString(16).padStart(16, "0")}`;
export const event = (n: number, extra: Partial<RoomEvent> = {}): RoomEvent => ({
  id: id(n), room: "demo", agent: "alice", act: "heartbeat", text: "", ts: BASE + n, lamport: n, ...extra,
});
export const op = (n: number, body: Record<string, unknown>, extra: Partial<RoomEvent> = {}): RoomEvent =>
  event(n, { act: "op", op: body, ...extra } as Partial<RoomEvent>);
export const beat = (n: number, extra: Partial<RoomEvent> = {}, run = "run_1"): RoomEvent => op(n, {
  kind: "activity.beat", task_id: "T01", micro_id: "T01.M01", run_id: run, op_id: `beat_${n.toString().padStart(8, "0")}`,
}, extra);
export const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
export const compare = (a: RoomEvent, b: RoomEvent): number => a.lamport - b.lamport || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export const pinned = (e: RoomEvent): boolean => e.act === "op" && e.op?.["kind"] !== "activity.beat";
export type Options = AgentStoreOptions & { maxBytesPerRoom?: number };
// Structural options allow the additive option to compile before implementation.
export const makeStore = (options: Options = {}): AgentStore => createAgentStore({ templates: () => template, ...options });

export function display(history: readonly RoomEvent[], count = 5000, budget = 16 * 1024 * 1024): RoomEvent[] {
  const first = new Map<string, RoomEvent>();
  for (const e of history) if (!first.has(e.id)) first.set(e.id, e);
  const unique = [...first.values()];
  const recent = unique.filter(e => !pinned(e)).sort(compare);
  let size = recent.reduce((sum, e) => sum + bytes(e), 0);
  while (recent.length > count || size > budget) size -= bytes(recent.shift()!);
  return [...unique.filter(pinned), ...recent].sort(compare);
}

export class FullHistory {
  readonly history: RoomEvent[] = [];
  readonly ids = new Set<string>();
  constructor(readonly resolver: TemplateResolver = () => template) {}
  accept(e: RoomEvent): "accepted" | "duplicate" {
    if (this.ids.has(e.id)) return "duplicate";
    this.ids.add(e.id); this.history.push(structuredClone(e)); return "accepted";
  }
  plan(room: string): PlanProjectionResult | undefined {
    const sorted = this.history.filter(e => e.room === room).sort(compare);
    if (!sorted.some(e => e.act === "op")) return undefined;
    const opening = sorted.filter(e => e.op?.["kind"] === "plan.open").at(-1)?.op;
    let resolved: PlanningTemplate | undefined;
    try {
      if (opening) {
        const candidate = this.resolver(String(opening["template_id"]), String(opening["template_hash"]));
        if (candidate?.hash === opening["template_hash"]) resolved = candidate;
      }
    } catch { /* Match existing resolver failure semantics. */ }
    const folded = resolved === undefined ? foldPlan(sorted) : foldPlan(sorted, resolved);
    return structuredClone({ room, source: "v2", projection: folded.projection, invalidOps: folded.stats.invalid,
      rejectedOps: folded.stats.rejected, errors: folded.stats.errors, ...(resolved === undefined ? {} : { template: resolved }) });
  }
  plans(): PlanProjectionResult[] {
    return [...new Set(this.history.map(e => e.room))].sort().flatMap(room => {
      const result = this.plan(room); return result === undefined ? [] : [result];
    });
  }
  states() { return foldRoomWithStats(this.history).states; }
  since(): Record<string, number> {
    const high: Record<string, number> = {};
    for (const e of this.history) high[e.room] = Math.max(high[e.room] ?? 0, e.lamport);
    return high;
  }
}

export function takeoverHistory(): RoomEvent[] {
  // Same fixture and values as the unchanged U85 retention/owner-activity case.
  return [...fixture().slice(0, 4), event(10, { ts: BASE + 600_000 }),
    ...[11, 12, 13].map(n => event(n, { agent: "bob" })),
    op(20, { kind: "task.claim", task_id: "T01", takeover: true }, { agent: "bob", ts: BASE + 700_000 })];
}

export function generatedRoom(room: string, offset: number): RoomEvent[] {
  const f = fixture();
  const local = (e: RoomEvent): RoomEvent => ({ ...e, id: id(offset + e.lamport), room });
  const first = f.slice(0, 7).map(local);
  const secondTask = first[2]!.op as Record<string, unknown>;
  secondTask["deps"] = ["T01"];
  return [...first,
    local(beat(8)), local(beat(9, {}, "run_2")), local(beat(10, {}, "run_1")),
    local(op(11, { kind: "task.claim", task_id: "T02" })),
    local(op(12, { kind: "micro.set", micro_id: "T02.M01", state: "active" })),
    local(op(13, { kind: "task.release", task_id: "T01", claim_lamport: 4 })),
    local(op(14, { kind: "task.claim", task_id: "T01" })),
    local(op(15, { kind: "micro.set", micro_id: "T01.M01", state: "active", claim_lamport: 4 })),
    local(op(16, { kind: "memory.set", section: "notes", text: "first", base_rev: 0, op_id: "memory_repeat" })),
    local(op(17, { kind: "memory.set", section: "notes", text: "first", base_rev: 0, op_id: "memory_repeat" })),
    local(op(18, { kind: "memory.set", section: "notes", text: "second", base_rev: 16 })),
    local({ ...f[7]!, id: id(19), lamport: 19 }),
    local(op(20, { kind: "task.set", task_id: "T02", state: "cancelled", base_rev: 11 })),
    local(op(21, { kind: "plan.close", base_rev: 1, outcome: "complete" })),
    local(op(22, { ...f[0]!.op!, title: "Reopened" })),
    local(event(23, { act: "plan", plan: { title: "legacy", steps: [{ text: "check", accept: "seen" }] } })),
    local(event(24, { act: "step", step: { index: 0, state: "active" } })),
    local(event(25, { act: "question", text: "ready?" })),
    local(event(26, { act: "answer", re: id(offset + 25), agent: "bob", text: "yes" })),
    local(event(27, { act: "close" })),
    local(event(28, { act: "plan", plan: { title: "new legacy", steps: [{ text: "next" }] } })),
    { ...local(event(29, { text: "tie-low", ts: BASE + 900_000 })), lamport: 28 },
    local(event(30, { text: "timestamp regression", ts: BASE - 100 })),
  ];
}

export function arrivals(seed: number, reversed = false): RoomEvent[] {
  const history = [...generatedRoom("demo", 1000), ...generatedRoom("zeta", 2000),
    event(3000, { room: "legacy-only", act: "question", text: "still open" })];
  let state = seed >>> 0;
  for (let i = history.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1); [history[i], history[j]] = [history[j]!, history[i]!];
  }
  if (reversed) history.sort((a, b) => -compare(a, b));
  history.splice(5, 0, structuredClone(history[0]!));
  history.push(structuredClone(history[9]!));
  return history;
}
