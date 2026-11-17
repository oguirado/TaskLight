import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect } from "vitest";
import { applyOp, emptyProjection } from "../../../src/plan/reducer";
import type { PlanProjection, PlanningTemplate } from "../../../src/plan/types";

export type Op = Record<string, unknown>;
export interface Event {
  id: string; room: string; agent: string; act: "op"; text: string;
  lamport: number; ts: number; op: Op;
}
export interface LifecycleRecord {
  lifecycle: "deployed" | "alive" | "finished" | "failed";
  run_id: string; swarm?: string; harness?: string; reason?: string;
  deployed_ts: number; last_alive_ts?: number; ts: number; lamport: number;
  retired_run_ids: string[];
}
export interface History {
  name: string; events: Event[];
  expected_agent_lifecycle: Record<string, LifecycleRecord>;
  rejected: { lamport: number; code: string }[];
}
export interface Fixture {
  a1_args: Record<string, string>; a1_event: Event; a1_expected: LifecycleRecord;
  template: PlanningTemplate; open_op: Op; add_op: Op; histories: History[];
}
export const root = process.cwd();
export const fixture = JSON.parse(readFileSync(join(root, "tests/unit/u132/fixtures.json"), "utf8")) as Fixture;
export const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export function lifecycle(projection: PlanProjection): Record<string, LifecycleRecord> | undefined {
  return (projection as PlanProjection & { agent_lifecycle?: Record<string, LifecycleRecord> }).agent_lifecycle;
}
export function python<T>(request: Record<string, unknown>): T {
  const child = spawnSync("python3", ["-B", "-m", "bridge.tests.room.u132.projection_cli"], {
    cwd: root, input: JSON.stringify(request), encoding: "utf8", timeout: 15000,
    maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    // Preserve the actual last traceback line, without embedding local file paths.
    throw new Error(child.stderr.trim().split("\n").at(-1) || "Python differential adapter failed");
  }
  return JSON.parse(child.stdout) as T;
}
let checked = false;
let prerequisiteFailure: Error | undefined;
export function readiness(): void {
  if (!checked) {
    checked = true;
    try { expect(python<{ ok: boolean }>({ mode: "probe" })).toEqual({ ok: true }); }
    catch (error) { prerequisiteFailure = error instanceof Error ? error : new Error(String(error)); }
  }
  if (prerequisiteFailure) throw prerequisiteFailure;
}
export function event(n: number, op: Op, ts = n * 1000, agent = "exec-a"): Event {
  return { id: `e-${n.toString(16).padStart(16, "0")}`, room: "demo", agent, act: "op", text: "", lamport: n, ts, op };
}
export function life(n: number, state = "deployed", run = "r1", ts = n * 1000, metadata: Op = {}): Event {
  return event(n, { kind: "agent.lifecycle", state, run_id: run, op_id: `life${String(n).padStart(4, "0")}`, ...metadata }, ts);
}
export function apply(state: PlanProjection, ev: Event): PlanProjection {
  const before = copy(state);
  const result = applyOp(state, ev, fixture.template);
  expect(state, "applyOp must not mutate caller state").toEqual(before);
  expect(result.ok, result.ok ? "accepted" : result.code).toBe(true);
  if (!result.ok) throw new Error(`operation rejected: ${result.code}`);
  return result.projection;
}
export function incremental(events: Event[], start = emptyProjection()): PlanProjection {
  return events.reduce((state, ev) => apply(copy(state), ev), start);
}
export function semantic(projection: PlanProjection): unknown {
  const { plan, tasks, memory, archived_plans, rollup } = projection;
  return copy({ plan, tasks, memory, archived_plans, rollup });
}
export function assertFrozen(projection: PlanProjection, history: History): void {
  expect(lifecycle(projection), `frozen lifecycle expectation: ${history.name}`).toEqual(history.expected_agent_lifecycle);
  expect(projection.rejected.map(({ lamport, code }) => ({ lamport, code }))).toEqual(history.rejected);
}
export function history(name: string): History {
  const result = fixture.histories.find(h => h.name === name);
  if (!result) throw new Error(`missing frozen history: ${name}`);
  return result;
}
