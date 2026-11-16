import { afterEach, describe, expect, it, vi } from "vitest";
import { mountAgentChat } from "../../../src/agentsui";
import type { AgentChatHandle, AgentChatVM } from "../../../src/agentsui/types";
import { element, HOSTILE, shortcut, submit, typeDraft, visibleText } from "./helpers";

type DraftHandle = AgentChatHandle & { setDraft(text: string): void; getDraft(): string };
type TaskChatVM = AgentChatVM & { task?: { id: string; assignee: string | null } };
let handle: AgentChatHandle | undefined;
afterEach(() => { handle?.destroy(); handle = undefined; vi.restoreAllMocks(); document.body.replaceChildren(); });

function mount(extra: Partial<TaskChatVM> = {}) {
  const host = document.createElement("div"); document.body.append(host);
  const handlers = { onSend: vi.fn(), onSuggest: vi.fn(), onEscalate: vi.fn(), onAcceptDrift: vi.fn(), onClose: vi.fn() };
  const vm: TaskChatVM = { room: "demo", agent: "worker-a", title: "Export CSV", messages: [], silent: false,
    sending: false, task: { id: "T01", assignee: "worker-a" }, ...extra };
  handle = mountAgentChat(host, vm, handlers);
  return { host, handlers, vm, handle };
}
function draftAPI(h: AgentChatHandle): DraftHandle {
  // Missing additive APIs fail as assertions on this revision, never as import or type errors.
  expect(h, "S1 setDraft must be on the public handle").toHaveProperty("setDraft", expect.any(Function));
  expect(h, "S1 getDraft must be on the public handle").toHaveProperty("getDraft", expect.any(Function));
  return h as DraftHandle;
}
function noHandlers(h: ReturnType<typeof mount>["handlers"]): void {
  for (const callback of Object.values(h)) expect(callback).not.toHaveBeenCalled();
}
function sendButton(host: HTMLElement): HTMLButtonElement { return element<HTMLButtonElement>(host, ".chat-send"); }


describe("A5 frozen S1 draft handle (M5)", () => {
  it("A5 setDraft replaces whitespace verbatim, updates count and eligibility, and invokes no handler", () => {
    const h = mount(); const api = draftAPI(h.handle);
    api.setDraft("old text"); api.setDraft("  review\nthis  ");
    expect(api.getDraft()).toBe("  review\nthis  ");
    expect(element<HTMLTextAreaElement>(h.host, "textarea").value).toBe("  review\nthis  ");
    // Preserve the existing counter's trimming-on-send semantics.
    expect(element(h.host, ".chat-count").textContent).toBe("11 / 4096");
    expect(sendButton(h.host).disabled).toBe(false); noHandlers(h.handlers);
    api.setDraft(""); expect(api.getDraft()).toBe("");
    expect(element(h.host, ".chat-count").textContent).toBe("0 / 4096");
    expect(sendButton(h.host).disabled).toBe(true); noHandlers(h.handlers);
  });

  it("A5 getDraft reads user edits and an ordinary update preserves the exact draft", () => {
    const h = mount(); const api = draftAPI(h.handle);
    typeDraft(h.host, "  user\nedit  "); expect(api.getDraft()).toBe("  user\nedit  ");
    h.handle.update({ ...h.vm, title: "Updated task title" });
    expect(api.getDraft()).toBe("  user\nedit  "); noHandlers(h.handlers);
  });

  it("A5 whitespace-only draft is retrievable but cannot send", () => {
    const h = mount(); const api = draftAPI(h.handle); api.setDraft(" \n\t ");
    expect(api.getDraft()).toBe(" \n\t "); expect(sendButton(h.host).disabled).toBe(true);
    submit(h.host); shortcut(h.host, "ctrlKey"); shortcut(h.host, "metaKey");
    expect(api.getDraft()).toBe(" \n\t "); noHandlers(h.handlers);
  });

  it("A5 destroyed handle makes setDraft harmless, getDraft empty and destruction repeatable", () => {
    const h = mount(); const api = draftAPI(h.handle); api.setDraft("retain before destroy");
    h.handle.destroy();
    expect(() => api.setDraft("ignored after destroy")).not.toThrow();
    expect(api.getDraft()).toBe(""); expect(() => h.handle.destroy()).not.toThrow();
    expect(() => h.handle.update(h.vm)).not.toThrow(); expect(api.getDraft()).toBe("");
    expect(h.host.childNodes).toHaveLength(0); noHandlers(h.handlers);
  });
});

describe("A6 hostile text and UTF-8 composer integrity (M6)", () => {
  it("A6 hostile title, message and setDraft render literal text without sending", () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const h = mount({ title: HOSTILE, messages: [{ id: "hostile-message", from: "agent", agent: "worker-a", text: HOSTILE, at: "09:00" }] });
    const api = draftAPI(h.handle); api.setDraft(HOSTILE);
    expect(element(h.host, ".agent-chat-title").textContent).toBe(HOSTILE);
    expect(element(h.host, ".chat-text").textContent).toBe(HOSTILE);
    expect(api.getDraft()).toBe(HOSTILE); expect(visibleText(h.host)).toContain(HOSTILE);
    expect(h.host.querySelector("img, script, [onerror]")).toBeNull(); expect(alert).not.toHaveBeenCalled();
    noHandlers(h.handlers);
  });

  it.each(["form", "ctrlKey", "metaKey"] as const)("A6 oversized setDraft stays editable and %s cannot send", entry => {
    const h = mount(); const api = draftAPI(h.handle); const draft = "😀".repeat(1025);
    api.setDraft(draft);
    expect(api.getDraft()).toBe(draft); expect(element(h.host, ".chat-count").textContent).toBe("4100 / 4096");
    expect(sendButton(h.host).disabled).toBe(true);
    const input = element<HTMLTextAreaElement>(h.host, "textarea");
    expect(input.disabled).toBe(false); expect(input.readOnly).toBe(false);
    if (entry === "form") submit(h.host); else shortcut(h.host, entry);
    expect(api.getDraft()).toBe(draft); noHandlers(h.handlers);
    typeDraft(h.host, "edited"); expect(api.getDraft()).toBe("edited"); expect(sendButton(h.host).disabled).toBe(false);
  });

  it("A6 setDraft at the exact UTF-8 limit sends once with trimming", () => {
    const h = mount(); const api = draftAPI(h.handle); const text = "😀".repeat(1024);
    api.setDraft(`  ${text}  `); expect(api.getDraft()).toBe(`  ${text}  `);
    expect(element(h.host, ".chat-count").textContent).toBe("4096 / 4096");
    expect(sendButton(h.host).disabled).toBe(false); submit(h.host);
    expect(h.handlers.onSend).toHaveBeenCalledExactlyOnceWith(text);
    // A-U92b: retain the raw boundary draft until acknowledgement, U92 M5; preserve U86 M5/M6.
    expect(api.getDraft()).toBe(`  ${text}  `);
  });

  it("A6 existing typed oversized input cannot bypass the limit through form or shortcuts", () => {
    const h = mount(); const text = "😀".repeat(1025); typeDraft(h.host, text);
    expect(element(h.host, ".chat-count").textContent).toBe("4100 / 4096"); expect(sendButton(h.host).disabled).toBe(true);
    submit(h.host); shortcut(h.host, "ctrlKey"); shortcut(h.host, "metaKey");
    expect(element<HTMLTextAreaElement>(h.host, "textarea").value).toBe(text); noHandlers(h.handlers);
  });

  it("A6 preserved form and keyboard send trim text and suppress empty submissions", () => {
    const h = mount(); typeDraft(h.host, " \n "); submit(h.host); expect(h.handlers.onSend).not.toHaveBeenCalled();
    typeDraft(h.host, "  status?\n "); shortcut(h.host, "ctrlKey");
    expect(h.handlers.onSend).toHaveBeenCalledExactlyOnceWith("status?");
    typeDraft(h.host, " next status "); submit(h.host);
    expect(h.handlers.onSend.mock.calls.map(args => args[0])).toEqual(["status?", "next status"]);
    // A-U92b: retain the latest raw submission until acknowledgement, U92 M5; preserve U86 M6 trimming.
    expect(element<HTMLTextAreaElement>(h.host, "textarea").value).toBe(" next status ");
  });

  it("A6 sending state blocks submission and setDraft preserves the in-flight draft", () => {
    const h = mount({ sending: true }); const api = draftAPI(h.handle); api.setDraft("queued draft");
    expect(sendButton(h.host).disabled).toBe(true); submit(h.host); shortcut(h.host, "metaKey");
    expect(api.getDraft()).toBe("queued draft"); noHandlers(h.handlers);
    h.handle.update({ ...h.vm, sending: false }); expect(sendButton(h.host).disabled).toBe(false);
  });
});

describe("A2 unassigned DOM guard (M2, M3)", () => {
  it("A2 unassigned VM visibly identifies task/room/executor and disables Send and Suggest", () => {
    const h = mount({ agent: "", task: { id: "T01", assignee: null } });
    for (const text of ["T01", "demo", "Executor unassigned"]) expect(visibleText(h.host)).toContain(text);
    typeDraft(h.host, "do not send"); expect(sendButton(h.host).disabled).toBe(true);
    expect(element<HTMLButtonElement>(h.host, ".chat-suggest").disabled).toBe(true);
    element<HTMLButtonElement>(h.host, ".chat-suggest").click(); noHandlers(h.handlers);
  });

  it.each(["form", "ctrlKey", "metaKey"] as const)("A2 unassigned %s submission cannot invoke onSend", entry => {
    const h = mount({ agent: "", task: { id: "T01", assignee: null } }); typeDraft(h.host, "empty recipient");
    if (entry === "form") submit(h.host); else shortcut(h.host, entry);
    expect(h.handlers.onSend).not.toHaveBeenCalled();
  });
});
