// U38 G2: extension/src/sw.ts has no module-level bootstrap; sw_main.ts is the only entry and takes origins from the manifest.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeChrome, HOST, settle } from "../u13/harness";
import type { ChromeLike } from "../../../extension/src/chrome_ports";
import { read, stripTs } from "./helpers";

const g = globalThis as Record<string, unknown>;
afterEach(() => { delete g["chrome"]; vi.resetModules(); });

function withManifest(fc: FakeChrome, matches: string[]): ChromeLike {
  const api = fc.api;
  return { ...api, runtime: { ...api.runtime, getManifest: () => ({ externally_connectable: { matches } }) } } as unknown as ChromeLike;
}

describe("G2 sw.ts does not self-start", () => {
  it("importing sw.ts with a chrome global registers nothing (no listeners, no native connection)", async () => {
    const fc = new FakeChrome(); g["chrome"] = fc.api;
    vi.resetModules();
    const mod = await import("../../../extension/src/sw");
    await settle(8);
    expect(typeof mod.createServiceWorker).toBe("function");
    expect(fc.externalL).toHaveLength(0);
    expect(fc.messageL).toHaveLength(0);
    expect(fc.nativeHosts).toEqual([]);
  });
  it("sw.ts source has no hard-coded origin filter and no module-level boot on the chrome global", () => {
    const s = stripTs(read("extension/src/sw.ts"));
    expect(s).not.toMatch(/site\.test/);
    expect(s).not.toMatch(/bootChrome/);
    expect(s).not.toMatch(/globalThis[^;\n]*chrome/);
  });
});

describe("G2 sw_main.ts is the only entry, origins from the manifest", () => {
  it("importing sw_main with a chrome global starts exactly one service worker (one external listener, one native port)", async () => {
    const fc = new FakeChrome(); g["chrome"] = withManifest(fc, ["http://localhost/*"]);
    vi.resetModules();
    await import("../../../extension/src/sw_main");
    await vi.waitFor(() => { expect(fc.externalL).toHaveLength(1); });
    await settle(8);
    expect(fc.externalL).toHaveLength(1);
    expect(fc.nativeHosts).toEqual([HOST]);
  });
  it("the gate is exactly the manifest's externally_connectable.matches: localhost accepted, site.test refused when not listed", async () => {
    const fc = new FakeChrome(); g["chrome"] = withManifest(fc, ["http://localhost/*"]);
    vi.resetModules();
    await import("../../../extension/src/sw_main");
    await vi.waitFor(() => { expect(fc.externalL).toHaveLength(1); });
    const ok = fc.connectExternal("http://localhost:5173"); ok.emit({ t: "hello", v: 1, nonce: "n" });
    const bad = fc.connectExternal("https://site.test");
    expect(ok.disconnected).toBe(false);
    expect(ok.ofType("snapshot")).toHaveLength(1);
    expect(bad.disconnected).toBe(true);
  });
  it("another manifest -> another gate (nothing is hard-coded)", async () => {
    const fc = new FakeChrome(); g["chrome"] = withManifest(fc, ["https://example.test/*"]);
    vi.resetModules();
    await import("../../../extension/src/sw_main");
    await vi.waitFor(() => { expect(fc.externalL).toHaveLength(1); });
    const ok = fc.connectExternal("https://example.test"); ok.emit({ t: "hello", v: 1, nonce: "n" });
    const bad = fc.connectExternal("http://localhost:5173");
    expect(ok.ofType("snapshot")).toHaveLength(1);
    expect(bad.disconnected).toBe(true);
  });
});
