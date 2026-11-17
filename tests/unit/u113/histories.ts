import type { RoomEvent } from "../../../src/agents/types";
import { event, fixture, opEvent } from "../u85/helpers";

export const SEEDS = [0x113, 0x85, 0xcafe] as const;
export const CLOCK = 1_700_000_010_000;

export function roomHistory(room: string, offset: number): RoomEvent[] {
  const original = fixture();
  const op = (n: number, body: Record<string, unknown>, agent = "alice") =>
    ({ ...opEvent(offset + n, body), room, agent, lamport: n });
  const legacy = (n: number, extra: Record<string, unknown> = {}) =>
    event(offset + n, { room, lamport: n, ...extra });
  return [
    op(1, { kind: "memory.set", section: "goal", text: "before plan", base_rev: 0 }),
    op(2, { ...original[0]!.op! }),
    op(3, { ...original[1]!.op! }),
    op(4, { ...original[2]!.op! }),
    op(5, { kind: "task.claim", task_id: "T01" }),
    op(6, { kind: "micro.set", micro_id: "T01.M01", state: "active" }),
    op(7, { kind: "activity.beat", task_id: "T01", micro_id: "T01.M01",
      run_id: "run_1", op_id: "beat_113" }),
    op(8, { kind: "memory.set", section: "goal", text: "during plan", base_rev: 1 }),
    op(9, { ...original[6]!.op! }),
    op(10, { ...original[7]!.op! }),
    // A-U113a: exercise release/reclaim on pending T02; U109 MUST M5 forbids releasing terminal T01.
    op(11, { kind: "task.release", task_id: "T02" }),
    op(12, { kind: "task.claim", task_id: "T02" }, "bob"),
    op(13, { kind: "task.release", task_id: "T02" }, "bob"),
    op(14, { kind: "memory.set", section: "notes", text: "room memory", base_rev: 0 }),
    // A-U113a: cancel unassigned T02 before close; U109 MUST M6 requires every task terminal.
    { ...op(27, { kind: "task.set", task_id: "T02", state: "cancelled", base_rev: 13 }), lamport: 14 },
    op(15, { kind: "plan.close", base_rev: 2, outcome: "first complete" }),
    op(16, { kind: "memory.set", section: "goal", text: "while closed", base_rev: 8 }),
    op(17, { ...original[0]!.op!, title: "Reopened" }),
    op(18, { kind: "memory.set", section: "goal", text: "after reopen", base_rev: 16 }),
    legacy(19, { act: "plan", plan: { title: "Legacy work", steps: [{ text: "Check", accept: "Seen" }] } }),
    legacy(20, { act: "step", step: { index: 0, state: "active" } }),
    legacy(21, { act: "question", text: "Ready?" }),
    legacy(22, { act: "answer", agent: "bob", re: event(offset + 21).id, text: "Ready" }),
    legacy(23, { text: "tie-low" }),
    op(24, { kind: "memory.set", section: "goal", text: "stale", base_rev: 0 }),
    op(25, { kind: "task.claim", task_id: "T03" }),
    legacy(26, { lamport: 23, text: "tie-high" }),
  ];
}

export function arrivals(seed: number): RoomEvent[] {
  const events = [
    ...roomHistory("zeta", 1000), ...roomHistory("demo", 2000),
    event(3000, { room: "only-legacy", act: "question", text: "legacy only" }),
  ];
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  for (let i = events.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [events[i], events[j]] = [events[j]!, events[i]!];
  }
  // Duplicates occur mid-history as well as after full replay.
  events.splice(3, 0, structuredClone(events[0]!));
  events.splice(17, 0, structuredClone(events[9]!));
  events.push(structuredClone(events[1]!));
  return events;
}

// Frozen return values are an equally valid way to protect cache internals.
export function tryMutation(action: () => void): void {
  try { action(); } catch (error) { if (!(error instanceof TypeError)) throw error; }
}
export type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
