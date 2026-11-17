import { beforeEach, describe, expect, it } from "vitest";
import { applyOp, checkConformance, emptyProjection, foldPlan } from "../../../src/plan/reducer";
import { validateOpShapeCode } from "../../../src/plan/validate";
import type { PlanProjection } from "../../../src/plan/types";
import { apply, assertFrozen, copy, event, fixture, history, incremental, life, lifecycle,
  python, readiness, semantic } from "./support";
import type { Event, Op } from "./support";

// Both language suites reach the same actual Python stub today. This prerequisite
// is not a skip, expected failure, mocked fold, or invented TypeScript product API.
beforeEach(readiness);

function frozenDeploy(): PlanProjection { return apply(emptyProjection(), copy(fixture.a1_event)); }
function denied(state: PlanProjection, ev: Event, code: string): void {
  const before = copy(state);
  const result = applyOp(state, ev, fixture.template);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("rejected transition was accepted");
  expect(result.code).toBe(code);
  expect(state).toEqual(before);
  expect(lifecycle(result.projection)).toEqual(lifecycle(before));
  expect(semantic(result.projection)).toEqual(semantic(before));
}

describe("A1/M1-M4 public lifecycle projection", () => {
  it("A1 deploys before a plan exists with the exact frozen record", () => {
    const result = foldPlan([fixture.a1_event], fixture.template);
    expect(result.stats.rejected).toBe(0);
    assertFrozen(result.projection, history("A1_no_plan"));
    expect(result.projection.plan).toBeNull();
    expect(lifecycle(result.projection)?.["exec-a"]).not.toHaveProperty("last_alive_ts");
  });
  it("M4 empty projection owns an empty room map", () => {
    expect(lifecycle(emptyProjection())).toEqual({});
  });
  it("M4 upgrades a serialized older projection without mutating it", () => {
    const older = copy(emptyProjection());
    delete (older as PlanProjection & { agent_lifecycle?: unknown }).agent_lifecycle;
    const after = apply(older, fixture.a1_event);
    expect(lifecycle(older)).toBeUndefined();
    expect(lifecycle(after)).toEqual({ "exec-a": fixture.a1_expected });
  });
  it("M4 same-run updates retain omitted literal metadata", () => {
    const h = history("M4_metadata_retention");
    assertFrozen(incremental(h.events), h);
  });
  it("M4 a new run clears metadata and absent alive evidence", () => {
    const h = history("M4_new_run_clears_metadata");
    const result = incremental(h.events);
    assertFrozen(result, h);
    for (const field of ["swarm", "harness", "reason", "last_alive_ts"]) {
      expect(lifecycle(result)?.["exec-a"]).not.toHaveProperty(field);
    }
  });
  it("M4 timestamps come only from the supplied committed event", () => {
    const result = apply(emptyProjection(), life(1, "deployed", "clock-run", -123));
    expect(lifecycle(result)?.["exec-a"]).toMatchObject({ deployed_ts: -123, ts: -123, lamport: 1 });
  });
});

describe("A2/A3/M5/M8 transition admission and identity", () => {
  it.each(["alive", "finished", "failed"])("A2 %s without deployment is not_conformant", state => {
    denied(emptyProjection(), life(1, state), "not_conformant");
  });
  it("M5 lifecycle admission applies even when no tool handler is involved", () => {
    const source = frozenDeploy();
    denied(source, life(2, "finished", "missing"), "not_conformant");
  });
  it("M5 identical deployment repeats preserve the lifecycle record", () => {
    const before = frozenDeploy();
    const after = apply(before, event(2, { ...fixture.a1_event.op, op_id: "repeat0001" }));
    expect(lifecycle(after)).toEqual(lifecycle(before));
    expect(semantic(after)).toEqual(semantic(before));
  });
  it.each(["finished", "failed"])("M5 %s cannot regress and an identical repeat is a no-op", terminal => {
    const ended = apply(frozenDeploy(), life(2, terminal));
    const repeated = apply(ended, life(3, terminal));
    expect(lifecycle(repeated)).toEqual(lifecycle(ended));
    const alive = apply(ended, life(4, "alive"));
    expect(lifecycle(alive)).toEqual(lifecycle(ended));
    denied(ended, life(5, "deployed"), "not_conformant");
    denied(ended, life(6, terminal === "failed" ? "finished" : "failed"), "not_conformant");
  });
  it("M5 fresh deployment retires the previous identifier in order", () => {
    const current = apply(apply(frozenDeploy(), life(2, "deployed", "r2")), life(3, "deployed", "r3"));
    expect(lifecycle(current)?.["exec-a"]?.retired_run_ids).toEqual(["r1", "r2"]);
    for (const state of ["deployed", "finished", "failed"]) denied(current, life(4, state, "r1"), "not_conformant");
    expect(lifecycle(apply(current, life(4, "alive", "r1")))).toEqual(lifecycle(current));
  });
  it("A3 replay of an old committed deployment cannot restore a retired run", () => {
    const current = apply(frozenDeploy(), life(2, "deployed", "r2"));
    const replay = apply(current, event(3, copy(fixture.a1_event.op)));
    expect(lifecycle(replay)).toEqual(lifecycle(current));
  });
  it.each(["state", "run_id", "swarm", "harness", "reason"])("A3 changed %s under a committed identity is bad_op", field => {
    const changes: Record<string, string> = { state: "failed", run_id: "r2", swarm: "different", harness: "different", reason: "different" };
    denied(frozenDeploy(), event(2, { ...fixture.a1_event.op, [field]: changes[field] }), "bad_op");
  });
  it("A3 identical op_id from a different agent has independent identity", () => {
    const state = apply(frozenDeploy(), event(2, { ...fixture.a1_event.op, run_id: "independent" }, 2000, "exec-b"));
    expect(lifecycle(state)?.["exec-a"]?.run_id).toBe("r1");
    expect(lifecycle(state)?.["exec-b"]?.run_id).toBe("independent");
  });
  it("A3 rejected identities do not reserve an op_id", () => {
    const source = emptyProjection();
    denied(source, life(1, "failed"), "not_conformant");
    expect(lifecycle(apply(source, life(2, "deployed", "r1", 2000, { op_id: "life0001" })))?.["exec-a"]?.lifecycle).toBe("deployed");
  });
});

describe("A4/M6 execution activity remains separate from semantic progress", () => {
  function working(): PlanProjection {
    return incremental([fixture.a1_event,
      event(2, { kind: "memory.set", section: "goal", text: "Verify lifecycle", base_rev: 0 }),
      event(3, copy(fixture.open_op)), event(4, copy(fixture.add_op)),
      event(5, { kind: "task.claim", task_id: "T01" }),
      event(6, { kind: "micro.set", micro_id: "T01.M01", state: "active" })]);
  }
  function beat(n: number, run: string): Event {
    return event(n, { kind: "activity.beat", task_id: "T01", run_id: run, op_id: `beat${String(n).padStart(4, "0")}` });
  }
  it("A4 stale and noncurrent activity cannot supersede the current run", () => {
    const initial = working();
    const current = apply(initial, life(7, "deployed", "r2"));
    expect(semantic(current)).toEqual(semantic(initial));
    const active = apply(current, beat(8, "r2"));
    expect(active.tasks[0]?.microtasks[0]?.live?.run_id).toBe("r2");
    for (const run of ["r1", "unrecorded"]) {
      const stale = apply(active, beat(9, run));
      expect(semantic(stale)).toEqual(semantic(active));
      expect(lifecycle(stale)).toEqual(lifecycle(active));
    }
  });
  it("A4 terminal activity cannot refresh live state or release owned work", () => {
    let state = apply(working(), beat(7, "r1"));
    state = apply(state, life(8, "failed"));
    const noBeat = apply(state, beat(9, "r1"));
    expect(semantic(noBeat)).toEqual(semantic(state));
    const noAlive = apply(state, life(10, "alive"));
    expect(lifecycle(noAlive)).toEqual(lifecycle(state));
    expect(noAlive.tasks[0]?.assignee).toBe("exec-a");
    expect(noAlive.tasks[0]?.microtasks[0]?.state).toBe("active");
    expect(apply(noAlive, event(11, { kind: "task.release", task_id: "T01" })).tasks[0]?.assignee).toBeNull();
  });
  it("M6 unregistered agents retain their existing beat behavior", () => {
    let state = working();
    state = apply(state, event(7, { kind: "task.release", task_id: "T01" }));
    state = apply(state, event(8, { kind: "task.claim", task_id: "T01" }, 8000, "legacy"));
    // A-U132a: U109 MUST reset released active work to pending; reactivate as its owner.
    state = apply(state, event(9, { kind: "micro.set", micro_id: "T01.M01", state: "active" }, 9000, "legacy"));
    state = apply(state, event(10, { ...beat(10, "legacy-run").op }, 10000, "legacy"));
    expect(state.tasks[0]?.microtasks[0]?.live?.run_id).toBe("legacy-run");
    expect(lifecycle(state)).not.toHaveProperty("legacy");
  });
  it("M6 lifecycle changes preserve phases, revisions, ownership and completion", () => {
    const initial = working();
    let state = initial;
    for (const ev of [life(7, "alive"), life(8, "deployed", "r2"), life(9, "failed", "r2")]) {
      state = apply(state, ev);
      expect(semantic(state)).toEqual(semantic(initial));
    }
  });
  it("M6 takeover keeps the strict existing silence threshold", () => {
    const state = working();
    const claimed = state.tasks[0]!.claim_ts!;
    denied(state, event(7, { kind: "task.claim", task_id: "T01", takeover: true }, claimed + 600000, "other"), "claimed_by_other");
    expect(apply(state, event(7, { kind: "task.claim", task_id: "T01", takeover: true }, claimed + 600001, "other")).tasks[0]?.assignee).toBe("other");
  });
});

describe("A5/M7 deterministic persisted-alive throttle", () => {
  it("A5 first alive persists, earlier and backward evidence cannot advance it", () => {
    const first = apply(frozenDeploy(), life(2, "alive", "r1", 2000));
    for (const ts of [31999, 1999, 0]) {
      const suppressed = apply(copy(first), life(3, "alive", "r1", ts));
      expect(lifecycle(suppressed)).toEqual(lifecycle(first));
      expect(lifecycle(suppressed)?.["exec-a"]?.lamport).toBe(2);
    }
    const eligible = apply(first, life(4, "alive", "r1", 32000));
    expect(lifecycle(eligible)?.["exec-a"]).toMatchObject({ last_alive_ts: 32000, ts: 32000, lamport: 4 });
  });
  it("A5 JSON restart and suppression do not postpone equality eligibility", () => {
    const h = history("A5_boundary_and_backward");
    assertFrozen(incremental(h.events), h);
  });
  it("A5 same-time boundary deliveries persist only the first record", () => {
    const first = apply(frozenDeploy(), life(2, "alive", "r1", 2000));
    const boundary = apply(first, life(3, "alive", "r1", 32000));
    expect(lifecycle(apply(boundary, life(4, "alive", "r1", 32000)))).toEqual(lifecycle(boundary));
  });
  it("A5 a new run has independent first-alive eligibility", () => {
    let state = apply(frozenDeploy(), life(2, "alive", "r1", 2000));
    state = apply(state, life(3, "deployed", "r2", 2001));
    expect(lifecycle(state)?.["exec-a"]).not.toHaveProperty("last_alive_ts");
    state = apply(state, life(4, "alive", "r2", 2001));
    expect(lifecycle(state)?.["exec-a"]?.last_alive_ts).toBe(2001);
  });
});

describe("A6 room state survives plan boundaries and JSON handoff", () => {
  it("A6 conformant close/reopen preserves retired runs and reused task IDs", () => {
    const h = history("A6_closed_reopen_reused_task");
    // A-U132a: U109 MUST close only done/cancelled work; A6 uses explicit cancellation.
    const prefix = incremental(h.events.slice(0, 6));
    expect(prefix.tasks[0]?.state).toBe("cancelled");
    expect(checkConformance(prefix, fixture.template).ok).toBe(true);
    const result = incremental(h.events);
    assertFrozen(result, h);
    expect(result.tasks[0]?.id).toBe("T01");
    expect(result.archived_plans).toHaveLength(1);
    expect(lifecycle(emptyProjection())).toEqual({});
  });
  it("A6 full projections and both directions of JSON continuation agree", () => {
    const h = history("A6_closed_reopen_reused_task");
    const pyPrefix = python<PlanProjection>({ mode: "fold", events: h.events.slice(0, 8) });
    const tsPrefix = incremental(h.events.slice(0, 8));
    expect(tsPrefix).toEqual(pyPrefix);
    const tsFromPy = incremental(h.events.slice(8), copy(pyPrefix));
    const pyFromTs = python<PlanProjection>({ mode: "continue", projection: tsPrefix, events: h.events.slice(8) });
    expect(tsFromPy).toEqual(pyFromTs);
    assertFrozen(tsFromPy, h);
    expect(tsFromPy).toEqual(foldPlan(h.events, fixture.template).projection);
  });
  it("A6 retirement churn remains deduplicated and ordered after continuation", () => {
    let state = emptyProjection();
    for (let n = 1; n <= 260; n++) state = apply(copy(state), life(n, "deployed", `run${n}`));
    expect(lifecycle(state)?.["exec-a"]?.retired_run_ids).toEqual(Array.from({ length: 259 }, (_, n) => `run${n + 1}`));
    const alive = apply(state, life(261, "alive", "run1"));
    expect(lifecycle(alive)).toEqual(lifecycle(state));
    denied(state, life(262, "deployed", "run1"), "not_conformant");
  });
});

describe("A7/M3 hostile operation validation", () => {
  it("M3 accepts all lifecycle states statically with persisted identities", () => {
    for (const state of ["deployed", "alive", "finished", "failed"]) {
      expect(validateOpShapeCode(life(1, state).op)).toBeNull();
    }
  });
  it.each(["state", "run_id", "op_id", "reason", "swarm", "harness"])("A7 rejects null and wrong-type %s", key => {
    for (const value of [null, true, 1, [], {}]) {
      expect(validateOpShapeCode({ ...fixture.a1_event.op, [key]: value })).toBe("bad_op");
    }
  });
  it("M3 rejects missing persisted fields and unknown keys", () => {
    for (const key of ["state", "run_id", "op_id"]) {
      const op = copy(fixture.a1_event.op); delete op[key];
      expect(validateOpShapeCode(op)).toBe("bad_op");
    }
    for (const key of ["command", "ts", "task_id", "plan_id", "micro_id", "base_rev"]) {
      expect(validateOpShapeCode({ ...fixture.a1_event.op, [key]: "extra" })).toBe("bad_op");
    }
    expect(validateOpShapeCode({ ...fixture.a1_event.op, kind: "agent.unknown" })).toBe("bad_op");
  });
  it("A7 full matches reject path traversal and trailing newlines", () => {
    for (const value of ["../x", "", "r1\n", "a/b", "a b", "r".repeat(65)]) {
      expect(validateOpShapeCode({ ...fixture.a1_event.op, run_id: value })).toBe("bad_op");
    }
    for (const value of ["short", "a".repeat(65), "12345678\n"]) {
      expect(validateOpShapeCode({ ...fixture.a1_event.op, op_id: value })).toBe("bad_op");
    }
    expect(validateOpShapeCode({ ...fixture.a1_event.op, run_id: "A_9-".repeat(16), op_id: "o".repeat(64) })).toBeNull();
    expect(validateOpShapeCode({ ...fixture.a1_event.op, run_id: "a", op_id: "o".repeat(8) })).toBeNull();
  });
  it("A7 reason is bounded by Unicode scalar count rather than UTF-16 units", () => {
    for (const reason of ["", "x".repeat(512), "🚀".repeat(512)]) {
      expect(validateOpShapeCode({ ...fixture.a1_event.op, reason })).toBeNull();
    }
    expect(validateOpShapeCode({ ...fixture.a1_event.op, reason: "x".repeat(513) })).toBe("bad_op");
  });
  it("A7 labels require non-whitespace and preserve TITLE_MAX scalar bounds", () => {
    for (const key of ["swarm", "harness"]) {
      for (const value of ["", "   ", "\u00a0", "x".repeat(121)]) {
        expect(validateOpShapeCode({ ...fixture.a1_event.op, [key]: value })).toBe("bad_op");
      }
      expect(validateOpShapeCode({ ...fixture.a1_event.op, [key]: "🚀".repeat(120) })).toBeNull();
    }
  });
  it("A7 all C0/C1 controls and isolated surrogates are rejected", () => {
    const points = [...Array.from({ length: 32 }, (_, n) => n), ...Array.from({ length: 33 }, (_, n) => n + 0x7f), 0xd800, 0xdfff];
    for (const key of ["swarm", "harness", "reason"]) {
      for (const point of points) {
        expect(validateOpShapeCode({ ...fixture.a1_event.op, [key]: "x" + String.fromCharCode(point) })).toBe("bad_op");
      }
    }
  });
  it("A7 prototype keys, inherited records, cycles and non-finite JSON are rejected", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const op = JSON.parse(JSON.stringify(fixture.a1_event.op).replace(/}$/, `,"${key}":{}}`)) as Op;
      expect(validateOpShapeCode(op)).toBe("bad_op");
      expect(validateOpShapeCode({ ...fixture.a1_event.op, swarm: key })).toBeNull();
    }
    const cycle: unknown[] = []; cycle.push(cycle);
    for (const value of [cycle, NaN, Infinity]) expect(validateOpShapeCode({ ...fixture.a1_event.op, reason: value })).toBe("bad_op");
    expect(validateOpShapeCode(Object.assign(Object.create({ inherited: true }) as Op, fixture.a1_event.op))).toBe("bad_op");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
  it("A7 operation byte overflow takes precedence over field length", () => {
    expect(validateOpShapeCode({ ...fixture.a1_event.op, reason: "x".repeat(8193) })).toBe("limit_exceeded");
  });
  it("A7 XSS strings remain literal metadata in both folds", () => {
    const h = history("A7_literal_metadata");
    const ts = foldPlan(h.events, fixture.template).projection;
    const py = python<PlanProjection>({ mode: "fold", events: h.events });
    assertFrozen(ts, h); assertFrozen(py, h);
    expect(ts).toEqual(py);
  });
});

describe("A8 independent frozen and differential controls", () => {
  it.each(fixture.histories)("A8 full Python/TS agreement: $name", h => {
    const before = copy(h.events);
    const ts = foldPlan(h.events, fixture.template).projection;
    const py = python<PlanProjection>({ mode: "fold", events: h.events });
    assertFrozen(ts, h); assertFrozen(py, h);
    expect(ts).toEqual(py);
    expect(h.events).toEqual(before);
  });
  it.each(["A1_no_plan", "A6_closed_reopen_reused_task"])("A8 disabled TS application fails frozen expectations: %s", name => {
    const h = history(name);
    const valid = foldPlan(h.events, fixture.template).projection;
    assertFrozen(valid, h);
    const disabled = h.events.filter(e => e.op["kind"] !== "agent.lifecycle");
    expect(() => assertFrozen(foldPlan(disabled, fixture.template).projection, h)).toThrow();
  });
  it.each(["A1_no_plan", "A6_closed_reopen_reused_task"])("A8 disabled Python application fails even if both folds are empty: %s", name => {
    const h = history(name);
    const disabled = h.events.filter(e => e.op["kind"] !== "agent.lifecycle");
    const py = python<PlanProjection>({ mode: "fold", events: disabled });
    const ts = foldPlan(disabled, fixture.template).projection;
    expect(lifecycle(ts)).toEqual(lifecycle(py));
    expect(() => assertFrozen(py, h)).toThrow();
    expect(() => assertFrozen(ts, h)).toThrow();
  });
});
