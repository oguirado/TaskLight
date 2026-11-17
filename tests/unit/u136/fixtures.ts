import { afterEach, beforeEach, expect, vi } from "vitest";
import type { RoomEvent } from "../../../src/agents/types";
import type { PlanMicrotask, PlanProjection, PlanTask } from "../../../src/plan/types";
import type { SwarmAgentVM, SwarmRegistration, SwarmViewModel } from "../../../src/app/swarm_vm";
import { renderSwarmView } from "../../../src/views/swarm";

export const NOW = 100_000;
export const HOSTILE = "<img src=x onerror=alert(1)>";
export type Registration = SwarmRegistration & Readonly<{ reason?: string }>;
// Structural fixture extension: U132 owns the shared projection type, not this oracle.
export type Projection = PlanProjection & { agent_lifecycle: Readonly<Record<string, Registration>> };
export type Agent = SwarmAgentVM & Readonly<{ reason?: string }>;
export interface Input {
  room: string; projection: PlanProjection | null; events: readonly RoomEvent[];
  nowMs: number; connected: boolean; agents?: Readonly<Record<string, Registration>>;
}
export function registration(extra: Partial<Registration> = {}): Registration {
  return { lifecycle: "alive", run_id: "r1", swarm: "alpha", harness: "Fixture harness", ...extra };
}
export function beat(extra: Partial<NonNullable<PlanMicrotask["live"]>> = {}): NonNullable<PlanMicrotask["live"]> {
  return { agent: "executor-a", run_id: "r1", beat_ts: NOW - 1_000, beat_lamport: 1, ...extra };
}
export function micro(id = "T01.M01", extra: Partial<PlanMicrotask> = {}): PlanMicrotask {
  return { id, text: `Micro ${id}`, accept: "Recorded result", state: "active", outcome: null,
    took: null, evidence: [], rev: 1, ...extra };
}
export function task(id = "T01", extra: Partial<PlanTask> = {}): PlanTask {
  return { id, title: `Task ${id}`, type: "implementation", phase: "build", accept: "Tests pass",
    deps: [], assignee: "executor-a", claim_lamport: 1, claim_ts: NOW - 2_000,
    estimate: null, explicit_state: null, blocked_reason: null, state: "active", ready: true,
    rev: 1, microtasks: [micro(`${id}.M01`, { live: beat() })], ...extra };
}
export function projection(tasks: readonly PlanTask[] = [], registrations: Readonly<Record<string, Registration>> = {}): Projection {
  const micros = tasks.flatMap(t => t.microtasks), done = micros.filter(m => m.state === "done").length;
  const progress = micros.length ? done / micros.length : 0;
  return { plan: { id: "p1", title: "Swarm fixture", template_id: "fixture", template_hash: "fixture-hash",
      brief: {}, phase: "build", state: "active", rev: 1, opened_lamport: 1, opened_ts: 0, closed_outcome: null },
    tasks, memory: {}, archived_plans: [], rollup: { tasks_total: tasks.length,
      tasks_done: tasks.filter(t => t.state === "done").length,
      tasks_blocked: tasks.filter(t => t.state === "blocked").length,
      tasks_ready: tasks.filter(t => t.ready).length, micro_total: micros.length, micro_done: done,
      progress, progress_pct: Math.round(progress * 100) }, replayed_ops: {}, rejected: [], last_lamport: 1,
    agent_lifecycle: registrations };
}
export function input(extra: Partial<Input> = {}): Input {
  return { room: "demo", projection: projection([task()]), events: [], nowMs: NOW, connected: true, ...extra };
}
export function event(n: number, extra: Partial<RoomEvent> = {}): RoomEvent {
  return { id: `e-${n.toString(16).padStart(16, "0")}`, lamport: n, ts: NOW - 100 + n,
    room: "demo", agent: "operator", act: "question", text: "Question in loaded history", to: "executor-a", ...extra };
}
export function frozenFixture(): Input {
  return freeze(input({ projection: projection([
    task("T01", { microtasks: [micro("T01.M01", { state: "done" }), micro("T01.M02", { live: beat() })] }),
    task("T02", { assignee: "executor-b", state: "pending", ready: false, deps: ["T01"],
      microtasks: [micro("T02.M01", { state: "pending" })] }),
    task("T03", { assignee: "executor-c", microtasks: [micro("T03.M01", {
      live: beat({ agent: "executor-c", beat_ts: NOW - 90_001 }) })] }),
    task("T04", { assignee: null, state: "pending", microtasks: [micro("T04.M01", { state: "pending" })] }),
  ], {
    "executor-a": registration(), "executor-b": registration(), "executor-c": registration(),
    "executor-d": registration({ lifecycle: "failed", swarm: "beta" }),
    "executor-e": registration({ lifecycle: "finished", swarm: "beta" }),
  }) }));
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
  expect(found, `Expected a displayed row for ${agent}`).toBeDefined();
  return found!;
}
export function agent(extra: Partial<Agent> = {}): Agent {
  return { ...registration(), agent: "executor-a", tasks: [task()], current_task_id: "T01",
    active_micro_id: "T01.M01", micro_done: 0, micro_total: 1, activity: "working",
    last_beat_ts: NOW - 1_000, last_beat_age_ms: 1_000, waiting_on: [], unanswered_questions: 0, ...extra };
}
export function viewModel(agents: readonly SwarmAgentVM[] = [agent()]): SwarmViewModel {
  return { room: "demo", agents, progress: projection().rollup, refresh_at_ms: null };
}
export const text = (node: Node): string => (node.textContent ?? "").replace(/\s+/g, " ").trim();
export function visibleText(node: HTMLElement): string {
  const copy = node.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll<HTMLElement>("[hidden], [aria-hidden='true']")) hidden.remove();
  for (const el of copy.querySelectorAll<HTMLElement>("[style]"))
    if (el.style.display === "none" || el.style.visibility === "hidden") el.remove();
  return text(copy);
}
export function mount(vm: SwarmViewModel): HTMLElement {
  const root = renderSwarmView(document, freeze(vm)); document.body.append(root); return root;
}
/** Visible identity and content locate cards without specifying a CSS class or tag. */
export function card(root: HTMLElement, slug: string, taskId: string | null = "T01"): HTMLElement {
  const matches = [...root.querySelectorAll<HTMLElement>("*")].filter(el => text(el) === slug &&
    ![...el.children].some(child => text(child) === slug));
  const identity = matches.find(el => el.matches("h1, h2, h3, h4, h5, h6, [role=heading]")) ?? matches[0];
  expect(identity, `Visible agent identity ${slug}`).toBeDefined();
  let found = identity;
  while (found && found !== root && !text(found).includes(taskId ?? "No current task")) found = found.parentElement ?? undefined;
  expect(found && found !== root, `Distinct card for ${slug}`).toBeTruthy();
  return found!;
}
export function identityOrder(root: HTMLElement, slugs: readonly string[]): string[] {
  const all = [...root.querySelectorAll<HTMLElement>("*")];
  const identities = new Set(slugs.map(slug => {
    const matches = all.filter(el => text(el) === slug && ![...el.children].some(child => text(child) === slug));
    return matches.find(el => el.matches("h1, h2, h3, h4, h5, h6, [role=heading]")) ?? matches[0];
  }));
  return all.filter(el => identities.has(el)).map(el => text(el));
}
export function taskControl(container: HTMLElement): HTMLElement {
  const control = [container, ...container.querySelectorAll<HTMLElement>("button, a[href], [role='button'], [tabindex]")]
    .find(el => el.tabIndex >= 0 && !el.hasAttribute("disabled"));
  expect(control, "Task-bearing cards need a keyboard-focusable task control").toBeDefined();
  return control!;
}
export function keyboardActivate(control: HTMLElement, key: "Enter" | " "): void {
  const down = new KeyboardEvent("keydown", { key, code: key === " " ? "Space" : "Enter", bubbles: true, cancelable: true });
  control.dispatchEvent(down);
  const up = new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }); control.dispatchEvent(up);
  // jsdom does not implement the browser's native button activation default.
  if (!down.defaultPrevented && !up.defaultPrevented && (control.tagName === "BUTTON" || (key === "Enter" && control.tagName === "A"))) control.click();
}
export function deterministic(): void {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
}
