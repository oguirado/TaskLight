// U37c AMEND_W (U22): hosting/src/main.ts wires startAgentWall. Placeholder firebase config (the shipped file):
// boot is skipped but the wall still renders (B16); no reviewer port. main.ts has no exported factory, so (as in
// tests/unit/u22/review1.test.ts) the module is imported with injected fakes for the U37 modules.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXT_ID, PagePort } from "./harness";

const H = vi.hoisted(() => ({
  link: { start: vi.fn(), stop: vi.fn(), state: vi.fn(), post: vi.fn() },
  store: { ingest: vi.fn(), ingestChecked: vi.fn(), ingestJsonl: vi.fn(), since: vi.fn(), states: vi.fn(), events: vi.fn() },
  reviewer: { review: vi.fn() },
  wall: { refresh: vi.fn(), destroy: vi.fn() },
  createAgentLink: vi.fn(), createAgentStore: vi.fn(), createDriftReviewer: vi.fn(), startAgentWall: vi.fn(),
  driftPortFromFactory: vi.fn(), boot: vi.fn(),
}));
vi.mock("../../../src/app/agent_link", () => ({ createAgentLink: H.createAgentLink }));
vi.mock("../../../src/app/agent_store", () => ({ createAgentStore: H.createAgentStore }));
vi.mock("../../../src/app/agent_drift", () => ({ createDriftReviewer: H.createDriftReviewer, driftPortFromFactory: H.driftPortFromFactory }));
vi.mock("../../../src/app/agent_wall", () => ({ startAgentWall: H.startAgentWall }));
vi.mock("../../../src/app/boot", async (orig) => {
  const o = await orig<typeof import("../../../src/app/boot")>();
  return { ...o, boot: (...a: Parameters<typeof o.boot>) => { H.boot(...a); return o.boot(...a); } };
});

let chromePort: PagePort; let chromeConnect: ReturnType<typeof vi.fn>;
beforeEach(() => {
  for (const f of [H.createAgentLink, H.createAgentStore, H.createDriftReviewer, H.startAgentWall, H.driftPortFromFactory, H.boot, H.link.start, H.store.ingest, H.store.ingestChecked, H.store.since, H.wall.refresh]) f.mockReset();
  H.createAgentLink.mockReturnValue(H.link); H.createAgentStore.mockReturnValue(H.store); H.createDriftReviewer.mockReturnValue(H.reviewer);
  H.startAgentWall.mockReturnValue(H.wall); H.store.since.mockReturnValue({ demo: 3 }); H.store.ingest.mockReturnValue(true);
  // A-U85c: hosting consumes explicit ingestion outcomes, M2/M5.
  H.store.ingestChecked.mockReturnValue("accepted");
  chromePort = new PagePort(); chromeConnect = vi.fn(() => chromePort);
  (globalThis as Record<string, unknown>)["chrome"] = { runtime: { connect: chromeConnect } };
});
afterEach(() => { vi.unstubAllEnvs(); delete (globalThis as Record<string, unknown>)["chrome"]; document.body.innerHTML = ""; });

async function loadMain(origins: string | undefined): Promise<void> {
  vi.resetModules();
  vi.stubEnv("MODE", "development");
  vi.stubEnv("VITE_RECAPTCHA_SITE_KEY", "");
  vi.stubEnv("VITE_EXTENSION_ORIGINS", origins ?? "");
  document.body.innerHTML = `<div id="wall"></div>`;
  await import("../../../hosting/src/main");
}
type WallArgs = { wallHost: HTMLElement; chatHost: HTMLElement; link: unknown; store: unknown; reviewer: unknown; clock: Record<string, unknown>; userAgent: string };
const wallArgs = (): WallArgs => H.startAgentWall.mock.calls[0]![0] as WallArgs;

describe("extension id configured (VITE_EXTENSION_ORIGINS) + placeholder Firebase config", () => {
  it("calls startAgentWall exactly once with two distinct hosts inside #wall, the link/store/reviewer built by main, a real clock and a userAgent", async () => {
    await loadMain(`chrome-extension://${EXT_ID}`);
    await vi.waitFor(() => { expect(H.startAgentWall).toHaveBeenCalledTimes(1); });
    const a = wallArgs();
    const root = document.getElementById("wall")!;
    expect(a.wallHost).toBeInstanceOf(HTMLElement); expect(a.chatHost).toBeInstanceOf(HTMLElement);
    expect(a.wallHost).not.toBe(a.chatHost);
    expect(root.contains(a.wallHost)).toBe(true); expect(root.contains(a.chatHost)).toBe(true);
    expect(a.wallHost.contains(a.chatHost)).toBe(false); expect(a.chatHost.contains(a.wallHost)).toBe(false);
    expect(a.link).toBe(H.link); expect(a.store).toBe(H.store); expect(a.reviewer).toBe(H.reviewer);
    for (const k of ["now", "setTimeout", "clearTimeout", "setInterval", "clearInterval"]) expect(typeof a.clock[k], k).toBe("function");
    expect(typeof a.userAgent).toBe("string"); expect(a.userAgent.length).toBeGreaterThan(0);
  });
  it("B16: boot is SKIPPED on a placeholder config, yet the wall hosts are rendered and the link is started", async () => {
    await loadMain(`chrome-extension://${EXT_ID}`);
    await vi.waitFor(() => { expect(H.startAgentWall).toHaveBeenCalled(); });
    expect(H.boot).not.toHaveBeenCalled();
    expect(document.getElementById("wall")!.contains(wallArgs().wallHost)).toBe(true);
    expect(H.link.start).toHaveBeenCalledTimes(1);
  });
  it("no reviewer port in a placeholder build (rules only): createDriftReviewer gets no `port`, driftPortFromFactory never runs", async () => {
    await loadMain(`chrome-extension://${EXT_ID}`);
    await vi.waitFor(() => { expect(H.createDriftReviewer).toHaveBeenCalled(); });
    const opts = H.createDriftReviewer.mock.calls[0]![0] as { port?: unknown } | undefined;
    expect(opts?.port).toBeUndefined();
    expect(H.driftPortFromFactory).not.toHaveBeenCalled();
  });
  it("createAgentLink is wired to the configured id and the real chrome.runtime.connect, the store's since(), store.ingestChecked + wall refresh on room events", async () => {
    await loadMain(`chrome-extension://${EXT_ID}`);
    await vi.waitFor(() => { expect(H.createAgentLink).toHaveBeenCalledTimes(1); });
    const o = H.createAgentLink.mock.calls[0]![0] as Record<string, (...a: unknown[]) => unknown> & { extId: string };
    expect(o.extId).toBe(EXT_ID);
    expect(o["connect"]!(EXT_ID)).toBe(chromePort);
    expect(chromeConnect.mock.calls[0]![0]).toBe(EXT_ID);
    expect(o["since"]!()).toEqual({ demo: 3 });
    const ev = { id: "e-0000000000000001", lamport: 1, room: "demo" };
    // A-U85c: the hosted callback accepts events only for hello rooms, M5.
    o["onRoomHello"]!({ t: "room_hello", v: 1, rooms: [{ room: "demo", floor: "ONLY_ON_DEVICE" }], agent: "alice" });
    const before = H.wall.refresh.mock.calls.length;
    o["onRoomEvent"]!({ t: "room_event", v: 1, room: "demo", floor: "ONLY_ON_DEVICE", event: ev });
    expect(H.store.ingestChecked).toHaveBeenCalledWith(ev);
    expect(H.wall.refresh).toHaveBeenCalledTimes(before + 1);
    expect(typeof o["onRoomHello"]).toBe("function");
  });
  it("first chrome-extension:// origin of a comma list is the id; non-extension origins are ignored", async () => {
    await loadMain(`https://x.test, chrome-extension://${EXT_ID} ,chrome-extension://${"b".repeat(32)}`);
    await vi.waitFor(() => { expect(H.createAgentLink).toHaveBeenCalledTimes(1); });
    expect((H.createAgentLink.mock.calls[0]![0] as { extId: string }).extId).toBe(EXT_ID);
  });
});

describe("no usable extension id", () => {
  it.each([["unset", ""], ["only a web origin", "https://x.test"], ["malformed id (not 32 a-p chars)", "chrome-extension://short"]])(
    "%s: startAgentWall and createAgentLink are not called; the page does not crash",
    async (_n, origins) => {
      await loadMain(origins);
      await new Promise((r) => setTimeout(r, 50));
      expect(H.startAgentWall).not.toHaveBeenCalled();
      expect(H.createAgentLink).not.toHaveBeenCalled();
      expect(document.getElementById("wall")).not.toBeNull();
    });
});
