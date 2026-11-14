// U38 V6: the agent chat opens as a right-side drawer (>= 1100 px) or bottom sheet (mobile) using design tokens.
// Contract: the chat host carries class `chat-drawer` and data-open="true|false"; agents.css (or views.css) styles it.
import { afterEach, describe, expect, it } from "vitest";
import { createAgentStore } from "../../../src/app/agent_store";
import { startAgentWall, type AgentWall } from "../../../src/app/agent_wall";
import { FakeAppClock, settle } from "../u37c/harness";
import { HEX_RE, cssRules, declsOf, definedTokens, ev, rulesFor, varsUsed } from "./helpers";

let wall: AgentWall | undefined;
afterEach(() => { wall?.destroy(); wall = undefined; document.body.replaceChildren(); });
async function run(withAgent: boolean) {
  const store = createAgentStore();
  if (withAgent) store.ingest(ev(1, "demo", "worker-1", "plan", "Plan", 1_700_000_000_000, { plan: { title: "Add CSV export", steps: [{ text: "a" }] } }));
  const wallHost = document.createElement("div"); const chatHost = document.createElement("div"); document.body.append(wallHost, chatHost);
  const clock = new FakeAppClock(); clock.t = 1_700_000_001_000;
  wall = startAgentWall({ wallHost, chatHost, link: { post: async () => ({ ok: true as const, id: "e-0000000000000009", lamport: 9 }) }, store, reviewer: { review: async () => undefined }, clock, userAgent: "wall-user" });
  await settle(10);
  return { store, chatHost, wallHost };
}

describe("V6 drawer DOM contract", () => {
  // Oracle amendment A-U42: the drawer starts CLOSED and opens when the user clicks a task (or its Chat button).
  it("with an agent: the chat host is a .chat-drawer, closed until a task is clicked, then open with a visible title and a close button", async () => {
    const { chatHost, wallHost } = await run(true);
    expect(chatHost.classList.contains("chat-drawer")).toBe(true);
    expect(chatHost.getAttribute("data-open")).toBe("false");
    wallHost.querySelector<HTMLButtonElement>("button.task-chat")?.click();
    expect(chatHost.getAttribute("data-open")).toBe("true");
    expect(chatHost.hidden).toBe(false);
    expect(chatHost.querySelector(".agent-chat-title")?.textContent?.trim()).toBe("Add CSV export");
    const close = chatHost.querySelector<HTMLButtonElement>(".agent-chat-close");
    expect(close).not.toBeNull();
    expect(close?.getAttribute("aria-label")).toBe("Close chat");
  });
  it("Close closes the drawer: data-open becomes 'false' (CSS hides it) and nothing throws", async () => {
    const { chatHost, wallHost } = await run(true);
    wallHost.querySelector<HTMLButtonElement>("button.task-chat")?.click(); // A-U42: open first
    expect(chatHost.getAttribute("data-open")).toBe("true");
    expect(() => { chatHost.querySelector<HTMLButtonElement>(".agent-chat-close")?.click(); }).not.toThrow();
    expect(chatHost.getAttribute("data-open")).toBe("false");
  });
  it("the drawer exposes dialog semantics (role=complementary or dialog, labelled)", async () => {
    const { chatHost } = await run(true);
    expect(["complementary", "dialog"]).toContain(chatHost.getAttribute("role"));
    expect((chatHost.getAttribute("aria-label") ?? "").length + (chatHost.getAttribute("aria-labelledby") ?? "").length).toBeGreaterThan(0);
  });
  it("with no agent yet there is nothing to open: the host is not an open drawer", async () => {
    const { chatHost } = await run(false);
    expect(chatHost.getAttribute("data-open")).not.toBe("true");
  });
});

describe("V6 drawer CSS (static)", () => {
  const rules = [...cssRules("styles/agents.css"), ...cssRules("styles/views.css")];
  const tokens = definedTokens();
  const base = () => declsOf(rulesFor(rules, /^\.chat-drawer$/, null));
  const wide = () => declsOf(rulesFor(rules, /^\.chat-drawer$/, /min-width:\s*1100px/));
  it("mobile default: fixed bottom sheet (left/right/bottom 0, capped height, stacking order)", () => {
    const d = base();
    expect(d["position"]).toBe("fixed");
    for (const p of ["left", "right", "bottom"]) expect(d[p], p).toMatch(/^0(px)?$/);
    expect(d["max-height"]).toBeDefined();
    expect(d["z-index"]).toBeDefined();
    expect(d["overflow-y"] ?? d["overflow"]).toMatch(/auto|scroll/);
  });
  it("desktop (@media min-width: 1100px): right-side drawer full height with a bounded width", () => {
    const d = wide();
    expect(d["position"] ?? base()["position"]).toBe("fixed");
    expect(d["right"]).toMatch(/^0(px)?$/);
    expect(d["top"]).toMatch(/^0(px)?$/);
    expect(d["bottom"]).toMatch(/^0(px)?$/);
    expect(d["left"]).toMatch(/^auto$/);
    expect(d["width"] ?? d["max-width"]).toBeDefined();
    expect(d["max-height"]).toMatch(/^(none|100(d?vh|%))$/);
  });
  it("closed state: .chat-drawer[data-open=\"false\"] is not displayed", () => {
    const rs = rulesFor(rules, /^\.chat-drawer\[data-open=["']?false["']?\]$/);
    expect(declsOf(rs)["display"]).toBe("none");
  });
  it("surface colours, border, shadow and radius come from design tokens (no hex), every var() is defined in tokens.css", () => {
    const rs = [...rulesFor(rules, /^\.chat-drawer$/), ...rulesFor(rules, /^\.chat-drawer \.agent-chat/)];
    const d = declsOf(rs);
    expect(d["background"] ?? d["background-color"]).toMatch(/var\(--/);
    expect(Object.values(declsOf(rulesFor(rules, /^\.chat-drawer$/))).join(" ")).not.toMatch(HEX_RE);
    for (const v of rs.flatMap((r) => Object.values(r.decls)).flatMap(varsUsed)) expect(tokens.has(v), v).toBe(true);
    const all = declsOf(rulesFor(rules, /^\.chat-drawer$/));
    expect(all["box-shadow"] ?? all["border"] ?? all["border-top"] ?? all["border-left"]).toMatch(/var\(--/);
  });
  it("the inner .agent-chat no longer renders as a centred full-width slab inside the drawer (margin/max-width/shadow reset)", () => {
    const d = declsOf(rulesFor(rules, /^\.chat-drawer \.agent-chat$/));
    expect(d["max-width"]).toMatch(/^none$|^100%$/);
    expect(d["margin-inline"] ?? d["margin"]).toMatch(/^0\b/);
  });
  it("reduced motion: any transition on the drawer is disabled under prefers-reduced-motion", () => {
    expect(rulesFor(rules, /^\.chat-drawer$/).length, "no .chat-drawer rule").toBeGreaterThan(0);
    const t = declsOf(rulesFor(rules, /^\.chat-drawer$/))["transition"];
    if (t === undefined) return;
    const rm = rulesFor(rules, /\.chat-drawer/, /prefers-reduced-motion:\s*reduce/);
    expect(declsOf(rm)["transition"]).toBe("none");
  });
});
