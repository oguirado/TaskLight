import { expect } from "vitest";
import { createAgentStore } from "../../../src/app/agent_store";
import type { RoomEvent, RoomOpBody } from "../../../src/agents/types";

export const NOW = 1_700_000_001_000;
export const HOSTILE = "<img src=x onerror=alert(1)>";

/** Real store input; op-only plans deliberately create no legacy AgentState. */
export function fixture() {
  const store = createAgentStore();
  let seq = 0;
  const event = (room: string, agent: string, act: RoomEvent["act"], text: string, extra: Partial<RoomEvent> = {}) => {
    seq += 1;
    const ev: RoomEvent = { id: `e-${seq.toString(16).padStart(16, "0")}`, lamport: seq,
      ts: NOW - 100 + seq, room, agent, act, text, ...extra };
    expect(store.ingest(ev), "fixture event must be accepted").toBe(true);
    return ev;
  };
  const op = (room: string, body: RoomOpBody, agent = "plan-owner") => {
    event(room, agent, "op", "", { op: body });
    expect(store.plan(room)?.projection.rejected, "fixture op must fold successfully").toEqual([]);
  };
  const open = (room = "demo") => {
    op(room, { kind: "plan.open", title: "Work plan", template_id: "neutral",
      template_hash: "a".repeat(64), brief: { goal: "Export data" }, phase: "start" });
    expect(store.plan(room)?.projection.plan).toMatchObject({ id: "p1", state: "active" });
  };
  const task = (assignee: string | null = "worker-a", title = "Export CSV", room = "demo") => {
    op(room, { kind: "task.add", title, type: "action", phase: "start", accept: "Export verified", assignee,
      microtasks: [{ text: "Export data", accept: "CSV exists" }] });
  };
  const legacy = (agent: string, room = "demo", title = `${agent} legacy task`) => {
    event(room, agent, "plan", title, { plan: { title, steps: [{ text: "Inspect export" }] } });
  };
  return { store, event, op, open, task, legacy };
}

export function element<T extends HTMLElement = HTMLElement>(host: ParentNode, selector: string): T {
  const found = host.querySelector<T>(selector);
  expect(found, `expected rendered ${selector}`).not.toBeNull();
  return found!;
}

/** Only visible text nodes count as identification, not data-* or aria-label. */
export function visibleText(root: Node): string {
  if (root instanceof HTMLElement && (root.hidden || root.getAttribute("aria-hidden") === "true" ||
      root.style.display === "none" || root.style.visibility === "hidden")) return "";
  if (root.nodeType === Node.TEXT_NODE) return root.textContent ?? "";
  return [...root.childNodes].map(visibleText).join(" ");
}

export function typeDraft(host: HTMLElement, text: string): void {
  const input = element<HTMLTextAreaElement>(host, "textarea");
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
export function submit(host: HTMLElement): void {
  element<HTMLFormElement>(host, "form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}
export function shortcut(host: HTMLElement, modifier: "ctrlKey" | "metaKey"): void {
  element<HTMLTextAreaElement>(host, "textarea").dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter", [modifier]: true, bubbles: true, cancelable: true,
  }));
}
