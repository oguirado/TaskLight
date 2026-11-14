import { afterEach, describe, expect, it } from "vitest";
import { cleanup, click, counter, input, log, mount, mountSpied, nth, q, qa, section, sendBtn, signature, suggestBtn, txt, txts } from "./helpers";
import { benignChat, FIXTURE, HOSTILE_STRINGS, hostileChat, MESSAGES } from "./fixture";
import type { AgentChatVM } from "../../../src/agentsui/types";

afterEach(cleanup);

describe("U35 C1 structure", () => {
  it("host holds exactly one section.agent-chat with data-agent and data-room", () => {
    const { host } = mount();
    expect(host.children.length).toBe(1);
    const s = nth(Array.from(host.children), 0);
    expect(s.tagName).toBe("SECTION");
    expect(s.classList.contains("agent-chat")).toBe(true);
    expect(s.getAttribute("data-agent")).toBe("Atlas");
    expect(s.getAttribute("data-room")).toBe("room-7");
  });

  it("section children order: header, banners (optional), log, form", () => {
    const { host } = mount();
    const kids = Array.from(section(host).children).map((e) => e.tagName.toLowerCase() + "." + e.className);
    expect(kids).toEqual(["header.agent-chat-head", "ol.agent-chat-log", "form.agent-chat-composer"]);
    const withBanners = mount({ ...FIXTURE, silent: true, silentFor: "1 min", drift: { verdict: "drift", reason: "r", added: [], removed: [], source: "rules" } });
    const k2 = Array.from(section(withBanners.host).children).map((e) => e.tagName.toLowerCase());
    expect(k2[0]).toBe("header");
    expect(k2.slice(-2)).toEqual(["ol", "form"]);
    expect(k2.filter((t) => t === "div").length).toBe(2);
  });

  it("header > h2.agent-chat-title + button.agent-chat-close with aria-label", () => {
    const { host } = mount();
    const head = q(host, "section.agent-chat > header.agent-chat-head");
    const kids = Array.from(head.children);
    expect(kids.map((e) => e.tagName)).toEqual(["H2", "BUTTON"]);
    expect(nth(kids, 0).classList.contains("agent-chat-title")).toBe(true);
    expect(txt(nth(kids, 0))).toBe("Atlas - release notes");
    const close = nth(kids, 1);
    expect(close.classList.contains("agent-chat-close")).toBe(true);
    expect(close.getAttribute("aria-label")).toBe("Close chat");
  });

  it("close button calls onClose once and nothing else", () => {
    const { host, spies } = mountSpied();
    click(q(host, "button.agent-chat-close"));
    expect(spies.onClose).toHaveBeenCalledTimes(1);
    expect(spies.onSend).not.toHaveBeenCalled();
    expect(spies.onEscalate).not.toHaveBeenCalled();
  });

  it("log is ol.agent-chat-log[role=log][aria-live=polite]", () => {
    const { host } = mount();
    const l = log(host);
    expect(l.getAttribute("role")).toBe("log");
    expect(l.getAttribute("aria-live")).toBe("polite");
  });

  it("one li.chat-msg per message, in order, with data-from", () => {
    const { host } = mount();
    const items = qa(log(host), "li.chat-msg");
    expect(items.length).toBe(MESSAGES.length);
    expect(qa(log(host), "li").length).toBe(MESSAGES.length);
    expect(items.map((li) => li.getAttribute("data-from"))).toEqual(["user", "agent", "nano", "user", "agent"]);
    expect(items.map((li) => txt(q(li, "p.chat-text")))).toEqual(MESSAGES.map((m) => m.text.replace(/\n/g, "\n").trim()));
  });

  it("each message has span.chat-from, p.chat-text, time.chat-at (once)", () => {
    const { host } = mount();
    for (const li of qa(log(host), "li.chat-msg")) {
      expect(qa(li, "span.chat-from").length).toBe(1);
      expect(qa(li, "p.chat-text").length).toBe(1);
      expect(qa(li, "time.chat-at").length).toBe(1);
    }
    expect(txts(log(host), "time.chat-at")).toEqual(MESSAGES.map((m) => m.at));
  });

  it("labels: user is 'You', agent is the agent name, nano is 'Gemini Nano'", () => {
    const { host } = mount();
    expect(txts(log(host), "span.chat-from")).toEqual(["You", "Atlas", "Gemini Nano", "You", "Atlas"]);
  });

  it("message text keeps newlines literally (textContent) and creates no <br>", () => {
    const { host } = mount();
    const p = q(nth(qa(log(host), "li.chat-msg"), 4), "p.chat-text");
    expect(p.textContent).toBe("Outline ready.\nSecond line.");
    expect(p.children.length).toBe(0);
  });

  it("empty message list renders an empty log (element kept)", () => {
    const { host } = mount({ ...FIXTURE, messages: [] });
    expect(qa(log(host), "li").length).toBe(0);
  });

  it("composer: form.agent-chat-composer holds textarea, suggest button, send button in order", () => {
    const { host } = mount();
    const f = q(host, "section.agent-chat > form.agent-chat-composer");
    const t = input(host), sg = suggestBtn(host), sd = sendBtn(host);
    for (const e of [t, sg, sd]) expect(e.parentElement).toBe(f);
    expect(t.compareDocumentPosition(sg) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sg.compareDocumentPosition(sd) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("textarea aria-label is 'Message to <agent>'; initial value empty", () => {
    const { host } = mount();
    expect(input(host).getAttribute("aria-label")).toBe("Message to Atlas");
    expect(input(host).value).toBe("");
    expect(input(host).tagName).toBe("TEXTAREA");
  });

  it("suggest button copy and type=button (must not submit the form)", () => {
    const { host, spies } = mountSpied();
    const b = suggestBtn(host);
    expect(txt(b)).toBe("Suggest with Gemini Nano");
    expect(b.getAttribute("type")).toBe("button");
    click(b);
    expect(spies.onSend).not.toHaveBeenCalled();
  });

  it("send button copy and type=submit", () => {
    const { host } = mount();
    expect(txt(sendBtn(host))).toBe("Send");
    expect(sendBtn(host).getAttribute("type")).toBe("submit");
  });

  it("byte counter span.chat-count starts at '0 / 4096' inside the composer", () => {
    const { host } = mount();
    expect(txt(counter(host))).toBe("0 / 4096");
    expect(counter(host).closest("form.agent-chat-composer")).not.toBeNull();
    expect(counter(host).hasAttribute("data-over")).toBe(false);
  });

  it("no banners on a plain chat", () => {
    const { host } = mount();
    expect(qa(host, ".chat-banner").length).toBe(0);
    expect(qa(host, "p.chat-suggest-note").length).toBe(0);
  });

  it("update() re-renders title, data-agent, data-room, aria-label and messages", () => {
    const { host, handle } = mount();
    handle.update({ ...FIXTURE, room: "room-9", agent: "Orion", title: "Orion thread", messages: MESSAGES.slice(0, 2) });
    expect(section(host).getAttribute("data-agent")).toBe("Orion");
    expect(section(host).getAttribute("data-room")).toBe("room-9");
    expect(txt(q(host, "h2.agent-chat-title"))).toBe("Orion thread");
    expect(input(host).getAttribute("aria-label")).toBe("Message to Orion");
    expect(qa(host, "li.chat-msg").length).toBe(2);
    expect(host.children.length).toBe(1);
    expect(qa(host, "section.agent-chat").length).toBe(1);
  });

  it("update() appends new messages in order", () => {
    const { host, handle } = mount({ ...FIXTURE, messages: MESSAGES.slice(0, 3) });
    handle.update(FIXTURE);
    expect(txts(host, "p.chat-text")).toEqual(MESSAGES.map((m) => m.text));
  });

  it("mounting twice on different hosts yields independent instances", () => {
    const a = mountSpied(), b = mountSpied({ ...FIXTURE, agent: "Orion" });
    click(q(a.host, "button.agent-chat-close"));
    expect(a.spies.onClose).toHaveBeenCalledTimes(1);
    expect(b.spies.onClose).not.toHaveBeenCalled();
    expect(section(b.host).getAttribute("data-agent")).toBe("Orion");
  });

  it("input VM is never mutated (deep-frozen VM mounts and updates)", async () => {
    const { deepFreeze } = await import("./fixture");
    const vm = deepFreeze(structuredClone(FIXTURE) as AgentChatVM);
    const { handle } = mount(vm);
    expect(() => handle.update(deepFreeze({ ...structuredClone(FIXTURE), silent: true, silentFor: "1 min" }))).not.toThrow();
  });
});

describe("U35 C2 text safety", () => {
  it.each(HOSTILE_STRINGS.map((s) => [s]))("hostile string renders literally and creates no elements: %s", (s) => {
    const { host } = mount(hostileChat(s));
    for (const bad of ["img", "script", "svg", "b", "i", "a", "#evil"]) expect(host.querySelector(bad), bad).toBeNull();
    expect(txt(q(host, "h2.agent-chat-title"))).toBe(s.trim());
    expect(txts(host, "p.chat-text")).toEqual([s.trim(), s.trim(), s.trim()]);
    expect(txts(host, "time.chat-at")).toEqual([s.trim(), s.trim(), s.trim()]);
    expect(section(host).getAttribute("data-agent")).toBe(s);
    expect(section(host).getAttribute("data-room")).toBe(s);
    expect(input(host).getAttribute("aria-label")).toBe(`Message to ${s}`);
    expect((window as unknown as Record<string, unknown>)["__pwned"]).toBeUndefined();
  });

  it.each(HOSTILE_STRINGS.map((s) => [s]))("hostile banners/lists/suggestion stay inert: %s", (s) => {
    const { host } = mount(hostileChat(s));
    const silent = q(host, ".chat-banner[data-kind=silent]");
    expect(silent.textContent).toContain(`${s} has been silent for ${s}`);
    const drift = q(host, ".chat-banner[data-kind=drift]");
    expect(drift.textContent).toContain(s);
    expect(txts(drift, "ul.drift-added > li")).toEqual([s.trim()]);
    expect(txts(drift, "ul.drift-removed > li")).toEqual([s.trim()]);
    expect(input(host).value).toBe(s);
    expect(host.querySelector("img,script,svg,b,i,a,#evil")).toBeNull();
  });

  it("hostile VM yields exactly the same element/class skeleton as a benign VM", () => {
    const a = mount(benignChat()).host;
    const hostile = mount(hostileChat(HOSTILE_STRINGS[0])).host;
    expect(signature(hostile)).toBe(signature(a));
    expect(signature(a).length).toBeGreaterThan(200);
  });

  it("hostile text through update() is also inert", () => {
    const { host, handle } = mount();
    handle.update(hostileChat(HOSTILE_STRINGS[1]));
    expect(host.querySelector("script")).toBeNull();
    expect(txts(host, "p.chat-text")[0]).toBe(HOSTILE_STRINGS[1]);
  });
});
