// U42 item 5 (placeholder half): the shipped placeholder Firebase config hides "Sign in with Google" /
// "Download device model" (they need a Firebase project); the "Gemini Nano: checking…" status line stays.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXT_ID, PagePort, settle } from "../u37c/harness";
import { FIREBASE_PUBLIC_CONFIG, isPlaceholderConfig } from "../../../src/app/firebase-config.public";

const g = globalThis as Record<string, unknown>;
let port: PagePort;
afterEach(() => { vi.unstubAllEnvs(); delete g["chrome"]; document.body.innerHTML = ""; });

async function loadMain(origins: string): Promise<HTMLElement> {
  port = new PagePort();
  g["chrome"] = { runtime: { connect: vi.fn(() => port) } };
  vi.resetModules();
  vi.stubEnv("MODE", "development");
  vi.stubEnv("VITE_RECAPTCHA_SITE_KEY", "");
  vi.stubEnv("VITE_EXTENSION_ORIGINS", origins);
  document.body.innerHTML = `<div id="wall"></div>`;
  await import("../../../hosting/src/main");
  await settle(10);
  return document.getElementById("wall") as HTMLElement;
}

describe("boot controls, placeholder config", () => {
  it("the repo ships the placeholder config (precondition)", () => {
    expect(isPlaceholderConfig(FIREBASE_PUBLIC_CONFIG)).toBe(true);
  });
  it("with the wall: no boot buttons anywhere; the status line reads 'Gemini Nano: checking…'", async () => {
    const root = await loadMain(`chrome-extension://${EXT_ID}`);
    await vi.waitFor(() => { expect(root.querySelector(".rail-status")).not.toBeNull(); });
    expect(root.querySelectorAll("button.boot-btn")).toHaveLength(0);
    expect(root.querySelector(".boot-controls")).toBeNull();
    expect(root.textContent ?? "").not.toMatch(/Sign in with Google|Download device model/);
    expect(root.querySelector(".rail-status .status-line[data-model] .status-text")?.textContent?.trim()).toBe("Gemini Nano: checking…");
  });
  it("still hidden after wall re-renders", async () => {
    const root = await loadMain(`chrome-extension://${EXT_ID}`);
    await vi.waitFor(() => { expect(root.querySelector(".rail-status")).not.toBeNull(); });
    port.emit({ t: "room_event", v: 1, room: "demo", floor: "ONLY_ON_DEVICE", event: { id: "e-0000000000000001", lamport: 1, ts: Date.now(), room: "demo", agent: "worker-1", act: "open", text: "hi" } });
    await settle(10);
    expect(root.querySelectorAll("button.boot-btn")).toHaveLength(0);
  });
  it("without an extension id (no wall): no boot buttons either", async () => {
    const root = await loadMain("");
    expect(root.querySelectorAll("button.boot-btn")).toHaveLength(0);
  });
});
