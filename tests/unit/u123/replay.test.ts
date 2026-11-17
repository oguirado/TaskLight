// @vitest-environment node
import { describe, expect, it } from "vitest";
import { foldPlan } from "../../../src/plan";
import { arrivals, BASE, beat, event, fixture, FullHistory, generatedRoom, makeStore, op, takeoverHistory, template } from "./oracle";

function equalFullReplay(history: ReturnType<typeof fixture>, cap = 2): ReturnType<typeof makeStore> {
  const store = makeStore({ maxPerRoom: cap }); const ref = new FullHistory();
  for (const e of history) {
    const expected = ref.accept(e);
    expect(store.ingestChecked(e)).toBe(expected);
    for (const room of new Set(ref.history.map(x => x.room))) expect(store.plan(room), `plan after ${e.id}`).toEqual(ref.plan(room));
    expect(store.plans(), `plans after ${e.id}`).toEqual(ref.plans());
    expect(store.states(), `states after ${e.id}`).toEqual(ref.states());
    expect(store.since()).toEqual(ref.since());
  }
  return store;
}

describe("U123 A2: activity still controls ownership after display eviction", () => {
  it("A2 unchanged U85 owner heartbeat fixture rejects Bob with claimed_by_other", () => {
    const history = takeoverHistory();
    const expected = foldPlan(history, template).projection;
    expect(expected.rejected.at(-1)?.code).toBe("claimed_by_other");
    expect(expected.tasks[0]?.assignee).toBe("alice");
    const store = equalFullReplay(history);
    expect(store.events("demo").some(e => e.id === history[4]!.id)).toBe(false);
    expect(store.plan("demo")?.projection).toEqual(expected);
  });

  it.each([600_000, 600_001])("A2 takeover silence is strictly greater than 600000 ms (%s)", silence => {
    const history = [...fixture().slice(0, 4), event(10, { ts: BASE + 800_000 }),
      event(11, { ts: BASE - 50 }), event(12, { agent: "bob" }), event(13, { agent: "bob" }),
      op(20, { kind: "task.claim", task_id: "T01", takeover: true }, { agent: "bob", ts: BASE + 800_000 + silence })];
    const store = equalFullReplay(history);
    expect(store.events("demo").some(e => e.id === history[4]!.id)).toBe(false);
    const projection = store.plan("demo")!.projection;
    expect(projection.tasks[0]?.assignee).toBe(silence === 600_000 ? "alice" : "bob");
    expect(projection.rejected.at(-1)?.code).toBe(silence === 600_000 ? "claimed_by_other" : undefined);
    // Legacy lastSeen is ordered, unlike the takeover timestamp maximum.
    expect(store.states().find(s => s.agent === "alice")?.lastSeen).toBe(BASE - 50);
  });

  it("A2 release/reclaim fences stale micro writes and retires old live activity", () => {
    const history = [...fixture().slice(0, 5), beat(6), op(7, { kind: "task.release", task_id: "T01", claim_lamport: 4 }),
      op(8, { kind: "task.claim", task_id: "T01" }),
      op(9, { kind: "micro.set", micro_id: "T01.M01", state: "active", claim_lamport: 4 }),
      op(10, { kind: "micro.set", micro_id: "T01.M01", state: "active", claim_lamport: 8 }),
      beat(11), event(12, { agent: "bob" }), event(13, { agent: "bob" }), event(14, { agent: "bob" })];
    const store = equalFullReplay(history);
    const p = store.plan("demo")!.projection;
    expect(p.tasks[0]?.assignee).toBe("alice");
    expect(p.tasks[0]?.claim_lamport).toBe(8);
    expect(p.rejected.map(r => r.code)).toContain("stale_rev");
    expect(p.tasks[0]?.microtasks[0]?.live).toBeUndefined();
    expect(store.events("demo").filter(e => e.op?.["kind"] === "activity.beat")).toEqual([]);
  });

  it("A2 sibling supersession retires old runs but retired receipts still fence takeover", () => {
    const base = fixture().slice(0, 5);
    const add = base[1]!.op as Record<string, unknown>;
    add["microtasks"] = [{ text: "first", accept: "seen" }, { text: "sibling", accept: "seen" }];
    const history = [...base, op(6, { kind: "micro.set", micro_id: "T01.M02", state: "active" }),
      beat(7, { ts: BASE + 800_000 }, "run_old"),
      op(8, { kind: "activity.beat", task_id: "T01", run_id: "run_new", op_id: "sibling_new_run" }, { ts: BASE + 100 }),
      beat(9, { ts: BASE + 900_000 }, "run_old"),
      event(10, { agent: "bob" }), event(11, { agent: "bob" }), event(12, { agent: "bob" }),
      op(20, { kind: "task.claim", task_id: "T01", takeover: true }, { agent: "bob", ts: BASE + 1_000_000 })];
    const store = equalFullReplay(history);
    const p = store.plan("demo")!.projection;
    expect(p.rejected.at(-1)?.code).toBe("claimed_by_other");
    expect(p.tasks[0]?.microtasks[0]?.live?.run_id).toBe("run_new");
    expect(p.tasks[0]?.microtasks[1]?.live?.run_id).toBe("run_new");
    expect(store.events("demo").filter(e => e.op?.["kind"] === "activity.beat")).toEqual([]);
  });

  it("A2 beat receipts on another task protect the same owner's earlier task", () => {
    const history = [...fixture().slice(0, 5), op(6, { kind: "task.claim", task_id: "T02" }),
      op(7, { kind: "micro.set", micro_id: "T02.M01", state: "active" }),
      op(8, { kind: "activity.beat", task_id: "T02", run_id: "other_run", op_id: "cross_task_beat" }, { ts: BASE + 900_000 }),
      event(9, { agent: "bob" }), event(10, { agent: "bob" }), event(11, { agent: "bob" }),
      op(20, { kind: "task.claim", task_id: "T01", takeover: true }, { agent: "bob", ts: BASE + 1_000_000 })];
    const store = equalFullReplay(history);
    expect(store.plan("demo")?.projection.rejected.at(-1)?.code).toBe("claimed_by_other");
    expect(store.plan("demo")?.projection.tasks[0]?.assignee).toBe("alice");
    expect(store.events("demo").some(e => e.id === history[7]!.id)).toBe(false);
  });
});

describe("U123 A3: full-history expectations at every arrival prefix", () => {
  it("A3 late semantic predecessors reclassify an already evicted rejected beat", () => {
    const base = fixture().slice(0, 5);
    const history = [...base.slice(0, 3), base[4]!, beat(10), event(20, { agent: "bob" }),
      event(21, { agent: "bob" }), event(22, { agent: "bob" })];
    const store = equalFullReplay(history);
    expect(store.plan("demo")?.projection.rejected.map(r => r.code)).toEqual(["not_conformant", "claimed_by_other"]);
    const ref = new FullHistory(); history.forEach(e => ref.accept(e));
    const since = store.since(); const claim = base[3]!;
    expect(store.ingestChecked(claim)).toBe("accepted"); ref.accept(claim);
    expect(store.plan("demo")).toEqual(ref.plan("demo")); expect(store.plans()).toEqual(ref.plans());
    expect(store.states()).toEqual(ref.states()); expect(store.since()).toEqual(since);
    expect(store.plan("demo")?.projection.rejected).toEqual([]);
    expect(store.plan("demo")?.projection.tasks[0]?.microtasks[0]?.live).toMatchObject({ run_id: "run_1", beat_lamport: 10 });
  });

  it("A3 duplicate IDs keep the first payload across rooms after recent eviction", () => {
    const history = [...fixture().slice(0, 5), event(100), event(101), event(102),
      event(100, { room: "other", lamport: 10000, text: "conflicting duplicate" })];
    const store = equalFullReplay(history);
    expect(store.events("other")).toEqual([]);
    expect(store.since()).toEqual({ demo: 102 });
    expect(store.states().some(s => s.room === "other")).toBe(false);
  });

  it.each([0x123, 0xcafe, 0xdead])("A3 deterministic shuffled multi-room history seed %s", seed => {
    const store = equalFullReplay(arrivals(seed));
    expect(store.plan("demo")?.projection.plan?.title).toBe("Reopened");
    expect(store.plan("demo")?.projection.archived_plans).toHaveLength(1);
    expect(store.plan("demo")?.projection.memory["notes"]?.text).toBe("second");
    expect(store.plan("demo")?.errors?.map(e => e.code)).toEqual(["not_conformant", "stale_rev"]);
    expect(store.plan("demo")?.projection.replayed_ops[JSON.stringify(["alice", "memory_repeat"])]).toBeDefined();
  });

  it("A3 reversed delivery and late predecessors preserve archives, replay identities and diagnostics", () => {
    const store = equalFullReplay(arrivals(0x123, true));
    expect(store.plans()).toHaveLength(2);
    expect(store.plan("legacy-only")).toBeUndefined();
    expect(store.plan("zeta")?.projection.archived_plans).toHaveLength(1);
    expect(store.states().find(s => s.room === "demo" && s.agent === "alice")?.lastText).toBe("timestamp regression");
  });

  it("A3 explicit ownership/progress before close and successful cancellation/close/reopen", () => {
    const history = generatedRoom("demo", 1000);
    const store = equalFullReplay(history.filter(e => e.lamport <= 20));
    const p = store.plan("demo")!.projection;
    expect(p.tasks[0]?.assignee).toBe("alice");
    expect(p.tasks[0]?.microtasks[0]?.state).toBe("done");
    expect(p.tasks[1]?.state).toBe("cancelled");
    expect(p.rollup.progress_pct).toBe(50);
    const ref = new FullHistory(); history.forEach(e => ref.accept(e));
    const reopened = equalFullReplay(history);
    expect(reopened.plan("demo")).toEqual(ref.plan("demo"));
    expect(reopened.plan("demo")?.projection.tasks).toEqual([]);
  });

  it("M2/M4 memory before plan, while closed and after reopen stays pinned under beat pressure", () => {
    const opening = fixture()[0]!.op!;
    const history = [op(10, { kind: "memory.set", section: "goal", text: "before", base_rev: 0 }),
      op(20, { ...opening }), op(21, { kind: "plan.close", base_rev: 20, outcome: "empty plan complete" }),
      op(22, { kind: "memory.set", section: "goal", text: "while closed", base_rev: 10 }),
      op(23, { ...opening, title: "Reopened" }),
      op(24, { kind: "memory.set", section: "goal", text: "after", base_rev: 22 }),
      ...Array.from({ length: 8 }, (_, i) => beat(100 + i))];
    const store = equalFullReplay(history);
    expect(store.plan("demo")?.projection.memory["goal"]).toMatchObject({ text: "after", rev: 24 });
    expect(store.plan("demo")?.projection.archived_plans).toHaveLength(1);
    expect(store.events("demo").filter(e => e.op?.["kind"] === "memory.set")).toEqual(history.filter(e => e.op?.["kind"] === "memory.set"));
  });

  it("A3 changed resolver content with unchanged identity/hash refolds after activity compaction", () => {
    const source = structuredClone(template);
    const resolve = () => source;
    const store = makeStore({ maxPerRoom: 2, templates: resolve }); const ref = new FullHistory(resolve);
    const history = [...fixture(), ...Array.from({ length: 12 }, (_, i) => beat(100 + i))];
    for (const e of history) { store.ingest(e); ref.accept(e); }
    expect(store.plan("demo")).toEqual(ref.plan("demo")); store.states();
    const cursor = store.since();
    source.memory_sections = [{ id: "goal", label: "Goal", required: true, max_chars: 1, hint: "Short" }];
    expect(source.hash).toBe(template.hash);
    expect(store.plan("demo")).toEqual(ref.plan("demo"));
    expect(store.plan("demo")?.projection.memory["goal"]).toBeUndefined();
    expect(store.plan("demo")?.errors).toEqual([{ id: fixture()[5]!.id, lamport: 6, code: "bad_op" }]);
    expect(store.plans()).toEqual(ref.plans()); expect(store.states()).toEqual(ref.states());
    source.memory_sections[0]!.max_chars = 100;
    expect(store.plan("demo")).toEqual(ref.plan("demo"));
    expect(store.plan("demo")?.projection.memory["goal"]?.text).toBe("Ship TaskLight");
    expect(store.since()).toEqual(cursor);
  });

  it("A3 a late evicted non-op changes an earlier takeover receipt without advancing high-water", () => {
    const history = [...fixture().slice(0, 4),
      op(20, { kind: "task.claim", task_id: "T01", takeover: true }, { agent: "bob", ts: BASE + 900_000 }),
      event(21, { agent: "bob" }), event(22, { agent: "bob" }), event(23, { agent: "bob" })];
    const store = makeStore({ maxPerRoom: 2 }); const ref = new FullHistory();
    for (const e of history) { store.ingest(e); ref.accept(e); }
    expect(store.plan("demo")?.projection.tasks[0]?.assignee).toBe("bob"); store.states();
    const since = store.since(); const late = event(10, { ts: BASE + 600_000 });
    expect(store.ingestChecked(late)).toBe("accepted"); ref.accept(late);
    expect(store.plan("demo")).toEqual(ref.plan("demo"));
    expect(store.plan("demo")?.projection.rejected.at(-1)?.code).toBe("claimed_by_other");
    expect(store.plan("demo")?.projection.tasks[0]?.assignee).toBe("alice");
    expect(store.plans()).toEqual(ref.plans()); expect(store.states()).toEqual(ref.states());
    expect(store.events("demo").some(e => e.id === late.id)).toBe(false);
    expect(store.since()).toEqual(since);
  });
});
