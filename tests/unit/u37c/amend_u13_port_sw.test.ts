// U37c AMEND_W (U13): port.ts onExtra hook, sw.ts exposes the native relay.
import { describe, expect, it, vi } from "vitest";
import { createExternalPortServer } from "../../../extension/src/port";
import { createServiceWorker } from "../../../extension/src/sw";
import { FakeChrome, FakeClock, GATE, HOST, settle } from "../u13/harness";
import type { NativeRelayAmended } from "./harness";

function server(onExtra?: (port: unknown, msg: unknown) => void) {
  const chrome = new FakeChrome(); const clock = new FakeClock();
  const s = createExternalPortServer({ chrome: chrome.api, gate: GATE, router: { peek: () => [] }, clock, ...(onExtra ? { onExtra } : {}) } as Parameters<typeof createExternalPortServer>[0]);
  s.start();
  return { chrome, s };
}

describe("createExternalPortServer onExtra(port,msg)", () => {
  it("unknown t from an allowed, helloed port -> onExtra(port, msg) with the same port object and the message", () => {
    const onExtra = vi.fn(); const { chrome } = server(onExtra);
    const p = chrome.connectExternal("https://site.test");
    p.emit({ t: "hello", v: 1, nonce: "n" });
    const m = { t: "room_sync", v: 1, rid: "a", since: { demo: 0 } };
    p.emit(m);
    expect(onExtra).toHaveBeenCalledTimes(1);
    expect(onExtra.mock.calls[0]![0]).toBe(p);
    expect(onExtra.mock.calls[0]![1]).toEqual(m);
  });
  it("existing types never reach onExtra and keep their behaviour: hello -> snapshot, ping -> pong, bad hello ignored", () => {
    const onExtra = vi.fn(); const { chrome } = server(onExtra);
    const p = chrome.connectExternal("https://site.test");
    p.emit({ t: "hello", v: 1, nonce: "n1" });
    p.emit({ t: "ping", v: 1 });
    p.emit({ t: "hello", v: 2, nonce: "n2" });
    p.emit({ t: "ping", v: 9 });
    expect(onExtra).not.toHaveBeenCalled();
    expect(p.ofType("snapshot")).toEqual([{ t: "snapshot", v: 1, nonce: "n1", items: [] }]);
    expect(p.ofType("pong")).toHaveLength(1);
  });
  it("non-objects and messages without a string t never reach onExtra", () => {
    const onExtra = vi.fn(); const { chrome } = server(onExtra);
    const p = chrome.connectExternal("https://site.test");
    for (const m of [null, 5, "room_sync", [], {}, { t: 7 }, { v: 1 }]) p.emit(m);
    expect(onExtra).not.toHaveBeenCalled();
  });
  it("a disallowed origin is disconnected and never reaches onExtra", () => {
    const onExtra = vi.fn(); const { chrome } = server(onExtra);
    const p = chrome.connectExternal("https://evil.test");
    expect(p.disconnected).toBe(true);
    p.emit({ t: "room_sync", v: 1, rid: "a", since: {} });
    expect(onExtra).not.toHaveBeenCalled();
  });
  it("a throwing onExtra is contained: later messages and hello/ping still work", () => {
    const onExtra = vi.fn(() => { throw new Error("hook"); }); const { chrome } = server(onExtra);
    const p = chrome.connectExternal("https://site.test");
    p.emit({ t: "hello", v: 1, nonce: "n" });
    expect(() => { p.emit({ t: "room_post", v: 1 }); }).not.toThrow();
    p.emit({ t: "ping", v: 1 });
    expect(p.ofType("pong")).toHaveLength(1);
  });
  it("without a hook, unknown t is ignored silently (as before)", () => {
    const { chrome } = server();
    const p = chrome.connectExternal("https://site.test");
    expect(() => { p.emit({ t: "room_sync", v: 1 }); }).not.toThrow();
    expect(p.sent).toEqual([]);
  });
});

describe("createServiceWorker exposes the native relay", () => {
  async function boot() {
    const chrome = new FakeChrome(); const clock = new FakeClock();
    const sw = createServiceWorker({ chrome: chrome.api, clock, gate: GATE, nativeHostName: HOST, maxFrameChars: 65536 });
    await sw.start();
    return { chrome, sw: sw as typeof sw & { relay: NativeRelayAmended } };
  }
  it("sw.relay is the NativeRelay: connected(), send() to the one native port, onFrame() for room frames", async () => {
    const { chrome, sw } = await boot();
    expect(chrome.nativeHosts).toEqual([HOST]);
    expect(sw.relay.connected()).toBe(true);
    expect(sw.relay.send({ t: "room_sync", v: 1, rid: "a", since: {} })).toBe(true);
    expect(chrome.nativePorts[0]!.sent).toEqual([{ t: "room_sync", v: 1, rid: "a", since: {} }]);
    const cb = vi.fn(); sw.relay.onFrame(cb);
    const room = { t: "room_hello", v: 1, rooms: [], agent: "wall-user" };
    chrome.nativeEmit(room); await settle();
    expect(cb).toHaveBeenCalledWith(room);
  });
  it("room frames bypass Router and storage.session; event frames still persist and publish", async () => {
    const { chrome, sw } = await boot();
    const wall = chrome.connectExternal("https://site.test"); wall.emit({ t: "hello", v: 1, nonce: "n" });
    chrome.nativeEmit({ t: "room_event", v: 1, room: "demo", floor: "ONLY_ON_DEVICE", event: { id: "e-0000000000000001" } }); await settle();
    expect(sw.router.peek()).toHaveLength(0);
    expect(chrome.sessionSets).toBe(0);
    chrome.nativeEmit({ t: "event", v: 1, projectId: "p1", payload: { n: 1 } }); await settle();
    expect(sw.router.peek()).toHaveLength(1);
    expect(wall.ofType("event")).toHaveLength(1);
  });
  it("sw.relay.send() is false once the native host is gone, true again after the backoff reconnect", async () => {
    vi.useFakeTimers();
    try {
      const { chrome, sw } = await boot();
      chrome.nativePorts[0]!.peerClose();
      expect(sw.relay.send({ t: "x" })).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(chrome.nativePorts).toHaveLength(2);
      expect(sw.relay.send({ t: "x" })).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
