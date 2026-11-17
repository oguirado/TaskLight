import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, vi } from "vitest";
import type { RoomEvent } from "../../../src/agents/types";
import type { AgentStore, AgentStoreOptions, PlanProjectionResult } from "../../../src/app/agent_store";
import { createAgentStore, toWallVM } from "../../../src/app/agent_store";
import type { MemoryVM, PlanVM, WallVM } from "../../../src/views/types";
import type { PlanningTemplate } from "../../../src/plan";

export interface Version { rev: number; by: string; ts: number; text: string }
export type History = Readonly<Record<string, readonly Version[]>>;
export type Memory = MemoryVM & { room?: string; history?: History };
export type Projection = PlanProjectionResult & { memoryHistory?: History };
const shared = JSON.parse(readFileSync(resolve(process.cwd(), "tests/unit/u126/fixture.json"), "utf8")) as {
  events: RoomEvent[]; versions: Version[];
};
export const EXPECTED: readonly Version[] = Object.freeze(shared.versions.map(v => Object.freeze(v)));
export const fixture = (): RoomEvent[] => structuredClone(shared.events);
export const NOW = 1_700_000_010_000;
export const HOSTILE = "<img src=x onerror=alert(1)>";
export const MALFORMED_ROOM = "demo';touch x;#";
export const COMMAND = `python3 -m bridge.room call room_export --json '{"room":"demo","agent":"worker-a","what":"memory"}'`;
export const id = (n: number): string => `e-${n.toString(16).padStart(16, "0")}`;
export const event = (n: number, changes: Partial<RoomEvent> = {}): RoomEvent => ({
  id: id(n), room: "demo", agent: "alice", act: "heartbeat", text: "", ts: NOW + n, lamport: n, ...changes,
});
export const op = (n: number, body: Record<string, unknown>, changes: Partial<RoomEvent> = {}): RoomEvent =>
  event(n, { act: "op", op: body as NonNullable<RoomEvent["op"]>, ...changes });
export const memoryOp = (n: number, base: number, text: string, changes: Partial<RoomEvent> = {}): RoomEvent =>
  op(n, { kind: "memory.set", section: "goal", text, base_rev: base, op_id: `memory-${n.toString().padStart(4, "0")}` }, changes);
export const opening = (n = 1, changes: Record<string, unknown> = {}): RoomEvent => op(n, {
  kind: "plan.open", title: "Memory oracle", template_id: "neutral", template_hash: "a".repeat(64),
  brief: {}, phase: "discovery", ...changes,
});
export const planEvents = (): RoomEvent[] => [opening(),
  op(2, { kind: "task.add", title: "Discover", type: "action", phase: "discovery", accept: "Seen",
    microtasks: [{ text: "Inspect", accept: "Seen" }] }),
  op(3, { kind: "task.add", title: "Build", type: "action", phase: "build", accept: "Seen",
    microtasks: [{ text: "Construct", accept: "Seen" }] }),
];
export function makeStore(events: readonly RoomEvent[] = fixture(), options?: AgentStoreOptions): AgentStore {
  const store = createAgentStore(options);
  for (const e of events) expect(store.ingestChecked(e), `fixture admission ${e.id}`).not.toBe("invalid");
  return store;
}
export function projection(store: AgentStore, room = "demo"): Projection {
  const value = store.plan(room);
  expect(value, `existing plan(room) seam for ${room}`).toBeDefined();
  return value as Projection;
}
export function wall(store: AgentStore, room = "demo", view: WallVM["view"] = "memory"): WallVM {
  return toWallVM(store.states(), undefined, {
    nowMs: NOW, model: { state: "unavailable", label: "Unavailable" }, network: "offline", workspace: room, view,
  }, store.plans());
}
export function memory(history?: History, room: string | undefined = "demo"): Memory {
  return { sections: [{ id: "goal", label: "Goal", text: "new", required: false, empty: false,
    rev: 9, by: "bob", changedAt: "1970-01-01T00:00:01.000Z", maxChars: 2000 }],
    ...(room === undefined ? {} : { room }), ...(history === undefined ? {} : { history }) };
}
export function plan(changes: Partial<PlanVM> = {}): PlanVM {
  return { id: "p1", title: "Phase oracle", templateId: "neutral", templateHash: "a".repeat(64),
    phaseId: "discovery", phases: [{ id: "discovery", label: "Discovery", active: true },
      { id: "build", label: "Build", active: false }], doneCount: 0, totalCount: 2, progressPct: 0, agents: [], ...changes };
}
export function phaseWall(): WallVM {
  return { now: "09:00", model: { state: "unavailable", label: "Unavailable" }, network: "offline",
    workspaces: [{ id: "demo", name: "Demo", lens: "dev", accent: "sky" }], workspace: "demo",
    view: "wall", archiveScope: "workspace", agenda: [], archive: [], plan: plan(),
    tasks: ["discovery", "build"].map((phaseId, i) => ({
      id: `task-${i + 1}`, taskId: `T0${i + 1}`, workspace: "demo", project: "Demo", accent: "sky",
      title: i === 0 ? "Discover" : "Build", summary: "", status: "idle", attention: "none", updated: "09:00",
      source: { kind: "rules", ms: 0 }, next: "", steps: [], phaseId,
    })),
  };
}
export function template(): PlanningTemplate {
  const raw = JSON.parse(readFileSync(resolve(process.cwd(), "tests/unit/u85/fixture.json"), "utf8")) as { template: PlanningTemplate };
  return { ...raw.template, hash: "a".repeat(64), phases: [{ id: "discovery", label: "Discovery", exit: "Seen" },
    { id: "build", label: "Build", exit: "Seen" }], memory_sections: [
    { id: "goal", label: "Goal", required: false, max_chars: 1, hint: "Deliberately restrictive" },
  ] };
}
export function python(events: readonly RoomEvent[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  const result = spawnSync("python3", ["-B", resolve(process.cwd(), "tests/unit/u126/python_oracle.py")], {
    cwd: process.cwd(), input: JSON.stringify({ events, ...extra }),
    encoding: "utf8", timeout: 8_000, maxBuffer: 512 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  expect(result.error, "Python oracle infrastructure must work").toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
export const text = (root: Node): string => (root.textContent ?? "").replace(/\s+/g, " ").trim();
export function visibleText(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  const originals = [root, ...root.querySelectorAll<HTMLElement>("*")];
  const copies = [copy, ...copy.querySelectorAll<HTMLElement>("*")];
  for (let i = 0; i < originals.length; i++) {
    const node = originals[i]!;
    const style = getComputedStyle(node);
    if (node.hidden || node.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden") {
      if (i === 0) return "";
      copies[i]?.remove();
    }
  }
  for (const n of copy.querySelectorAll("script, style")) n.remove();
  return text(copy);
}
export function assertHistory(value: unknown, expected: readonly Version[] = EXPECTED): void {
  expect(value, "retained accepted versions, newest first").toEqual(expected);
}
export function assertPhaseLabels(root: HTMLElement, current = "Discovery", filter = "Build"): void {
  expect(visibleText(root), "visible current-phase label").toContain(`Current phase: ${current}`);
  expect(visibleText(root), "visible filter label").toContain(`Phase filter: ${filter}`);
}
export function commandText(root: HTMLElement): string | undefined {
  for (const node of root.querySelectorAll<HTMLElement>("input, textarea, *")) {
    const value = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node.value : node.textContent;
    if (value?.trim().startsWith("python3 -m bridge.room call room_export --json ")) return value.trim();
  }
  return undefined;
}
export function assertCommand(root: HTMLElement, expected: string | undefined): void {
  if (expected === undefined) {
    expect(commandText(root), "invalid or absent slug must not produce executable text").toBeUndefined();
    expect(text(root)).toContain("Command unavailable");
  } else {
    expect(text(root)).toContain("Memory export command");
    expect(commandText(root)).toBe(expected);
  }
}
export function assertScoped(memoryValue: Memory | undefined, room: string, expected: readonly Version[]): void {
  expect(memoryValue?.room).toBe(room);
  assertHistory(memoryValue?.history?.["goal"], expected);
  expect(JSON.stringify(memoryValue)).not.toContain("secret");
}
export function activate(button: HTMLElement, keyboard = false): void {
  if (keyboard) {
    expect(button.tabIndex).toBeGreaterThanOrEqual(0);
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    button.focus();
    expect(document.activeElement).toBe(button);
    const key = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    button.dispatchEvent(key);
    // jsdom has no native keyboard default actions. Model the uncancelled action.
    if (!key.defaultPrevented) button.click();
  } else button.click();
}
export function noNetwork(): ReturnType<typeof vi.fn> {
  const denied = vi.fn(() => { throw new Error("Network forbidden"); });
  vi.stubGlobal("fetch", denied);
  vi.stubGlobal("XMLHttpRequest", denied);
  vi.stubGlobal("WebSocket", denied);
  return denied;
}
