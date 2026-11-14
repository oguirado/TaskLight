import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, click, input, key, log, mount, mountSpied, q, qa, sendBtn, type } from "./helpers";
import { DRIFT, FIXTURE, MESSAGES, SILENT } from "./fixture";
import { mountAgentChat } from "../../../src/agentsui";

afterEach(cleanup);

/** Stubs scrollTop/scrollHeight/clientHeight on the element instance; scrollHeight grows 100px per <li>. */
function stubScroll(el: HTMLElement, client = 300): { top: () => number; set: (n: number) => void; height: () => number; client: number } {
  let top = 0;
  const height = () => 100 * el.querySelectorAll("li").length;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: height });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => client });
  Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { top = v; } });
  return { top: () => top, set: (n) => { top = n; }, height, client };
}
const more = { ...FIXTURE, messages: [...MESSAGES, { id: "m6", from: "agent" as const, agent: "Atlas", text: "New message", at: "09:20" }] };

describe("U35 C7 log scroll", () => {
  it("at the bottom before update: stays pinned to the bottom after new messages", () => {
    const { host, handle } = mount();
    const l = log(host);
    const s = stubScroll(l);
    s.set(s.height() - s.client); // exactly at bottom
    handle.update(more);
    expect(log(host)).toBe(l); // same element instance (scroll state lives there)
    expect(s.height()).toBe(600);
    expect(s.top()).toBeGreaterThanOrEqual(s.height() - s.client);
  });

  it("at the bottom, update without new messages keeps it at the bottom", () => {
    const { host, handle } = mount();
    const s = stubScroll(log(host));
    s.set(s.height() - s.client);
    handle.update({ ...FIXTURE });
    expect(s.top()).toBeGreaterThanOrEqual(s.height() - s.client);
  });

  it("scrolled away from the bottom: position is preserved after new messages", () => {
    const { host, handle } = mount();
    const s = stubScroll(log(host));
    s.set(40);
    handle.update(more);
    expect(s.top()).toBe(40);
  });

  it("scrolled to the very top (0) is preserved", () => {
    const { host, handle } = mount();
    const s = stubScroll(log(host));
    s.set(0);
    handle.update(more);
    expect(s.top()).toBe(0);
  });

  it("the decision uses the position before the DOM changes (several consecutive updates)", () => {
    const { host, handle } = mount();
    const s = stubScroll(log(host));
    s.set(s.height() - s.client);
    handle.update(more);
    const t1 = s.top();
    expect(t1).toBeGreaterThanOrEqual(s.height() - s.client);
    s.set(10); // user scrolls up
    handle.update(FIXTURE);
    expect(s.top()).toBe(10);
  });
});

describe("U35 C8 lifecycle", () => {
  it("draft text survives update() and the textarea element is the same instance", () => {
    const { host, handle } = mount();
    const t = type(host, "half-written\nthought");
    handle.update(more);
    handle.update(SILENT);
    handle.update(DRIFT);
    expect(input(host)).toBe(t);
    expect(t.value).toBe("half-written\nthought");
  });

  it("focus on the textarea survives update()", () => {
    const { host, handle } = mount();
    input(host).focus();
    expect(document.activeElement).toBe(input(host));
    handle.update(more);
    expect(document.activeElement).toBe(input(host));
  });

  it("updates do not leak or duplicate listeners: one click still sends once after many updates", () => {
    const { host, handle, spies } = mountSpied();
    for (let i = 0; i < 5; i++) handle.update(i % 2 ? more : FIXTURE);
    type(host, "once");
    click(sendBtn(host));
    expect(spies.onSend).toHaveBeenCalledTimes(1);
    handle.update(SILENT);
    click(q(host, "button.chat-escalate"));
    expect(spies.onEscalate).toHaveBeenCalledTimes(1);
    click(q(host, "button.agent-chat-close"));
    expect(spies.onClose).toHaveBeenCalledTimes(1);
    type(host, "again");
    key(input(host), "Enter", { ctrlKey: true });
    expect(spies.onSend).toHaveBeenCalledTimes(2);
  });

  it("destroy() empties the host and is idempotent", () => {
    const { host, handle } = mount();
    handle.destroy();
    expect(host.childNodes.length).toBe(0);
    expect(() => handle.destroy()).not.toThrow();
    expect(host.childNodes.length).toBe(0);
  });

  it("calls after destroy() are no-ops: update does not re-render or throw", () => {
    const { host, handle } = mount();
    handle.destroy();
    expect(() => handle.update(SILENT)).not.toThrow();
    expect(() => handle.update(more)).not.toThrow();
    expect(host.childNodes.length).toBe(0);
  });

  it("detached elements no longer trigger handlers after destroy()", () => {
    const { host, handle, spies } = mountSpied(SILENT);
    const t = type(host, "pending");
    const send = sendBtn(host), esc = q(host, "button.chat-escalate"), close = q(host, "button.agent-chat-close"), sug = q(host, "button.chat-suggest");
    handle.destroy();
    key(t, "Enter", { ctrlKey: true });
    for (const b of [send, esc, close, sug]) click(b);
    t.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(spies.onSend).not.toHaveBeenCalled();
    expect(spies.onEscalate).not.toHaveBeenCalled();
    expect(spies.onClose).not.toHaveBeenCalled();
    expect(spies.onSuggest).not.toHaveBeenCalled();
  });

  it("destroy() removes every listener that mount/update added (add/remove spy)", () => {
    type Rec = { target: unknown; type: string; fn: unknown; capture: boolean; signal: AbortSignal | undefined };
    const adds: Rec[] = [], removes: Rec[] = [];
    const proto = window.EventTarget.prototype;
    const cap = (o: unknown): boolean => (typeof o === "boolean" ? o : !!(o as { capture?: boolean } | undefined)?.capture);
    const sig = (o: unknown): AbortSignal | undefined => (typeof o === "object" && o !== null ? (o as { signal?: AbortSignal }).signal : undefined);
    const origAdd = proto.addEventListener, origRemove = proto.removeEventListener;
    vi.spyOn(proto, "addEventListener").mockImplementation(function (this: EventTarget, t: string, fn: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions) {
      adds.push({ target: this, type: t, fn, capture: cap(o), signal: sig(o) });
      return origAdd.call(this, t, fn, o);
    });
    vi.spyOn(proto, "removeEventListener").mockImplementation(function (this: EventTarget, t: string, fn: EventListenerOrEventListenerObject | null, o?: boolean | EventListenerOptions) {
      removes.push({ target: this, type: t, fn, capture: cap(o), signal: undefined });
      return origRemove.call(this, t, fn, o);
    });
    // control: the spy really observes listener registration
    document.createElement("i").addEventListener("x", () => undefined);
    expect(adds.length).toBe(1);
    adds.length = 0;

    const { host, handle } = mount(SILENT);
    handle.update(DRIFT);
    handle.update(more);
    expect(adds.length).toBeGreaterThan(0);
    handle.destroy();
    const dangling = adds.filter((a) => !(a.signal?.aborted) && !removes.some((r) => r.target === a.target && r.type === a.type && r.fn === a.fn && r.capture === a.capture));
    expect(dangling.map((d) => d.type)).toEqual([]);
    expect(host.childNodes.length).toBe(0);
  });

  it("document-level listeners (if any) are removed: no listener added to document/window survives destroy()", () => {
    const docAdds: string[] = [], docRemoves: string[] = [];
    const oa = document.addEventListener.bind(document), or = document.removeEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation((t: string, f: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions) => { docAdds.push(t); oa(t, f, o); });
    vi.spyOn(document, "removeEventListener").mockImplementation((t: string, f: EventListenerOrEventListenerObject, o?: boolean | EventListenerOptions) => { docRemoves.push(t); or(t, f, o); });
    const { handle } = mount();
    handle.update(SILENT);
    handle.destroy();
    for (const t of docAdds) expect(docRemoves).toContain(t);
  });

  it("two instances: destroying one leaves the other fully working", () => {
    const a = mountSpied(), b = mountSpied();
    a.handle.destroy();
    type(b.host, "still alive");
    click(sendBtn(b.host));
    expect(b.spies.onSend).toHaveBeenCalledWith("still alive");
    expect(a.host.childNodes.length).toBe(0);
  });

  it("host siblings and the host itself are untouched by destroy()", () => {
    const { host, handle } = mount();
    const sib = document.createElement("p");
    host.parentElement?.appendChild(sib);
    handle.destroy();
    expect(host.isConnected).toBe(true);
    expect(sib.isConnected).toBe(true);
  });

  it("remounting after destroy on the same host works", () => {
    const { host, handle } = mount();
    handle.destroy();
    const h2 = mountAgentChat(host, FIXTURE);
    expect(qa(host, "section.agent-chat").length).toBe(1);
    h2.destroy();
    expect(host.childNodes.length).toBe(0);
  });
});
