import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { startAgentWall } from "../../../src/app/agent_wall";
import { createAgentStore, toWallVM } from "../../../src/app/agent_store";
import { resolveStarterTemplate } from "../../../src/app/starter_templates";
import { mountWall } from "../../../src/views";
import type { Clock } from "../../../src/app/types";
import type { WallVM, WallHandlers } from "../../../src/views/types";
import { event, opening, template, NOW } from "../u67/helpers";

const cleanups: (() => void)[] = [];
export function setup() {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    localStorage.clear(); document.documentElement.removeAttribute("data-theme");
    // Unexpected I/O is a test failure, never a real request.
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden in U78 oracle"); }));
    const style = document.createElement("style"); style.dataset.u78 = "true";
    style.textContent = ["tokens", "wall", "views", "agents", "plan", "model_selector"]
      .map(name => readFileSync(resolve(__dirname, `../../../styles/${name}.css`), "utf8")).join("\n");
    document.head.append(style);
  });
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    document.body.replaceChildren(); document.head.querySelectorAll("[data-u78]").forEach(n => n.remove());
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllTimers(); vi.useRealTimers();
    localStorage.clear(); document.documentElement.removeAttribute("data-theme");
  });
}
export function storeFixture({ completed = false, cancelled = false, legacy = false } = {}) {
  const t = template(); const store = createAgentStore({ templates: resolveStarterTemplate });
  expect(store.ingest(event(1, opening(t)))).toBe(true);
  for (let i = 0; i < 5; i++) {
    expect(store.ingest(event(i + 2, { kind: "task.add", title: `Work ${i + 1}`, type: t.task_types[0]!.id,
      phase: i % 2 ? "build" : "discovery", accept: "Verified", microtasks: [{ text: "Verify", accept: "Verified" }] }))).toBe(true);
  }
  if (completed) expect(store.ingest(event(7, { kind: "micro.set", micro_id: "T01.M01", state: "done", outcome: "Verified" }))).toBe(true);
  if (cancelled) expect(store.ingest(event(8, { kind: "task.set", task_id: "T02", base_rev: 3, state: "cancelled" }))).toBe(true);
  if (legacy) {
    // close_task's browser-facing event is act: close, not a new act named close_task.
    expect(store.ingest({ ...event(20, {}), act: "plan", agent: "legacy", plan: { title: "Old work", steps: [{ text: "Finish" }] }, op: undefined })).toBe(true);
    expect(store.ingest({ ...event(21, {}), act: "close", agent: "legacy", text: "Finished", op: undefined })).toBe(true);
    expect(store.states().find(s => s.agent === "legacy")?.closed).toBe(true);
  }
  expect(store.plan("oracle")?.projection.rejected).toHaveLength(0);
  return store;
}
export function vm(store = storeFixture()): WallVM {
  return toWallVM(store.states(), new Map(), { nowMs: NOW, model: { state: "unavailable", label: "" }, network: "offline", userAgent: "human" }, store.plans());
}
export function mounted(value = vm(), handlers?: WallHandlers) {
  const host = document.createElement("div"); document.body.append(host);
  const handle = mountWall(host, value, handlers); cleanups.push(() => handle.destroy());
  return { host, handle };
}
export function running(store = storeFixture(), neverSettles = false) {
  const host = document.createElement("div"), chat = document.createElement("div"); document.body.append(host, chat);
  const clock: Clock = { now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: id => window.clearTimeout(id),
    setInterval: (fn, ms) => window.setInterval(fn, ms), clearInterval: id => window.clearInterval(id) };
  const review = vi.fn(() => neverSettles ? new Promise<undefined>(() => {}) : Promise.resolve(undefined));
  const post = vi.fn(async () => ({ ok: true as const, id: "e-00000000000000ff", lamport: 255 }));
  const wall = startAgentWall({ wallHost: host, chatHost: chat, clock, store, userAgent: "human", link: { post }, reviewer: { review } });
  cleanups.push(() => wall.destroy()); return { host, chat, wall, post };
}
export function q(root: ParentNode, selector: string): HTMLElement {
  const node = root.querySelector<HTMLElement>(selector); expect(node, `Missing ${selector}`).not.toBeNull(); return node!;
}
export function button(root: ParentNode, name: RegExp): HTMLElement {
  const node = [...root.querySelectorAll<HTMLElement>('button, [role="button"]')]
    .find(n => name.test(n.getAttribute("aria-label") ?? n.textContent ?? ""));
  expect(node, `Missing control ${name}`).toBeDefined(); return node!;
}
export function visible(root: HTMLElement): string {
  if (root.hidden || root.getAttribute("aria-hidden") === "true" || getComputedStyle(root).display === "none") return "";
  return [...root.childNodes].map(n => n instanceof HTMLElement ? visible(n) : n.textContent ?? "").join(" ");
}
export const memoryText = `First decision\nSecond decision\n${"x".repeat(200)}`;
export const memory = { sections: [{ id: "decisions", label: "Decisions", text: memoryText, rev: 12, by: "builder", changedAt: "09:00", required: true, empty: false, maxChars: 2000 }] };
