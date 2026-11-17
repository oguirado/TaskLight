import { afterEach, beforeEach, expect, vi } from "vitest";
import { createAgentStore } from "../../../src/app/agent_store";
import { startAgentWall, type AgentWallDeps, type WorkspaceStatus } from "../../../src/app/agent_wall";
import { mountWall, type WallMountVM, type WallViewId } from "../../../src/views";
import { renderSwarmView } from "../../../src/views/swarm";
import type { AgentInventoryRow, AgentInventoryTotals, SwarmAgentVM, SwarmViewModel } from "../../../src/app/swarm_vm";
import type { PlanMicrotask, PlanProjection, PlanTask } from "../../../src/plan/types";
import type { Clock } from "../../../src/app/types";

export const NOW = 100_000;
export const HOSTILE = '<img src=x onerror="throw 1">';
// C2 already supplies these runtime fields; its compatibility display type is narrower.
export type Lane = SwarmAgentVM & Omit<AgentInventoryRow, "harness" | "run_id">;
export type Board = Omit<SwarmViewModel, "agents"> & { agents: readonly Lane[]; totals: AgentInventoryTotals };
const cleanup: Array<() => void> = [];
const network = vi.fn((): never => { throw new Error("Network forbidden in V1 oracle"); });

export function deterministic(): void {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(NOW); localStorage.clear();
    document.documentElement.scrollTop = 0; document.body.scrollTop = 0;
    network.mockClear();
    for (const key of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]) vi.stubGlobal(key, network);
  });
  afterEach(() => {
    try {
      for (const dispose of cleanup.splice(0).reverse()) dispose();
      expect(network, "V1 must remain local").not.toHaveBeenCalled();
    } finally {
      document.body.replaceChildren(); document.head.querySelectorAll("style[data-v1-oracle]").forEach(n => n.remove());
      document.documentElement.scrollTop = 0; document.body.scrollTop = 0;
      delete document.documentElement.dataset.theme;
      localStorage.clear(); vi.clearAllTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
    }
  });
}
export function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
export function micro(id: string, state: PlanMicrotask["state"] = "pending", text = `Micro ${id}`): PlanMicrotask {
  return { id, text, state, accept: "Observed result", outcome: null, took: null, evidence: [], rev: 1 };
}
export function task(id = "T09", extra: Partial<PlanTask> = {}): PlanTask {
  return { id, title: `Task ${id}`, state: "active", type: "implementation", phase: "build",
    accept: "Verified", assignee: "z-lead", deps: [], claim_lamport: 1, claim_ts: NOW - 100,
    estimate: null, explicit_state: null, blocked_reason: null, ready: true, rev: 1,
    microtasks: [micro(`${id}.M04`, "pending"), micro(`${id}.M02`, "active"),
      micro(`${id}.M03`, "done"), micro(`${id}.M01`, "blocked")], ...extra };
}
export function agent(slug = "z-lead", extra: Partial<Lane> = {}): Lane {
  const tasks = slug === "z-lead" ? [task(), task("T01", { state: "pending", microtasks: [] })] : [];
  return { agent: slug, harness: "Fixture harness", run_id: "run-a", lifecycle: "alive",
    state: "working", parent: null, children: [], last_seen_lamport: 1, last_seen_ts: NOW - 100,
    current: tasks.length ? { task_id: tasks[0]!.id, micro_id: "T09.M02" } : null,
    counts: { tasks_owned: tasks.length, micros_done: 1, micros_total: 4 }, tasks,
    current_task_id: tasks[0]?.id ?? null, active_micro_id: tasks[0]?.microtasks[1]?.id ?? null,
    micro_done: tasks.length ? 1 : null, micro_total: tasks.length ? 4 : null, activity: "working",
    last_beat_ts: NOW - 100, last_beat_age_ms: 100, waiting_on: [], unanswered_questions: 0, ...extra };
}
export function board(agents: readonly Lane[] = [agent()]): Board {
  const totals: Record<keyof AgentInventoryTotals, number> = {
    working: 0, waiting: 0, idle: 0, registered: 0, finished: 0, failed: 0, unknown: 0, total: agents.length,
  };
  for (const row of agents) totals[row.state]++;
  return { room: "demo", agents, totals, progress: null, refresh_at_ms: null };
}
export function tree(): Board {
  return board([
    agent("z-lead", { children: ["b-child"] }),
    agent("b-child", { state: "waiting", activity: "waiting", parent: { agent: "z-lead", run_id: "run-a" }, children: ["a-leaf"] }),
    agent("a-leaf", { state: "idle", activity: "idle", parent: { agent: "b-child", run_id: "run-a" } }),
    agent("a-root", { state: "registered", activity: "idle", lifecycle: "deployed" }),
  ]);
}
export function render(vm: Board = board()): HTMLElement {
  const node = renderSwarmView(document, freeze(vm)); document.body.append(node); return node;
}
export const text = (node: Node): string => (node.textContent ?? "").replace(/\s+/g, " ").trim();
export function visible(node: HTMLElement): boolean {
  for (let at: HTMLElement | null = node; at; at = at.parentElement) {
    if (at.hidden || at.getAttribute("aria-hidden") === "true" || at.style.display === "none" || at.style.visibility === "hidden") return false;
    if (at.matches("details:not([open])") && !at.querySelector("summary")?.contains(node)) return false;
  }
  return true;
}
export function visibleText(node: HTMLElement): string {
  const copy = node.cloneNode(true) as HTMLElement;
  for (const child of [...copy.querySelectorAll<HTMLElement>("*")].reverse()) if (!visible(child)) child.remove();
  return text(copy);
}
export function name(node: HTMLElement): string {
  const refs = node.getAttribute("aria-labelledby")?.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean);
  return node.getAttribute("aria-label") ?? (refs?.length ? refs.map(n => text(n!)).join(" ") : text(node));
}
export function identity(root: HTMLElement, slug: string): HTMLElement {
  const matches = [...root.querySelectorAll<HTMLElement>("*")].filter(n => text(n).includes(slug) &&
    ![...n.children].some(c => text(c).includes(slug)));
  const found = matches.find(n => n.matches("h1,h2,h3,h4,h5,h6,[role=heading]")) ?? matches[0];
  expect(found, `M3 visible identity: ${slug}`).toBeDefined(); return found!;
}
export function lane(root: HTMLElement, slug: string): HTMLElement {
  let node: HTMLElement | null = identity(root, slug);
  while (node && node !== root) {
    if (node.matches('[role="group"],[role="treeitem"],article,li,section') || node.tabIndex >= 0) return node;
    node = node.parentElement;
  }
  expect.fail(`M3 distinct lane for ${slug}`);
}
export function bubble(root: ParentNode, title: string): HTMLButtonElement {
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("button,[role=button]")]
    .filter(n => visible(n) && n.hasAttribute("aria-expanded") && name(n).includes(title));
  expect(buttons, `M4 disclosure button with task title: ${title}`).toHaveLength(1); return buttons[0]!;
}
export function microNode(root: ParentNode, title: string): HTMLElement {
  const candidates = [...root.querySelectorAll<HTMLElement>("*")].filter(n => visible(n) && name(n).includes(title + ",") && /, (pending|active|done|blocked), [0-9]+\/[0-9]+/.test(name(n)));
  const found = candidates.find(n => ![...n.children].some(c => candidates.includes(c as HTMLElement)));
  expect(found, `M4 expanded microtask: ${title}`).toBeDefined(); return found!;
}
export function activate(node: HTMLElement, key: "Enter" | " "): void {
  const down = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }); node.dispatchEvent(down);
  const up = new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }); node.dispatchEvent(up);
  if (!down.defaultPrevented && !up.defaultPrevented && node.matches("button")) node.click();
}
export function escape(node: HTMLElement): void {
  node.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}
export function projection(vm: Board): PlanProjection {
  const tasks = vm.agents.flatMap(a => a.tasks);
  return { plan: { id: "p1", title: "Board fixture", template_id: "fixture", template_hash: "fixture",
    brief: {}, phase: "build", state: "active", rev: 1, opened_lamport: 1, opened_ts: 0, closed_outcome: null },
    tasks, memory: {}, archived_plans: [], replayed_ops: {}, rejected: [], last_lamport: 1,
    agent_lifecycle: Object.fromEntries(vm.agents.map((a, index) => [a.agent, {
      lifecycle: a.lifecycle ?? "alive", run_id: a.run_id ?? "run-a", harness: a.harness ?? "Fixture harness",
      deployed_ts: NOW - 200, ts: NOW - 100, lamport: index + 1, retired_run_ids: [],
      ...(a.parent ? { parent_agent: a.parent.agent, parent_run_id: a.parent.run_id ?? "run-a" } : {}),
    }])),
    rollup: { tasks_total: tasks.length, tasks_done: 0, tasks_blocked: 0, tasks_ready: tasks.length,
      micro_total: 4, micro_done: 1, progress: 0.25, progress_pct: 25 } };
}
export function wallVM(vm: Board = board(), view: WallViewId = "swarm"): WallMountVM {
  return { now: "Fixed time", model: { state: "ready", label: "Device ready" }, network: "online",
    workspace: vm.room, view, archiveScope: "workspace", workspaces: [{ id: vm.room, name: vm.room, lens: "dev", accent: "sky" }],
    tasks: [], agenda: [], archive: [], swarm: vm };
}
export function mounted(vm: Board = board(), view: WallViewId = "swarm") {
  const host = document.createElement("div"); document.body.append(host);
  let value = wallVM(vm, view);
  const handle = mountWall(host, freeze(value), { onView(next) { value = { ...value, view: next }; handle.update(freeze(value)); } });
  cleanup.push(() => handle.destroy());
  return { host, update(next: Board = vm) { value = { ...value, swarm: next }; handle.update(freeze(value)); },
    navigate(next: WallViewId) { value = { ...value, view: next }; handle.update(freeze(value)); } };
}
export function integrated(initialView?: WallViewId, initialReadError?: string) {
  const vm = board(); const p = projection(vm); const real = createAgentStore();
  const record = { id: "e-0000000000000001", lamport: 1, ts: NOW - 100, room: "demo", agent: "z-lead",
    act: "op" as const, text: "", op: { kind: "agent.lifecycle" as const, state: "alive" as const, run_id: "run-a", op_id: "v1-lifecycle", harness: "Fixture harness" } };
  expect(real.ingestChecked(record), "Fixture lifecycle must be admitted").toBe("accepted");
  const result = { room: "demo", projection: p, source: "v2" as const, invalidOps: 0 };
  const plan = vi.spyOn(real, "plan").mockReturnValue(result);
  vi.spyOn(real, "plans").mockReturnValue([result]);
  const events = vi.spyOn(real, "events").mockReturnValue(real.events("demo"));
  const status: WorkspaceStatus = { link: { kind: "linked", nonce: "fixture-session" }, rooms: ["demo"], synced: ["demo"] };
  const host = document.createElement("div"), chat = document.createElement("div"); document.body.append(host, chat);
  const clock: Clock = { now: () => Date.now(), setTimeout: (fn, ms) => Number(setTimeout(fn, ms)),
    clearTimeout: id => clearTimeout(id), setInterval: (fn, ms) => Number(setInterval(fn, ms)), clearInterval: id => clearInterval(id) };
  const post = vi.fn(async () => ({ ok: true as const, id: "e-000000000000ffff", lamport: 65535 }));
  const deps: AgentWallDeps = { wallHost: host, chatHost: chat, store: real, clock, userAgent: "wall-user",
    link: { post }, reviewer: { review: vi.fn(async () => undefined) }, workspaceStatus: () => status,
    ...(initialView === undefined ? {} : { initialView }) };
  if (initialReadError !== undefined) events.mockImplementation(() => { throw new Error(initialReadError); });
  const wall = startAgentWall(deps); cleanup.push(() => wall.destroy());
  return { host, wall, events, plan, result, status, post };
}
