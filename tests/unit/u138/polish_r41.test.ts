// A-Q1: U148/U150 named non-article task roots retain their classes and identity hooks.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mountWall, type WallMountHandlers, type WallMountVM } from "../../../src/views";
import { startAgentWall } from "../../../src/app/agent_wall";
import {
  HOSTILE, activate, chipHeader, cleanup, clock, control, deterministic, frozenPlan, key,
  models, noExecutableLabels, roomFixture, swarmVM, taskCard, visible, visibleText, wallVM,
} from "./helpers";

deterministic();

function mount(vm: WallMountVM, handlers: WallMountHandlers = {}) {
  const host = document.createElement("div"); document.body.append(host);
  const handle = mountWall(host, vm, handlers); cleanup.push(() => handle.destroy());
  return { host, handle };
}
function fixture(fallback = false): WallMountVM {
  const p = frozenPlan(), vm = wallVM(p, swarmVM(p));
  if (!fallback) return vm;
  const { plan: _plan, ...rest } = vm;
  return rest;
}
function firstCard(host: HTMLElement): HTMLElement {
  const card = [...host.querySelectorAll<HTMLElement>(".task[data-task-id]")].find(visible);
  expect(card).toBeDefined(); return card!;
}

describe("U138p R41 Wall polish regressions", () => {
  it.each([false, true])("R41 removes per-task chat controls from the full mount (fallback=%s)", fallback => {
    const { host } = mount(fixture(fallback), { onOpenTask: vi.fn() });
    const cards = [...host.querySelectorAll<HTMLElement>(".task[data-task-id]")].filter(visible);
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.querySelector(".task-chat, [aria-label^='Open chat']")).toBeNull();
      expect([...card.querySelectorAll("button,a")].some(el => /chat/i.test(el.textContent ?? ""))).toBe(false);
    }
  });

  it("R41 read-only cards do not advertise a clickable chat target", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync("styles/views.css", "utf8");
    document.head.append(style); cleanup.push(() => style.remove());
    const { host } = mount(fixture());
    expect(getComputedStyle(firstCard(host)).cursor).not.toBe("pointer");
  });

  it.each([false, true])("R41 card/title/background and keyboard activation never route to chat (fallback=%s)", fallback => {
    const onOpenTask = vi.fn(), { host } = mount(fixture(fallback), { onOpenTask });
    const card = firstCard(host), title = card.querySelector<HTMLElement>(".task-title")!;
    for (const target of [card, title, card.querySelector<HTMLElement>(".task-head")!]) {
      target.click(); key(target, "Enter"); key(target, " ");
    }
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it("R41 the collapsed Messages entry is the only Wall chat route and survives refresh", () => {
    const f = roomFixture(); f.rooms.set("demo", frozenPlan());
    const wallHost = document.createElement("div"), chatHost = document.createElement("div");
    document.body.append(wallHost, chatHost);
    const post = vi.fn(async () => ({ ok: true as const, id: "e-000000000000ffff", lamport: 65535 }));
    const wall = startAgentWall({ wallHost, chatHost, store: f.store, clock, userAgent: "wall-user",
      link: { post }, reviewer: { review: async () => undefined }, initialView: "wall" });
    cleanup.push(() => wall.destroy());
    taskCard(wallHost, "T01").click();
    expect(chatHost.getAttribute("data-open")).not.toBe("true");
    const toggle = control(wallHost, "Messages (legacy)");
    expect(toggle.getAttribute("aria-expanded")).toBe("false"); activate(toggle);
    expect(visibleText(wallHost)).toContain("Use your harness to message agents");
    expect(visibleText(wallHost)).not.toContain("Select a task on Wall for legacy chat");
    activate(control(wallHost, "Open task messages"), " ");
    expect(chatHost.getAttribute("data-open")).toBe("true");
    wall.refresh(); expect(chatHost.getAttribute("data-open")).toBe("true");
    chatHost.querySelector<HTMLButtonElement>(".agent-chat-close")!.click();
    expect(chatHost.getAttribute("data-open")).toBe("false"); expect(post).not.toHaveBeenCalled();
  });

  it("V1 the plan roster has explicit readable separators in DOM text", () => {
    const { host } = mount(fixture()), roster = host.querySelector<HTMLElement>(".plan-agents")!;
    const names = [...roster.querySelectorAll<HTMLElement>(".agent-dot")].map(el => el.textContent!);
    expect(names.length).toBeGreaterThan(1);
    expect(roster.textContent).toBe(names.join(", "));
  });

  it("V2 a working task presents its owner/state once, beside its unchanged task ring", () => {
    const { host } = mount(fixture());
    const head = chipHeader(host, "T02", "executor-a", "Harness A", "Working");
    expect(head.querySelector(".assignee, .activity-label")).toBeNull();
    expect(head.querySelector(".status")).toBeNull();
    expect(head.textContent!.match(/executor-a/g)).toHaveLength(1);
    expect(head.textContent!.match(/Working/g)).toHaveLength(1);
    expect(head.querySelector(".status-icon")!.nextElementSibling?.classList.contains("wall-agent-chip")).toBe(true);
  });

  it("V2 task Waiting and agent Working remain distinct without a repeated assignee", () => {
    const { host } = mount(fixture());
    const head = chipHeader(host, "T03", "executor-a", "Harness A", "Working");
    expect(head.querySelector(".assignee, .activity-label")).toBeNull();
    expect(visibleText(head)).toContain("Task: Waiting");
    expect(taskCard(host, "T03").getAttribute("data-activity")).toBe("waiting");
    expect(visibleText(taskCard(host, "T03"))).toContain("Waiting on T90 · executor-c");
  });

  it.each([["done", "Done"], ["blocked", "Blocked"], ["waiting", "Needs input"]] as const)(
    "V2 keeps meaningful task lifecycle %s beside agent Working", (status, label) => {
      const vm = fixture();
      const tasks = vm.tasks.map(t => t.taskId === "T02" ? { ...t, status } : t);
      const { host } = mount({ ...vm, tasks });
      const head = chipHeader(host, "T02", "executor-a", "Harness A", "Working");
      expect(head.querySelector(".assignee, .activity-label")).toBeNull();
      expect(head.querySelector(".status")?.textContent).toBe(label);
    });

  it("V2 missing agent evidence preserves identity without claiming harness registration or liveness", () => {
    const p = frozenPlan(), { host } = mount(wallVM(p));
    const head = taskCard(host, "T02").querySelector<HTMLElement>(".task-head")!;
    expect(head.querySelector(".assignee, .activity-label")).toBeNull();
    expect(visibleText(head.querySelector(".wall-agent-chip")!)).toContain("executor-a");
    expect(visibleText(head)).toContain("Agent status unavailable");
    expect(visibleText(head)).not.toContain("Not registered by a harness");
  });

  it.each(["failed-agent", "finished-agent"])("V2 terminal %s chip keeps precedence over fresh work", owner => {
    const { host } = mount(fixture()), id = owner === "failed-agent" ? "T04" : "T05";
    const head = taskCard(host, id).querySelector<HTMLElement>(".task-head")!;
    expect(head.querySelector(".assignee, .activity-label")).toBeNull();
    expect(visibleText(head.querySelector(".wall-agent-chip")!)).toContain(owner === "failed-agent" ? "Failed" : "Finished");
    expect(visibleText(head)).toContain("Task: Working");
  });

  it.each(["unavailable", "ready", "downloading"] as const)("V4 Models has one honest status line for %s and one named opener", state => {
    const vm = fixture(), label = `Gemini Nano: ${state}. Rules is the active reviewer.`;
    const availability = `Device ${state} · Private room: cloud disabled`;
    const onOpenModels = vi.fn(), { host, handle } = mount({ ...vm, model: { state, label }, availability }, { onOpenModels });
    const line = host.querySelector<HTMLElement>(".model-health")!;
    expect(visibleText(line)).toContain("Models:");
    expect(visibleText(line)).toContain(label); expect(visibleText(line)).toContain(availability);
    expect(host.querySelector(".rules-line, .model-availability")).toBeNull();
    const opener = models(host); activate(opener);
    expect(onOpenModels).toHaveBeenCalledExactlyOnceWith(opener);
    opener.focus(); handle.update({ ...vm, model: { state, label }, availability });
    expect(document.activeElement).toBe(models(host));
  });

  it("V4 unavailable default and hostile supplied status stay literal on refresh", () => {
    const vm = fixture(), { host, handle } = mount({ ...vm, model: { state: "unavailable", label: "" } });
    expect(visibleText(host.querySelector(".model-health")!)).toContain("Models: on-device unavailable");
    handle.update({ ...vm, model: { state: "unavailable", label: HOSTILE }, availability: HOSTILE });
    const line = host.querySelector<HTMLElement>(".model-health")!;
    expect(line.textContent).toContain(HOSTILE); expect(line.querySelector("img")).toBeNull();
    noExecutableLabels(host);
  });

  it.each(["ready", "downloading"] as const)("V4 an empty %s label never claims the device is unavailable", state => {
    const { host } = mount({ ...fixture(), model: { state, label: "" } });
    const line = host.querySelector<HTMLElement>(".model-health")!;
    expect(visibleText(line)).toContain("Models:");
    expect(visibleText(line)).toContain(state);
    expect(visibleText(line)).not.toMatch(/not available|unavailable/i);
    expect(visibleText(line)).toContain("Rules");
  });
});
