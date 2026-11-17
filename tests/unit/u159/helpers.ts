import { afterEach, beforeEach, expect, vi } from "vitest";
import { toWallVM } from "../../../src/app/agent_store";
import { deriveSwarmViewModel } from "../../../src/app/swarm_vm";
import { applyOp } from "../../../src/plan/reducer";
import { mountWall, type WallMountVM } from "../../../src/views";
import { NOW, beat, event, freeze, micro, projection, registration, task } from "../u136/fixtures";

export const TASK_IDS = Array.from({ length: 30 }, (_, i) => `T${String(i + 1).padStart(2, "0")}`);
const disposers: Array<() => void> = [];
const network = vi.fn((): never => { throw new Error("U159 forbids network access"); });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  localStorage.clear();
  network.mockClear();
  for (const name of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]) vi.stubGlobal(name, network);
});
afterEach(() => {
  try {
    for (const dispose of disposers.splice(0).reverse()) dispose();
    expect(network, "the keyboard oracle must remain local").not.toHaveBeenCalled();
  } finally {
    document.body.replaceChildren();
    localStorage.clear();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

export function mountFixture() {
  const agents = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`worker-${i + 1}`, registration()]));
  let p = projection(TASK_IDS.map((id, i) => {
    const agent = `worker-${i % 5 + 1}`;
    return task(id, { title: "Repeated task title", assignee: agent, microtasks: [micro(`${id}.M01`, {
      text: "Inspect the outcome", live: beat({ agent }), outcome: `Outcome for ${id}`,
      evidence: [{ path: `evidence/${id}.txt`, sha256: "a".repeat(64) }],
    })] });
  }), agents);
  const vm = (): WallMountVM => {
    const converted = toWallVM([], new Map(), {
      nowMs: NOW, model: { state: "ready", label: "Device ready" }, network: "online",
      workspace: "demo", view: "wall", archiveScope: "workspace",
    }, [{ room: "demo", projection: p, source: "v2", invalidOps: 0 }]);
    expect(converted.plan, "fixture precondition: an existing plan must render").toBeDefined();
    return { ...converted, plan: { ...converted.plan!, phases: [
      { id: "brief", label: "Brief", active: false },
      { id: "build", label: "Build", active: true },
    ] }, swarm: deriveSwarmViewModel({ room: "demo", projection: p, events: [], nowMs: NOW, connected: true }) };
  };
  const before = Object.assign(document.createElement("button"), { textContent: "Before Wall" });
  const host = document.createElement("div");
  const after = Object.assign(document.createElement("button"), { textContent: "After Wall" });
  document.body.append(before, host, after);
  let current = vm();
  const onOpenTask = vi.fn();
  const handle = mountWall(host, freeze(current), {
    onOpenTask,
    onView(view) { current = { ...current, view }; handle.update(freeze(current)); },
  });
  disposers.push(() => handle.destroy());
  // These checks fail closed if a future fixture silently truncates the tail.
  expect([...host.querySelectorAll(".plan-wall .task[data-task-id]")].map(n => n.getAttribute("data-task-id"))).toEqual(TASK_IDS);
  const initialStops = domStops(host).map(key);
  expect(initialStops.filter(k => k.startsWith("title:"))).toEqual(TASK_IDS.map(id => `title:${id}`));
  expect(initialStops.filter(k => k.startsWith("micro:"))).toEqual(TASK_IDS.map(id => `micro:${id}.M01`));
  expect(new Set(initialStops).size, "fixture controls need distinct identities").toBe(initialStops.length);
  let sequence = 0;
  return { host, before, after, onOpenTask,
    refreshBeat() {
      sequence += 1;
      const result = applyOp(p, event(sequence + 10, {
        agent: "worker-1", act: "op", text: "", ts: NOW - 500 + sequence,
        op: { kind: "activity.beat", op_id: `u159-beat-${sequence}`, task_id: "T01", micro_id: "T01.M01", run_id: "r1" },
      }));
      expect(result.ok, "fixture precondition: activity beat is accepted").toBe(true);
      expect(result.projection.tasks[0]?.microtasks[0]?.live?.beat_ts).toBe(NOW - 500 + sequence);
      expect(result.projection.tasks.map(t => t.state)).toEqual(p.tasks.map(t => t.state));
      expect(result.projection.rollup).toEqual(p.rollup);
      p = { ...result.projection, agent_lifecycle: agents };
      current = { ...vm(), view: current.view };
      handle.update(freeze(current));
    },
  };
}

export function name(node: HTMLElement): string {
  const labels = node.getAttribute("aria-labelledby")?.trim().split(/\s+/).filter(Boolean);
  return (labels?.length ? labels.map(id => document.getElementById(id)?.textContent ?? "").join(" ")
    : node.getAttribute("aria-label") || node.textContent || "").replace(/\s+/g, " ").trim();
}

export function key(node: Element | null): string {
  if (node === document.body) return "document:body";
  if (!(node instanceof HTMLElement)) return "document:none";
  if (node.dataset.microId) return `micro:${node.dataset.microId}`;
  if (node.dataset.nav) return `${node.closest("nav,[role=tablist]") || node.hasAttribute("aria-keyshortcuts") ? "nav" : "content-nav"}:${node.dataset.nav}`;
  if (node.dataset.wsid) return `workspace:${node.dataset.wsid}`;
  if (node.matches("button[data-phase-id]")) return `phase:${node.dataset.phaseId}`;
  const titleId = /^View task (T\d+):/.exec(name(node))?.[1];
  if (titleId) return `title:${titleId}`;
  if (node.getAttribute("role") === "tabpanel") return `panel:${node.getAttribute("aria-labelledby")}`;
  return `${node.tagName.toLowerCase()}:${name(node)}`;
}

export function one(root: ParentNode, selector: string): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>(selector)];
  expect(found, `fixture precondition: exactly one ${selector}`).toHaveLength(1);
  return found[0]!;
}

export function title(root: ParentNode, id: string): HTMLElement {
  const controls = [...root.querySelectorAll<HTMLElement>("summary,button,a[href],[role=button]")]
    .filter(node => key(node) === `title:${id}`);
  expect(controls, `fixture precondition: a named task detail control for ${id}`).toHaveLength(1);
  return controls[0]!;
}

// Native sequential navigation excludes hidden/disabled/inert subtrees, but NOT
// an offscreen rectangle. A genuine adjacent control may scroll into view.
export function available(node: HTMLElement): boolean {
  if (node.matches(":disabled") || node.closest("[inert]")) return false;
  for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (ancestor.hidden || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (ancestor instanceof HTMLDetailsElement && !ancestor.open && node !== ancestor) {
      const summary = [...ancestor.children].find(child => child.tagName === "SUMMARY");
      if (!summary?.contains(node)) return false;
    }
  }
  return true;
}

/** Reference order: eligible controls in DOM order; no tabindex sorting. */
export function domStops(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("button,a[href],input,select,textarea,summary,[tabindex],[contenteditable=true]")]
    .filter(node => node.tabIndex >= 0 && available(node));
}

/** jsdom has no Tab default. Model only the missing browser default, after
 * dispatching the real key event. Positive tabindex precedes zero; ties use DOM
 * order. Application preventDefault/focus handlers remain observable. */
export function tab(backward = false): void {
  const start = document.activeElement ?? document.body;
  const down = new KeyboardEvent("keydown", { key: "Tab", code: "Tab", shiftKey: backward, bubbles: true, cancelable: true });
  start.dispatchEvent(down);
  if (!down.defaultPrevented) {
    const stops = domStops(document).map((node, index) => ({ node, index }))
      .sort((a, b) => {
        const ap = a.node.tabIndex > 0, bp = b.node.tabIndex > 0;
        return ap !== bp ? (ap ? -1 : 1) : ap ? a.node.tabIndex - b.node.tabIndex || a.index - b.index : a.index - b.index;
      }).map(entry => entry.node);
    const index = stops.indexOf(document.activeElement as HTMLElement);
    const destination = index < 0 ? (backward ? stops.at(-1) : stops[0]) : stops[index + (backward ? -1 : 1)];
    expect(destination, "fixture navigation must stay between explicit document sentinels").toBeDefined();
    destination!.focus();
  }
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keyup", {
    key: "Tab", code: "Tab", shiftKey: backward, bubbles: true, cancelable: true,
  }));
}

export function enter(): void {
  const node = document.activeElement;
  expect(node, "Enter requires an active control").toBeInstanceOf(HTMLElement);
  const down = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
  node!.dispatchEvent(down);
  const up = new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
  node!.dispatchEvent(up);
  // Native activation is another browser default missing from jsdom. Do not
  // double-activate handlers that consumed either keyboard event.
  if (!down.defaultPrevented && !up.defaultPrevented && (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement || node?.tagName === "SUMMARY")) {
    (node as HTMLElement).click();
  }
}

export function tabTo(wall: ReturnType<typeof mountFixture>, targetKey: string): void {
  wall.before.focus();
  const expected = domStops(wall.host).map(key);
  const index = expected.indexOf(targetKey);
  expect(index, `fixture has a sequential control ${targetKey}`).toBeGreaterThanOrEqual(0);
  for (let i = 0; i <= index; i += 1) tab();
  expect(key(document.activeElement), "U159 focus order on the way to a control").toBe(targetKey);
}

export function assertWalk(wall: ReturnType<typeof mountFixture>, expected: readonly string[], backward = false): void {
  (backward ? wall.after : wall.before).focus();
  const actual: string[] = [];
  for (let i = 0; i < expected.length; i += 1) { tab(backward); actual.push(key(document.activeElement)); }
  expect(actual, "U159 focus order must follow DOM order exactly").toEqual(expected);
  tab(backward);
  expect(document.activeElement, "sequential navigation must exit at the adjacent document sentinel")
    .toBe(backward ? wall.before : wall.after);
}
