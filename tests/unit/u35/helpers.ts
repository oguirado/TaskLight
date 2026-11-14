import { vi, type Mock } from "vitest";
import { mountAgentChat } from "../../../src/agentsui";
import type { AgentChatHandle, AgentChatHandlers, AgentChatVM } from "../../../src/agentsui/types";
import { FIXTURE } from "./fixture";

export interface Spies {
  onSend: Mock<(t: string) => void>;
  onSuggest: Mock<() => void>;
  onEscalate: Mock<() => void>;
  onAcceptDrift: Mock<() => void>;
  onClose: Mock<() => void>;
}
export const makeSpies = (): Spies => ({
  onSend: vi.fn<(t: string) => void>(),
  onSuggest: vi.fn<() => void>(),
  onEscalate: vi.fn<() => void>(),
  onAcceptDrift: vi.fn<() => void>(),
  onClose: vi.fn<() => void>(),
});
export const totalCalls = (s: Spies): number =>
  s.onSend.mock.calls.length + s.onSuggest.mock.calls.length + s.onEscalate.mock.calls.length +
  s.onAcceptDrift.mock.calls.length + s.onClose.mock.calls.length;

const live: { host: HTMLElement; handle: AgentChatHandle }[] = [];

export function mount(v: AgentChatVM = FIXTURE, handlers?: AgentChatHandlers): { host: HTMLElement; handle: AgentChatHandle } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const handle = mountAgentChat(host, v, handlers);
  live.push({ host, handle });
  return { host, handle };
}
export function mountSpied(v: AgentChatVM = FIXTURE): { host: HTMLElement; handle: AgentChatHandle; spies: Spies } {
  const spies = makeSpies();
  return { ...mount(v, spies), spies };
}
export function cleanup(): void {
  for (const l of live.splice(0)) {
    try { l.handle.destroy(); } catch { /* stub */ }
    l.host.remove();
  }
  vi.restoreAllMocks();
  document.body.replaceChildren();
}

export function q<T extends Element = HTMLElement>(root: ParentNode, sel: string): T {
  const e = root.querySelector<T>(sel);
  if (!e) throw new Error(`missing element: ${sel}`);
  return e;
}
export const qa = <T extends Element = HTMLElement>(root: ParentNode, sel: string): T[] => Array.from(root.querySelectorAll<T>(sel));
export const nth = <T>(a: readonly T[], i: number): T => {
  const x = a[i];
  if (x === undefined) throw new Error(`missing index ${i} of ${a.length}`);
  return x;
};
export const txt = (e: Element | null | undefined): string => (e?.textContent ?? "").trim();
export const txts = (root: ParentNode, sel: string): string[] => qa(root, sel).map(txt);

export const click = (e: Element): void => { e.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); };
export const key = (target: EventTarget, k: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
};

export const section = (host: ParentNode) => q<HTMLElement>(host, "section.agent-chat");
export const input = (host: ParentNode) => q<HTMLTextAreaElement>(host, "textarea.chat-input");
export const sendBtn = (host: ParentNode) => q<HTMLButtonElement>(host, "button.chat-send");
export const suggestBtn = (host: ParentNode) => q<HTMLButtonElement>(host, "button.chat-suggest");
export const log = (host: ParentNode) => q<HTMLOListElement>(host, "ol.agent-chat-log");
export const counter = (host: ParentNode) => q<HTMLElement>(host, "span.chat-count");

/** Simulates the user typing: sets the value then fires `input`. */
export function type(host: ParentNode, value: string): HTMLTextAreaElement {
  const t = input(host);
  t.value = value;
  t.dispatchEvent(new Event("input", { bubbles: true }));
  return t;
}
export const submitForm = (host: ParentNode): Event => {
  const f = q<HTMLFormElement>(host, "form.agent-chat-composer");
  const ev = new Event("submit", { bubbles: true, cancelable: true });
  f.dispatchEvent(ev);
  return ev;
};

export const signature = (root: ParentNode): string =>
  qa<Element>(root, "*").map((e) => `${e.tagName.toLowerCase()}.${e.getAttribute("class") ?? ""}`).join("|");

export const utf8 = (s: string): number => new TextEncoder().encode(s).length;
