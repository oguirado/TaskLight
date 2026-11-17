// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { applyOp } from "../../../src/plan/reducer";
import type { PlanProjection } from "../../../src/plan/types";
const data = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")) as {
  fixtures: Record<string, PlanProjection>;
};
type Op = Record<string, unknown>;
function event(n: number, op: Op, agent = "alice") {
  return {id: `e-${n.toString(16).padStart(16, "0")}`, lamport: n, ts: 1700000000000+n,
    room: "demo", agent, act: "op", text: "", op};
}
function accepted(p: PlanProjection, n: number, op: Op, agent = "alice"): PlanProjection {
  const r = applyOp(p, event(n, op, agent));
  expect(r.ok ? "accepted" : r.code).toBe("accepted");
  return r.projection;
}
function rejected(p: PlanProjection, n: number, op: Op, code: string, agent = "alice") {
  const original = structuredClone(p), r = applyOp(p, event(n, op, agent));
  expect(r.ok ? null : r.code).toBe(code);
  expect(p).toEqual(original);
  for (const key of ["plan", "tasks", "rollup", "archived_plans", "replayed_ops"] as const)
    expect(r.projection[key]).toEqual(original[key]);
}
function reacquired() {
  let p = structuredClone(data.fixtures["pending"]!);
  p = accepted(p, 31, {kind: "task.release", task_id: "T01"});
  return accepted(p, 32, {kind: "task.claim", task_id: "T01"});
}
for (const state of ["pending", "active", "blocked", "done"])
  it(`a5 history rejects old same-slug fence on ${state}`, () => {
    const p = reacquired(); expect(p.tasks[0]!.claim_lamport).toBe(32);
    rejected(p, 33, {kind: "micro.set", micro_id: "T01.M01", state, claim_lamport: 10}, "stale_rev");
  });
it("a5 history rejects old same-slug release fence", () => {
  rejected(reacquired(), 33, {kind: "task.release", task_id: "T01", claim_lamport: 10}, "stale_rev");
});
it("a5 current fence survives intervening task revisions", () => {
  let p = reacquired();
  p = accepted(p, 33, {kind: "micro.set", micro_id: "T01.M01", state: "active"});
  expect(p.tasks[0]!.rev).toBe(33); expect(p.tasks[0]!.claim_lamport).toBe(32);
  p = accepted(p, 34, {kind: "micro.set", micro_id: "T01.M01", state: "pending", claim_lamport: 32});
  p = accepted(p, 35, {kind: "task.release", task_id: "T01", base_rev: 34, claim_lamport: 32});
  expect(p.tasks[0]!.assignee).toBeNull();
});
for (const changed of [false, true])
  it(`a6 accepted release replay after reassignment changed-fence=${changed}`, () => {
    const release = {kind: "task.release", task_id: "T01", op_id: "release-first"};
    let p = accepted(structuredClone(data.fixtures["pending"]!), 31, release);
    p = accepted(p, 32, {kind: "task.claim", task_id: "T01"}, "bob");
    const before = structuredClone(p);
    const r = applyOp(p, event(33, changed ? {...release, claim_lamport: 9007199254740991} : release));
    expect(r).toMatchObject({ok: true, replayed: true});
    for (const key of ["plan", "tasks", "rollup", "archived_plans", "replayed_ops"] as const)
      expect(r.projection[key]).toEqual(before[key]);
  });
it("a5 cross-agent reacquisition race preserves the winning claim", () => {
  let p = accepted(structuredClone(data.fixtures["pending"]!), 31, {kind: "task.release", task_id: "T01"});
  p = accepted(p, 32, {kind: "task.claim", task_id: "T01"}, "bob");
  rejected(p, 33, {kind: "task.claim", task_id: "T01"}, "claimed_by_other");
  rejected(p, 34, {kind: "micro.set", micro_id: "T01.M01", state: "done", claim_lamport: 10}, "claimed_by_other");
  rejected(p, 35, {kind: "task.release", task_id: "T01", claim_lamport: 10}, "claimed_by_other");
});
it("a4 retired live run cannot return after release and reacquisition", () => {
  let p = accepted(structuredClone(data.fixtures["live"]!), 31, {kind: "task.release", task_id: "T01"});
  p = accepted(p, 32, {kind: "task.claim", task_id: "T01"});
  p = accepted(p, 33, {kind: "micro.set", micro_id: "T01.M01", state: "active"});
  p = accepted(p, 34, {kind: "activity.beat", task_id: "T01", run_id: "run-old", op_id: "old-run-probe"});
  expect(p.tasks[0]!.microtasks[0]!.live ?? null).toBeNull();
});
