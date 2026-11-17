import { expect, vi } from "vitest";
import type { AgentStore, PlanProjectionResult } from "../../../src/app/agent_store";
import type { Clock } from "../../../src/app/types";
import type { RoomEvent } from "../../../src/agents/types";
import type { PlanProjection } from "../../../src/plan/types";
import { fixedInput, input, projection, task, event, NOW, HOSTILE } from "../u112/fixtures";
export { NOW, HOSTILE, projection, task, event };

export const flush = async (): Promise<void> => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
export const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => Number(setTimeout(fn, ms)), clearTimeout: id => clearTimeout(id),
  setInterval: (fn, ms) => Number(setInterval(fn, ms)), clearInterval: id => clearInterval(id),
};
/** Public read seams, with real U112 projection data; no substitute renderer. */
export function roomFixture() {
  const rooms = new Map<string, PlanProjection>([
    ["demo", fixedInput().projection!],
    ["work", input({ projection: projection([task("T11", { assignee: "work-executor", title: "Other room work" })]) }).projection!],
  ]);
  const history: RoomEvent[] = [event(1), event(2, { room: "work", to: "work-executor" })];
  const result = (room: string): PlanProjectionResult | undefined => {
    const value = rooms.get(room);
    return value ? { room, source: "v2", projection: value, invalidOps: 0 } : undefined;
  };
  const store: AgentStore = {
    ingest: vi.fn(() => false), ingestChecked: vi.fn(() => "invalid" as const),
    ingestJsonl: vi.fn(() => ({ accepted: 0, duplicate: 0, malformed: 0, torn: false })),
    since: () => ({ demo: 1, work: 2 }), states: () => [],
    events: vi.fn(room => history.filter(e => e.room === room)),
    plan: vi.fn(result), plans: vi.fn(() => [...rooms.keys()].map(room => result(room)!)),
  };
  return { rooms, history, store };
}
export function text(root: Node): string {
  const value = root.nodeType === Node.TEXT_NODE ? root.textContent ?? "" : [...root.childNodes].map(text).join(" ");
  return value.replace(/\s+/g, " ").trim();
}
export function visible(node: HTMLElement): boolean {
  for (let at: HTMLElement | null = node; at; at = at.parentElement) {
    if (at.hidden || at.getAttribute("aria-hidden") === "true" || at.style.display === "none" || at.style.visibility === "hidden") return false;
    if (at.matches('dialog:not([open]), .model-sheet[data-open="false"], .chat-drawer[data-open="false"]')) return false;
    const details = at.closest("details:not([open])");
    if (details && !details.querySelector("summary")?.contains(node)) return false;
  }
  return true;
}
export function visibleText(root: Node): string {
  if (root.nodeType === Node.TEXT_NODE) return root.textContent ?? "";
  if (root instanceof HTMLElement && !visible(root)) return "";
  return [...root.childNodes].map(visibleText).join(" ");
}
export function accessibleName(node: HTMLElement): string {
  const labelled = node.getAttribute("aria-labelledby");
  if (labelled) return labelled.split(/\s+/).map(id => text(node.ownerDocument.getElementById(id) ?? document.createTextNode(""))).join(" ").trim();
  if (node.hasAttribute("aria-label")) return node.getAttribute("aria-label") ?? "";
  const copy = node.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[aria-hidden="true"]').forEach(child => child.remove());
  return text(copy);
}
export function control(root: ParentNode, name: string): HTMLElement {
  // A-V1: the unchanged swarm destination is labelled Agents in navigation.
  if (name === "Swarm") name = "Agents";
  const found = [...root.querySelectorAll<HTMLElement>('button,summary,a,[role="button"],[role="tab"]')]
    .find(el => visible(el) && accessibleName(el) === name);
  expect(found, `Visible control named ${name}`).toBeDefined();
  return found!;
}
export function swarm(root: ParentNode): HTMLElement {
  // A-V1: locate the renamed Agents board by its stable view class.
  const found = root.querySelector<HTMLElement>(".swarm-view");
  expect(found, "Selected workspace must mount the real U112 Swarm view").not.toBeNull();
  return found!;
}
export function models(root: ParentNode = document): HTMLButtonElement {
  const openers = [...root.querySelectorAll<HTMLButtonElement>('button[aria-controls="model-sheet"]')].filter(visible);
  expect(openers, "Exactly one visible Models opener").toHaveLength(1);
  const trigger = openers[0]!;
  expect(accessibleName(trigger)).toBe("Models");
  expect(text(trigger)).toBe("Models");
  expect(trigger.type).toBe("button"); expect(trigger.disabled).toBe(false);
  expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
  expect(trigger.tabIndex).toBeGreaterThanOrEqual(0);
  return trigger;
}
export function noExecutableLabels(root: ParentNode): void {
  expect(root.querySelector("img,script,iframe,[onerror],[onclick]"), "Labels remain passive DOM text").toBeNull();
  expect([...root.querySelectorAll("a")].some(a => /^\s*(javascript|data):/i.test(a.getAttribute("href") ?? ""))).toBe(false);
}
