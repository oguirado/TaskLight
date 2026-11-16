import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeChrome, GATE, HOST, settle } from "../u13/harness";

const globals = globalThis as Record<string, unknown>;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("U73 built service worker has one startup owner", () => {
  it("defines autoboot as false for the service-worker bundle", () => {
    const source = readFileSync("extension/build.mjs", "utf8");
    expect(source).toMatch(/define:\s*\{\s*__CW_SW_AUTOBOOT__:\s*"false"\s*\}/);
    expect(source).toMatch(/await bundle\("cw-sw-entry"[^;]*\{\s*__CW_SW_AUTOBOOT__:\s*"false"\s*\}/);
  });

  it("suppresses import startup when disabled, then explicitly starts exactly one worker", async () => {
    const chrome = new FakeChrome();
    vi.stubGlobal("chrome", chrome.api);
    vi.stubGlobal("__CW_SW_AUTOBOOT__", false);
    expect(globals["__CW_SW_AUTOBOOT__"]).toBe(false);
    vi.resetModules();
    const { startSwMain } = await import("../../../extension/src/sw_main");
    await settle();
    expect(chrome.externalL).toHaveLength(0);
    expect(chrome.nativePorts).toHaveLength(0);
    expect(chrome.nativeHosts).toEqual([]);

    await startSwMain({ chrome: chrome.api, gate: GATE });
    await settle();
    expect(chrome.externalL).toHaveLength(1);
    expect(chrome.nativePorts).toHaveLength(1);
    expect(chrome.nativeHosts).toEqual([HOST]);
  });
});
