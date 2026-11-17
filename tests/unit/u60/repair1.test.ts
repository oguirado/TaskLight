// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyOp, foldPlan } from "../../../src/plan";
import { add, clone, event, folded, freeze, open, projection, template, vector } from "./helpers";

// Repair 1, item 1 (oracle amendment A-U55b): plan.close archives immediately
// with closed_ts = close event ts; reopening must not duplicate or alter it.
describe("repair1 archive at plan.close", () => {
  it("archive entry is present immediately after close, without reopening", () => {
    const events = [
      event(1, open()),
      event(2, add()),
      // A-U109c: (a) claim and complete before testing immediate archival, M3/M6.
      event(3, { kind: "task.claim", task_id: "T01" }),
      event(4, { kind: "micro.set", micro_id: "T01.M01", state: "done" }),
      event(5, { kind: "plan.close", base_rev: 1, outcome: "Finished" }),
    ];
    const p = folded(events);
    expect(p.plan).toMatchObject({ state: "closed", closed_outcome: "Finished" });
    expect(p.archived_plans).toHaveLength(1);
    expect(p.archived_plans[0]).toEqual({
      id: "p1",
      title: "Plan",
      template_id: template.id,
      opened_ts: events[0]!.ts,
      closed_ts: events[4]!.ts,
      tasks_total: 1,
      tasks_done: 1,
      outcome: "Finished",
    });
  });

  it("reopening does not duplicate or alter the archived entry", () => {
    // A-U109c: (a) cancel unfinished work before closing/reopening, M6.
    const base = [event(1, open()), event(2, add()),
      event(3, { kind: "task.set", task_id: "T01", base_rev: 2, state: "cancelled" }),
      event(4, { kind: "plan.close", base_rev: 1, outcome: "Finished" })];
    const reopen = [...clone(base), event(5, open())];
    const p = foldPlan(reopen, template).projection;
    expect(p.rejected).toEqual([]);
    expect(p.archived_plans).toEqual([{ id: "p1", title: "Plan", template_id: template.id,
      opened_ts: base[0]!.ts, closed_ts: base[3]!.ts, tasks_total: 1, tasks_done: 0, outcome: "Finished" }]);
    expect(p.archived_plans).toHaveLength(1);
    expect(p.tasks).toEqual([]);
  });

  it("a second close appends a second distinct archive entry", () => {
    const events = [
      event(1, open()),
      event(2, add()),
      // A-U109c: (a) cancel unfinished tasks in both archive cycles, M6.
      event(3, { kind: "task.set", task_id: "T01", base_rev: 2, state: "cancelled" }),
      event(4, { kind: "plan.close", base_rev: 1, outcome: "First" }),
      event(5, open()),
      event(6, add()),
      event(7, { kind: "task.set", task_id: "T01", base_rev: 6, state: "cancelled" }),
      event(8, { kind: "plan.close", base_rev: 5, outcome: "Second" }),
    ];
    const p = folded(events);
    expect(p.archived_plans).toHaveLength(2);
    expect(p.archived_plans[0]).toMatchObject({ closed_ts: events[3]!.ts, outcome: "First" });
    expect(p.archived_plans[1]).toMatchObject({ closed_ts: events[7]!.ts, outcome: "Second" });
  });

  it("close does not mutate the input projection", () => {
    const before = projection("plan_open");
    const input = freeze(clone(before));
    const result = applyOp(input, event(9, { kind: "plan.close", base_rev: 1, outcome: "Done" }), template);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.projection.archived_plans).toHaveLength(1);
      expect(result.projection.archived_plans[0]).toMatchObject({ closed_ts: 1_700_000_000_009, outcome: "Done" });
    }
    expect(input).toEqual(before);
    expect(before.archived_plans).toHaveLength(0);
  });
});

// Repair 1, item 2: per-field length/count overflow error codes.
// Python bridge/plan/ops.py is canonical for its own receipts: count caps
// (deps/microtasks/evidence) and the 8192-byte canonical payload cap map to
// limit_exceeded. A-U60a: per-field string-length caps are bad_op (Python U55 canonical);
// per binding amendment W0-R item 12 ("Oversize -> limit_exceeded") and the
// H1 hostile oracle; see report for the ops.py _check_str_len discrepancy.
describe("repair1 overflow error codes", () => {
  it("canonical 8192-byte payload cap is limit_exceeded", () => {
    const brief = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`field${i}`, "😀".repeat(300)]));
    const e = event(1, { ...open(), brief });
    expect(Buffer.byteLength(JSON.stringify(e.op), "utf8")).toBeGreaterThan(8192);
    const r = applyOp(projection("empty"), e, template);
    expect(r).toMatchObject({ ok: false, code: "limit_exceeded" });
  });

  it("count caps are limit_exceeded", () => {
    const deps = applyOp(projection(), event(10, add({ deps: Array.from({ length: 9 }, (_, i) => `T${String(i + 1).padStart(2, "0")}`) })), template);
    expect(deps).toMatchObject({ ok: false, code: "limit_exceeded" });
    const micros = applyOp(projection(), event(10, add({ microtasks: Array.from({ length: 13 }, () => ({ text: "x" })) })), template);
    expect(micros).toMatchObject({ ok: false, code: "limit_exceeded" });
    const ev = applyOp(projection(), event(10, { kind: "micro.set", micro_id: "T01.M01", state: "done", evidence: Array.from({ length: 9 }, () => ({ path: "proof", sha256: "a".repeat(64) })) }), template);
    expect(ev).toMatchObject({ ok: false, code: "limit_exceeded" });
  });

  it("per-field code-point caps are enforced (inclusive at cap, rejected above)", () => {
    expect(applyOp(projection("empty"), event(1, { ...open(), title: "😀".repeat(120) }), template).ok).toBe(true);
    expect(applyOp(projection("empty"), event(1, { ...open(), title: "😀".repeat(121) }), template)).toMatchObject({ ok: false, code: "bad_op" });
    expect(applyOp(projection("plan_open"), event(10, { ...add(), accept: "x".repeat(160) }), template).ok).toBe(true);
    expect(applyOp(projection("plan_open"), event(10, { ...add(), accept: "x".repeat(161) }), template)).toMatchObject({ ok: false, code: "bad_op" });
  });
});
