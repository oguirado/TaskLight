import { afterEach, beforeEach, expect, vi } from "vitest";
import { toWallVM } from "../../../src/app/agent_store";
import { deriveSwarmViewModel } from "../../../src/app/swarm_vm";
import type { SwarmAgentVM, SwarmViewModel } from "../../../src/app/swarm_vm";
import type { PlanProjection } from "../../../src/plan/types";
import { mountWall } from "../../../src/views";
import type { WallMountVM } from "../../../src/views";
import {
  NOW, HOSTILE, agent, beat, event, freeze, input, micro, projection, registration, task, viewModel,
} from "../u136/fixtures";
import {
  accessibleName, clock, control, flush, models, noExecutableLabels, roomFixture, text, visible, visibleText,
} from "../u118/fixtures";

export {
  NOW, HOSTILE, agent, beat, event, freeze, input, micro, projection, registration, task, viewModel,
  accessibleName, clock, control, flush, models, noExecutableLabels, roomFixture, text, visible, visibleText,
};
export const cleanup: Array<() => void> = [];
export const DESTINATIONS = ["Wall", "Agenda", "Diary", "Archive", "Memory", "Swarm"] as const;

export function deterministic(): void {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    localStorage.clear();
    const forbidden = vi.fn((): never => { throw new Error("Network forbidden by U138 oracle"); });
    vi.stubGlobal("fetch", forbidden);
    vi.stubGlobal("WebSocket", forbidden);
    vi.stubGlobal("XMLHttpRequest", forbidden);
  });
  afterEach(() => {
    try { for (const dispose of cleanup.splice(0).reverse()) dispose(); }
    finally {
      document.body.replaceChildren(); localStorage.clear();
      delete document.documentElement.dataset.theme;
      vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
    }
  });
}

/** R40 reverses the older fixture's T01/T02 dependency direction. */
export function frozenPlan(): PlanProjection {
  return freeze(projection([
    task("T01", { assignee: "executor-b", ready: false, state: "pending", deps: ["T02"],
      microtasks: [micro("T01.M01", { state: "pending", outcome: "T01 local outcome",
        evidence: [{ path: "evidence/T01.txt", sha256: "a".repeat(64) }] })] }),
    task("T02"),
    task("T03", { ready: false, state: "pending", deps: ["T90"],
      microtasks: [micro("T03.M01", { state: "pending" })] }),
    task("T04", { assignee: "failed-agent", microtasks: [micro("T04.M01", { live: beat({ agent: "failed-agent" }) })] }),
    task("T05", { assignee: "finished-agent", microtasks: [micro("T05.M01", { live: beat({ agent: "finished-agent" }) })] }),
    task("T06", { assignee: "unregistered", microtasks: [micro("T06.M01", { live: beat({ agent: "unregistered" }) })] }),
    task("T07", { assignee: null, ready: false, state: "pending", deps: ["T02", "T08"], microtasks: [] }),
    task("T08", { assignee: null, state: "pending", microtasks: [] }),
    task("T09", { assignee: "executor-b", ready: false, state: "pending", deps: ["T08", "T404"],
      blocked_reason: "Literal approval <pending> & unchanged", microtasks: [] }),
    task("T90", { assignee: "executor-c", microtasks: [] }),
  ], {
    "executor-a": registration({ harness: "Harness A" }),
    "executor-b": registration({ harness: "Harness B" }),
    "executor-c": registration({ harness: "Harness C", swarm: "beta" }),
    "failed-agent": registration({ lifecycle: "failed", harness: "Failed harness" }),
    "finished-agent": registration({ lifecycle: "finished", harness: "Finished harness" }),
    "registered-only": registration({ lifecycle: "deployed", harness: "Registration harness", swarm: "beta" }),
  }));
}

export function swarmVM(p: PlanProjection = frozenPlan(), connected = true): SwarmViewModel {
  return deriveSwarmViewModel({ room: "demo", projection: p, events: [], nowMs: NOW, connected });
}

export function wallVM(p: PlanProjection = frozenPlan(), swarm?: SwarmViewModel): WallMountVM {
  const vm = toWallVM([], new Map(), {
    nowMs: NOW, model: { state: "ready", label: "Device ready" }, network: "online",
    view: "wall", workspace: "demo", archiveScope: "workspace",
  }, [{ room: "demo", projection: p, source: "v2", invalidOps: 0 }]);
  return { ...vm, ...(swarm === undefined ? {} : { swarm }) };
}

export function mountVM(vm: WallMountVM): HTMLElement {
  const host = document.createElement("div"); document.body.append(host);
  const handle = mountWall(host, vm); cleanup.push(() => handle.destroy());
  return host;
}

export function taskCard(root: ParentNode, id: string): HTMLElement {
  // A-U146: task identity is a class/data contract, independent of the root element.
  const found = [...root.querySelectorAll<HTMLElement>(".task[data-task-id]")]
    .find(el => el.getAttribute("data-task-id") === id && visible(el));
  expect(found, `Visible Wall task card ${id}`).toBeDefined(); return found!;
}

/** Frozen ring hooks already exist; no new chip class or wrapper is prescribed. */
export function chipHeader(root: ParentNode, id: string, owner: string, harness: string, state: string): HTMLElement {
  const card = taskCard(root, id), ring = card.querySelector<HTMLElement>(".status-icon");
  expect(ring, `Existing task activity ring ${id}`).not.toBeNull();
  const header = ring!.closest<HTMLElement>(".task-head")!;
  expect(header, "Chip must be adjacent to the existing task ring").not.toBeNull();
  for (const value of [owner, harness, state]) expect(visibleText(header)).toContain(value);
  const chip = [...header.querySelectorAll<HTMLElement>("*")].find(el =>
    !el.contains(ring) && [owner, harness, state].filter(Boolean).every(value => visibleText(el).includes(value)));
  expect(chip, "An agent chip distinct from the task ring must carry identity, harness and literal state").toBeDefined();
  let label = visibleText(chip!);
  for (const identity of [harness, owner].filter(Boolean)) label = label.split(identity).join("");
  expect(label, "State evidence must be separate from text in the supplied identity/harness").toContain(state);
  return header;
}

/** Locate the labelled strip through its mandated action, without choosing its tag or label. */
export function strip(root: HTMLElement): HTMLElement {
  const action = control(root, "Show all in Swarm");
  let at: HTMLElement | null = action.parentElement;
  while (at && at !== root) {
    if (visible(at) && (at.hasAttribute("aria-label") || at.hasAttribute("aria-labelledby"))) {
      // A-U146: preserve strip separation for named non-article task containers.
      expect(at.querySelector('[aria-label="Plan"],.task[data-task-id]'), "The labelled strip must be separate from plan/cards").toBeNull();
      return at;
    }
    at = at.parentElement;
  }
  throw new Error("A labelled agents strip must contain Show all in Swarm");
}

export function swarmRoot(root: ParentNode): HTMLElement {
  const el = root.querySelector<HTMLElement>('[aria-label="Swarm"]');
  expect(el, "Swarm must render the supplied selected-room model").not.toBeNull(); return el!;
}

export function selected(root: ParentNode): string | undefined {
  const node = [...root.querySelectorAll<HTMLElement>('[aria-selected="true"],[aria-current="page"]')]
    .find(visible);
  return node ? accessibleName(node).toLowerCase() : undefined;
}

export function key(target: EventTarget, value: string, extra: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...extra }));
}

/** Supply native activation only when jsdom omits the browser default action. */
export function activate(node: HTMLElement, value: "Enter" | " " = "Enter"): void {
  node.focus();
  const details = node.tagName === "SUMMARY" ? node.closest("details") : null;
  const priorOpen = details?.open, priorExpanded = node.getAttribute("aria-expanded");
  const down = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
  const up = new KeyboardEvent("keyup", { key: value, bubbles: true, cancelable: true });
  node.dispatchEvent(down); node.dispatchEvent(up);
  if (!down.defaultPrevented && !up.defaultPrevented &&
    (node.tagName === "BUTTON" || node.tagName === "SUMMARY" || (node.tagName === "A" && value === "Enter")) &&
    priorOpen === details?.open && priorExpanded === node.getAttribute("aria-expanded")) node.click();
}

export function disclosure(card: HTMLElement): HTMLElement {
  const found = [...card.querySelectorAll<HTMLElement>("summary, [aria-expanded]")]
    .find(node => !/^View task\b/.test(accessibleName(node)) && visible(node));
  expect(found, "Agent metadata requires a labelled keyboard disclosure").toBeDefined();
  expect(accessibleName(found!)).not.toBe(""); expect(found!.tabIndex).toBeGreaterThanOrEqual(0);
  return found!;
}

export function expanded(node: HTMLElement): boolean {
  return node.tagName === "SUMMARY" ? node.closest("details")!.open : node.getAttribute("aria-expanded") === "true";
}

export function agentCard(root: HTMLElement, slug: string): HTMLElement {
  const name = [...root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6,[role=heading]")]
    .find(node => text(node) === slug);
  expect(name, `Agent identity ${slug}`).toBeDefined();
  // A-U146: the named non-article agent container retains its class hook.
  const card = name!.closest<HTMLElement>(".swarm-card");
  expect(card, `Existing agent card ${slug}`).not.toBeNull(); return card!;
}

export function groupOrder(root: HTMLElement, slugs: readonly string[]): string[] {
  return [...root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6,[role=heading]")]
    .map(text).filter(value => slugs.includes(value));
}

export function noNewControls(root: HTMLElement): void {
  expect(root.querySelector('input,textarea,form,[contenteditable="true"],[role="textbox"]')).toBeNull();
  for (const node of root.querySelectorAll<HTMLElement>('button,a,[role="button"],[role="link"]'))
    expect(accessibleName(node)).not.toMatch(/\b(chat|reply|send|composer|terminal|shell|deploy|terminate|restart)\b/i);
}

export function registrationOnly(name: string, extra: Partial<SwarmAgentVM> = {}): SwarmAgentVM {
  return agent({ agent: name, tasks: [], current_task_id: null, active_micro_id: null,
    micro_done: null, micro_total: null, activity: "idle", last_beat_age_ms: null, last_beat_ts: null, ...extra });
}
