import { afterEach, beforeEach, expect, vi } from "vitest";
import { mountWall } from "../../../src/views";
import type { WallMountHandlers, WallMountVM } from "../../../src/views";
import { groupTasksByPhase, renderPhaseTaskCards } from "../../../src/views/plan";
import type { PlanCardHandlers } from "../../../src/views/plan";
import type { SwarmViewModel } from "../../../src/app/swarm_vm";
import type { TaskVM } from "../../../src/views/types";
import { task as baseTask, step as baseStep, wall as baseWall } from "../u62/helpers";
import { NOW, accessibleName, visible, visibleText } from "../u138/helpers";

export { NOW, accessibleName, visible, visibleText };
export const LABEL = "Inspect replay";
export const TITLE = "Verify room";
export const task = (over: Partial<TaskVM> = {}): TaskVM => baseTask({
  assignee: "executor-a", title: TITLE, activity: { state: "working" },
  steps: [
    baseStep({ microId: "T01.M01", label: LABEL, state: "done", activity: { state: "done" } }),
    { microId: "T01.M02", label: LABEL, state: "active", activity: { state: "working" } },
    { microId: "T01.M03", label: LABEL, state: "pending", activity: { state: "idle" } },
  ],
  ...over,
});

const disposers: Array<() => void> = [];
export const network = vi.fn((): never => { throw new Error("Network forbidden by U148 oracle"); });
export function deterministic(): void {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    network.mockClear();
    vi.stubGlobal("fetch", network); vi.stubGlobal("WebSocket", network); vi.stubGlobal("XMLHttpRequest", network);
  });
  afterEach(() => {
    try {
      for (const dispose of disposers.splice(0).reverse()) dispose();
      expect(network).not.toHaveBeenCalled();
    } finally {
      document.body.replaceChildren();
      vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
    }
  });
}
export function render(tasks: readonly TaskVM[] = [task()], swarm?: SwarmViewModel, handlers?: PlanCardHandlers): HTMLElement {
  const root = renderPhaseTaskCards(document, groupTasksByPhase(tasks, [{ id: "build", label: "Build", active: true }]),
    handlers, swarm === undefined ? undefined : { swarm });
  document.body.append(root);
  return root;
}
export function mount(tasks: readonly TaskVM[] = [task()], swarm?: SwarmViewModel, handlers?: WallMountHandlers) {
  const host = document.createElement("div"); document.body.append(host);
  const vm: WallMountVM = { ...baseWall({ tasks }), ...(swarm === undefined ? {} : { swarm }) };
  const handle = mountWall(host, vm, handlers);
  disposers.push(() => handle.destroy());
  return { host, handle, vm };
}
export function mountVM(vm: WallMountVM, handlers?: WallMountHandlers): HTMLElement {
  const host = document.createElement("div"); document.body.append(host);
  const handle = mountWall(host, vm, handlers);
  disposers.push(() => handle.destroy());
  return host;
}
export function q(root: ParentNode, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  expect(found, `Expected existing element ${selector}`).not.toBeNull();
  return found!;
}
export function card(root: ParentNode, id = "T01"): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>(".task[data-task-id]")]
    .find(node => node.dataset.taskId === id && visible(node));
  expect(found, `Expected visible task ${id}`).toBeDefined();
  return found!;
}
export function rows(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".step-row")];
}
/** Locate visible count text without requiring a dedicated count element or wrapper. */
export function completionRun(root: HTMLElement, done: number, total: number): readonly [Node, Node] {
  const parts: Array<{ node: Node; start: number; end: number }> = [];
  let content = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement || !visible(node.parentElement)) continue;
    const start = content.length;
    content += node.textContent ?? "";
    parts.push({ node, start, end: content.length });
    content += " ";
  }
  const pattern = new RegExp("\\b" + done + "\\s*(?:/|of)\\s*" + total + "\\b", "g");
  const matches = [...content.matchAll(pattern)];
  expect(matches, "Header must expose one persisted microtask completion count").toHaveLength(1);
  const match = matches[0]!;
  const start = match.index, end = start + match[0].length;
  const first = parts.find(part => part.end > start)!;
  const last = parts.findLast(part => part.start < end)!;
  return [first.node, last.node];
}

export function titleControl(root: HTMLElement): HTMLElement {
  const title = q(root, ".task-title");
  const wrapper = title.closest<HTMLElement>('button,summary,a[href],[role="button"]');
  const controls = [title, ...title.querySelectorAll<HTMLElement>("*"), ...(wrapper ? [wrapper] : [])];
  const found = controls.find(node => node.matches('button,summary,a[href],[role="button"]') && visible(node));
  expect(found, "Task title must expose a keyboard-operable detail control").toBeDefined();
  expect(found!.tabIndex, "Detail control must be keyboard focusable").toBeGreaterThanOrEqual(0);
  return found!;
}
export function activate(control: HTMLElement, method: "click" | "Enter" | " "): void {
  if (method === "click") { control.click(); return; }
  control.focus();
  expect(document.activeElement).toBe(control);
  const down = new KeyboardEvent("keydown", { key: method, bubbles: true, cancelable: true });
  const up = new KeyboardEvent("keyup", { key: method, bubbles: true, cancelable: true });
  control.dispatchEvent(down); control.dispatchEvent(up);
  // jsdom omits the trusted native keyboard default. Custom roles must handle their own keys.
  if (control.matches("button,summary") && !down.defaultPrevented && !up.defaultPrevented) control.click();
}
export function description(node: HTMLElement): string {
  const ids = (node.getAttribute("aria-describedby") ?? "").trim().split(/\s+/).filter(Boolean);
  const fromIds = ids.map(id => {
    const target = document.getElementById(id);
    expect(target, `Description reference ${id} must resolve`).not.toBeNull();
    return target!.textContent ?? "";
  }).join(" ");
  return [node.getAttribute("aria-description"), fromIds, node.getAttribute("title")].filter(Boolean).join(" ");
}
export function controlledPanel(control: HTMLElement): HTMLElement {
  const ids = (control.getAttribute("aria-controls") ?? "").split(/\s+/).filter(Boolean);
  expect(ids, "Disclosure must reference its local detail").toHaveLength(1);
  const panel = document.getElementById(ids[0]!);
  expect(panel, "Dotted microtask ID must resolve literally").not.toBeNull();
  return panel!;
}
export function expectReadOnlyDetail(control: HTMLElement, root: HTMLElement, previouslyVisible: ReadonlySet<HTMLElement>): void {
  const details = control.closest("summary")?.parentElement;
  const ids = (control.getAttribute("aria-controls") ?? "").split(/\s+/).filter(Boolean);
  const expanded = control.getAttribute("aria-expanded") === "true";
  const panels = ids.map(id => document.getElementById(id)).filter((node): node is HTMLElement => node !== null);
  const dialogs = [...document.querySelectorAll<HTMLElement>('dialog[open],[role="dialog"],[role="region"]')]
    .filter(node => visible(node) && !previouslyVisible.has(node) && (node.textContent ?? "").includes(TITLE));
  const candidates = [
    ...(details?.matches("details[open]") ? [details] : []),
    ...(expanded ? panels.filter(node => visible(node) && !previouslyVisible.has(node)) : []), ...dialogs,
  ];
  expect(candidates.length, "Title activation must reveal task detail").toBeGreaterThan(0);
  for (const detail of candidates) {
    const body = detail.cloneNode(true) as HTMLElement;
    body.querySelector("summary")?.remove();
    expect((body.textContent ?? "").trim().length, "Revealed detail must contain information").toBeGreaterThan(0);
    expect(detail.querySelector('input:not([readonly]):not([disabled]),textarea:not([readonly]):not([disabled]),[contenteditable="true"]'),
      "Task detail is read-only").toBeNull();
  }
  expect(root.querySelector(".task-chat"), "Task detail must not introduce chat").toBeNull();
}
export function expectIndependentStates(root: HTMLElement, taskState = "waiting", ownerState = "Working"): void {
  expect(q(root, ".status-icon").getAttribute("data-activity"), "Task ring describes this task").toBe(taskState);
  const chip = q(root, ".wall-agent-chip");
  expect(visibleText(chip), "Owner state remains independent from task state").toContain(ownerState);
  const taskHeader = q(root, ".task-head").cloneNode(true) as HTMLElement;
  taskHeader.querySelectorAll(".wall-agent-chip").forEach(node => node.remove());
  expect(visibleText(taskHeader), "Task state remains explicitly readable apart from agent state").toContain("Waiting");
}
