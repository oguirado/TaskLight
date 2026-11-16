import { vi } from "vitest";
import type { PlanTaskInput, PlanBriefInput, PlanAiClock, PlanAiPort } from "../../../src/planai/types";
export const task = (patch: Partial<PlanTaskInput> = {}): PlanTaskInput => ({
 id: "T01", title: "Ship tests", type: "implementation", phase: "build", accept: "All checks pass",
 status: "active", deps: [], rev: 1,
 microtasks: [{ id: "T01.M01", text: "Run checks", state: "done", outcome: "Checks passed" }], ...patch,
});
export const plan = (patch: Partial<PlanBriefInput> = {}): PlanBriefInput => ({
 planId: "p1", title: "Release", phase: "build", status: "active", rev: 1,
 doneMicrotasks: 1, totalMicrotasks: 3,
 tasks: [
  { id: "T01", title: "Ship tests", state: "active", ready: true, waitsFor: [] },
  { id: "T02", title: "Publish", state: "blocked", ready: false, waitsFor: ["T01"] },
 ], ...patch,
});
export const flush = async (): Promise<void> => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
export function deferred<T>() {
 let resolve!: (value: T) => void;
 const promise = new Promise<T>((r) => { resolve = r; });
 return { promise, resolve };
}
export const response = (source: "device" | "cloud" | "local" | "remote" = "device") => ({
 text: JSON.stringify({ verdict: "on_track", reason: "Model accepted", brief: "Next: T01 Ship tests; T02 waits for T01" }), source,
});
export function fakePort(impl: PlanAiPort["generate"] = async () => response()) {
 const generate = vi.fn(impl);
 return { port: { generate } satisfies PlanAiPort, generate };
}
export function fakeClock() {
 let now = 0, seq = 0;
 const timers = new Map<number, { at: number; cb: () => void }>();
 const setTimeout = vi.fn((cb: () => void, ms: number): unknown => {
  const id = ++seq; timers.set(id, { at: now + ms, cb }); return id;
 });
 const clearTimeout = vi.fn((handle: unknown): void => { timers.delete(handle as number); });
 const clock: PlanAiClock = { setTimeout, clearTimeout };
 return { clock, setTimeout, clearTimeout, timers, async advance(ms: number) {
  const end = now + ms;
  for (let guard = 0; guard < 1000; guard++) {
   const due = [...timers].filter(([, v]) => v.at <= end).sort((a,b) => a[1].at - b[1].at)[0];
   if (!due) { now = end; await flush(); return; }
   now = due[1].at; timers.delete(due[0]); due[1].cb(); await flush();
  }
  throw new Error("Fake clock callback budget exceeded");
 } };
}
export function tracked<T>(promise: Promise<T>) {
 const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
 void promise.then((value) => { state.settled = true; state.value = value; },
  (error: unknown) => { state.settled = true; state.error = error; });
 return state;
}
export function records(value: unknown): Record<string, unknown>[] {
 if (Array.isArray(value)) return value.flatMap(records);
 if (value !== null && typeof value === "object") {
  const rec = value as Record<string, unknown>;
  return [rec, ...Object.values(rec).flatMap(records)];
 }
 return [];
}
