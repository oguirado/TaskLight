import { expect } from "vitest";
import { createAgentStore } from "../../../src/app/agent_store";
import type { RoomEvent, RoomOpBody } from "../../../src/agents/types";
import type { AgentChatHandle, AgentChatHandlers, AgentChatVM, ChatMessageVM } from "../../../src/agentsui/types";

// Structural additions allow fail-first runtime assertions before U92 lands.
export type Delivery = { client_id: string } & (
  | { state: "sending" }
  | { state: "delivered"; event_id: string; lamport: number }
  | { state: "failed"; code: string }
  | { state: "unknown"; code: string }
);
export type Message = ChatMessageVM & { delivery?: Delivery };
export type ChatVM = Omit<AgentChatVM, "messages"> & { messages: readonly Message[]; task?: { id: string; assignee: string | null } };
export type Handlers = AgentChatHandlers & { onRetry?(client_id: string): void };
export type DraftHandle = AgentChatHandle & { setDraft(text: string): void; getDraft(): string };
export const NOW = 1_700_000_001_000;
export const RAW = "  Explain this  ";
export const REQUEST = { room: "demo", to: "executor-a", text: "Explain this" };
export const RECEIPT = { ok: true, id: "e-receipt", lamport: 42 } as const;
export const HOSTILE = "<img src=x onerror=alert(1)>";
export const HOSTILE_CODE = "<svg onload=alert(1)>";

export function baseVM(messages: readonly Message[] = [], sending = false): ChatVM {
  return { room: "demo", agent: "executor-a", title: "Explain task", silent: false, sending, messages };
}
export function message(delivery?: Delivery): Message {
  return { id: "local-entry", from: "user", agent: "wall-user", text: "Explain this", at: "now",
    ...(delivery ? { delivery } : {}) };
}
export function element<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T>(selector);
  expect(node, `expected rendered ${selector}`).not.toBeNull();
  return node!;
}
export const draft = (root: ParentNode): string => element<HTMLTextAreaElement>(root, "textarea").value;
export function typeDraft(root: ParentNode, text: string): void {
  const input = element<HTMLTextAreaElement>(root, "textarea");
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
export function submit(root: ParentNode, via: "form" | "ctrlKey" | "metaKey" = "form"): void {
  if (via === "form") element(root, "form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  else element(root, "textarea").dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter", [via]: true, bubbles: true, cancelable: true,
  }));
}
// jsdom does not implement browser keyboard default actions. This is the native
// detail=0 click emitted by Enter/Space, after keyboard focus and key events.
export function keyboardActivate(button: HTMLButtonElement): void {
  button.focus();
  expect(document.activeElement).toBe(button);
  button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  button.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
  if (!button.disabled) button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
}
export function hasDraftSeam(handle: AgentChatHandle): handle is DraftHandle {
  const candidate = handle as Partial<DraftHandle>;
  return typeof candidate.setDraft === "function" && typeof candidate.getDraft === "function";
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
export function fixture() {
  const store = createAgentStore();
  let seq = 0;
  function event(room: string, agent: string, act: RoomEvent["act"], text: string, extra: Partial<RoomEvent> = {}) {
    seq += 1;
    const ev: RoomEvent = { id: `e-${seq.toString(16).padStart(16, "0")}`, room, agent, act, text,
      ts: NOW - 100 + seq, lamport: seq, ...extra };
    expect(store.ingest(ev), "valid fixture event").toBe(true);
    return ev;
  }
  const op = (room: string, body: RoomOpBody, agent = "plan-owner") => {
    event(room, agent, "op", "", { op: body });
    expect(store.plan(room)?.projection.rejected, "valid fixture operation").toEqual([]);
  };
  const openPlan = (room = "demo") => op(room, { kind: "plan.open", title: "Explain plan", template_id: "neutral",
    template_hash: "a".repeat(64), brief: { goal: "Explain this" }, phase: "start" });
  const task = (assignee: string | null = "executor-a", room = "demo") => op(room, {
    kind: "task.add", title: "Explain task", type: "action", phase: "start", accept: "Explanation supplied", assignee,
    microtasks: [{ text: "Explain", accept: "Explanation exists" }],
  });
  const legacy = (agent: string, room = "demo") => event(room, agent, "plan", "Explain task", {
    plan: { title: "Explain task", steps: [{ text: "Explain" }] },
  });
  return { store, event, op, openPlan, task, legacy };
}

/** Observe textual mutations in active polite regions, without prescribing
 * whether the implementation uses the log or a separate status region. */
export function watchAnnouncements(host: HTMLElement) {
  const records: MutationRecord[] = [];
  const observer = new MutationObserver(batch => records.push(...batch));
  observer.observe(host, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["aria-live"], attributeOldValue: true });
  const take = (): string[] => {
    const batch = [...records.splice(0), ...observer.takeRecords()];
    const silenced = new Set(batch.filter(r => r.type === "attributes" && r.oldValue === "off").map(r => r.target));
    return batch.flatMap(r => {
      if (r.type === "attributes") return [];
      const target = r.target instanceof Element ? r.target : r.target.parentElement;
      const region = target?.closest('[aria-live], [role="log"], [role="status"]');
      if (!region || region.getAttribute("aria-live") === "off" || region.getAttribute("aria-live") === "assertive" ||
          silenced.has(region)) return [];
      const text = r.type === "characterData" ? r.target.textContent ?? "" :
        [...r.addedNodes, ...r.removedNodes].map(n => n.textContent ?? "").join(" ");
      return text.trim() ? [text] : [];
    });
  };
  return { take, disconnect: () => observer.disconnect() };
}
