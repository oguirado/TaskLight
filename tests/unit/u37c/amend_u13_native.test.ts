// U37c AMEND_W (U13): createNativeRelay reconnect/backoff, send()/onFrame()/connected(), only t==="event" -> Router.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeRelay } from "../../../extension/native/relay";
import { FakePort, HOST } from "../u13/harness";
import type { NativeRelayAmended } from "./harness";

const EV = { t: "event", v: 1, seq: 1, projectId: "p1", payload: { n: 1 } };
interface Rig { relay: NativeRelayAmended; ports: FakePort[]; accept: ReturnType<typeof vi.fn>; failConnect: { n: number } }
function rig(maxFrameChars = 65536): Rig {
  const ports: FakePort[] = []; const failConnect = { n: 0 };
  const accept = vi.fn(async () => ({ ok: true as const, id: 1, evictedIds: [] as number[] }));
  const relay = createNativeRelay({ hostName: HOST, maxFrameChars }, {
    connectNative: () => { if (failConnect.n > 0) { failConnect.n--; throw new Error("host not found"); } const p = new FakePort(); ports.push(p); return p; },
    router: { accept },
  }) as unknown as NativeRelayAmended;
  return { relay, ports, accept, failConnect };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("reconnect with backoff 100 ms -> 5 s", () => {
  it("host exit: reconnects after exactly 100 ms (not before), a fresh port is used", () => {
    const r = rig(); r.relay.start();
    expect(r.ports).toHaveLength(1);
    r.ports[0]!.peerClose();
    vi.advanceTimersByTime(99);
    expect(r.ports).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(r.ports).toHaveLength(2);
  });
  it("consecutive failures back off 100, 200, 400, 800, 1600, 3200, then cap at 5000 ms", () => {
    const r = rig(); r.relay.start();
    const delays = [100, 200, 400, 800, 1600, 3200, 5000, 5000];
    delays.forEach((d, i) => {
      r.ports[i]!.peerClose();
      vi.advanceTimersByTime(d - 1);
      expect(r.ports, `before ${d} ms (attempt ${i})`).toHaveLength(i + 1);
      vi.advanceTimersByTime(1);
      expect(r.ports, `at ${d} ms (attempt ${i})`).toHaveLength(i + 2);
    });
  });
  it("connectNative throwing is also retried with backoff and never escapes start()", () => {
    const r = rig(); r.failConnect.n = 2;
    expect(() => { r.relay.start(); }).not.toThrow();
    expect(r.ports).toHaveLength(0);
    vi.advanceTimersByTime(100);          // attempt 2 fails
    expect(r.ports).toHaveLength(0);
    vi.advanceTimersByTime(199); expect(r.ports).toHaveLength(0);
    vi.advanceTimersByTime(1);            // attempt 3 (200 ms later) succeeds
    expect(r.ports).toHaveLength(1);
  });
  it("a delivered frame proves the link: the next disconnect restarts at 100 ms", () => {
    const r = rig(); r.relay.start();
    r.ports[0]!.peerClose(); vi.advanceTimersByTime(100);
    r.ports[1]!.peerClose(); vi.advanceTimersByTime(200);
    expect(r.ports).toHaveLength(3);
    r.ports[2]!.emit(EV);
    r.ports[2]!.peerClose();
    vi.advanceTimersByTime(99); expect(r.ports).toHaveLength(3);
    vi.advanceTimersByTime(1); expect(r.ports).toHaveLength(4);
  });
  it("stop() cancels a pending reconnect and a later disconnect never reconnects", () => {
    const r = rig(); r.relay.start();
    r.ports[0]!.peerClose();
    r.relay.stop();
    vi.advanceTimersByTime(60_000);
    expect(r.ports).toHaveLength(1);
    const r2 = rig(); r2.relay.start(); r2.relay.stop(); r2.ports[0]!.peerClose();
    vi.advanceTimersByTime(60_000);
    expect(r2.ports).toHaveLength(1);
  });
  it("frames from a superseded port are ignored after reconnect", () => {
    const r = rig(); r.relay.start();
    const old = r.ports[0]!; old.peerClose(); vi.advanceTimersByTime(100);
    old.emit(EV);
    expect(r.accept).not.toHaveBeenCalled();
    r.ports[1]!.emit(EV);
    expect(r.accept).toHaveBeenCalledTimes(1);
  });
  it("start() is still idempotent (one connectNative) and a single disconnect yields a single reconnect", () => {
    const r = rig(); r.relay.start(); r.relay.start();
    r.ports[0]!.peerClose(); vi.advanceTimersByTime(100);
    expect(r.ports).toHaveLength(2);
    vi.advanceTimersByTime(100);
    expect(r.ports).toHaveLength(2);
  });
});

describe("send() / onFrame() / connected()", () => {
  it("send() posts to the live native port and returns true; false (no throw) before start, after disconnect and after stop", () => {
    const r = rig();
    expect(r.relay.connected()).toBe(false);
    expect(r.relay.send({ t: "room_sync" })).toBe(false);
    r.relay.start();
    expect(r.relay.connected()).toBe(true);
    expect(r.relay.send({ t: "room_sync", v: 1, rid: "a", since: {} })).toBe(true);
    expect(r.ports[0]!.sent).toEqual([{ t: "room_sync", v: 1, rid: "a", since: {} }]);
    r.ports[0]!.peerClose();
    expect(r.relay.connected()).toBe(false);
    expect(r.relay.send({ t: "x" })).toBe(false);
    vi.advanceTimersByTime(100);
    expect(r.relay.connected()).toBe(true);
    expect(r.relay.send({ t: "y" })).toBe(true);
    expect(r.ports[1]!.sent).toEqual([{ t: "y" }]);
    r.relay.stop();
    expect(r.relay.connected()).toBe(false);
    expect(r.relay.send({ t: "z" })).toBe(false);
  });
  it("send() returns false when the port's postMessage throws", () => {
    const r = rig(); r.relay.start();
    r.ports[0]!.postMessage = () => { throw new Error("closed"); };
    expect(r.relay.send({ t: "x" })).toBe(false);
  });
  it("onFrame listeners receive room frames, survive reconnects, can unsubscribe, and a throwing listener does not break others", () => {
    const r = rig(); r.relay.start();
    const a = vi.fn(); const b = vi.fn(); const bad = vi.fn(() => { throw new Error("listener"); });
    r.relay.onFrame(bad); r.relay.onFrame(a); const offB = r.relay.onFrame(b);
    const room = { t: "room_event", v: 1, room: "demo", floor: "ONLY_ON_DEVICE", event: { id: "e-0000000000000001" } };
    r.ports[0]!.emit(room);
    expect(a).toHaveBeenCalledWith(room); expect(b).toHaveBeenCalledWith(room);
    offB();
    r.ports[0]!.peerClose(); vi.advanceTimersByTime(100);
    r.ports[1]!.emit({ ...room, v: 1, room: "other" });
    expect(a).toHaveBeenCalledTimes(2); expect(b).toHaveBeenCalledTimes(1);
  });
  it("frames over maxFrameChars reach neither Router nor onFrame", () => {
    const r = rig(1000); r.relay.start();
    const cb = vi.fn(); r.relay.onFrame(cb);
    r.ports[0]!.emit({ t: "room_event", pad: "x".repeat(2000) });
    r.ports[0]!.emit({ ...EV, payload: { pad: "x".repeat(2000) } });
    expect(cb).not.toHaveBeenCalled(); expect(r.accept).not.toHaveBeenCalled();
    expect(r.relay.stats().dropped).toBe(2);
  });
});

describe("only t===\"event\" frames reach the Router", () => {
  it.each([
    ["room_event", { t: "room_event", v: 1, room: "demo", floor: "ONLY_ON_DEVICE", event: {} }],
    ["room_hello", { t: "room_hello", v: 1, rooms: [], agent: "wall-user" }],
    ["room_synced", { t: "room_synced", v: 1, rid: "a", room: "demo", upto: 1, more: false }],
    ["room_ack", { t: "room_ack", v: 1, rid: "a", id: "e-0000000000000001", lamport: 1 }],
    ["room_nack", { t: "room_nack", v: 1, rid: "a", code: "x" }],
    ["hello", { t: "hello", v: 1, projects: [] }],
    ["t-less frame with projectId+payload", { projectId: "p1", payload: { n: 1 } }],
    ["t not a string", { t: 5, projectId: "p1", payload: {} }],
    ["room frame that also carries projectId+payload", { t: "room_event", projectId: "p1", payload: {} }],
  ])("%s does not reach Router.accept", (_n, frame) => {
    const r = rig(); r.relay.start();
    r.ports[0]!.emit(frame);
    expect(r.accept).not.toHaveBeenCalled();
  });
  it("a t:\"event\" frame is accepted by the Router exactly once and counted", async () => {
    const r = rig(); r.relay.start();
    r.ports[0]!.emit(EV);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.accept).toHaveBeenCalledTimes(1);
    expect(r.accept).toHaveBeenCalledWith(EV);
    expect(r.relay.stats()).toMatchObject({ frames: 1, accepted: 1, dropped: 0 });
  });
  it("non-event frames are counted as frames but never as rejected/accepted by the Router", () => {
    const r = rig(); r.relay.start();
    r.ports[0]!.emit({ t: "room_hello", v: 1, rooms: [], agent: "a" });
    expect(r.relay.stats()).toMatchObject({ frames: 1, accepted: 0, rejected: 0, dropped: 0 });
  });
});

describe("existing contract kept", () => {
  it("still throws RangeError for a bad maxFrameChars", () => {
    expect(() => createNativeRelay({ hostName: HOST, maxFrameChars: 0 }, { connectNative: () => new FakePort(), router: { accept: vi.fn() } })).toThrow(RangeError);
  });
});
