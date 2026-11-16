import { vi } from "vitest";
import type { Clock } from "../../../src/app/types";
import type { ModelServices } from "../../../src/app/model_services";
import type { ModelFactory } from "../../../src/ai/types";
import type { PlanAi, PlanAiOptions, PlanAiPort, PlanTaskInput } from "../../../src/planai/types";
import type { DriftVerdict } from "../../../src/agents/types";
import type { PlanWiringDeps, RoomPlanSnapshot } from "../../../src/app/plan_wiring";
export const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const verdict = (source: DriftVerdict["source"] = "device", reason = "Checked"): DriftVerdict => ({ verdict: "on_track", reason, source });
export const task = (id = "T01", rev = 1): PlanTaskInput => ({ id, rev, title: "Verify", type: "task", phase: "plan", accept: "Verified", status: "active", deps: [], microtasks: [{ id: `${id}.M01`, text: "Check", state: "done", outcome: "Passed" }] });
export const snapshot = (tasks = [task()], room = "room"): RoomPlanSnapshot => ({ room, planId: `p-${room}`, title: "Release", phase: "plan", status: "active", rev: 1, doneMicrotasks: 1, totalMicrotasks: tasks.length, tasks });
export function fakeClock() {
  let now = 0, seq = 0;
  const pending = new Map<number, { at: number; cb: () => void }>();
  const clock: Clock = {
    now: () => now,
    setTimeout: vi.fn((cb: () => void, ms: number) => { const id = ++seq; pending.set(id, { at: now + ms, cb }); return id; }),
    clearTimeout: vi.fn((id: number) => { pending.delete(id); }),
    setInterval: vi.fn((): number => { throw new Error("Unexpected interval"); }),
    clearInterval: vi.fn(),
  };
  return { clock, pending, async advance(ms = 250) {
    const end = now + ms;
    for (let budget = 0; budget < 1000; budget++) {
      const due = [...pending].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) { now = end; await flush(); return; }
      now = due[1].at; pending.delete(due[0]); due[1].cb(); await flush();
    }
    throw new Error("Fake clock budget exceeded");
  } };
}
export function harness(initial: readonly RoomPlanSnapshot[] = [snapshot()]) {
  const time = fakeClock();
  let snapshots = initial;
  const generate = vi.fn<PlanAiPort["generate"]>(async () => ({ text: JSON.stringify({ verdict: "on_track", reason: "Checked", brief: "Continue" }), source: "device" }));
  const port: PlanAiPort = { generate };
  const driftPortFor = vi.fn((mode: string) => ({ port, allowExternal: mode === "PREFER_ON_DEVICE" }));
  const reviewTask = vi.fn<PlanAi["reviewTask"]>(async () => verdict());
  const briefPlan = vi.fn<PlanAi["briefPlan"]>(async () => ({ brief: "Continue", source: "device" }));
  const createPlanAi = vi.fn((_opts: PlanAiOptions): PlanAi => ({ reviewTask, briefPlan }));
  const deps: PlanWiringDeps = {
    clock: time.clock, getServices: vi.fn(() => ({ driftPortFor }) as unknown as ModelServices),
    getDriftFactory: vi.fn((): ModelFactory | null => null), driftPortFromFactory: vi.fn(() => port),
    adaptDriftPort: vi.fn(p => p), getSnapshots: () => snapshots, createPlanAi, onUpdate: vi.fn(),
  };
  return { ...time, deps, generate, port, driftPortFor, reviewTask, briefPlan, createPlanAi,
    setSnapshots(next: readonly RoomPlanSnapshot[]) { snapshots = next; } };
}
