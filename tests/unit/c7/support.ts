import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { PlanOpEvent, PlanProjection, PlanningTemplate } from "../../../src/plan/types";
import type { RoomEvent } from "../../../src/agents/types";
import { foldPlan } from "../../../src/plan/reducer";
import { deriveSwarmViewModel } from "../../../src/app/swarm_vm";

export type Evidence = { path: string; sha256: string };
export type Decision = { verdict: string; reason: string; evidence?: Evidence[] };
export type DecisionTask = { decisions?: Decision[]; last_decision?: Decision | null };
export type Vector = { name: string; valid: boolean; op: Record<string, unknown> };
export type History = { name: string; events: PlanOpEvent[]; reasons: string[]; rejected_ids: string[] };
export const root = process.cwd();
export const fixture = JSON.parse(readFileSync(join(root, "bridge/tests/room/c7/fixtures.json"), "utf8")) as {
  template: PlanningTemplate; base: Record<string, unknown>; evidence: Evidence[];
  seed: PlanOpEvent[]; cases: Vector[]; histories: History[];
};
export const NOW = 1800000001000;
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export function event(n: number, op: Record<string, unknown>, agent = "reviewer"): PlanOpEvent {
  return { id: `e-${n.toString(16).padStart(16, "0")}`, room: "demo", agent, act: "op", text: "",
    lamport: n, ts: NOW - 1000 + n, op: clone(op) as unknown as PlanOpEvent["op"] };
}
export function decision(n = 6, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...clone(fixture.base), op_id: `c7-decision-${String(n).padStart(4, "0")}`, ...fields };
}
export const fold = (events: readonly unknown[]): PlanProjection => foldPlan(events, fixture.template).projection;
export function decisionTask(projection: PlanProjection): DecisionTask {
  expect(projection.tasks).not.toHaveLength(0);
  return projection.tasks[0] as unknown as DecisionTask;
}
export function python(what: "fold" | "inventory", events: readonly unknown[]): unknown {
  const child = spawnSync("python3", ["-B", "-m", "bridge.tests.room.c7.probe"], {
    cwd: root, input: JSON.stringify({ what, events }), encoding: "utf8", timeout: 5000,
    maxBuffer: 512 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  expect(child.error, "bounded local Python probe must start").toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as unknown;
}
export function view(events: PlanOpEvent[], projection = fold(events)) {
  return deriveSwarmViewModel({ room: "demo", projection,
    events: events as unknown as RoomEvent[], nowMs: NOW, connected: true });
}
export function deterministic(): void {
  beforeEach(() => {
    vi.useFakeTimers({ loopLimit: 100 });
    vi.setSystemTime(NOW);
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
    vi.stubGlobal("WebSocket", class { constructor() { throw new Error("network forbidden"); } });
    vi.stubGlobal("XMLHttpRequest", class { constructor() { throw new Error("network forbidden"); } });
  });
  afterEach(() => {
    document.body.replaceChildren();
    for (const node of document.head.querySelectorAll("[data-c7-style]")) node.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  });
}
