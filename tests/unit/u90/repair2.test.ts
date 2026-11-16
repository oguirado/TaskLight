// @vitest-environment node
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyOp, foldPlan } from "../../../src/plan/reducer";
import type { PlanProjection } from "../../../src/plan/types";
import { apply, beat, copy, event, fixture, incremental } from "./support";

afterEach(() => vi.restoreAllMocks());

function saturatedHistory(): Record<string, unknown>[] {
  return [...copy(fixture.seed),
    event(10, { kind: "memory.set", section: "notes", text: "Keep", base_rev: 0, op_id: "keep-memory" }),
    ...Array.from({ length: 258 }, (_, i) => beat(20 + i, `run_${String(i).padStart(3, "0")}`))];
}
function reopenEvents(run: string): Record<string, unknown>[] {
  return [
    event(300, { kind: "plan.close", base_rev: 1, op_id: "close-old" }),
    event(301, { ...(fixture.seed[0]!["op"] as object), title: "New plan", op_id: "open-new" }),
    event(302, { ...(fixture.seed[1]!["op"] as object), op_id: "add-next" }),
    event(303, { kind: "micro.set", micro_id: "T01.M01", state: "active", op_id: "active-new" }),
    beat(304, run),
  ];
}
function pythonProjection(events: Record<string, unknown>[]): unknown {
  const result = spawnSync("python3", ["-B", "-c",
    "import json, sys; from bridge.plan.fold import fold_plan; print(json.dumps(fold_plan(json.load(sys.stdin))))"], {
    cwd: process.cwd(), input: JSON.stringify(events), encoding: "utf8", timeout: 10000,
    maxBuffer: 2 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

const activeHistory = () => [...copy(fixture.seed), beat(10), beat(11, "run_B")];
type OperationCase = { kind: string; op: Record<string, unknown>; agent?: string; closed?: boolean };
const acceptedCases: OperationCase[] = [
  { kind: "plan.open", op: { ...(fixture.seed[0]!["op"] as object), title: "New plan" }, closed: true },
  { kind: "plan.close", op: { base_rev: 1 } },
  { kind: "plan.phase", op: { base_rev: 1, phase: "finish" } },
  { kind: "task.add", op: { ...(fixture.seed[1]!["op"] as object) } },
  { kind: "task.set", op: { task_id: "T01", base_rev: 5, title: "Changed", state: "blocked" } },
  { kind: "task.claim", op: { task_id: "T01", takeover: true }, agent: "mallory" },
  { kind: "task.release", op: { task_id: "T01" } },
  { kind: "micro.add", op: { task_id: "T01", base_rev: 5, text: "New" } },
  { kind: "micro.set", op: { micro_id: "T01.M01", state: "done", evidence: [{ path: "proof.txt", sha256: "a".repeat(64) }] } },
  { kind: "memory.set", op: { section: "notes", base_rev: 0, text: "Changed" } },
  { kind: "activity.beat", op: { task_id: "T01", micro_id: "T01.M01", run_id: "run_C" } },
];
function historyFor(c: OperationCase): Record<string, unknown>[] {
  return [...activeHistory(), ...(c.closed ? [event(20, { kind: "plan.close", base_rev: 1 })] : [])];
}
function expectedRejection(before: PlanProjection, ev: Record<string, unknown>, code: string): PlanProjection {
  const expected = copy(before);
  expected.last_lamport = ev["lamport"] as number;
  expected.rejected = [...expected.rejected, { id: ev["id"] as string, lamport: ev["lamport"] as number,
    op_id: (ev["op"] as Record<string, unknown>)["op_id"] as string, code: code as "bad_op" }];
  return expected;
}
function failReceiptOnce(opId: string): () => number {
  const stringify = JSON.stringify;
  let keys = 0;
  vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
    const value: unknown = args[0];
    if (Array.isArray(value) && value.length === 2 && value[1] === opId && ++keys === 2) {
      throw new Error("receipt serialization failed");
    }
    return Reflect.apply(stringify, JSON, args) as string;
  });
  return () => keys;
}

describe("U90 repair two: plan-scoped retirement", () => {
  it.each(["run_000", "fresh_run"])("reopens a saturated plan and accepts %s with exact Python parity", run => {
    const history = saturatedHistory();
    const sealed = foldPlan(history);
    expect(sealed.stats.rejected).toBe(0);
    expect(sealed.projection.replayed_ops["activity.retired"]).toMatchObject({ T01: ["*"] });
    expect(sealed.projection.tasks[0]!.microtasks[0]!.live).toBeUndefined();
    const denied = applyOp(sealed.projection, event(280, fixture.seed[0]!["op"] as Record<string, unknown>));
    expect(denied).toMatchObject({ ok: false, code: "plan_exists" });
    expect(denied.projection.replayed_ops).toEqual(sealed.projection.replayed_ops);
    let state = copy(sealed.projection);
    for (const ev of reopenEvents(run)) {
      state = apply(JSON.parse(JSON.stringify(state)) as PlanProjection, ev);
      if ((ev["op"] as Record<string, unknown>)["kind"] === "plan.open") {
        expect(state.replayed_ops).not.toHaveProperty("activity.retired");
      }
    }
    const full = foldPlan([...history, ...reopenEvents(run)]);
    expect(full.stats.rejected).toBe(0);
    expect(full.projection).toEqual(state);
    expect(incremental([...history, ...reopenEvents(run)])).toEqual(state);
    expect(pythonProjection([...history, ...reopenEvents(run)])).toEqual(state);
    expect(state.tasks[0]!.microtasks[0]!.live).toEqual({ agent: "alice", run_id: run, beat_ts: 30400, beat_lamport: 304 });
    expect(state.memory).toEqual(sealed.projection.memory);
    expect(state.archived_plans).toHaveLength(1);
    for (const [key, receipt] of Object.entries(sealed.projection.replayed_ops)) {
      if (key !== "activity.retired") expect(state.replayed_ops[key]).toEqual(receipt);
    }
  });
  it("also resets an unsaturated retired set", () => {
    const history = [...copy(fixture.seed), beat(10, "run_000"), beat(11, "run_B")];
    expect(foldPlan(history).projection.replayed_ops["activity.retired"]).toMatchObject({ T01: ["run_000"] });
    const events = [...history, ...reopenEvents("run_000")];
    const result = foldPlan(events);
    expect(result.stats.rejected).toBe(0);
    expect(result.projection.tasks[0]!.microtasks[0]!.live?.run_id).toBe("run_000");
    expect(pythonProjection(events)).toEqual(result.projection);
  });
});

describe("U90 repair two: private accumulator rollback", () => {
  const rejectedCases = [
    { kind: "plan.open", op: fixture.seed[0]!["op"], code: "plan_exists" },
    { kind: "plan.close", op: { base_rev: 999 }, code: "stale_rev" },
    { kind: "plan.phase", op: { base_rev: 999, phase: "finish" }, code: "stale_rev" },
    { kind: "task.add", op: { ...(fixture.seed[1]!["op"] as object), deps: ["T40"] }, code: "not_found" },
    { kind: "task.set", op: { task_id: "T01", base_rev: 5, title: "Changed", deps: ["T01"] }, code: "dep_cycle" },
    { kind: "task.claim", op: { task_id: "T01" }, agent: "mallory", code: "claimed_by_other" },
    { kind: "task.release", op: { task_id: "T01" }, agent: "mallory", code: "claimed_by_other" },
    { kind: "micro.add", op: { task_id: "T01", base_rev: 999, text: "New" }, code: "stale_rev" },
    { kind: "micro.set", op: { micro_id: "T01.M01", state: "done" }, agent: "mallory", code: "claimed_by_other" },
    { kind: "memory.set", op: { section: "notes", base_rev: 999, text: "Changed" }, code: "stale_rev" },
    { kind: "activity.beat", op: { task_id: "T01", run_id: "run_B" }, agent: "mallory", code: "claimed_by_other" },
  ];
  it.each(rejectedCases)("rejected $kind changes only journal bookkeeping", c => {
    const history = activeHistory();
    const before = foldPlan(history).projection;
    const ev = event(100, { ...(c.op as object), kind: c.kind, op_id: `reject-${c.kind.replace(".", "_")}` }, c.agent ?? "alice", 2000000);
    const result = foldPlan([...history, ev]);
    expect(result.stats.rejected).toBe(1);
    expect(result.projection).toEqual(expectedRejection(before, ev, c.code));
    expect(result.projection).toEqual(pythonProjection([...history, ev]));
  });
  it.each(acceptedCases)("throwing $kind rolls back every mutation and replay entry", c => {
    const history = historyFor(c);
    const before = foldPlan(history).projection;
    const opId = `throw-${c.kind.replace(".", "_")}`;
    const ev = event(100, { ...c.op, kind: c.kind, op_id: opId }, c.agent ?? "alice", 2000000);
    // Establish the control before injecting a failure after handler mutation.
    expect(foldPlan([...history, ev]).stats.rejected).toBe(0);
    const count = failReceiptOnce(opId);
    const result = foldPlan([...history, ev]);
    vi.restoreAllMocks();
    expect(count()).toBe(2);
    expect(result.stats.rejected).toBe(1);
    expect(result.projection).toEqual(expectedRejection(before, ev, "bad_op"));
    const next = event(101, { kind: "memory.set", section: "recovery", base_rev: 0, text: "Still usable" });
    failReceiptOnce(opId);
    const continued = foldPlan([...history, ev, next]);
    vi.restoreAllMocks();
    const expected = foldPlan([...history, next]).projection;
    expected.rejected = expectedRejection(before, ev, "bad_op").rejected;
    expect(continued.projection).toEqual(expected);
  });
  it.each(acceptedCases)("public applyOp also rolls back a throwing $kind", c => {
    const before = foldPlan(historyFor(c)).projection;
    const input = copy(before);
    const opId = `public-${c.kind.replace(".", "_")}`;
    const ev = event(100, { ...c.op, kind: c.kind, op_id: opId }, c.agent ?? "alice", 2000000);
    const count = failReceiptOnce(opId);
    const result = applyOp(input, ev);
    vi.restoreAllMocks();
    expect(count()).toBe(2);
    expect(result).toMatchObject({ ok: false, code: "bad_op" });
    expect(input).toEqual(before);
    expect(result.projection).toEqual({ ...before, last_lamport: 100 });
  });
  it("a recompute exception rejects and rolls back the operation", () => {
    const history = activeHistory();
    const before = foldPlan(history).projection;
    const ev = event(100, { kind: "task.set", task_id: "T01", base_rev: 5, state: "blocked", title: "Changed", op_id: "recompute-fault" });
    const set = Map.prototype.set;
    let faults = 0;
    vi.spyOn(Map.prototype, "set").mockImplementation(function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      if (key === "T01" && value && typeof value === "object" && "rev" in value && value.rev === 100 && faults++ === 0) {
        throw new Error("derived state failed");
      }
      return Reflect.apply(set, this, [key, value]) as Map<unknown, unknown>;
    });
    const result = foldPlan([...history, ev]);
    vi.restoreAllMocks();
    expect(faults).toBeGreaterThan(0);
    expect(result.stats.rejected).toBe(1);
    expect(result.projection).toEqual(expectedRejection(before, ev, "bad_op"));
  });
});
