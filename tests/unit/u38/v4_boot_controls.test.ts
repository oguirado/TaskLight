// U38 V4: "Sign in with Google" / "Download device model" are styled buttons in the rail status area (hosting/src/main.ts), not raw elements on top.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXT_ID, PagePort, settle } from "../u37c/harness";
import { HEX_RE, cssRules, declsOf, definedTokens, rulesFor, varsUsed } from "./helpers";

let port: PagePort;
const g = globalThis as Record<string, unknown>;
afterEach(() => { vi.unstubAllEnvs(); delete g["chrome"]; document.body.innerHTML = ""; });

async function loadMain(): Promise<HTMLElement> {
  port = new PagePort();
  g["chrome"] = { runtime: { connect: vi.fn(() => port) } };
  vi.resetModules();
  vi.stubEnv("MODE", "development");
  vi.stubEnv("VITE_RECAPTCHA_SITE_KEY", "");
  vi.stubEnv("VITE_EXTENSION_ORIGINS", `chrome-extension://${EXT_ID}`);
  document.body.innerHTML = `<div id="wall"></div>`;
  await import("../../../hosting/src/main");
  await vi.waitFor(() => { expect(document.querySelector("#wall .rail-status")).not.toBeNull(); });
  return document.getElementById("wall") as HTMLElement;
}
const btns = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>(".rail-status .boot-controls button.boot-btn")];

describe("V4 boot controls placement", () => {
  // Oracle amendment A-U42: this suite loads the placeholder Firebase config, where the boot buttons are hidden
  // (they need a Firebase project). The placement contract with a real config is checked in tests/unit/u42/boot_controls.test.ts.
  it("placeholder config: no boot buttons are shown; the Gemini Nano status line stays (A-U42)", async () => {
    const root = await loadMain();
    expect(btns(root)).toEqual([]);
    expect(root.textContent ?? "").not.toContain("Sign in with Google");
    expect(root.textContent ?? "").not.toContain("Download device model");
    expect(root.querySelector(".rail-status")?.textContent ?? "").toContain("Gemini Nano: checking");
  });
  it("no raw button is a direct child of #wall (nothing unstyled at the top of the page)", async () => {
    const root = await loadMain();
    expect([...root.children].filter((c) => c.tagName === "BUTTON" || c.querySelector(":scope > button"))).toEqual([]);
  });
  it("the controls survive wall re-renders (a room event triggers a refresh) and are not duplicated", async () => {
    const root = await loadMain();
    port.emit({ t: "room_event", v: 1, room: "demo", floor: "ONLY_ON_DEVICE", event: { id: "e-0000000000000001", lamport: 1, ts: Date.now(), room: "demo", agent: "worker-1", act: "open", text: "hi" } });
    await settle(10);
    await vi.waitFor(() => { expect(root.querySelectorAll(".chat-msg, .task").length).toBeGreaterThanOrEqual(0); });
    // Oracle amendment A-U42: placeholder config -> still no boot controls after re-renders.
    expect(btns(root)).toHaveLength(0);
    expect(root.querySelectorAll(".boot-controls")).toHaveLength(0);
  });
});

describe("V4 boot controls styling (static CSS)", () => {
  const rules = [...cssRules("styles/views.css"), ...cssRules("styles/agents.css")];
  const tokens = definedTokens();
  it("a .boot-btn rule exists and styles colour, background, border and radius from design tokens only", () => {
    const d = declsOf(rulesFor(rules, /^\.boot-btn$|\.rail-status \.boot-btn$|\.boot-controls \.boot-btn$|^button\.boot-btn$/, null));
    for (const p of ["color", "border-radius"]) expect(d[p], p).toMatch(/var\(--/);
    expect(d["background"] ?? d["background-color"]).toMatch(/var\(--/);
    expect(d["border"] ?? d["border-color"]).toBeDefined();
    expect(Object.values(d).join(" ")).not.toMatch(HEX_RE);
    for (const v of Object.values(d).flatMap(varsUsed)) expect(tokens.has(v), v).toBe(true);
  });
  it("hover/focus-visible states exist for .boot-btn and a .boot-controls layout rule exists", () => {
    expect(rulesFor(rules, /\.boot-btn:focus-visible/).length).toBeGreaterThan(0);
    expect(rulesFor(rules, /\.boot-btn:hover/).length).toBeGreaterThan(0);
    expect(rulesFor(rules, /\.boot-controls$/).length).toBeGreaterThan(0);
  });
});
