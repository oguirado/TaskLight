// @vitest-environment node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { applyOp, emptyProjection, foldPlan, isTaskReady } from "../../../src/plan/reducer";
import type { PlanningTemplate, PlanProjection, PlanTask, TaskStatus } from "../../../src/plan/types";

interface Fixture {
  name: string;
  ops: Record<string, unknown>[];
  expected: { tasks: { id: string; state: TaskStatus; ready: boolean }[]; rollup: PlanProjection["rollup"] };
}
const root = new URL("../../../", import.meta.url);
const template = (JSON.parse(readFileSync(new URL("fixtures/plan/templates.v1.json", root), "utf8")) as
  { templates: PlanningTemplate[] }).templates[0]!;
const cases = (JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")) as
  { cases: Fixture[] }).cases;
const vector = (name: string): Fixture => structuredClone(cases.find(c => c.name === name)!);
function event(n: number, operation: Record<string, unknown>) {
  const op = structuredClone(operation);
  if (op["kind"] === "plan.open") op["template_hash"] = template.hash;
  return { id: `e-${n.toString(16).padStart(16, "0")}`, lamport: n,
    ts: 1_700_000_000_000 + n, room: "demo", agent: "alice", act: "op", text: "", op };
}
const eventsFor = (fixture: Fixture) => fixture.ops.map((op, index) => event(index + 1, op));
const folded = (events: unknown[]) => foldPlan(events, template).projection;
function accepted(projection: PlanProjection, item: unknown): PlanProjection {
  const result = applyOp(projection, item, template);
  expect(result.ok, "fixture operation must be accepted").toBe(true);
  if (!result.ok) throw new Error(`Unexpected fixture rejection: ${result.code}`);
  return result.projection;
}
const incremental = (events: unknown[]) => events.reduce<PlanProjection>(accepted, emptyProjection());
function canonical(projection: PlanProjection) {
  return { tasks: [...projection.tasks].sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, state, ready }) => ({ id, state, ready })), rollup: projection.rollup };
}

describe("U88 A1 exported dependency predicate", () => {
  it.each([
    ["done", true], ["cancelled", true], ["pending", false],
    ["active", false], ["blocked", false], ["missing", false],
  ] as const)("A1 isTaskReady prerequisite %s -> %s", (state, ready) => {
    const projection = folded(eventsFor(vector("A1_pending")));
    const dependant = projection.tasks[1]!;
    const byId = new Map<string, PlanTask>();
    if (state !== "missing") byId.set("T01", { ...projection.tasks[0]!, state });
    expect(isTaskReady(dependant, byId)).toBe(ready);
  });
});

describe("U88 canonical full folding, independent of the exported helper", () => {
  it.each(cases)("$name event fold and incremental application", fixture => {
    const events = eventsFor(fixture);
    const replay = foldPlan(events, template);
    expect(replay.stats).toMatchObject({ rejected: 0, invalid: 0, applied: events.length });
    expect(replay.projection.rejected).toEqual([]);
    expect(incremental(events)).toEqual(replay.projection);
    expect(canonical(replay.projection)).toEqual(fixture.expected);
  });

  it("M6 Python and TS canonical task states, readiness and rollups agree", () => {
    const batches = cases.map(eventsFor);
    const python = spawnSync("python3", ["-B", "-m", "bridge.tests.plan.u88.fixtures"], {
      cwd: root, input: JSON.stringify(batches), encoding: "utf8", timeout: 10_000,
      maxBuffer: 1_048_576, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(python.error).toBeUndefined();
    expect(python.status, python.stderr).toBe(0);
    const projections: unknown = JSON.parse(python.stdout);
    const typescript = batches.map(events => canonical(folded(events)));
    expect(projections).toEqual(typescript);
    // Agreement on the old bug is insufficient: fixed expected results are binding.
    expect(typescript).toEqual(cases.map(fixture => fixture.expected));
  });

  it("A2 cancellation immediately recomputes downstream readiness", () => {
    const events = eventsFor(vector("A1_pending"));
    const before = folded(events);
    const snapshot = structuredClone(before);
    const cancellation = event(4, { kind: "task.set", task_id: "T01",
      base_rev: before.tasks[0]!.rev, state: "cancelled" });
    const after = accepted(before, cancellation);
    expect(before).toEqual(snapshot);
    expect(after).toEqual(folded([...events, cancellation]));
    expect(canonical(after)).toEqual(vector("A1_cancelled").expected);
  });

  it("A2 clearing with latest revision restores pending and not-ready dependant", () => {
    const events = eventsFor(vector("A1_cancelled"));
    const cancelled = folded(events);
    const reversal = event(5, { kind: "task.set", task_id: "T01",
      base_rev: cancelled.tasks[0]!.rev, state: null });
    const after = accepted(cancelled, reversal);
    expect(after).toEqual(folded([...events, reversal]));
    expect(canonical(after)).toEqual(vector("A2_reversed").expected);
    expect(after.tasks[0]!.explicit_state).toBeNull();
  });

  it("A2 op_id replay preserves cancellation without an extra task revision", () => {
    const events = eventsFor(vector("A1_pending"));
    const cancellation = event(4, { kind: "task.set", task_id: "T01", base_rev: 2,
      state: "cancelled", op_id: "cancel-once" });
    const after = accepted(folded(events), cancellation);
    const duplicate = event(5, cancellation.op);
    const result = applyOp(after, duplicate, template);
    expect(result).toMatchObject({ ok: true, replayed: true });
    expect(result.projection.tasks).toEqual(after.tasks);
    expect(result.projection.rollup).toEqual(after.rollup);
    expect(result.projection).toEqual(folded([...events, cancellation, duplicate]));
  });

  it.each(["A3_conjunction_wait", "A3_conjunction_done", "A3_conjunction_cancelled", "A3_chain"])(
    "A3 reversed task-array order: %s", name => {
      const fixture = vector(name);
      const events = eventsFor(fixture);
      const before = incremental(events.slice(0, -1));
      const reversed = { ...before, tasks: [...before.tasks].reverse() };
      const after = accepted(reversed, events.at(-1));
      expect(canonical(after)).toEqual(fixture.expected);
    });
});

describe("U88 A4 cancellation remains distinct from completion", () => {
  it("A4 preserves microdata, ownership, revisions and completion progress", () => {
    const fixture = vector("A1_pending");
    fixture.ops[1]!["microtasks"] = Array.from({ length: 3 }, () => ({ text: "Step", accept: "Verified" }));
    const events = eventsFor(fixture);
    events.push(event(4, { kind: "task.claim", task_id: "T01", base_rev: 2 }),
      event(5, { kind: "micro.set", micro_id: "T01.M01", state: "done", outcome: "Verified", took: "1m",
        evidence: [{ path: "proof.txt", sha256: "a".repeat(64) }] }),
      event(6, { kind: "micro.set", micro_id: "T01.M02", state: "active" }));
    const before = incremental(events);
    const snapshot = structuredClone(before);
    const cancellation = event(7, { kind: "task.set", task_id: "T01",
      base_rev: before.tasks[0]!.rev, state: "cancelled" });
    const after = accepted(before, cancellation);
    expect(before).toEqual(snapshot);
    expect(after.tasks[0]).toEqual({ ...before.tasks[0]!, explicit_state: "cancelled",
      state: "cancelled", ready: false, rev: 7 });
    const { ready: _readyBefore, ...priorDependant } = before.tasks[1]!;
    const { ready: _readyAfter, ...nextDependant } = after.tasks[1]!;
    expect(nextDependant).toEqual(priorDependant);
    for (const key of ["tasks_done", "micro_done", "progress", "progress_pct"] as const)
      expect(after.rollup[key]).toBe(before.rollup[key]);
    for (const key of ["plan", "memory", "archived_plans"] as const)
      expect(after[key]).toEqual(before[key]);
    expect(after).toEqual(folded([...events, cancellation]));
  });

  it.each(["A4_terminal_done", "A4_terminal_cancelled"])("A4 terminal helper guard: %s", name => {
    const projection = folded(eventsFor(vector(name)));
    expect(isTaskReady(projection.tasks[1]!, new Map(projection.tasks.map(task => [task.id, task])))).toBe(false);
  });

  it("A4 pending tasks with empty dependencies stay ready", () => {
    const projection = folded(eventsFor(vector("A1_pending")));
    expect(isTaskReady(projection.tasks[0]!, new Map())).toBe(true);
  });

  it("A4 unlocking never activates microtasks or manufactures liveness", () => {
    const dependant = folded(eventsFor(vector("A1_cancelled"))).tasks[1]!;
    expect(dependant.state).toBe("pending");
    expect(dependant.microtasks[0]!.state).toBe("pending");
    expect(dependant.microtasks[0]).not.toHaveProperty("live");
    expect(dependant.ready, "unlocked work stays pending").toBe(true);
  });
});

describe("U88 A6 rejected operations leave domain data unchanged", () => {
  it.each([
    { name: "missing dependency", changes: { deps: ["T40"] }, code: "not_found" },
    { name: "self dependency", changes: { deps: ["T02"] }, code: "dep_cycle" },
    { name: "forged state", changes: { state: "cancelled<script>" }, code: "bad_op" },
    { name: "stale revision", changes: { base_rev: 2, state: "cancelled" }, code: "stale_rev" },
    { name: "missing task", changes: { task_id: "T40", state: "cancelled" }, code: "not_found" },
    { name: "transitive cycle", changes: { task_id: "T01", base_rev: 2, deps: ["T02"] }, code: "dep_cycle" },
  ])("A6 $name -> $code", ({ changes, code }) => {
    const events = eventsFor(vector("A1_pending"));
    const before = folded(events);
    const snapshot = structuredClone(before);
    const hostile = event(4, { kind: "task.set", task_id: "T02", base_rev: before.tasks[1]!.rev, ...changes });
    const result = applyOp(before, hostile, template);
    expect(result).toMatchObject({ ok: false, code });
    expect(before).toEqual(snapshot);
    const replay = folded([...events, hostile]);
    expect(replay.rejected.map(receipt => receipt.code)).toEqual([code]);
    for (const key of ["plan", "tasks", "memory", "archived_plans", "rollup"] as const) {
      expect(result.projection[key]).toEqual(before[key]);
      expect(replay[key]).toEqual(before[key]);
    }
  });
});
