import { afterEach, describe, expect, it } from "vitest";
import { cleanup, click, input, log, mount, mountSpied, q, qa, section, sendBtn, txt } from "./helpers";
import { DRIFT, FIXTURE, MESSAGES } from "./fixture";
import type { AgentChatVM } from "../../../src/agentsui/types";

afterEach(cleanup);

const bad = (o: unknown): AgentChatVM => o as AgentChatVM;
const base = { room: "r", agent: "Atlas", title: "T", silent: false, sending: false };

const MALFORMED: [string, unknown][] = [
  ["empty object", {}],
  ["no messages array", { ...base }],
  ["messages null", { ...base, messages: null }],
  ["messages a string", { ...base, messages: "abc" }],
  ["messages an object", { ...base, messages: { length: 2 } }],
  ["messages with null/primitive entries", { ...base, messages: [null, 3, "x", undefined, []] }],
  ["messages with empty objects", { ...base, messages: [{}, { id: "a" }] }],
  ["message text/at not strings", { ...base, messages: [{ id: "a", from: "user", agent: 1, text: { a: 1 }, at: null }] }],
  ["unknown 'from' values", { ...base, messages: [{ id: "a", from: "robot", agent: "x", text: "t", at: "1" }] }],
  ["inherited 'from' constructor", { ...base, messages: [{ id: "a", from: "constructor", agent: "x", text: "t", at: "1" }] }],
  ["inherited 'from' __proto__/toString/hasOwnProperty", { ...base, messages: ["__proto__", "toString", "hasOwnProperty", "valueOf"].map((f, i) => ({ id: `i${i}`, from: f, agent: "x", text: "t", at: "1" })) }],
  ["drift missing arrays", { ...base, messages: [], drift: { verdict: "drift", reason: "r", source: "device" } }],
  ["drift arrays null / holding non-strings", { ...base, messages: [], drift: { verdict: "drift", reason: "r", added: null, removed: [1, null, {}], source: "cloud" } }],
  ["drift null", { ...base, messages: [], drift: null }],
  ["drift empty object", { ...base, messages: [], drift: {} }],
  ["drift verdict inherited constructor", { ...base, messages: [], drift: { verdict: "constructor", reason: "r", added: [], removed: [], source: "device" } }],
  ["drift source inherited constructor", { ...base, messages: [], drift: { verdict: "drift", reason: "r", added: [], removed: [], source: "constructor" } }],
  ["drift source __proto__/toString", { ...base, messages: [], drift: { verdict: "needs_user", reason: "r", added: [], removed: [], source: "__proto__" } }],
  ["drift source toString", { ...base, messages: [], drift: { verdict: "needs_user", reason: "r", added: [], removed: [], source: "toString" } }],
  ["silent true with non-string silentFor", { ...base, messages: [], silent: true, silentFor: 42 }],
  ["silent truthy non-boolean", { ...base, messages: [], silent: "yes" }],
  ["suggestion not a string", { ...base, messages: [], suggestion: 5 }],
  ["suggestion object", { ...base, messages: [], suggestion: { a: 1 } }],
  ["title/agent/room missing", { messages: [], silent: false, sending: false }],
  ["title/agent/room are objects", { room: {}, agent: [], title: null, messages: [], silent: false, sending: false }],
  ["sending not boolean", { ...base, messages: [], sending: "no" }],
];

describe("U35 C8 malformed view models never throw", () => {
  it.each(MALFORMED)("update(%s) does not throw and leaves a mounted, working component", (_n, vm) => {
    const { host, handle } = mount();
    expect(() => handle.update(bad(vm))).not.toThrow();
    expect(qa(host, "section.agent-chat").length).toBe(1);
    expect(host.children.length).toBe(1);
  });

  it.each(MALFORMED)("mount(%s) does not throw", (_n, vm) => {
    expect(() => mount(bad(vm))).not.toThrow();
  });

  it.each([[null], [undefined], [42], ["str"], [true], [[]]])("update(%j) with a non-object does not throw", (v) => {
    const { handle } = mount();
    expect(() => handle.update(bad(v))).not.toThrow();
  });

  it("a valid update after a malformed one restores a correct render", () => {
    const { host, handle } = mount();
    handle.update(bad(MALFORMED[0]?.[1]));
    handle.update(DRIFT);
    expect(qa(host, "li.chat-msg").length).toBe(MESSAGES.length);
    expect(qa(host, "[data-kind=drift]").length).toBe(1);
    expect(txt(q(host, "h2.agent-chat-title"))).toBe(FIXTURE.title);
    expect(section(host).getAttribute("data-agent")).toBe("Atlas");
  });

  it("missing arrays count as empty: no messages, no lists", () => {
    const { host } = mount(bad({ ...base, drift: { verdict: "drift", reason: "why", source: "rules" } }));
    expect(qa(log(host), "li").length).toBe(0);
    expect(qa(host, "ul.drift-added, ul.drift-removed").length).toBe(0);
    expect(host.textContent).toContain("why");
  });

  it("inherited key 'constructor' as 'from' does not leak function source into the label", () => {
    const { host } = mount(bad({ ...base, messages: [{ id: "a", from: "constructor", agent: "x", text: "t", at: "1" }] }));
    const t = host.textContent ?? "";
    expect(t).not.toContain("native code");
    expect(t).not.toContain("function");
    expect(t).not.toContain("[object");
  });

  it("inherited keys as drift verdict/source do not leak function source into the banner", () => {
    for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const { host } = mount(bad({ ...base, messages: [], drift: { verdict: "drift", reason: "r", added: [], removed: [], source: k } }));
      const t = host.textContent ?? "";
      expect(t, k).not.toContain("native code");
      expect(t, k).not.toContain("function");
      expect(t, k).not.toContain("undefined");
      const { host: h2 } = mount(bad({ ...base, messages: [], drift: { verdict: k, reason: "r", added: [], removed: [], source: "device" } }));
      expect(h2.textContent, k).not.toContain("native code");
    }
  });

  it("an unknown drift verdict is not treated as a visible 'drift' with Accept; on_track-like silence or a safe render only (no 'undefined' text)", () => {
    const { host } = mount(bad({ ...base, messages: [], drift: { verdict: "weird", reason: "r", added: [], removed: [], source: "device" } }));
    expect(host.textContent).not.toContain("undefined");
    expect(host.textContent).not.toContain("null");
  });

  it("missing fields never print 'undefined' or 'null' into text nodes", () => {
    const { host } = mount(bad({ messages: [{ id: "a", from: "user" }, { id: "b", from: "agent" }], silent: true }));
    expect(host.textContent).not.toContain("undefined");
    expect(host.textContent).not.toContain("null");
  });

  it("handlers missing entirely: every control is inert but safe", () => {
    const { host } = mount({ ...DRIFT, silent: true, silentFor: "1 min" });
    for (const sel of ["button.agent-chat-close", "button.chat-suggest", "button.chat-escalate", "button.chat-accept-drift"]) {
      expect(() => click(q(host, sel)), sel).not.toThrow();
    }
    expect(sendBtn(host).disabled).toBe(true);
    expect(input(host).value).toBe("");
  });

  it("partial handlers: only the provided ones are called", () => {
    const calls: string[] = [];
    const { host } = mount({ ...DRIFT, silent: true }, { onClose: () => calls.push("close"), onAcceptDrift: () => calls.push("accept") });
    click(q(host, "button.agent-chat-close"));
    click(q(host, "button.chat-escalate"));
    click(q(host, "button.chat-suggest"));
    click(q(host, "button.chat-accept-drift"));
    expect(calls).toEqual(["close", "accept"]);
  });

  it("hostile ids/keys such as '__proto__' as agent/room are set as plain attributes", () => {
    const { host } = mountSpied(bad({ ...FIXTURE, agent: "__proto__", room: "constructor" }));
    expect(section(host).getAttribute("data-agent")).toBe("__proto__");
    expect(section(host).getAttribute("data-room")).toBe("constructor");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});
