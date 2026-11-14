import { describe, it, expect } from "vitest";
import { createRouter } from "../../../extension/src/router";
import { createExternalPortServer, isOriginAllowed } from "../../../extension/src/port";
import { PORT_LIMITS } from "../../../extension/src/types";
import { FakeChrome, FakeClock, FakePort, GATE, evt, settle } from "./harness";
import { createSessionStore } from "../../../extension/src/chrome_ports";

async function mk(chrome = new FakeChrome(), clock = new FakeClock()) {
  const router = createRouter({ store: createSessionStore(chrome.api), clock, notify: () => {} });
  await router.load();
  const server = createExternalPortServer({ chrome: chrome.api, gate: GATE, router, clock });
  server.start();
  return { chrome, clock, router, server };
}

describe("T1 external port (B20)", () => {
  it("isOriginAllowed: pattern match on exact origin; lookalikes, other scheme and undefined refused", () => {
    const g = { allowedOrigins: ["https://site.test/*", "http://localhost/*"] };
    expect(isOriginAllowed(g, "https://site.test")).toBe(true);
    expect(isOriginAllowed(g, "http://localhost:8766")).toBe(true);
    for (const o of ["https://site.test.evil.com", "https://evilsite.test", "http://site.test", "https://sub.site.test", "chrome-extension://abc", "", undefined, "null"]) {
      expect(isOriginAllowed(g, o), String(o)).toBe(false);
    }
    expect(isOriginAllowed({ allowedOrigins: [] }, "https://site.test")).toBe(false);
  });

  it("start() registers onConnectExternal", async () => {
    const t = await mk(); expect(t.chrome.externalL).toHaveLength(1);
  });

  it("unlisted origin refused: disconnected at once, nothing posted, later hello gets nothing", async () => {
    const t = await mk(); await t.router.accept(evt(1));
    for (const origin of ["https://evil.test", undefined]) {
      const p = t.chrome.connectExternal(origin);
      expect(p.disconnected).toBe(true);
      p.emit({ t: "hello", v: 1, nonce: "a" });
      expect(p.sent).toEqual([]);
    }
    expect(t.server.portCount()).toBe(0);
    t.server.publish((await t.router.lease(1))[0]!);
  });

  it("listed origin: no event before hello; hello -> snapshot{nonce, latest per projectId} first", async () => {
    const t = await mk();
    await t.router.accept(evt(1, "p1")); await t.router.accept(evt(2, "p2")); await t.router.accept(evt(3, "p1"));
    const port = t.chrome.connectExternal("https://site.test");
    expect(port.disconnected).toBe(false);
    t.server.publish(t.router.peek()[2]!);
    expect(port.sent).toEqual([]);
    port.emit({ t: "hello", v: 1, nonce: "a" });
    expect(port.sent).toHaveLength(1);
    const snap = port.sent[0] as { t: string; v: number; nonce: string; items: Array<{ seq: number; projectId: string; payload: { n: number } }> };
    expect(snap).toMatchObject({ t: "snapshot", v: 1, nonce: "a" });
    expect(snap.items.map((i) => [i.projectId, i.payload.n])).toEqual([["p2", 2], ["p1", 3]]);
    expect(snap.items.map((i) => i.seq)).toEqual(t.router.peek().filter((e) => e.payload && [2, 3].includes((e.payload as { n: number }).n)).map((e) => e.id));
  });

  it("empty queue still answers hello with an empty snapshot", async () => {
    const t = await mk(); const p = t.chrome.connectExternal("https://site.test");
    p.emit({ t: "hello", v: 1, nonce: "z" });
    expect(p.sent[0]).toEqual({ t: "snapshot", v: 1, nonce: "z", items: [] });
  });

  it("after the snapshot, published items resume as `event` frames", async () => {
    const t = await mk(); const p = t.chrome.connectExternal("https://site.test");
    p.emit({ t: "hello", v: 1, nonce: "a" });
    const r = await t.router.accept(evt(9, "p3")); if (!r.ok) throw new Error();
    t.server.publish(t.router.peek().at(-1)!);
    expect(p.ofType("event")).toEqual([{ t: "event", v: 1, seq: r.id, projectId: "p3", payload: { n: 9, pad: "" } }]);
  });

  it("hello with wrong version or malformed frames are ignored (no snapshot, no throw)", async () => {
    const t = await mk(); const p = t.chrome.connectExternal("https://site.test");
    for (const m of [{ t: "hello", v: 2, nonce: "a" }, { t: "hello", v: 1 }, { t: "hello", v: 1, nonce: 5 }, "x", null, { t: "bogus" }]) p.emit(m);
    expect(p.sent).toEqual([]);
  });

  it("ping -> pong, every time, v:1", async () => {
    const t = await mk(); const p = t.chrome.connectExternal("https://site.test");
    p.emit({ t: "hello", v: 1, nonce: "a" });
    for (let i = 0; i < 3; i++) p.emit({ t: "ping", v: 1 });
    expect(p.ofType("pong")).toEqual([{ t: "pong", v: 1 }, { t: "pong", v: 1 }, { t: "pong", v: 1 }]);
  });

  it("ping cadence (fake clock): a wall pinging every 20 s for 80 s keeps one live port and gets 4 pongs", async () => {
    const t = await mk(); const p = t.chrome.connectExternal("https://site.test");
    p.emit({ t: "hello", v: 1, nonce: "a" });
    const tick = () => { p.emit({ t: "ping", v: 1 }); t.clock.setTimer(PORT_LIMITS.PING_MS, tick); };
    t.clock.setTimer(PORT_LIMITS.PING_MS, tick);
    await t.clock.advance(80_000);
    expect(p.ofType("pong")).toHaveLength(4);
    expect(p.disconnected).toBe(false);
    expect(t.server.portCount()).toBe(1);
  });

  it("port close removes it; publish to closed ports never throws", async () => {
    const t = await mk(); const p = t.chrome.connectExternal("https://site.test");
    p.emit({ t: "hello", v: 1, nonce: "a" });
    expect(t.server.portCount()).toBe(1);
    p.peerClose();
    expect(t.server.portCount()).toBe(0);
    await t.router.accept(evt(1));
    expect(() => t.server.publish(t.router.peek()[0]!)).not.toThrow();
  });

  it("reconnect after SW death (<=100 ms retry): new lifetime, same storage.session -> hello gets the persisted queue", async () => {
    const t1 = await mk();
    for (let i = 0; i < 3; i++) await t1.router.accept(evt(i, `p${i}`));
    const wall = t1.chrome.connectExternal("https://site.test");
    wall.emit({ t: "hello", v: 1, nonce: "a" });
    wall.peerClose(); // SW terminated
    const clock2 = new FakeClock();
    let t2: Awaited<ReturnType<typeof mk>> | undefined;
    // wall reconnect loop: retries every RECONNECT_RETRY_MS until the SW is back
    let port2: FakePort | undefined;
    clock2.setTimer(PORT_LIMITS.RECONNECT_RETRY_MS, () => { port2 = t2?.chrome.connectExternal("https://site.test"); port2?.emit({ t: "hello", v: 1, nonce: "b" }); });
    t2 = await mk(t1.chrome.restart(), clock2);
    await clock2.advance(PORT_LIMITS.RECONNECT_RETRY_MS); await settle();
    const snap = port2!.sent[0] as { t: string; nonce: string; items: unknown[] };
    expect(snap).toMatchObject({ t: "snapshot", nonce: "b" });
    expect(snap.items).toHaveLength(3);
    expect(t2.chrome.local.writes).toBe(0);
  });
});
