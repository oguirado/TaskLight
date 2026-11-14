import { describe, it, expect } from "vitest";
import { createServiceWorker } from "../../../extension/src/sw";
import { EXT_LIMITS } from "../../../extension/src/limits";
import { FakeChrome, FakeClock, GATE, HOST, EXT_ID, evt, evtOfChars, settle } from "./harness";
const nf = <T extends object>(e: T): T & { t: "event"; v: 1 } => ({ t: "event", v: 1, ...e });

const PANEL = `chrome-extension://${EXT_ID}/src/panel/panel.html`;
async function boot(chrome = new FakeChrome(), clock = new FakeClock()) {
  const sw = createServiceWorker({ chrome: chrome.api, clock, gate: GATE, nativeHostName: HOST, maxFrameChars: 65536 });
  await sw.start();
  return { chrome, clock, sw };
}
const queue = (c: FakeChrome) => c.session.get("u13.queue") as { v: number; items: Array<{ id: number; payload: any }>; totalChars: number } | undefined;

describe("service worker wiring", () => {
  it("start(): one native port to the bridge host, T1 + runtime listeners registered, sidePanel untouched", async () => {
    const { chrome } = await boot();
    expect(chrome.nativeHosts).toEqual([HOST]);
    expect(chrome.externalL).toHaveLength(1);
    expect(chrome.messageL.length).toBeGreaterThan(0);
    expect(chrome.sidePanelOpens).toEqual([]);
  });

  it("native frame -> persisted in chrome.storage.session only (never local) -> pushed to a linked wall port", async () => {
    const { chrome } = await boot();
    const wall = chrome.connectExternal("https://site.test");
    wall.emit({ t: "hello", v: 1, nonce: "a" });
    chrome.nativeEmit(nf(evt(1, "p1"))); await settle();
    expect(queue(chrome)?.items).toHaveLength(1);
    expect(chrome.local.writes).toBe(0);
    expect(wall.ofType("event")).toHaveLength(1);
    expect(wall.ofType("event")[0]).toMatchObject({ v: 1, projectId: "p1", payload: { n: 1 } });
  });

  it("bad / oversize native frames never persist or reach the wall", async () => {
    const { chrome } = await boot();
    const wall = chrome.connectExternal("https://site.test"); wall.emit({ t: "hello", v: 1, nonce: "a" });
    chrome.nativeEmit({ projectId: "", payload: 1 });
    chrome.nativeEmit(evtOfChars(70000));
    chrome.nativeEmit({ nope: true });
    await settle();
    expect(queue(chrome)?.items ?? []).toHaveLength(0);
    expect(wall.ofType("event")).toHaveLength(0);
  });

  it("SW restart: queue restored from storage.session and delivered to the wall after reconnect (snapshot), bounded", async () => {
    const a = await boot();
    for (let i = 0; i < 3; i++) a.chrome.nativeEmit(nf(evt(i, `p${i}`)));
    await settle();
    const b = await boot(a.chrome.restart());
    const wall = b.chrome.connectExternal("https://site.test");
    wall.emit({ t: "hello", v: 1, nonce: "n" }); await settle();
    const snap = wall.sent[0] as { t: string; items: unknown[] };
    expect(snap.t).toBe("snapshot"); expect(snap.items).toHaveLength(3);
    expect(b.sw.router.stats().depth).toBe(3);
  });

  it("persisted queue stays within QUEUE_MAX_EVENTS even under a 600-event burst", async () => {
    const { chrome, sw } = await boot();
    for (let i = 0; i < 600; i++) chrome.nativeEmit(nf(evt(i))); 
    await settle(20);
    expect(sw.router.stats().depth).toBeLessThanOrEqual(EXT_LIMITS.QUEUE_MAX_EVENTS);
    expect(queue(chrome)!.items.length).toBeLessThanOrEqual(EXT_LIMITS.QUEUE_MAX_EVENTS);
    expect(queue(chrome)!.totalChars).toBeLessThanOrEqual(EXT_LIMITS.QUEUE_MAX_CHARS);
  });

  it("STORE_FAILED: nothing reaches the wall when storage.session rejects", async () => {
    const { chrome } = await boot();
    const wall = chrome.connectExternal("https://site.test"); wall.emit({ t: "hello", v: 1, nonce: "a" });
    chrome.failSessionSet = true; chrome.nativeEmit(nf(evt(1))); await settle();
    expect(wall.ofType("event")).toHaveLength(0);
  });

  it("unlisted origin on T1 is refused through the SW wiring too", async () => {
    const { chrome } = await boot();
    const p = chrome.connectExternal("https://evil.test");
    expect(p.disconnected).toBe(true);
  });
});

describe("sidePanel only from a user gesture on an extension page", () => {
  const open = (c: FakeChrome, msg: unknown, sender: Parameters<FakeChrome["sendMessage"]>[1]) => c.sendMessage(msg, sender);

  it("extension page + userGesture -> sidePanel.open once with the given window", async () => {
    const { chrome } = await boot();
    const r = await open(chrome, { t: "open_panel", userGesture: true, windowId: 7 }, { id: EXT_ID, url: PANEL });
    expect(chrome.sidePanelOpens).toEqual([{ windowId: 7 }]);
    expect(r).toMatchObject({ ok: true });
  });
  it("extension page without gesture -> NO_GESTURE, not opened", async () => {
    const { chrome } = await boot();
    const r = await open(chrome, { t: "open_panel", userGesture: false, windowId: 7 }, { id: EXT_ID, url: PANEL });
    expect(chrome.sidePanelOpens).toEqual([]); expect(r).toEqual({ ok: false, code: "NO_GESTURE" });
  });
  it("content script / web page / other extension, even with userGesture=true -> NOT_EXTENSION_PAGE", async () => {
    const { chrome } = await boot();
    const senders = [
      { id: EXT_ID, url: "https://example.com/x", tab: { id: 5, url: "https://example.com/x" } },
      { id: EXT_ID, tab: { id: 5 } },
      { id: "otherextensionidotherextensionid", url: "chrome-extension://otherextensionidotherextensionid/p.html" },
      { url: PANEL },
      {},
    ];
    for (const s of senders) {
      const r = await open(chrome, { t: "open_panel", userGesture: true, windowId: 1 }, s);
      expect(r, JSON.stringify(s)).toEqual({ ok: false, code: "NOT_EXTENSION_PAGE" });
    }
    expect(chrome.sidePanelOpens).toEqual([]);
  });
  it("malformed open_panel (userGesture not boolean true) never opens", async () => {
    const { chrome } = await boot();
    for (const m of [{ t: "open_panel" }, { t: "open_panel", userGesture: "true" }, { t: "open_panel", userGesture: 1 }]) await open(chrome, m, { id: EXT_ID, url: PANEL });
    expect(chrome.sidePanelOpens).toEqual([]);
  });
  it("events, native frames, pins and wall connections never open the panel", async () => {
    const { chrome, sw } = await boot();
    chrome.tabs.set(5, { id: 5, title: "x", url: "https://example.com/" });
    chrome.nativeEmit(nf(evt(1))); await sw.sources.pinTab(5, "p1", true);
    const w = chrome.connectExternal("https://site.test"); w.emit({ t: "hello", v: 1, nonce: "a" }); await settle();
    expect(chrome.sidePanelOpens).toEqual([]);
  });
});

describe("pinned sources through the SW", () => {
  it("unpinned tab events never reach the queue, the store or the wall", async () => {
    const { chrome, sw } = await boot();
    chrome.tabs.set(6, { id: 6, title: "Bank", url: "https://bank.test/a?x=1" });
    const wall = chrome.connectExternal("https://site.test"); wall.emit({ t: "hello", v: 1, nonce: "a" });
    expect(await sw.sources.onSelection(6, "secret words")).toEqual({ ok: false, code: "NOT_PINNED" });
    expect(await sw.sources.captureSnapshot(6)).toEqual({ ok: false, code: "NOT_PINNED" });
    await settle();
    expect(sw.router.stats().accepted).toBe(0);
    expect(JSON.stringify([...chrome.session.values()])).not.toContain("secret words");
    expect(wall.ofType("event")).toHaveLength(0);
  });
  it("pinned tab: event enqueued with query/fragment stripped and persisted only in storage.session", async () => {
    const { chrome, sw } = await boot();
    chrome.tabs.set(5, { id: 5, title: "Doc", url: "https://example.com/a/b?token=SECRET#frag" });
    const wall = chrome.connectExternal("https://site.test"); wall.emit({ t: "hello", v: 1, nonce: "a" });
    expect(await sw.sources.pinTab(5, "p1", true)).toEqual({ ok: true }); await settle();
    expect(sw.router.stats().accepted).toBe(1);
    const dump = JSON.stringify([...chrome.session.values()]);
    expect(dump).toContain("https://example.com/a/b"); expect(dump).not.toContain("SECRET"); expect(dump).not.toContain("frag");
    expect(wall.ofType("event")[0]).toMatchObject({ projectId: "p1", payload: { kind: "tab_pinned", originPath: "https://example.com/a/b" } });
    expect(chrome.local.writes).toBe(0);
  });
});
