import { afterEach, beforeEach, expect, vi } from "vitest";
import { mountWall } from "../../../src/views/index";
import type { StepVM, TaskVM, WallVM, WallHandlers, WallHandle } from "../../../src/views/types";
import type { renderPlanBand, buildPlanDiary } from "../../../src/views/plan";
import type { renderMemoryView } from "../../../src/views/memory";

export type Plan = Parameters<typeof renderPlanBand>[1];
export type Memory = NonNullable<Parameters<typeof renderMemoryView>[1]>;
export type Entry = Parameters<typeof buildPlanDiary>[0][number];
export type Step = StepVM & { microId?: string; accept?: string };
export type Task = Omit<TaskVM, "steps"> & {
  taskId?: string; phaseId?: string; phaseLabel?: string; taskType?: string;
  assignee?: string; estimate?: string; waitsFor?: readonly string[]; blockedReason?: string;
  nanoVerdict?: { verdict: "on_track" | "drift" | "needs_user"; reason: string; source: TaskVM["source"] };
  steps: readonly Step[];
};
export const source = { kind: "device", ms: 12 } as const;
export const phases = [
  { id: "discover", label: "Discover", active: false },
  { id: "build", label: "Build", active: true },
] as const;
export const plan = (over: Partial<Plan> = {}): Plan => ({
  id: "p1", title: "Release plan", templateId: "release", templateHash: "test-hash",
  phaseId: "build", phases, doneCount: 1, totalCount: 4, progressPct: 99,
  agents: [{ agent: "builder", active: true, accent: "sky" }, { agent: "reviewer", active: false }],
  brief: "Build the release.", conformanceFindings: ["Missing verification task"], ...over,
});
export const step = (over: Partial<Step> = {}): Step => ({
  microId: "T01.M01", label: "Verify release", state: "done", accept: "All checks pass",
  detail: { outcome: "Release verified", evidence: ["reports/check.txt", "src/release.ts"], source }, ...over,
});
export const task = (over: Partial<Task> = {}): Task => ({
  id: "T01", taskId: "T01", workspace: "w1", project: "Release", accent: "sky",
  title: "Build release", summary: "Prepare release", status: "running", attention: "low",
  updated: "09:00", source, next: "Verify", phaseId: "build", taskType: "implementation",
  assignee: "builder", estimate: "20 min", steps: [step()], ...over,
});
export const memory = (): Memory => ({ sections: [
  { id: "decisions", label: "Decisions", text: "Use the stable API.", required: true, empty: false,
    rev: 1, by: "builder", changedAt: "2026-11-15 09:00", maxChars: 2000 },
  { id: "risks", label: "Risks", text: "", required: true, empty: true, rev: 0, maxChars: 2000 },
] });
export const entries: readonly Entry[] = [
  { kind: "microtask", day: "2026-11-15", at: "09:00", title: "Verify release", outcome: "Verified",
    took: "2 min", evidence: ["reports/check.txt"] },
  { kind: "memory", day: "2026-11-15", at: "09:10", title: "Decisions", author: "builder" },
  { kind: "memory", day: "2026-11-14", at: "08:00", title: "Risks", author: "reviewer" },
];
export const wall = (over: Record<string, unknown> = {}): WallVM => ({
  now: "09:00", model: { state: "ready", label: "Model ready" }, network: "offline",
  workspaces: [{ id: "w1", name: "Release", lens: "dev", accent: "sky" }], workspace: "w1",
  view: "wall", archiveScope: "workspace", tasks: [task()], agenda: [], archive: [],
  plan: plan(), diary: entries, memory: memory(), ...over,
} as unknown as WallVM);
const handles: WallHandle[] = [];
export function mount(vm = wall(), handlers?: WallHandlers) {
  const host = document.createElement("div"); document.body.append(host);
  const handle = mountWall(host, vm, handlers); handles.push(handle);
  return { host, handle };
}
export function setup() {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-15T09:00:00Z")); });
  afterEach(() => {
    for (const h of handles.splice(0)) h.destroy();
    document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers();
  });
}
export function q<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T>(selector);
  expect(node, `Missing ${selector}`).not.toBeNull(); return node!;
}
export const all = (root: ParentNode, selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
export const text = (root: Node) => root.textContent ?? "";
export function visibleText(root: HTMLElement): string {
  if (root.hidden || root.getAttribute("aria-hidden") === "true" || root.style.display === "none") return "";
  return [...root.childNodes].map(n => n.nodeType === 3 ? n.textContent : n instanceof HTMLElement ? visibleText(n) : "").join(" ");
}
export function key(target: EventTarget, name: string, type = "keydown") {
  const event = new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true });
  target.dispatchEvent(event); return event;
}
/** jsdom does not generate a trusted native button click from synthetic keyboard events. */
export function activate(control: HTMLElement, method: string) {
  if (method === "click") { control.click(); return; }
  control.focus();
  const down = key(control, method); const up = key(control, method, "keyup");
  if (control.tagName === "BUTTON" && !down.defaultPrevented && !up.defaultPrevented) control.click();
}
export function disclosure(root: ParentNode) {
  return q(root, '.step-row[aria-expanded], .step-row [aria-expanded]');
}
export function safeDOM(root: HTMLElement) {
  expect(root.querySelector("img, script, svg, canvas, iframe, object, embed")).toBeNull();
  for (const e of [root, ...all(root, "*")]) {
    expect([...e.attributes].some(a => /^on/i.test(a.name))).toBe(false);
  }
}
export const hostile = '<img src=x onerror=alert(1)>';
