import { afterEach, beforeEach, expect, vi } from "vitest";
import type { RoomEvent } from "../../../src/agents/types";
import type { PlanMicrotask, PlanProjection, PlanTask } from "../../../src/plan/types";
import type { SwarmAgentVM, SwarmRegistration, SwarmViewModel } from "../../../src/app/swarm_vm";

export const NOW = 200_000;
export const HOSTILE = "<img src=x onerror=alert(1)>";
export interface Input {
  room: string; projection: PlanProjection | null; events: readonly RoomEvent[];
  nowMs: number; connected: boolean; agents?: Readonly<Record<string, SwarmRegistration>>;
}
export function micro(id = "T01.M01", extra: Partial<PlanMicrotask> = {}): PlanMicrotask {
  return { id, text: `Micro ${id}`, accept: "Recorded result", state: "active", outcome: null,
    took: null, evidence: [], rev: 1, ...extra };
}
export function beat(extra: Partial<NonNullable<PlanMicrotask["live"]>> = {}): NonNullable<PlanMicrotask["live"]> {
  return { agent: "executor-a", run_id: "run_a-1", beat_ts: NOW - 1_000, beat_lamport: 1, ...extra };
}
export function task(id = "T01", extra: Partial<PlanTask> = {}): PlanTask {
  return { id, title: `Task ${id}`, type: "implementation", phase: "build", accept: "Tests pass",
    deps: [], assignee: "executor-a", claim_lamport: 1, claim_ts: NOW - 2_000,
    estimate: null, explicit_state: null, blocked_reason: null, state: "active", ready: true,
    rev: 1, microtasks: [micro(`${id}.M01`, { live: beat() })], ...extra };
}
export function projection(tasks: readonly PlanTask[] = []): PlanProjection {
  const micros = tasks.flatMap(t => t.microtasks);
  const done = micros.filter(m => m.state === "done").length;
  const progress = micros.length ? done / micros.length : 0;
  return { plan: { id: "p1", title: "Swarm fixture", template_id: "fixture", template_hash: "fixture-hash",
      brief: {}, phase: "build", state: "active", rev: 1, opened_lamport: 1, opened_ts: 0, closed_outcome: null },
    tasks, memory: {}, archived_plans: [], rollup: { tasks_total: tasks.length,
      tasks_done: tasks.filter(t => t.state === "done").length,
      tasks_blocked: tasks.filter(t => t.state === "blocked").length,
      tasks_ready: tasks.filter(t => t.ready).length, micro_total: micros.length, micro_done: done,
      progress, progress_pct: Math.round(progress * 100) }, replayed_ops: {}, rejected: [], last_lamport: 1 };
}
export function input(extra: Partial<Input> = {}): Input {
  return { room: "demo", projection: projection([task()]), events: [], nowMs: NOW, connected: true, ...extra };
}
export function event(n: number, extra: Partial<RoomEvent> = {}): RoomEvent {
  return { id: `e-${n.toString(16).padStart(16, "0")}`, lamport: n, ts: NOW - 100 + n,
    room: "demo", agent: "operator", act: "question", text: "Question in loaded history", to: "executor-a", ...extra };
}
export function fixedInput(): Input {
  return input({ projection: projection([
    task("T04", { state: "pending", ready: false, deps: ["T03"],
      microtasks: [micro("T04.M01", { state: "pending" })] }),
    task("T03", { assignee: "executor-c", microtasks: [micro("T03.M01", {
      live: beat({ agent: "executor-c", beat_ts: NOW - 90_001 }) })] }),
    task("T02", { assignee: "executor-b", microtasks: [micro("T02.M01", {
      live: beat({ agent: "executor-b", beat_ts: NOW - 2_000 }) })] }),
    task("T01", { microtasks: [micro("T01.M02", { live: beat() }), micro("T01.M01", { state: "done" })] }),
    task("T00", { assignee: null, state: "pending", microtasks: [] }),
  ]) });
}
export function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function row(vm: SwarmViewModel, agent = "executor-a"): SwarmAgentVM {
  const found = vm.agents.find(a => a.agent === agent);
  expect(found, `Expected membership for ${agent}`).toBeDefined();
  return found!;
}
export function agentVM(extra: Partial<SwarmAgentVM> = {}): SwarmAgentVM {
  const t = task("T01", { microtasks: [micro("T01.M01", { state: "done" }), micro("T01.M02", { live: beat() })] });
  return { agent: "executor-a", tasks: [t], current_task_id: "T01", active_micro_id: "T01.M02",
    micro_done: 1, micro_total: 2, activity: "working", last_beat_ts: NOW - 1_000,
    last_beat_age_ms: 1_000, waiting_on: [], unanswered_questions: 0, ...extra };
}
export function viewModel(agents: readonly SwarmAgentVM[] = [agentVM()]): SwarmViewModel {
  return { room: "demo", agents, progress: projection().rollup, refresh_at_ms: NOW + 89_001 };
}
export const text = (node: Node): string => (node.textContent ?? "").replace(/\s+/g, " ").trim();
/** Locate a card by its visible identity, without prescribing markup or class names. */
export function card(root: HTMLElement, agent: string, peers: readonly string[]): HTMLElement {
  const candidates = [root, ...root.querySelectorAll<HTMLElement>("*")].filter(el =>
    text(el).includes(agent) && peers.every(p => p === agent || !text(el).includes(p)));
  candidates.sort((a, b) => text(b).length - text(a).length);
  expect(candidates.length, `A distinct visible card for ${agent}`).toBeGreaterThan(0);
  return candidates[0]!;
}
export function deterministic(): void {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
}
