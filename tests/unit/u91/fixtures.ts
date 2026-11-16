import { afterEach, beforeEach, expect, vi } from "vitest";
import { mountWall } from "../../../src/views/index";
import { toWallVM } from "../../../src/app/agent_store";
import type { PlanProjectionResult, PlanWallOpts } from "../../../src/app/agent_store";
import type { PlanMicrotask, PlanTask } from "../../../src/plan/types";
import type { PlanVM, StepVM, TaskVM, WallHandle, WallHandlers, WallVM } from "../../../src/views/types";

// Additive frozen-seam fields are structural fixture types, not missing imports.
export type ActivityState = "idle" | "working" | "done" | "blocked" | "waiting" | "needs_you" | "unknown" | "cancelled";
export interface Activity { state: ActivityState; expiresAt?: number }
export type Step = StepVM & { activity?: Activity };
export type Task = Omit<TaskVM, "steps"> & {
  steps: readonly Step[];
  activity?: Activity;
  operatorQuestion?: { eventId: string; text: string };
};
export type Wall = Omit<WallVM, "tasks"> & { tasks: readonly Task[]; syncStale?: boolean };
export type LiveMicro = PlanMicrotask & {
  live?: { agent: string; run_id: string; beat_ts: number; beat_lamport: number };
};
export type CanonicalTask = Omit<PlanTask, "microtasks"> & { microtasks: readonly LiveMicro[] };
export const source = { kind: "rules", ms: 0 } as const;
export const hostile = '<img src=x onerror=alert(1)>';
export const selectorHostile = 'q"]:not(*) <img src=x onerror=alert(1)> #';
export const phases = [
  { id: "discovery", label: "Discovery", active: true },
  { id: "build", label: "Build", active: false },
] as const;
export const labels: Record<ActivityState, string> = {
  idle: "Idle", working: "Working", done: "Done", blocked: "Blocked",
  waiting: "Waiting", needs_you: "Needs you", unknown: "Liveness unknown", cancelled: "Cancelled",
};
export const states = Object.keys(labels) as ActivityState[];

export function step(over: Partial<Step> = {}): Step {
  return { microId: "T01.M02", label: "Preserve CSV headers", state: "pending", accept: "CSV preserves headers", ...over };
}
export function task(over: Partial<Task> = {}): Task {
  return {
    id: "plan:room-a:T01", taskId: "T01", workspace: "room-a", project: "CSV import", accent: "sky",
    title: "Import CSV", summary: "Record import progress", status: "idle", attention: "none",
    updated: "09:00", source, next: "", phaseId: "discovery", assignee: "owner", steps: [step()], ...over,
  };
}
export function plan(over: Partial<PlanVM> = {}): PlanVM {
  return {
    id: "p1", title: "CSV delivery", templateId: "neutral", templateHash: "fixture-hash", phaseId: "discovery",
    phases, doneCount: 0, totalCount: 1, progressPct: 0, agents: [{ agent: "owner", active: false }], ...over,
  };
}
export function wall(over: Partial<Wall> = {}): Wall {
  return {
    now: "09:00", model: { state: "ready", label: "Model ready" }, network: "online", theme: "light",
    workspaces: [{ id: "room-a", name: "CSV import", lens: "dev", accent: "sky" },
      { id: "room-b", name: "Other workspace", lens: "dev", accent: "iris" }],
    workspace: "room-a", view: "wall", archiveScope: "workspace", tasks: [task()], agenda: [], archive: [], plan: plan(), ...over,
  };
}
export function micro(over: Partial<LiveMicro> = {}): LiveMicro {
  return {
    id: "T01.M02", text: "Preserve CSV headers", accept: "CSV preserves headers", state: "active",
    outcome: null, took: null, evidence: [], rev: 7,
    live: { agent: "owner", run_id: "r2", beat_ts: 100000, beat_lamport: 7 }, ...over,
  };
}
export function canonical(over: Partial<CanonicalTask> = {}): CanonicalTask {
  return {
    id: "T01", title: "Import CSV", type: "implementation", phase: "discovery", accept: "Preserve CSV",
    deps: [], assignee: "owner", claim_lamport: 1, claim_ts: 99000, estimate: null,
    explicit_state: null, blocked_reason: null, state: "active", ready: true, rev: 7, microtasks: [micro()], ...over,
  };
}
export function projection(tasks: readonly CanonicalTask[], room = "room-a"): PlanProjectionResult {
  const micros = tasks.flatMap(t => t.microtasks);
  const done = micros.filter(m => m.state === "done").length;
  const progress = micros.length ? done / micros.length : 0;
  return {
    room, source: "v2", invalidOps: 0, projection: {
      plan: { id: "p1", title: "CSV delivery", template_id: "neutral", template_hash: "fixture-hash", brief: {},
        phase: "discovery", state: "active", rev: 7, opened_lamport: 1, opened_ts: 99000, closed_outcome: null },
      tasks, memory: {}, archived_plans: [], replayed_ops: {}, rejected: [], last_lamport: 7,
      rollup: { tasks_total: tasks.length, tasks_done: tasks.filter(t => t.state === "done").length,
        tasks_blocked: tasks.filter(t => t.state === "blocked").length, tasks_ready: tasks.filter(t => t.ready).length,
        micro_total: micros.length, micro_done: done, progress, progress_pct: Math.round(progress * 100) },
    },
  };
}
export function map(tasks: readonly CanonicalTask[], nowMs = Date.now(), extra: Partial<PlanWallOpts> = {},
  otherRooms: readonly PlanProjectionResult[] = []): Wall {
  return toWallVM([], undefined, { nowMs, model: { state: "ready", label: "Model ready" }, network: "online",
    workspace: "room-a", ...extra }, [projection(tasks), ...otherRooms]) as Wall;
}

const handles: WallHandle[] = [];
export function setup() {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(189999); });
  afterEach(() => {
    for (const handle of handles.splice(0)) handle.destroy();
    document.body.replaceChildren(); document.head.querySelectorAll("style[data-u91]").forEach(n => n.remove());
    document.documentElement.removeAttribute("data-theme");
    vi.clearAllTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  });
}
export function mount(vm: Wall = wall(), handlers: WallHandlers = {}) {
  const host = document.createElement("div"); document.body.append(host);
  const handle = mountWall(host, vm, handlers); handles.push(handle);
  return { host, handle };
}
export function q<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T>(selector);
  expect(node, `Required UI element: ${selector}`).not.toBeNull();
  return node!;
}
export function card(root: ParentNode, id = "T01"): HTMLElement {
  const node = [...root.querySelectorAll<HTMLElement>("article.task")].find(n => n.dataset.taskId === id);
  expect(node, `Required task card: ${id}`).toBeDefined(); return node!;
}
export const text = (node: Node): string => node.textContent ?? "";
export function visibleText(node: HTMLElement): string {
  if (node.hidden || node.getAttribute("aria-hidden") === "true") return "";
  return [...node.childNodes].map(n => n.nodeType === Node.TEXT_NODE ? n.textContent ?? ""
    : n instanceof HTMLElement ? visibleText(n) : "").join(" ");
}
export function activityNode(scope: HTMLElement): HTMLElement | null {
  if (scope.hasAttribute("data-activity")) return scope;
  return [...scope.querySelectorAll<HTMLElement>("[data-activity]")].find(n =>
    !scope.matches("article.task") || !n.closest("li.step")) ?? null;
}
export function expectActivity(scope: HTMLElement, state: ActivityState) {
  const node = activityNode(scope);
  expect(node, `Activity vocabulary must be rendered: ${state}`).not.toBeNull();
  expect(node!.getAttribute("data-activity")).toBe(state);
  const own = scope.cloneNode(true) as HTMLElement;
  if (scope.matches("article.task")) own.querySelectorAll(".steps").forEach(n => n.remove());
  const ownText = text(own);
  expect(ownText).toContain(labels[state]);
}
// jsdom omits the browser's default keyboard-to-click action for native buttons.
export function activate(button: HTMLElement, key: "Enter" | " " = "Enter") {
  button.focus();
  const down = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  const up = new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true });
  button.dispatchEvent(down); button.dispatchEvent(up);
  if (button.tagName === "BUTTON" && !down.defaultPrevented && !up.defaultPrevented) button.click();
}
export function disclosure(root: ParentNode): HTMLButtonElement {
  return q<HTMLButtonElement>(root, "button[aria-expanded][data-micro-id]");
}
export function controlledPanel(button: HTMLButtonElement): HTMLElement {
  const id = button.getAttribute("aria-controls"); expect(id, "Disclosure controls a labelled panel").toBeTruthy();
  const panel = button.ownerDocument.getElementById(id!); expect(panel).not.toBeNull(); return panel!;
}
export function expectSafe(root: ParentNode) {
  expect(root.querySelector("img,script,iframe,object,embed")).toBeNull();
  for (const node of root.querySelectorAll("*")) {
    expect([...node.attributes].some(a => /^on/i.test(a.name))).toBe(false);
  }
}
export function workingWall(expiresAt = 190000): Wall {
  return wall({ tasks: [task({ status: "running", activity: { state: "working", expiresAt },
    steps: [step({ state: "active", activity: { state: "working", expiresAt } })] })],
    plan: plan({ agents: [{ agent: "owner", active: true }] }) });
}
export function announcements(host: HTMLElement) {
  const messages: string[] = [];
  const observer = new MutationObserver(records => {
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      const live = target?.closest('[aria-live="polite"]');
      if (live && text(live).trim()) { messages.push(text(live)); continue; }
      for (const added of record.addedNodes) if (added instanceof Element) {
        const regions = added.matches('[aria-live="polite"]') ? [added] : [...added.querySelectorAll('[aria-live="polite"]')];
        for (const region of regions) if (text(region).trim()) messages.push(text(region));
      }
    }
  });
  observer.observe(host, { childList: true, characterData: true, subtree: true });
  return { messages, stop: () => observer.disconnect() };
}
