// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyOp, computeProgress, computeTaskStatus, emptyProjection, foldPlan, isTaskReady } from "../../../src/plan";
import type { PlanOpErrorCode, PlanProjection, TaskStatus } from "../../../src/plan";
import { accepted, add, clone, event, folded, freeze, open, projection, task, template, vector } from "./helpers";

// Compile-time preservation of the exact eleven-code public contract.
const errorCodeContract = {
  no_plan: true, plan_exists: true, unknown_template: true, bad_template: true,
  bad_op: true, not_found: true, stale_rev: true, dep_cycle: true,
  claimed_by_other: true, limit_exceeded: true, not_conformant: true,
} satisfies Record<PlanOpErrorCode, true>;
void errorCodeContract;

function reject(p: PlanProjection, op: Record<string, unknown>, code: string, extra = {}) {
  const before = clone(p);
  const result = applyOp(freeze(p), event(100, op, extra), template);
  expect(result).toMatchObject({ok: false, code});
  expect(p).toEqual(before);
  // Rejection bookkeeping may advance; domain data must remain unchanged.
  for (const key of ["plan", "tasks", "memory", "archived_plans", "rollup"] as const)
    expect(result.projection[key]).toEqual(before[key]);
}

describe("R1 all ten operations and canonical snapshots", () => {
  it("R1 happy path includes T01..T03 and parent revisions", () => {
    const events = [event(1, open()), event(2, add()), event(3, add()), event(4, add()),
      event(5, {kind: "task.claim", task_id: "T01"}),
      event(6, {kind: "micro.add", task_id: "T01", base_rev: 5, text: "Next"}),
      event(7, {kind: "micro.set", micro_id: "T01.M01", state: "done"}),
      event(8, {kind: "task.set", task_id: "T02", base_rev: 3, state: "blocked", reason: "Wait"}),
      event(9, {kind: "task.release", task_id: "T01"}),
      event(10, {kind: "plan.phase", base_rev: 1, phase: "finish"}),
      event(11, {kind: "memory.set", section: "notes", text: "Decision", base_rev: 0}),
      event(12, {kind: "plan.close", base_rev: 10, outcome: "Finished"})];
    const p = folded(events);
    expect(p.rejected).toEqual([]);
    expect(p.tasks.map(t => t.id)).toEqual(["T01", "T02", "T03"]);
    expect(p.plan).toMatchObject({id: "p1", state: "closed", rev: 12, closed_outcome: "Finished"});
    expect(p.tasks[0]).toMatchObject({rev: 9, assignee: null, claim_lamport: null, claim_ts: null});
    expect(p.tasks[0]!.microtasks[0]).toMatchObject({state: "done", rev: 7});
    expect(p.memory["notes"]).toMatchObject({rev: 11, ts: events[10]!.ts});
  });
  it("R1 micro mutations advance task and micro revision but not plan", () => {
    const before = projection();
    const p = accepted(before, event(20, {kind: "micro.set", micro_id: "T01.M01", state: "active"}));
    expect(p.tasks[0]!.rev).toBe(20); expect(p.tasks[0]!.microtasks[0]!.rev).toBe(20);
    expect(p.plan!.rev).toBe(before.plan!.rev);
  });
  it("R1 operation evidence remains independent of legacy event evidence", () => {
    const proof = {path: "proof", sha256: "a".repeat(64)};
    const legacy = {path: "legacy-proof", sha256: "b".repeat(64)};
    const p = accepted(projection(), event(20, {kind: "micro.set", micro_id: "T01.M01", state: "done", evidence: [proof]}, {evidence: [legacy]}));
    expect(p.tasks[0]!.microtasks[0]!.evidence).toEqual([proof]);
  });
  it("R1 input and nested output snapshots are independent", () => {
    const p = projection(); const before = clone(p);
    const result = accepted(freeze(p), event(20, {kind: "micro.set", micro_id: "T01.M01", state: "done"}));
    expect(p).toEqual(before); expect(result).not.toBe(p);
    expect(result.tasks).not.toBe(p.tasks);
    expect(result.memory).not.toBe(p.memory);
    expect(result.plan!.brief).not.toBe(p.plan!.brief);
    expect(result.tasks[0]!.microtasks).not.toBe(p.tasks[0]!.microtasks);
  });
  it("R1 memory works before plan and closed plan; reopen archives and preserves memory", () => {
    let p = accepted(projection("empty"), event(1, {kind: "memory.set", section: "notes", text: "Keep", base_rev: 0}));
    p = accepted(p, event(2, open())); p = accepted(p, event(3, add()));
    p = accepted(p, event(4, {kind: "plan.close", base_rev: 2}));
    p = accepted(p, event(5, {kind: "memory.set", section: "notes", text: "Kept", base_rev: 1}));
    p = accepted(p, event(6, open())); p = accepted(p, event(7, add()));
    expect(p.tasks.map(t => t.id)).toEqual(["T01"]); expect(p.archived_plans).toHaveLength(1);
    expect(p.memory["notes"]!.text).toBe("Kept");
  });
  it("R1 emptyProjection matches canonical empty shared vector", () => {
    expect(emptyProjection()).toEqual(projection("empty"));
  });
});

describe("R2 failures and amendment field/revision gates", () => {
  const cases: [string, string, Record<string, unknown>, string, Record<string, unknown>?][] = [
    ["before plan", "empty", add(), "no_plan"],
    ["closed plan", "plan_close", add(), "no_plan"],
    ["active plan exists", "plan_open", open(), "plan_exists"],
    ["missing task", "task_add", {kind: "task.claim", task_id: "T40"}, "not_found"],
    ["missing micro", "task_add", {kind: "micro.set", micro_id: "T01.M12", state: "done"}, "not_found"],
    ["missing dependency", "task_add", add({deps: ["T40"]}), "not_found"],
    ["self dependency", "task_add", {kind: "task.set", task_id: "T01", base_rev: 3, deps: ["T01"]}, "dep_cycle"],
    ["task.add self dependency", "task_add", add({deps: ["T02"]}), "dep_cycle"],
    ["duplicate dependency", "task_add", add({deps: ["T01", "T01"]}), "bad_op"],
    ["unknown operation", "task_add", {kind: "task.delete"}, "bad_op"],
    ["unknown op field", "task_add", add({surprise: true}), "bad_op"],
    ["legacy micro id", "task_add", {kind: "micro.set", id: "T01.M01", state: "done"}, "bad_op"],
    ["micro base rev forbidden", "task_add", {kind: "micro.set", micro_id: "T01.M01", state: "done", base_rev: 3}, "bad_op"],
    ["task explicit active forbidden", "task_add", {kind: "task.set", task_id: "T01", base_rev: 3, state: "active"}, "bad_op"],
    ["null revision", "task_add", {kind: "task.set", task_id: "T01", base_rev: null, title: "Changed"}, "bad_op"],
    ["boolean revision", "task_add", {kind: "task.set", task_id: "T01", base_rev: true, title: "Changed"}, "bad_op"],
    ["task status forbidden", "task_add", {kind: "task.set", task_id: "T01", base_rev: 3, status: "active"}, "bad_op"],
    ["task assignee forbidden", "task_add", {kind: "task.set", task_id: "T01", base_rev: 3, assignee: "bob"}, "bad_op"],
    ["claim lock", "task_claim", {kind: "task.claim", task_id: "T01"}, "claimed_by_other", {agent: "bob"}],
    ["release lock", "task_claim", {kind: "task.release", task_id: "T01"}, "claimed_by_other", {agent: "bob"}],
    ["micro lock", "task_claim", {kind: "micro.set", micro_id: "T01.M01", state: "done"}, "claimed_by_other", {agent: "bob"}],
    ["ninth evidence", "task_add", {kind: "micro.set", micro_id: "T01.M01", state: "done", evidence: Array.from({length: 9}, () => ({path: "proof", sha256: "a".repeat(64)}))}, "limit_exceeded"],
    ["ninth dependency", "task_add", add({deps: Array.from({length: 9}, (_, i) => `T${String(i+1).padStart(2,"0")}`)}), "limit_exceeded"],
  ];
  for (const [name, fixture, op, code, extra] of cases)
    it(`R2 ${name}: ${code}`, () => reject(projection(fixture), op, code, extra));
  const required: Record<string, unknown>[] = [
    {kind: "plan.close"}, {kind: "plan.phase", phase: "finish"},
    {kind: "task.set", task_id: "T01", title: "Changed"},
    {kind: "micro.add", task_id: "T01", text: "Next"},
    {kind: "memory.set", section: "notes", text: "First"},
  ];
  for (const op of required) {
    it(`R2 ${op["kind"]}: missing required revision is bad_op`, () => reject(projection(), op, "bad_op"));
    it(`R2 ${op["kind"]}: mismatched revision is stale_rev`, () => reject(projection(), {...op, base_rev: 99}, "stale_rev"));
  }
  for (const op of [add({base_rev: 99}), {kind: "task.claim", task_id: "T01", base_rev: 99}, {kind: "task.release", task_id: "T01", base_rev: 99}])
    it(`R2 ${op["kind"]}: supplied optional revision must match`, () => reject(projection("task_claim"), op, "stale_rev"));
  for (const id of ["cycle_3", "task_capacity", "micro_capacity"])
    it(`R2 ${id}: shared negative control`, () => {
      const c = vector(id); expect(foldPlan(c.events, template).projection).toEqual(c.expected_projection);
    });
  it("R2 nullable task mutation clears explicit state/reason/estimate", () => {
    const p = accepted(projection("task_set_blocked_ready"), event(20, {kind: "task.set", task_id: "T01", base_rev: 4, state: null, reason: null, estimate: null}));
    expect(p.tasks[0]).toMatchObject({explicit_state: null, blocked_reason: null, estimate: null, state: "pending"});
  });
  for (const assignee of [null, "bob"])
    it(`R2 task.add accepts assignee ${assignee}`, () => {
      const p = accepted(projection("plan_open"), event(20, add({assignee})));
      expect(p.tasks[0]!.assignee).toBe(assignee);
    });
});

describe("R3 strict takeover boundary and assignee activity", () => {
  it("R3 current owner may reclaim and refresh claim clock/revision", () => {
    const before = projection("task_claim");
    const p = accepted(before, event(20, {kind: "task.claim", task_id: "T01"}));
    expect(p.tasks[0]).toMatchObject({assignee: "alice", claim_lamport: 20, claim_ts: 1_700_000_000_020, rev: 20});
  });
  for (const dt of [600_000, 600_001])
    it(`R3 claim silence ${dt}`, () => {
      const p = projection("task_claim"); const ts = p.tasks[0]!.claim_ts! + dt;
      const r = applyOp(p, event(20, {kind: "task.claim", task_id: "T01", takeover: true}, {agent: "bob", ts}), template);
      expect(r.ok).toBe(dt > 600_000);
      if (!r.ok) expect(r.code).toBe("claimed_by_other");
    });
  for (const dt of [600_000, 600_001])
    it(`R3 legacy heartbeat restarts silence: ${dt}`, () => {
      const prior = clone(vector("task_claim").events);
      const ts = 1_700_001_000_000;
      prior.push(event(10, {}, {act: "heartbeat", ts}), event(11, {kind: "task.claim", task_id: "T01", takeover: true}, {agent: "bob", ts: ts + dt}));
      const p = folded(prior);
      expect(p.tasks[0]!.assignee).toBe(dt > 600_000 ? "bob" : "alice");
      expect(p.rejected.map(x => x.code)).toEqual(dt > 600_000 ? [] : ["claimed_by_other"]);
    });
});

describe("R4 accepted-result replay and event ingestion", () => {
  it("R4 conflicting payload replay retains first result and updates only ingestion bookkeeping", () => {
    const p = accepted(projection("plan_open"), event(10, add({op_id: "repeat_01"})));
    const r = applyOp(p, event(11, add({op_id: "repeat_01", title: "Different"})), template);
    expect(r).toMatchObject({ok: true, replayed: true});
    expect(r.projection.tasks).toEqual(p.tasks); expect(r.projection.plan).toEqual(p.plan);
    expect(r.projection.last_lamport).toBe(11);
    expect(Object.keys(r.projection.replayed_ops)).toContain(JSON.stringify(["alice", "repeat_01"]));
    const next = accepted(r.projection, event(12, add())); expect(next.tasks[1]!.id).toBe("T02");
  });
  it("R4 another agent using same op_id is distinct", () => {
    const p = folded([event(1, open()), event(2, add({op_id: "repeat_01"})), event(3, add({op_id: "repeat_01"}), {agent: "bob"})]);
    expect(p.tasks.map(t => t.id)).toEqual(["T01", "T02"]);
  });
  it("R4 duplicate event ID suppressed; distinct replay ID counted", () => {
    const a = event(2, add({op_id: "repeat_01"}));
    const r = foldPlan([event(1, open()), a, clone(a), event(3, add({op_id: "repeat_01"}))], template);
    expect(r.projection.tasks).toHaveLength(1); expect(r.stats.replayed).toBe(1);
    expect(r.projection.last_lamport).toBe(3);
  });
  it("R4 replay history survives reopening", () => {
    let p = accepted(projection("plan_open"), event(10, add({op_id: "repeat_01"})));
    p = accepted(p, event(11, {kind: "plan.close", base_rev: 1}));
    p = accepted(p, event(12, open()));
    const r = applyOp(p, event(13, add({op_id: "repeat_01"})), template);
    expect(r).toMatchObject({ok: true, replayed: true}); expect(r.projection.tasks).toEqual([]);
    expect(Object.keys(r.projection.replayed_ops)).toContain(JSON.stringify(["alice", "repeat_01"]));
  });
  it("R4 separately folded histories do not share replay state", () => {
    const events = [event(1, open()), event(2, add({op_id: "repeat_01"}))];
    expect(folded(events).tasks).toHaveLength(1); expect(folded(events).tasks).toHaveLength(1);
  });
  it("R4 cancelled IDs remain consumed", () => {
    const p = folded([event(1, open()), event(2, add()), event(3, {kind: "task.set", task_id: "T01", base_rev: 2, state: "cancelled"}), event(4, add())]);
    expect(p.tasks.map(t => t.id)).toEqual(["T01", "T02"]);
  });
});

describe("R5 derived state, progress and dependency readiness", () => {
  const states: [string[], "blocked" | "cancelled" | null, TaskStatus][] = [
    [[], null, "pending"], [["pending"], null, "pending"], [["active"], null, "active"],
    [["done", "pending"], null, "active"], [["done"], null, "done"],
    [["blocked", "done"], null, "blocked"], [["done"], "blocked", "blocked"],
    [["blocked"], "cancelled", "cancelled"],
  ];
  for (const [micros, explicit_state, expected] of states)
    it(`R5 precedence ${micros.join("+")}/${explicit_state}: ${expected}`, () => {
      const t = task(); const micro = t.microtasks[0]!;
      expect(computeTaskStatus({...t, explicit_state, microtasks: micros.map(state => ({...micro, state: state as typeof micro.state}))})).toBe(expected);
    });
  it("R5 no micros and no done micros yield zero; partial progress is fractional", () => {
    expect(computeProgress([])).toBe(0); const t = task();
    expect(computeProgress([{...t, microtasks: []}])).toBe(0);
    expect(computeProgress([t])).toBe(0);
    expect(computeProgress([{...t, microtasks: [{...t.microtasks[0]!, state: "done"}, t.microtasks[0]!]}])).toBe(0.5);
  });
  it("R5 all deps must be done; blocked remains dependency-ready", () => {
    const t = {...task(), id: "T03", deps: ["T01", "T02"]};
    const one = {...task(), id: "T01", state: "done" as const}; const two = {...task(), id: "T02"};
    const map = new Map([[one.id, one], [two.id, two]]);
    expect(isTaskReady(t, map)).toBe(false); map.set(two.id, {...two, state: "done"});
    expect(isTaskReady(t, map)).toBe(true);
    expect(isTaskReady({...t, state: "blocked"}, map)).toBe(true);
    expect(isTaskReady({...t, state: "done"}, map)).toBe(false);
    expect(isTaskReady({...t, state: "cancelled"}, map)).toBe(false);
    expect(isTaskReady({...t, deps: ["T40"]}, map)).toBe(false);
  });
  it("R5 fold recomputes readiness after dependency completion", () => {
    const events = [event(1, open()), event(2, add()), event(3, add({deps: ["T01"]}))];
    expect(folded(events).tasks[1]!.ready).toBe(false);
    expect(folded([...events, event(4, {kind: "micro.set", micro_id: "T01.M01", state: "done"})]).tasks[1]!.ready).toBe(true);
  });
  it("R5 ordinal tie ordering uses id and does not mutate events", () => {
    const first = event(2, add({title: "First"})); const second = event(3, add({title: "Second"}), {lamport: 2});
    expect(folded(freeze([second, event(1, open()), first])).tasks.map(t => t.title)).toEqual(["First", "Second"]);
  });
});
