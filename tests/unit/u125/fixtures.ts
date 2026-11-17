import { expect, vi } from "vitest";
import { startAgentWall, type AgentWall, type AgentWallDeps } from "../../../src/app/agent_wall";
import { createAgentStore, type AgentStore, type PlanProjectionResult } from "../../../src/app/agent_store";
import { canonicalStarterTemplateHash, resolveStarterTemplate } from "../../../src/app/starter_templates";
import { checkConformance, emptyProjection } from "../../../src/plan";
import type { PlanOpBody, PlanProjection } from "../../../src/plan/types";
import type { Clock, WallPortState } from "../../../src/app/types";
import blank from "../../../templates/planning/blank.json";

export const NOW = Date.UTC(2026, 0, 1, 9);
export const HOSTILE = "<img src=x onerror=alert(1)>";
export const ERROR = "javascript:alert(1)";
export const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => Number(setTimeout(fn, ms)), clearTimeout: id => clearTimeout(id),
  setInterval: (fn, ms) => Number(setInterval(fn, ms)), clearInterval: id => clearInterval(id),
};
export const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
export interface Observation { link: WallPortState | null; rooms: readonly string[]; synced: readonly string[] }
// Structural test input: this optional spec seam need not exist in the current product types.
export type ObservedDeps = AgentWallDeps & { workspaceStatus?: () => Observation };
export function observation(link: WallPortState = { kind: "linked", nonce: "session-a" }): Observation {
  return { link, rooms: ["demo"], synced: ["demo"] };
}
export function dataFixture(known = ["demo"]) {
  const real = createAgentStore({ templates: resolveStarterTemplate });
  const overrides = new Map<string, PlanProjectionResult | undefined>();
  const knownRooms = new Set(known);
  let seq = 0;
  const read = (room: string): PlanProjectionResult | undefined => {
    if (overrides.has(room)) return overrides.get(room);
    return real.plan(room) ?? (knownRooms.has(room)
      ? { room, source: "v2", projection: emptyProjection(), invalidOps: 0 } : undefined);
  };
  const store = {
    ...real,
    states: vi.fn(() => real.states()),
    events: vi.fn((room: string) => real.events(room)),
    plan: vi.fn(read),
    plans: vi.fn(() => [...new Set([...knownRooms, ...overrides.keys(), ...real.plans().map(p => p.room)])]
      .map(read).filter((p): p is PlanProjectionResult => p !== undefined)),
  } satisfies AgentStore;
  function emit(op: PlanOpBody, room = "demo", agent = "alpha") {
    const n = ++seq;
    const ev = { id: `e-${n.toString(16).padStart(16, "0")}`, lamport: n,
      ts: NOW - 1000 + n, room, agent, act: "op" as const, text: "", op };
    expect(real.ingestChecked(ev), "The test history must be accepted before checking guidance").toBe("accepted");
    const result = real.plan(room);
    expect(result?.invalidOps, "The fixture is not a malformed-operation oracle").toBe(0);
    expect(result?.rejectedOps ?? 0, "The fixture must fold successfully").toBe(0);
    return ev;
  }
  function legacy(room = "demo", agent = "legacy-observer") {
    const n = ++seq;
    expect(real.ingestChecked({ id: `e-${n.toString(16).padStart(16, "0")}`, lamport: n,
      ts: NOW - 1000 + n, room, agent, act: "open", text: "Observed legacy activity" })).toBe("accepted");
  }
  function memory(room = "demo") {
    for (const section of ["goal", "mission", "rules"]) emit({ kind: "memory.set", section,
      text: `Scratch ${section}`, base_rev: 0, op_id: `seed-${section}-${room}` }, room);
  }
  function open(room = "demo", title = "Scratch verification", withTask = true) {
    memory(room);
    const template_hash = canonicalStarterTemplateHash(blank);
    emit({ kind: "plan.open", title, template_id: "blank", template_hash,
      brief: { goal: "Verify a local scratch artifact" }, op_id: `scratch-open-${room}` }, room);
    if (withTask) {
      emit({ kind: "task.add", title: "Verify scratch artifact", type: "task", phase: "execute",
        accept: "Artifact contents verified", microtasks: [
          { text: "Write scratch artifact" }, { text: "Verify artifact contents" },
        ], op_id: `scratch-task-${room}` }, room);
      emit({ kind: "task.claim", task_id: "T01", op_id: `scratch-claim-${room}` }, room);
    }
    const result = real.plan(room)!;
    expect(checkConformance(result.projection, resolveStarterTemplate("blank", template_hash)).ok,
      "A4 uses the strict scratch-plan recipe from docs/HEADLESS.md").toBe(true);
    return result.projection;
  }
  function snapshot(projection: PlanProjection, room = "demo") {
    overrides.set(room, { room, source: "v2", projection, invalidOps: 0 });
  }
  return { store, real, overrides, knownRooms, emit, legacy, memory, open, snapshot };
}
export type Data = ReturnType<typeof dataFixture>;
export const walls: AgentWall[] = [];
export function mount(options: { data?: Data; status?: Observation; observe?: boolean;
  readStatus?: () => Observation; view?: "swarm" | "wall"; availability?: string } = {}) {
  const data = options.data ?? dataFixture();
  const status = options.status ?? observation();
  const wallHost = document.createElement("div"), chatHost = document.createElement("div");
  document.body.append(wallHost, chatHost);
  const post = vi.fn(async () => ({ ok: true as const, id: "e-000000000000ffff", lamport: 65535 }));
  const review = vi.fn(async () => undefined);
  const readStatus = vi.fn(options.readStatus ?? (() => status));
  const deps: ObservedDeps = {
    wallHost, chatHost, store: data.store, clock, userAgent: "wall-user",
    link: { post, state: () => status.link ?? { kind: "linked", nonce: "fallback-must-not-certify" } },
    reviewer: { review }, initialView: options.view ?? "swarm",
    modelAvailability: () => options.availability ?? "Cloud blocked by room policy",
    ...(options.observe === false ? {} : { workspaceStatus: readStatus }),
  };
  const wall = startAgentWall(deps); walls.push(wall);
  return { data, status, wallHost, chatHost, wall, post, review, readStatus };
}
export function visible(node: HTMLElement): boolean {
  for (let at: HTMLElement | null = node; at; at = at.parentElement) {
    if (at.hidden || at.getAttribute("aria-hidden") === "true" || at.style.display === "none"
      || at.style.visibility === "hidden") return false;
    if (at.matches('dialog:not([open]), .chat-drawer[data-open="false"], .model-sheet[data-open="false"]')) return false;
  }
  return true;
}
export function text(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof HTMLElement && !visible(node)) return "";
  return [...node.childNodes].map(text).join(" ").replace(/\s+/g, " ").trim();
}
export function name(node: HTMLElement): string {
  return node.getAttribute("aria-label") ?? text(node);
}
export function control(root: ParentNode, label: string): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>('button,a[href],[role="button"]')]
    .find(node => visible(node) && name(node) === label);
  expect(found, `Visible guidance action: ${label}`).toBeDefined();
  return found!;
}
export function selectRoom(root: ParentNode, room: string) {
  const button = [...root.querySelectorAll<HTMLButtonElement>("button[data-wsid]")]
    .find(node => node.dataset.wsid === room && visible(node));
  expect(button, `Hello-listed room is selectable before events: ${room}`).toBeDefined();
  button!.click();
  expect(root.querySelector(".app")?.getAttribute("data-workspace")).toBe(room);
}
export const STATE_COPY = [
  ["Connection unknown", "Open workspace help"],
  ["Connecting to bridge", "Check workspace connection setup"],
  ["Bridge disconnected", "Open workspace help"],
  ["Syncing workspace", "Wait for room replay"],
  ["Workspace unavailable", "Ask the harness to inspect the room"],
  ["Empty workspace", "Open workspace help"],
  ["Legacy activity only", "Ask the harness to create a shared plan"],
  ["No plan yet", "Ask the harness to seed required memory and create a plan"],
  ["No tasks yet", "Ask the harness to add work"],
] as const;
export function assertState(root: ParentNode, heading: string, action: string) {
  const headings = [...root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,[role="heading"]')]
    .filter(visible).map(node => text(node));
  expect(headings, `A visible heading distinguishes ${heading}`).toContain(heading);
  const selected = root.querySelector(".app")?.getAttribute("data-workspace");
  const node = [...root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,[role="heading"]')]
    .find(candidate => visible(candidate) && text(candidate) === heading);
  let notice = node?.parentElement;
  while (notice?.parentElement && !text(notice).includes(action)) notice = notice.parentElement;
  if (selected && notice) expect(text(notice), "Guidance identifies the selected room").toContain(selected);
  expect(text(root as Node), `Verbatim next action for ${heading}`).toContain(action);
  for (const [other] of STATE_COPY) if (other !== heading) expect(headings).not.toContain(other);
}
export function assertNotice(root: ParentNode, label: string, action: string, room: string) {
  const node = [...root.querySelectorAll<HTMLElement>("*")]
    .find(candidate => visible(candidate) && text(candidate) === label
      && ![...candidate.children].some(child => text(child) === label));
  expect(node, `Visible notice: ${label}`).toBeDefined();
  let notice = node!.parentElement;
  while (notice?.parentElement && !text(notice).includes(action)) notice = notice.parentElement;
  expect(text(notice!), `Verbatim action for ${label}`).toContain(action);
  expect(text(notice!), `Notice for selected room ${room}`).toContain(room);
}
export const REGISTRATION_LABELS = ["No harness connected", "No agents deployed", "Harness registration unknown", "Agent deployment unknown"];
export function assertSuppressed(root: Node) {
  for (const label of REGISTRATION_LABELS) expect(text(root)).not.toContain(label);
}
export function noExecutableText(root: ParentNode) {
  expect(root.querySelector("img,script,iframe,object,embed")).toBeNull();
  for (const node of root.querySelectorAll("*")) for (const attr of [...node.attributes]) {
    expect(attr.name).not.toMatch(/^on/i);
    if (/^(href|src|action|formaction|xlink:href)$/i.test(attr.name)) expect(attr.value.trim()).not.toMatch(/^javascript:/i);
  }
}
export function politeText(root: ParentNode): string {
  return [...root.querySelectorAll<HTMLElement>('[aria-live="polite"],[role="status"]')]
    .filter(visible).map(node => text(node)).join(" ");
}
