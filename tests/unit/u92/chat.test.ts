import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountAgentChat } from "../../../src/agentsui";
import type { AgentChatHandle } from "../../../src/agentsui/types";
import { baseVM, draft, element, hasDraftSeam, HOSTILE, HOSTILE_CODE, keyboardActivate, message,
  RAW, settle, submit, typeDraft, watchAnnouncements } from "./helpers";
import type { Delivery, Handlers, Message } from "./helpers";

let handle: AgentChatHandle | undefined;
afterEach(() => { handle?.destroy(); handle = undefined; vi.restoreAllMocks(); document.body.replaceChildren(); });
function mount(messages: readonly Message[] = [], sending = false) {
  const host = document.createElement("div"); document.body.append(host);
  const handlers: Handlers = { onSend: vi.fn(), onRetry: vi.fn() };
  handle = mountAgentChat(host, baseVM(messages, sending), handlers);
  return { host, handlers, handle };
}
function loadStyles(): void {
  const style = document.createElement("style");
  style.textContent = readFileSync(resolve("styles/agents.css"), "utf8");
  document.body.append(style);
}
const probe = mountAgentChat(document.createElement("div"), baseVM());
const S1_AVAILABLE = hasDraftSeam(probe);
probe.destroy();

describe("U92 composer and additive delivery view", () => {
  it.each(["form", "ctrlKey", "metaKey"] as const)("A1 %s retains the raw draft while submitting trimmed text", via => {
    const h = mount(); typeDraft(h.host, RAW); submit(h.host, via);
    expect(h.handlers.onSend).toHaveBeenCalledExactlyOnceWith("Explain this");
    expect(draft(h.host), "do not clear before persistence acknowledgement").toBe(RAW);
  });

  const states: Array<[Delivery, string]> = [
    [{ client_id: "opaque-c1", state: "sending" }, "Sending"],
    [{ client_id: "opaque-c1", state: "delivered", event_id: "e-receipt", lamport: 42 }, "Delivered"],
    [{ client_id: "opaque-c1", state: "failed", code: "bad_request" }, "Failed"],
    [{ client_id: "opaque-c1", state: "unknown", code: "timeout" }, "Delivery unknown"],
  ];
  it.each(states)("A1/A2/A3/A4 exposes delivery metadata and literal status: %j", (delivery, label) => {
    const h = mount([message(delivery)], delivery.state === "sending");
    const entry = element(h.host, '[data-client-id="opaque-c1"]');
    expect(entry.dataset.delivery).toBe(delivery.state);
    expect(element(entry, ".chat-delivery").textContent).toContain(label);
    if (delivery.state === "delivered") {
      expect(element(entry, ".chat-delivery").textContent).toContain("e-receipt");
      expect(element(entry, ".chat-delivery").textContent).toMatch(/\b42\b/);
      expect(entry.textContent).not.toMatch(/\b(read|answered|applied)\b/i);
    }
    if (delivery.state === "failed") expect(element(entry, ".chat-delivery").textContent).toContain(delivery.code);
  });

  it("M2 legacy messages acquire no inferred receipt, read status or Retry", () => {
    const h = mount([message()]);
    expect(h.host.querySelectorAll(".chat-msg")).toHaveLength(1);
    expect(h.host.querySelector("[data-delivery], [data-client-id], .chat-delivery, .chat-retry")).toBeNull();
    expect(h.host.textContent).not.toMatch(/\b(delivered|sending|read|answered|applied)\b/i);
  });

  it("A3/A7 failed entries provide a focusable native Retry and emit the original client id", () => {
    const h = mount([message({ client_id: "opaque-c1", state: "failed", code: "bad_request" })]);
    const retry = element<HTMLButtonElement>(h.host, "button.chat-retry");
    expect(retry.textContent).toContain("Retry"); expect(retry.disabled).toBe(false); expect(retry.tabIndex).toBeGreaterThanOrEqual(0);
    keyboardActivate(retry);
    expect(h.handlers.onRetry).toHaveBeenCalledExactlyOnceWith("opaque-c1");
    expect(h.handlers.onSend).not.toHaveBeenCalled();
  });

  it.each(["sending", "delivered", "unknown"] as const)("A4/M6 %s never enables Retry", state => {
    const delivery: Delivery = state === "delivered" ? { client_id: "c1", state, event_id: "e1", lamport: 1 } :
      state === "unknown" ? { client_id: "c1", state, code: "timeout" } : { client_id: "c1", state };
    const h = mount([message(delivery)], state === "sending");
    expect(element(h.host, "[data-client-id]").dataset.delivery).toBe(state);
    for (const retry of h.host.querySelectorAll<HTMLButtonElement>("button.chat-retry")) expect(retry.disabled).toBe(true);
  });

  it("A6 renders hostile message and failure code as literal text nodes", () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const h = mount([{ ...message({ client_id: "c1", state: "failed", code: HOSTILE_CODE }), text: HOSTILE }]);
    expect(element(h.host, ".chat-text").textContent).toBe(HOSTILE);
    expect(element(h.host, ".chat-delivery").textContent).toContain(HOSTILE_CODE);
    expect(h.host.querySelector("img, svg, script, [onerror], [onload]")).toBeNull(); expect(alert).not.toHaveBeenCalled();
  });

  it("A6 renders a hostile receipt id literally", () => {
    const h = mount([message({ client_id: "c1", state: "delivered", event_id: HOSTILE_CODE, lamport: 42 })]);
    expect(element(h.host, ".chat-delivery").textContent).toContain(HOSTILE_CODE);
    expect(h.host.querySelector("svg, script, [onload]")).toBeNull();
  });

  it.each(["form", "ctrlKey", "metaKey"] as const)("A6 %s blocks whitespace and over-limit UTF-8 without truncating a valid boundary draft", via => {
    const h = mount();
    for (const text of [" \n\t ", "😀".repeat(1025)]) {
      typeDraft(h.host, text); submit(h.host, via); expect(h.handlers.onSend).not.toHaveBeenCalled();
      expect(draft(h.host)).toBe(text);
    }
    const text = "😀".repeat(1024); typeDraft(h.host, text); submit(h.host, via);
    expect(h.handlers.onSend).toHaveBeenCalledExactlyOnceWith(text);
  });

  it("A7 repeated identical VM updates do not duplicate messages", () => {
    const vm = baseVM([message({ client_id: "c1", state: "delivered", event_id: "e1", lamport: 1 })]);
    const h = mount(vm.messages); h.handle.update(vm); h.handle.update(structuredClone(vm));
    expect(h.host.querySelectorAll(".chat-msg")).toHaveLength(1);
    expect(h.host.querySelectorAll("[data-client-id]")).toHaveLength(1);
  });

  it("A7 delivery transitions are polite and unchanged history is not announced again", async () => {
    const h = mount(); const live = watchAnnouncements(h.host);
    try {
      h.handle.update(baseVM([message({ client_id: "c1", state: "sending" })], true)); await settle();
      expect(live.take().join(" ")).toContain("Sending");
      const delivered = baseVM([message({ client_id: "c1", state: "delivered", event_id: "e1", lamport: 42 })]);
      h.handle.update(delivered); await settle(); expect(live.take().join(" ")).toContain("Delivered");
      h.handle.update(structuredClone(delivered)); await settle(); expect(live.take()).toEqual([]);
      expect(h.host.querySelector('[aria-live="assertive"]')).toBeNull();
    } finally { live.disconnect(); }
  });

  it("M7 long receipts wrap and native Retry has a visible keyboard focus rule", () => {
    loadStyles();
    const h = mount([message({ client_id: "c1", state: "failed", code: "x".repeat(512) })]);
    const status = element(h.host, ".chat-delivery");
    const wrapping = [status, ...status.querySelectorAll<HTMLElement>("*"), status.parentElement!].some(node => {
      const css = getComputedStyle(node);
      return ["anywhere", "break-word"].includes(css.overflowWrap) || css.wordBreak === "break-all";
    });
    expect(wrapping, "receipt/error tokens must wrap").toBe(true);
    const retry = element<HTMLButtonElement>(h.host, "button.chat-retry"); retry.focus();
    expect(document.activeElement).toBe(retry);
    const css = getComputedStyle(retry);
    expect(Boolean(css.outline && !/^(none|0(?:px)?)$/.test(css.outline)) || Boolean(css.boxShadow && css.boxShadow !== "none"),
      "Retry must expose a visible focus indicator").toBe(true);
  });

  it("M7 long event ids have wrapping styles without truncating receipt text", () => {
    loadStyles(); const id = "e-" + "x".repeat(512);
    const h = mount([message({ client_id: "c1", state: "delivered", event_id: id, lamport: 42 })]);
    const status = element(h.host, ".chat-delivery"); expect(status.textContent).toContain(id);
    const nodes = [status, ...status.querySelectorAll<HTMLElement>("*"), status.parentElement!];
    expect(nodes.some(node => {
      const css = getComputedStyle(node);
      return ["anywhere", "break-word"].includes(css.overflowWrap) || css.wordBreak === "break-all";
    }), "long receipt must wrap").toBe(true);
  });
});

describe.skipIf(!S1_AVAILABLE)("U86 prerequisite: preserved S1 (out of scope when absent)", () => {
  it("A7 setDraft/getDraft preserve raw text, never send, and retain destroyed-handle semantics", () => {
    const h = mount(); if (!hasDraftSeam(h.handle)) throw new Error("prerequisite changed during the run");
    h.handle.setDraft(RAW); expect(h.handle.getDraft()).toBe(RAW); expect(h.handlers.onSend).not.toHaveBeenCalled();
    submit(h.host); expect(h.handle.getDraft()).toBe(RAW);
    h.handle.update(baseVM([message({ client_id: "c1", state: "sending" })], true));
    h.handle.setDraft("new draft"); expect(h.handle.getDraft()).toBe("new draft");
    expect(h.handlers.onSend).toHaveBeenCalledTimes(1);
    const api = h.handle;
    api.destroy(); expect(() => api.setDraft("ignored")).not.toThrow(); expect(api.getDraft()).toBe("");
  });
});
