import { afterEach, beforeEach, expect, vi } from "vitest";
import { toWallVM } from "../../../src/app/agent_store";
import { deriveSwarmViewModel } from "../../../src/app/swarm_vm";
import { applyOp } from "../../../src/plan/reducer";
import { mountWall } from "../../../src/views";
import type { PlanProjection } from "../../../src/plan/types";
import type { SwarmRegistration } from "../../../src/app/swarm_vm";
import type { WallMountHandlers, WallMountVM } from "../../../src/views";
import type { TaskVM } from "../../../src/views/types";
import { accessibleName, visible } from "../u118/fixtures";
import { NOW, beat, event, freeze, micro, projection, registration, task } from "../u136/fixtures";

export { NOW, accessibleName, freeze, visible };
export const cleanup: Array<() => void> = [];

export function deterministic(): void {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    localStorage.clear();
    const forbidden = vi.fn((): never => { throw new Error("Network forbidden by U150 oracle"); });
    for (const name of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]) vi.stubGlobal(name, forbidden);
  });
  afterEach(() => {
    try { for (const dispose of cleanup.splice(0).reverse()) dispose(); }
    finally {
      document.body.replaceChildren();
      localStorage.clear();
      delete document.documentElement.dataset.theme;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
}

export function fallbackTask(): TaskVM {
  return {
    id: "legacy-task", workspace: "demo", project: "Continuity", accent: "sky",
    title: "Inspect fallback evidence", summary: "Read-only task context",
    status: "running", attention: "low", updated: "now", source: { kind: "rules", ms: 0 },
    next: "Inspect the recorded result", activity: { state: "working" },
    steps: [{ label: "Inspect evidence", state: "active", microId: "T01.M01",
      activity: { state: "working" },
      detail: { outcome: "Fallback outcome", evidence: ["evidence/fallback.txt"], source: { kind: "rules", ms: 0 } } }],
  };
}

export function fallbackVM(tasks: readonly TaskVM[] = [fallbackTask()]): WallMountVM {
  return {
    now: "Fixed time", model: { state: "ready", label: "Device ready" }, network: "online",
    workspace: "demo", view: "wall", archiveScope: "workspace",
    workspaces: [
      { id: "demo", name: "Same workspace name", lens: "dev", accent: "sky" },
      { id: "work", name: "Same workspace name", lens: "dev", accent: "iris" },
    ], tasks, agenda: [], archive: [],
  };
}

export function planFixture(): PlanProjection {
  return projection(["T01", "T05", "T07"].map((id, index) => {
    const agent = ["worker-a", "worker-b", "worker-c"][index]!;
    return task(id, { assignee: agent, microtasks: [micro(`${id}.M01`, {
      live: beat({ agent }), outcome: `${id} recorded outcome`,
      evidence: [{ path: `evidence/${id}.txt`, sha256: "a".repeat(64) }],
    })] });
  }), {
    "worker-a": registration(), "worker-b": registration(), "worker-c": registration(),
  });
}

export function planVM(p: PlanProjection, view: "wall" | "swarm" = "swarm"): WallMountVM {
  const vm = toWallVM([], new Map(), {
    nowMs: NOW, model: { state: "ready", label: "Device ready" }, network: "online",
    workspace: "demo", view: "wall", archiveScope: "workspace",
  }, [{ room: "demo", projection: p, source: "v2", invalidOps: 0 }]);
  return { ...vm, view, swarm: deriveSwarmViewModel({ room: "demo", projection: p,
    events: [], nowMs: NOW, connected: true }) };
}

/** Real reducer operation at the in-memory store seam; no simulated renderer. */
export function commitBeat(p: PlanProjection, sequence: number): PlanProjection {
  const result = applyOp(p, event(sequence + 10, {
    agent: "worker-a", act: "op", text: "", ts: NOW - 500 + sequence,
    op: { kind: "activity.beat", op_id: `u150-beat-${sequence}`, task_id: "T01", micro_id: "T01.M01", run_id: "r1" },
  }));
  expect(result.ok, "Fixture precondition: activity_beat must be accepted").toBe(true);
  expect(result.projection.tasks[0]?.microtasks[0]?.live?.beat_ts).toBe(NOW - 500 + sequence);
  expect(result.projection.tasks.map(t => t.state)).toEqual(p.tasks.map(t => t.state));
  expect(result.projection.rollup).toEqual(p.rollup);
  return result.projection;
}

export function silentVM(registrations: Readonly<Record<string, SwarmRegistration>>,
  view: "wall" | "swarm" = "wall", base: WallMountVM = fallbackVM([])): WallMountVM {
  return { ...base, view, swarm: deriveSwarmViewModel({ room: "demo", projection: null,
    agents: registrations, events: [], nowMs: NOW, connected: true }) };
}

export function mount(vm: WallMountVM, handlers: WallMountHandlers = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const handle = mountWall(host, freeze(vm), handlers);
  cleanup.push(() => handle.destroy());
  return { host, handle, update: (next: WallMountVM) => handle.update(freeze(next)) };
}

export function one<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T {
  const matches = [...root.querySelectorAll<T>(selector)].filter(visible);
  expect(matches, `Fixture precondition: one visible ${selector}`).toHaveLength(1);
  return matches[0]!;
}

export function button(root: ParentNode, name: string): HTMLElement {
  const matches = [...root.querySelectorAll<HTMLElement>("button,summary,[role=button]")]
    .filter(node => visible(node) && accessibleName(node) === name);
  expect(matches, `Fixture precondition: one visible control named ${name}`).toHaveLength(1);
  return matches[0]!;
}

export function status(root: ParentNode): HTMLElement {
  return one(root, '[role="status"][aria-live="polite"]');
}

export function agentMetadata(root: ParentNode, agent: string): HTMLElement {
  return button(root, `Agent details · ${agent}`);
}

export function detail(root: ParentNode, id = "T05"): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>('[role="region"],section')]
    .find(node => visible(node) && accessibleName(node) === `Task details · ${id}`);
}

export function panel(toggle: HTMLElement): HTMLElement {
  const id = toggle.getAttribute("aria-controls");
  expect(id, "Disclosure must reference its content").toBeTruthy();
  const result = toggle.ownerDocument.getElementById(id!);
  expect(result, "Disclosure content must exist").not.toBeNull();
  return result!;
}

export function press(target: EventTarget, key: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

/** Native activation fallback only for the browser default absent in jsdom. */
export function activate(control: HTMLElement, key: "Enter" | " " = "Enter"): void {
  control.focus();
  const down = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  control.dispatchEvent(down);
  const up = new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true });
  control.dispatchEvent(up);
  if (!down.defaultPrevented && !up.defaultPrevented && control.tagName === "BUTTON") control.click();
}

/** Emit an article as an opaque node; preserve descendants of other containers. */
export function prunedControls(root: Element): string[] {
  const controls: string[] = [];
  const visit = (node: Element): void => {
    if (node.tagName === "ARTICLE" || node.getAttribute("role") === "article") return;
    if (node.matches('button,[role="button"]')) controls.push(accessibleName(node as HTMLElement));
    for (const child of node.children) visit(child);
  };
  visit(root);
  return controls;
}

export function watchStatus(node: HTMLElement) {
  const delivered: MutationRecord[] = [];
  const observer = new MutationObserver(records => delivered.push(...records));
  observer.observe(node, { subtree: true, childList: true, characterData: true });
  cleanup.push(() => observer.disconnect());
  return { takeRecords: (): MutationRecord[] => [...delivered.splice(0), ...observer.takeRecords()] };
}
