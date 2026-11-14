import { describe, it, expect } from "vitest";
import { createRouter } from "../../../extension/src/router";
import { createWallClient } from "../../../extension/src/client";
import { EXT_LIMITS } from "../../../extension/src/limits";
import type { RouterPort, QueuedEvent } from "../../../extension/src/types";
import type { ConnectorMsg } from "../../../src/app/types";
import { FakeClock, FakeSessionStore, SITE, settle, evt } from "./harness";

const SRC = { sentinel: "frame" };
async function setup(queued = 0) {
  const clock = new FakeClock(); const store = new FakeSessionStore();
  const wakers = new Set<() => void>();
  const router = createRouter({ store, clock, notify: () => wakers.forEach((f) => f()) });
  await router.load();
  for (let i = 0; i < queued; i++) await router.accept(evt(i));
  const committed: number[] = [];
  const port: RouterPort = {
    lease: (m) => router.lease(m),
    commit: async (ids) => { committed.push(...ids); await router.commit(ids); },
    onWake: (cb) => { wakers.add(cb); return () => { wakers.delete(cb); }; },
  };
  const posts: Array<{ m: ConnectorMsg; o: string }> = [];
  let k = 0;
  const client = createWallClient({
    ext: { siteOrigin: SITE, wallUrl: SITE + "/" }, frame: { postMessage: (m, o) => { posts.push({ m, o }); } },
    frameSource: SRC, router: port, clock, newNonce: () => `n${++k}`,
  });
  const ack = (nonce: string, origin = SITE, source: unknown = SRC) => client.onMessage({ origin, data: { t: "ack", v: 1, nonce }, source });
  const nack = (code: string, seq?: number) => client.onMessage({ origin: SITE, data: seq === undefined ? { t: "nack", v: 1, code } : { t: "nack", v: 1, code, seq }, source: SRC });
  const events = () => posts.filter((p) => p.m.t === "event").map((p) => p.m as Extract<ConnectorMsg, { t: "event" }>);
  const hellos = () => posts.filter((p) => p.m.t === "hello").map((p) => p.m as Extract<ConnectorMsg, { t: "hello" }>);
  return { clock, store, router, port, posts, client, ack, nack, events, hellos, committed };
}

describe("U13 wall client (B10-B16)", () => {
  it("O7 hello_first_exact_origin: first post is hello n1 to siteOrigin; 0 events before ack; never '*'", async () => {
    const s = await setup(3);
    s.client.start(); await settle();
    expect(s.posts[0]).toEqual({ m: { t: "hello", v: 1, nonce: "n1" }, o: SITE });
    expect(s.events()).toHaveLength(0);
    expect(s.client.state()).toMatchObject({ kind: "handshaking", nonce: "n1" });
    s.ack("n1"); await settle();
    expect(s.events()).toHaveLength(3);
    expect(s.posts.every((p) => p.o === SITE)).toBe(true);
    expect(s.posts.some((p) => p.o === "*")).toBe(false);
  });

  it("O8 reply_filter (neg): foreign origin, foreign source, wrong nonce all ignored; then correct ack links", async () => {
    const s = await setup(1);
    s.client.start(); await settle();
    s.ack("n1", "https://evil.test");
    s.ack("n1", SITE, { other: true });
    s.ack("zz");
    await settle();
    expect(s.client.state().kind).toBe("handshaking");
    expect(s.client.stats().ignoredReplies).toBe(3);
    expect(s.events()).toHaveLength(0);
    s.client.onMessage({ origin: SITE, data: { t: "ack", v: 2 }, source: SRC });
    s.client.onMessage({ origin: SITE, data: "garbage", source: SRC });
    expect(s.client.stats().ignoredReplies).toBe(5);
    s.ack("n1"); await settle();
    expect(s.client.state()).toMatchObject({ kind: "linked", nonce: "n1" });
  });

  it("O9 seq_per_handshake: seqs 1,2,3; re-handshake gets n2 and seq restarts at 1", async () => {
    const s = await setup(3);
    s.client.start(); await settle(); s.ack("n1"); await settle();
    expect(s.events().map((e) => e.seq)).toEqual([1, 2, 3]);
    s.nack("SEQ_NOT_MONOTONIC", 3); await settle();
    expect(s.hellos().map((h) => h.nonce)).toEqual(["n1", "n2"]);
    expect(s.client.state().kind).toBe("handshaking");
    s.ack("n2"); await settle();
    expect(s.events().map((e) => e.seq)).toEqual([1, 2, 3, 1]);
    expect((s.events()[3]!.payload as { n: number }).n).toBe(2);
  });

  it("B12 no event posted before linked even when events arrive later; seq strictly increasing", async () => {
    const s = await setup(0);
    s.client.start(); await settle();
    await s.router.accept(evt(1)); await settle();
    expect(s.events()).toHaveLength(0);
    s.ack("n1"); await settle();
    await s.router.accept(evt(2)); await settle();
    const seqs = s.events().map((e) => e.seq);
    expect(seqs).toEqual([1, 2]);
  });

  it("O10 pacing: 100 queued, clock frozen -> 40; +1000ms -> 80; all 100, each committed once, FIFO", async () => {
    const s = await setup(100);
    s.client.start(); await settle(); s.ack("n1"); await settle(10);
    expect(s.events()).toHaveLength(EXT_LIMITS.SEND_MAX_PER_SEC);
    await s.clock.advance(1000); await settle(10);
    expect(s.events()).toHaveLength(80);
    await s.clock.advance(1000); await settle(10);
    expect(s.events()).toHaveLength(100);
    expect(s.committed).toHaveLength(100);
    expect(new Set(s.committed).size).toBe(100);
    const ns = s.events().map((e) => (e.payload as { n: number }).n);
    expect(ns).toEqual([...Array(100).keys()]);
    expect((await s.router.lease(10))).toHaveLength(0);
  });

  it("B14 never more than 40 posts in any sliding 1000 ms window", async () => {
    const s = await setup(0);
    s.client.start(); await settle(); s.ack("n1"); await settle();
    const times: number[] = [];
    const orig = s.posts.push.bind(s.posts);
    s.posts.push = (...a) => { if (a[0]?.m.t === "event") times.push(s.clock.now()); return orig(...a); };
    for (let i = 0; i < 120; i++) { await s.router.accept(evt(i)); if (i % 10 === 9) await s.clock.advance(150); }
    await s.clock.advance(4000); await settle(10);
    expect(times).toHaveLength(120);
    for (let i = 0; i < times.length; i++) {
      const inWin = times.filter((t) => t > times[i]! - 1000 && t <= times[i]!).length;
      expect(inWin).toBeLessThanOrEqual(EXT_LIMITS.SEND_MAX_PER_SEC);
    }
  });

  it("O11 nack_policy: THROTTLED resent once after 1000ms with new seq; BAD_SHAPE dropped and counted", async () => {
    const s = await setup(3);
    s.client.start(); await settle(); s.ack("n1"); await settle();
    s.nack("THROTTLED", 2); s.nack("BAD_SHAPE", 3); await settle();
    await s.clock.advance(EXT_LIMITS.THROTTLE_RETRY_MS - 1);
    expect(s.events()).toHaveLength(3);
    await s.clock.advance(1);
    expect(s.events()).toHaveLength(4);
    const re = s.events()[3]!;
    expect(re.seq).toBe(4);
    expect((re.payload as { n: number }).n).toBe(1);
    await s.clock.advance(10_000);
    expect(s.events()).toHaveLength(4);
    expect(s.client.stats().nacked.BAD_SHAPE).toBe(1);
    expect(s.client.stats().nacked.THROTTLED).toBe(1);
    expect(s.client.state().kind).toBe("linked");
  });

  it("O12 hello_timeout: 6 hellos (1 + 5 retries) with fresh nonces, then unreachable; queue intact", async () => {
    const s = await setup(3);
    s.client.start(); await settle();
    for (let i = 0; i < EXT_LIMITS.HELLO_MAX_RETRIES; i++) await s.clock.advance(EXT_LIMITS.HELLO_TIMEOUT_MS);
    expect(s.hellos().map((h) => h.nonce)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6"]);
    expect(s.client.state().kind).toBe("handshaking");
    await s.clock.advance(EXT_LIMITS.HELLO_TIMEOUT_MS);
    expect(s.client.state()).toEqual({ kind: "unreachable", reason: "HELLO_TIMEOUT" });
    await s.clock.advance(60_000);
    expect(s.hellos()).toHaveLength(6);
    expect(s.events()).toHaveLength(0);
    expect(s.router.stats().depth).toBe(3);
  });

  it("B13 nack UNSUPPORTED_VERSION -> unreachable, no retry, queue kept", async () => {
    const s = await setup(2);
    s.client.start(); await settle();
    s.nack("UNSUPPORTED_VERSION"); await settle();
    expect(s.client.state()).toEqual({ kind: "unreachable", reason: "UNSUPPORTED_VERSION" });
    await s.clock.advance(60_000);
    expect(s.hellos()).toHaveLength(1);
    expect(s.router.stats().depth).toBe(2);
  });

  it("O13 panel_closed_buffering: 5 accepts with no client, then start+ack -> 5 posts in id order", async () => {
    const s = await setup(5);
    expect(s.posts).toHaveLength(0);
    s.client.start(); await settle(); s.ack("n1"); await settle();
    expect(s.events().map((e) => (e.payload as { n: number }).n)).toEqual([0, 1, 2, 3, 4]);
  });

  it("B8/B14 leases LEASE_MAX at a time", async () => {
    const s = await setup(40);
    let maxAsked = 0; const orig = s.port.lease;
    s.port.lease = (m) => { maxAsked = Math.max(maxAsked, m); return orig(m); };
    s.client.start(); await settle(); s.ack("n1"); await settle(10);
    expect(maxAsked).toBeLessThanOrEqual(EXT_LIMITS.LEASE_MAX);
    expect(maxAsked).toBeGreaterThan(0);
  });

  it("B16 stop() posts bye to siteOrigin, state closed, nothing more is sent", async () => {
    const s = await setup(2);
    s.client.start(); await settle(); s.ack("n1"); await settle();
    const n = s.posts.length;
    s.client.stop();
    expect(s.posts[n]).toEqual({ m: { t: "bye", v: 1 }, o: SITE });
    expect(s.client.state().kind).toBe("closed");
    await s.router.accept(evt(9)); await settle();
    expect(s.posts).toHaveLength(n + 1);
  });

  it("types: QueuedEvent import is used by the suite", () => { const q: QueuedEvent | undefined = undefined; expect(q).toBeUndefined(); });
});
