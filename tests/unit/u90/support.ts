import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect } from "vitest";
import { deriveActivity } from "../../../src/app/activity";
import { applyOp, emptyProjection, foldPlan } from "../../../src/plan/reducer";
import type { PlanMicrotask, PlanProjection, PlanTask } from "../../../src/plan/types";

export const root = process.cwd();
export const fixture = JSON.parse(readFileSync(join(root, "tests/unit/u90/fixture.json"), "utf8")) as {
  seed: Record<string, unknown>[]; beat: Record<string, unknown> & { op: Record<string, unknown> };
};
export type Live = { agent: string; run_id: string; beat_ts: number; beat_lamport: number };
export type ActivityMicro = PlanMicrotask & { live?: Live };
export const live: Live = { agent: "alice", run_id: "run_A", beat_ts: 1000, beat_lamport: 10 };
export const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export function micro(changes: Partial<ActivityMicro> = {}): ActivityMicro {
  return { id: "T01.M01", text: "Step", accept: "Checked", state: "active", outcome: null, took: null, evidence: [], rev: 4, ...changes };
}
export function task(micros: ActivityMicro[] = [micro()], changes: Partial<PlanTask> = {}): PlanTask {
  return { id: "T01", title: "Action", type: "action", phase: "start", accept: "Checked", deps: [], assignee: "alice", claim_lamport: 3, claim_ts: 300, estimate: null, explicit_state: null, blocked_reason: null, state: "active", ready: true, rev: 4, microtasks: micros, ...changes };
}
export function readiness(): void {
  // A public helper prerequisite gives a stub failure, never a false skip or mocked admission.
  const m = micro();
  expect(deriveActivity(task([m]), m, 1000)).toBe("unknown");
}
export function event(n: number, op: Record<string, unknown>, agent = "alice", ts = n * 100): Record<string, unknown> {
  return { id: `e-${n.toString(16).padStart(16, "0")}`, room: "demo", agent, act: "op", text: "", ts, lamport: n, op };
}
export function beat(n = 10, run = "run_A", changes: Record<string, unknown> = {}): Record<string, unknown> {
  return event(n, { ...fixture.beat.op, op_id: `beat${String(n).padStart(4, "0")}`, run_id: run, ...changes });
}
export function apply(state: PlanProjection, ev: unknown): PlanProjection {
  const result = applyOp(state, ev);
  expect(result.ok, result.ok ? "accepted" : result.code).toBe(true);
  if (!result.ok) throw new Error(`operation rejected: ${result.code}`);
  return result.projection;
}
export function incremental(events: Record<string, unknown>[]): PlanProjection {
  let state = emptyProjection();
  for (const ev of events) {
    if (ev["act"] === "op") state = apply(copy(state), ev);
  }
  return state;
}
export function projectedMicro(state: PlanProjection, index = 0): ActivityMicro {
  return state.tasks[0]!.microtasks[index]! as ActivityMicro;
}
export function publicView(state: PlanProjection): unknown {
  // Amendment B permits no additional public fields; replay-cache payloads stay opaque.
  expect(Object.keys(state).sort()).toEqual(Object.keys(emptyProjection()).sort());
  for (const t of state.tasks) {
    expect(Object.keys(t).sort()).toEqual(Object.keys(task()).sort());
    for (const m of t.microtasks) expect(Object.keys(m).filter((k) => k !== "live").sort()).toEqual(Object.keys(micro()).sort());
  }
  const { plan, memory, archived_plans, rollup, last_lamport, rejected } = state;
  return { plan, memory, archived_plans, rollup, last_lamport, rejected, tasks: state.tasks.map((t) => {
    const { id, title, type, phase, accept, deps, assignee, claim_lamport, claim_ts, estimate, explicit_state, blocked_reason, state, ready, rev } = t;
    return { id, title, type, phase, accept, deps, assignee, claim_lamport, claim_ts, estimate, explicit_state, blocked_reason, state, ready, rev, microtasks: t.microtasks.map((m) => {
      const { id, text, accept, state, outcome, took, evidence, rev } = m;
      const value = { id, text, accept, state, outcome, took, evidence, rev };
      const activity = (m as ActivityMicro).live;
      return activity === undefined ? value : { ...value, live: activity };
    }) };
  }) };
}
export function publicTasks(state: PlanProjection): unknown {
  return (publicView(state) as { tasks: unknown }).tasks;
}
export function python(request: object): unknown {
  const script = join(root, "bridge/tests/room/u90/projection_cli.py");
  const result = spawnSync("python3", ["-B", script], { cwd: root, input: JSON.stringify(request), encoding: "utf8", timeout: 10000, maxBuffer: 262144,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}
export function initial(): PlanProjection {
  const result = foldPlan(fixture.seed);
  expect(result.stats.rejected).toBe(0);
  return result.projection;
}
export function requireOwnerRejection(run: typeof applyOp): void {
  const result = run(initial(), event(10, fixture.beat.op, "mallory"));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe("claimed_by_other");
}
export function requireClaimOnlyIdle(derive: typeof deriveActivity): void {
  const t = task([micro({ state: "pending" })], { state: "active" });
  expect(derive(t, undefined, 1000)).toBe("idle");
}
