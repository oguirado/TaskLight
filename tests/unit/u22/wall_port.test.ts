import { describe, expect, it } from "vitest";
import { PORT_LIMITS, WALL_QUEUE_MAX, createWallPort } from "../../../src/app/wall_port";
import { EXT_ID, FakeClock, fakeRuntime } from "./harness";

function rig(rt = fakeRuntime()) {
  const clock = new FakeClock(); const raw: string[] = []; let n = 0;
  const wp = createWallPort({ extId: EXT_ID, connect: rt.connect, clock, onEvent: (r) => { raw.push(r); }, nonce: () => `n${++n}` });
  const snap = (nonce: string, items: Array<{ seq: number; projectId: string; payload: unknown }>) =>
    ({ t: "snapshot", v: 1, nonce, items });
  return { rt, clock, raw, wp, snap };
}
const ev = (seq: number, projectId = "p1") => ({ t: "event", v: 1, seq, projectId, payload: { seq } });
const parsed = (raw: string[]) => raw.map((r) => JSON.parse(r) as { t: string; seq: number; projectId: string });

describe("constants", () => {
  it("PORT_LIMITS [TARGET] + S4 ping", () => {
    expect(PORT_LIMITS).toEqual({ PING_MS: 20000, RECONNECT_RETRY_MS: 100, RECONNECT_MAX: 50 });
    expect(WALL_QUEUE_MAX).toBe(256);
  });
});

describe("connect + hello + resync (B23)", () => {
  it("start connects to extId, sends hello{v:1,nonce}, state resyncing", () => {
    const r = rig(); r.wp.start();
    expect(r.rt.ids).toEqual([EXT_ID]);
    expect(r.rt.last().sent).toEqual([{ t: "hello", v: 1, nonce: "n1" }]);
    expect(r.wp.state()).toEqual({ kind: "resyncing", nonce: "n1" });
  });
  it("matching snapshot -> linked; items delivered in order as raw event JSON", () => {
    const r = rig(); r.wp.start();
    r.rt.last().emit(r.snap("n1", [{ seq: 1, projectId: "a", payload: 1 }, { seq: 1, projectId: "b", payload: 2 }, { seq: 4, projectId: "c", payload: 3 }]));
    expect(r.wp.state()).toEqual({ kind: "linked", nonce: "n1" });
    expect(parsed(r.raw).map((x) => x.projectId)).toEqual(["a", "b", "c"]);
    expect(parsed(r.raw).every((x) => x.t === "event")).toBe(true);
    expect(r.wp.stats().snapshotsApplied).toBe(1);
  });
  it("snapshot with a stale/foreign nonce is ignored", () => {
    const r = rig(); r.wp.start();
    r.rt.last().emit(r.snap("other", [{ seq: 1, projectId: "a", payload: 1 }]));
    expect(r.wp.state()).toEqual({ kind: "resyncing", nonce: "n1" });
    expect(r.raw).toEqual([]);
    expect(r.wp.stats().snapshotsApplied).toBe(0);
  });
  it("linked: live events pass through; malformed/unknown messages are ignored without throwing", () => {
    const r = rig(); r.wp.start(); const p = r.rt.last();
    p.emit(r.snap("n1", []));
    p.emit(ev(2));
    for (const junk of ["str", null, 5, [], { t: "boom", v: 1 }, { t: "event", v: 2, seq: 3, projectId: "p", payload: 1 },
      { t: "event", v: 1, seq: "x", projectId: "p" }, { t: "pong", v: 1 }, { t: "snapshot", v: 1, nonce: "n1", items: "no" }])
      expect(() => p.emit(junk)).not.toThrow();
    expect(parsed(r.raw)).toHaveLength(1);
    expect(r.wp.state()).toEqual({ kind: "linked", nonce: "n1" });
  });
});

describe("bounded queue while resyncing", () => {
  it("events before the snapshot are queued then flushed after the snapshot items", () => {
    const r = rig(); r.wp.start(); const p = r.rt.last();
    p.emit(ev(7, "q1")); p.emit(ev(8, "q2"));
    expect(r.raw).toEqual([]);
    p.emit(r.snap("n1", [{ seq: 1, projectId: "s1", payload: 0 }]));
    expect(parsed(r.raw).map((x) => x.projectId)).toEqual(["s1", "q1", "q2"]);
  });
  it("over WALL_QUEUE_MAX: oldest dropped first, count reported, memory bounded", () => {
    const r = rig(); r.wp.start(); const p = r.rt.last();
    const total = WALL_QUEUE_MAX + 44;
    for (let i = 1; i <= total; i++) p.emit(ev(i));
    p.emit(r.snap("n1", []));
    const got = parsed(r.raw);
    expect(got).toHaveLength(WALL_QUEUE_MAX);
    expect(got[0]!.seq).toBe(45); expect(got[got.length - 1]!.seq).toBe(total);
    expect(r.wp.stats().queueDropped).toBe(44);
  });
  it("queue is discarded on disconnect (stale events are not replayed after reconnect)", () => {
    const r = rig(); r.wp.start(); r.rt.last().emit(ev(1)); r.rt.last().drop(); r.clock.advance(100);
    r.rt.last().emit(r.snap("n2", []));
    expect(r.raw).toEqual([]);
  });
});

describe("reconnect + snapshot resend (A6, S4)", () => {
  it("drop -> connecting; retry within RECONNECT_RETRY_MS (not synchronous); new hello with a new nonce", () => {
    const r = rig(); r.wp.start(); r.rt.last().emit(r.snap("n1", []));
    r.rt.last().drop();
    expect(r.wp.state()).toMatchObject({ kind: "connecting" });
    expect(r.rt.ports).toHaveLength(1);
    r.clock.advance(PORT_LIMITS.RECONNECT_RETRY_MS);
    expect(r.rt.ports).toHaveLength(2);
    expect(r.rt.last().sent).toEqual([{ t: "hello", v: 1, nonce: "n2" }]);
    expect(r.wp.state()).toEqual({ kind: "resyncing", nonce: "n2" });
    expect(r.wp.stats().reconnects).toBe(1);
  });
  it("3 projects re-delivered from the resent snapshot; state returns to linked; old-nonce snapshot ignored", () => {
    const r = rig(); r.wp.start(); const p1 = r.rt.last();
    const items = ["a", "b", "c"].map((projectId, i) => ({ seq: i + 1, projectId, payload: i }));
    p1.emit(r.snap("n1", items)); expect(r.raw).toHaveLength(3);
    p1.drop(); r.clock.advance(100);
    const p2 = r.rt.last();
    p2.emit(r.snap("n1", items)); expect(r.raw).toHaveLength(3);
    p2.emit(r.snap("n2", items));
    expect(r.wp.state()).toEqual({ kind: "linked", nonce: "n2" });
    expect(parsed(r.raw).slice(3).map((x) => x.projectId)).toEqual(["a", "b", "c"]);
    expect(r.wp.stats()).toMatchObject({ reconnects: 1, snapshotsApplied: 2 });
  });
  it("messages arriving on the dead port are ignored", () => {
    const r = rig(); r.wp.start(); const p1 = r.rt.last(); p1.emit(r.snap("n1", []));
    p1.drop(); r.clock.advance(100); r.rt.last().emit(r.snap("n2", []));
    p1.emit(ev(9));
    expect(r.raw).toEqual([]);
  });
  it("RETRIES_EXHAUSTED after RECONNECT_MAX failed retries; then no more connects", async () => {
    const r = rig(fakeRuntime({ autoDrop: true })); r.wp.start();
    for (let i = 0; i < 200; i++) { await Promise.resolve(); r.clock.advance(100); await Promise.resolve(); }
    expect(r.wp.state()).toEqual({ kind: "unreachable", reason: "RETRIES_EXHAUSTED" });
    expect(r.rt.ids).toHaveLength(1 + PORT_LIMITS.RECONNECT_MAX);
    r.clock.advance(60_000);
    expect(r.rt.ids).toHaveLength(1 + PORT_LIMITS.RECONNECT_MAX);
  });
  it("a successful link resets the retry budget", async () => {
    const r = rig(); r.wp.start();
    for (let i = 0; i < 40; i++) { r.rt.last().drop(); r.clock.advance(100); }
    r.rt.last().emit(r.snap(`n${r.rt.ports.length}`, []));
    expect(r.wp.state().kind).toBe("linked");
    for (let i = 0; i < 40; i++) { r.rt.last().drop(); r.clock.advance(100); }
    expect(r.wp.state().kind).not.toBe("unreachable");
  });
});

describe("NOT_LISTED", () => {
  it("connect throwing -> unreachable NOT_LISTED immediately, never retried", () => {
    const r = rig(fakeRuntime({ throwOnConnect: true }));
    expect(() => r.wp.start()).not.toThrow();
    expect(r.wp.state()).toEqual({ kind: "unreachable", reason: "NOT_LISTED" });
    r.clock.advance(60_000);
    expect(r.rt.ids).toHaveLength(1);
  });
});

describe("A7 ping cadence (20 s keep-alive)", () => {
  it("none before linked; exactly 2 in the first 59 999 ms after link", () => {
    const r = rig(); r.wp.start();
    r.clock.advance(25_000);
    expect(r.rt.last().ofType("ping")).toHaveLength(0);
    r.rt.last().emit(r.snap("n1", []));
    r.clock.advance(59_999);
    expect(r.rt.last().ofType("ping")).toEqual([{ t: "ping", v: 1 }, { t: "ping", v: 1 }]);
    expect(r.wp.stats().pings).toBe(2);
  });
  it("first ping at link+20 000, not earlier", () => {
    const r = rig(); r.wp.start(); r.rt.last().emit(r.snap("n1", []));
    r.clock.advance(19_999); expect(r.rt.last().ofType("ping")).toHaveLength(0);
    r.clock.advance(1); expect(r.rt.last().ofType("ping")).toHaveLength(1);
  });
  it("pings stop on drop, resume after relink on the new port", () => {
    const r = rig(); r.wp.start(); const p1 = r.rt.last(); p1.emit(r.snap("n1", []));
    r.clock.advance(20_000); p1.drop(); r.clock.advance(100);
    r.clock.advance(60_000);
    expect(p1.ofType("ping")).toHaveLength(1);
    expect(r.rt.last().ofType("ping")).toHaveLength(0);
    r.rt.last().emit(r.snap("n2", [])); r.clock.advance(20_000);
    expect(r.rt.last().ofType("ping")).toHaveLength(1);
  });
});

describe("stop()", () => {
  it("disconnects, stops pings and retries, ignores later messages", () => {
    const r = rig(); r.wp.start(); const p = r.rt.last(); p.emit(r.snap("n1", []));
    r.wp.stop();
    expect(p.disconnected).toBe(true);
    r.clock.advance(120_000);
    expect(p.ofType("ping")).toHaveLength(0);
    p.emit(ev(1)); expect(r.raw).toEqual([]);
    p.drop(); r.clock.advance(1000);
    expect(r.rt.ports).toHaveLength(1);
  });
  it("stop during connecting cancels the pending retry", () => {
    const r = rig(); r.wp.start(); r.rt.last().drop(); r.wp.stop(); r.clock.advance(1000);
    expect(r.rt.ports).toHaveLength(1);
  });
});
