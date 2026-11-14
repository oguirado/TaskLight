// U37c oracle: src/app/agent_link.ts createAgentLink (SPEC_U37 "U37c"). Red until implemented.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentLink, type AgentLink, type PostResult } from "../../../src/app/agent_link";
import { EXT_ID, FakeAppClock, PagePort, ROOM, idOf, pageRuntime, roomEvent, settle } from "./harness";

const FLOOR = "ONLY_ON_DEVICE" as const;
const HELLO = { t: "room_hello", v: 1, rooms: [{ room: ROOM, floor: FLOOR }], agent: "wall-user" };
const RID_RE = /^[A-Za-z0-9_-]{1,64}$/;
interface Rig { link: AgentLink; clock: FakeAppClock; rt: ReturnType<typeof pageRuntime>; since: ReturnType<typeof vi.fn>; onRoomEvent: ReturnType<typeof vi.fn>; onRoomHello: ReturnType<typeof vi.fn>; onWallEvent: ReturnType<typeof vi.fn> }
let r: Rig;
function make(over: Record<string, unknown> = {}): Rig {
  const clock = new FakeAppClock(); const rt = pageRuntime();
  const since = vi.fn(() => ({ [ROOM]: 3 })); const onRoomEvent = vi.fn(); const onRoomHello = vi.fn(); const onWallEvent = vi.fn();
  const link = createAgentLink({ extId: EXT_ID, connect: rt.connect, clock, nonce: () => "nonce-1", since, onRoomEvent, onRoomHello, onWallEvent, ...over } as Parameters<typeof createAgentLink>[0]);
  return { link, clock, rt, since, onRoomEvent, onRoomHello, onWallEvent };
}
/** start + complete the wall-port handshake on the latest port, then run the +1 tick. */
function linkUp(rig: Rig, items: unknown[] = []): PagePort {
  rig.link.start();
  const p = rig.rt.last();
  p.emit({ t: "snapshot", v: 1, nonce: "nonce-1", items });
  rig.clock.advance(1);
  return p;
}
beforeEach(() => { r = make(); });
afterEach(() => { r.link.stop(); });

describe("wraps createWallPort", () => {
  it("start() connects to the extension id and sends hello with the injected nonce; state() delegates", () => {
    r.link.start();
    expect(r.rt.ids).toEqual([EXT_ID]);
    expect(r.rt.last().ofType("hello")).toEqual([{ t: "hello", v: 1, nonce: "nonce-1" }]);
    expect(r.link.state()).toEqual({ kind: "resyncing", nonce: "nonce-1" });
    r.rt.last().emit({ t: "snapshot", v: 1, nonce: "nonce-1", items: [] });
    expect(r.link.state()).toEqual({ kind: "linked", nonce: "nonce-1" });
  });
  it("keeps the wall-port behaviours: reconnect after a drop (100 ms), 20 s ping once linked", () => {
    linkUp(r);
    r.clock.advance(20_000);
    expect(r.rt.last().ofType("ping")).toHaveLength(1);
    r.rt.last().drop(); r.clock.advance(100);
    expect(r.rt.ports).toHaveLength(2);
  });
  it("stop() disconnects the port and leaves no timers", () => {
    const p = linkUp(r);
    r.link.stop();
    expect(p.disconnected).toBe(true);
    expect(r.clock.pending()).toBe(0);
  });
});

describe("onWallEvent passthrough", () => {
  it("snapshot items and live events reach onWallEvent as the raw event JSON string (wall port format)", () => {
    linkUp(r, [{ seq: 1, projectId: "p1", payload: { a: 1 } }]);
    r.rt.last().emit({ t: "event", v: 1, seq: 2, projectId: "p1", payload: { a: 2 } });
    const raws = r.onWallEvent.mock.calls.map((c) => JSON.parse(c[0] as string) as Record<string, unknown>);
    expect(raws).toEqual([
      { t: "event", v: 1, seq: 1, projectId: "p1", payload: { a: 1 } },
      { t: "event", v: 1, seq: 2, projectId: "p1", payload: { a: 2 } },
    ]);
  });
  it("room_* frames never reach onWallEvent (not `event`, not buffered by the wall-port resync queue)", () => {
    r.link.start();
    const p = r.rt.last();
    p.emit({ t: "room_event", v: 1, room: ROOM, floor: FLOOR, event: roomEvent(1) }); // while resyncing
    p.emit({ t: "snapshot", v: 1, nonce: "nonce-1", items: [] });
    r.clock.advance(1);
    p.emit(HELLO); p.emit({ t: "room_synced", v: 1, rid: "x", room: ROOM, upto: 1, more: false });
    expect(r.onWallEvent).not.toHaveBeenCalled();
  });
  it("works without onWallEvent", () => {
    const x = make({ onWallEvent: undefined });
    expect(() => { linkUp(x, [{ seq: 1, projectId: "p", payload: 1 }]); }).not.toThrow();
    x.link.stop();
  });
});

describe("room_sync scheduling", () => {
  it("after the snapshot, +1 tick, when linked: one room_sync {since()} with a valid rid", () => {
    const p = linkUp(r);
    const syncs = p.ofType("room_sync");
    expect(syncs).toHaveLength(1);
    expect(syncs[0]).toMatchObject({ t: "room_sync", v: 1, since: { [ROOM]: 3 } });
    expect(String(syncs[0]!["rid"])).toMatch(RID_RE);
  });
  it("since() is read at send time (fresh value on each room_sync)", () => {
    const p = linkUp(r);
    r.since.mockReturnValue({ [ROOM]: 9, other: 2 });
    p.emit(HELLO); r.clock.advance(1);
    // U38 G1: since covers the rooms listed in the latest room_hello (HELLO lists only ROOM), each read fresh from since() at send time.
    expect(p.ofType("room_sync").at(-1)).toMatchObject({ since: { [ROOM]: 9 } });
  });
  it("no room_sync when the snapshot is not accepted (wrong nonce) or the port dropped before the tick", () => {
    r.link.start();
    const p = r.rt.last();
    p.emit({ t: "snapshot", v: 1, nonce: "WRONG", items: [] });
    r.clock.advance(5);
    expect(p.ofType("room_sync")).toEqual([]);
    const y = make(); y.link.start(); const q = y.rt.last();
    q.emit({ t: "snapshot", v: 1, nonce: "nonce-1", items: [] });
    q.drop();
    y.clock.advance(1);
    expect(q.ofType("room_sync")).toEqual([]);
    y.link.stop();
  });
  it("every room_hello triggers a room_sync (each time) and onRoomHello(frame)", () => {
    const p = linkUp(r);
    p.emit(HELLO); p.emit(HELLO);
    r.clock.advance(1);
    expect(p.ofType("room_sync")).toHaveLength(3);
    expect(r.onRoomHello).toHaveBeenCalledTimes(2);
    expect(r.onRoomHello).toHaveBeenCalledWith(HELLO);
  });
  it("a reconnect re-runs the sequence on the new port (hello -> snapshot -> room_sync)", () => {
    linkUp(r);
    r.rt.last().drop(); r.clock.advance(100);
    const p2 = r.rt.last();
    expect(p2.ofType("hello")).toHaveLength(1);
    p2.emit({ t: "snapshot", v: 1, nonce: "nonce-1", items: [] }); r.clock.advance(1);
    expect(p2.ofType("room_sync")).toHaveLength(1);
  });
});

describe("only the latest port is trusted", () => {
  it("frames from a superseded port are ignored (room_event, room_hello, room_ack); the new port's frames work", () => {
    linkUp(r);
    const old = r.rt.last();
    old.drop(); r.clock.advance(100);
    const cur = r.rt.last();
    cur.emit({ t: "snapshot", v: 1, nonce: "nonce-1", items: [] }); r.clock.advance(1);
    const before = cur.ofType("room_sync").length;
    old.emit({ t: "room_event", v: 1, room: ROOM, floor: FLOOR, event: roomEvent(1) });
    old.emit(HELLO);
    expect(r.onRoomEvent).not.toHaveBeenCalled();
    expect(r.onRoomHello).not.toHaveBeenCalled();
    expect(cur.ofType("room_sync")).toHaveLength(before);
    expect(old.ofType("room_sync")).toHaveLength(1); // only the one sent before the drop
    cur.emit({ t: "room_event", v: 1, room: ROOM, floor: FLOOR, event: roomEvent(2) });
    expect(r.onRoomEvent).toHaveBeenCalledTimes(1);
  });
  it("a stale port's ack cannot resolve a post", async () => {
    const old = linkUp(r);
    const pr = r.link.post({ room: ROOM, text: "hi" });
    const rid = old.ofType("room_post")[0]!["rid"];
    old.drop(); r.clock.advance(100);
    old.emit({ t: "room_ack", v: 1, rid, id: idOf(1), lamport: 1 });
    r.clock.advance(5000);
    expect((await pr).ok).toBe(false);
  });
});

describe("room frames to callbacks", () => {
  it("room_event (live or replay, with/without rid) -> onRoomEvent(frame) unchanged", () => {
    const p = linkUp(r);
    const live = { t: "room_event", v: 1, room: ROOM, floor: "PREFER_ON_DEVICE", event: roomEvent(1) };
    const replay = { t: "room_event", v: 1, room: ROOM, floor: FLOOR, event: roomEvent(2), rid: "x" };
    p.emit(live); p.emit(replay);
    expect(r.onRoomEvent.mock.calls.map((c) => c[0])).toEqual([live, replay]);
  });
  it.each([
    ["event not an object", { t: "room_event", v: 1, room: ROOM, floor: FLOOR, event: "x" }],
    ["bad room slug", { t: "room_event", v: 1, room: "Bad Room", floor: FLOOR, event: {} }],
    ["bad floor", { t: "room_event", v: 1, room: ROOM, floor: "NOPE", event: {} }],
    ["v=2", { t: "room_event", v: 2, room: ROOM, floor: FLOOR, event: {} }],
  ])("malformed room_event (%s) is ignored", (_n, f) => {
    const p = linkUp(r); p.emit(f);
    expect(r.onRoomEvent).not.toHaveBeenCalled();
  });
  it("a throwing onRoomEvent / onRoomHello does not break the link", () => {
    const x = make({ onRoomEvent: vi.fn(() => { throw new Error("cb"); }), onRoomHello: vi.fn(() => { throw new Error("cb"); }) });
    const p = linkUp(x);
    expect(() => { p.emit({ t: "room_event", v: 1, room: ROOM, floor: FLOOR, event: roomEvent(1) }); p.emit(HELLO); }).not.toThrow();
    expect(x.link.state().kind).toBe("linked");
    x.link.stop();
  });
});

describe("post()", () => {
  const sentPost = (p: PagePort, i = 0) => p.ofType("room_post")[i]!;
  it("sends room_post {rid,room,act:question,text,to?,re?} (no undefined keys) and resolves {ok:true,id,lamport} on room_ack", async () => {
    const p = linkUp(r);
    const pr = r.link.post({ room: ROOM, text: "hello", to: "worker-1", re: idOf(2) });
    const f = sentPost(p);
    expect(f).toMatchObject({ t: "room_post", v: 1, room: ROOM, act: "question", text: "hello", to: "worker-1", re: idOf(2) });
    expect(String(f["rid"])).toMatch(RID_RE);
    p.emit({ t: "room_ack", v: 1, rid: f["rid"], id: idOf(7), lamport: 7 });
    await expect(pr).resolves.toEqual({ ok: true, id: idOf(7), lamport: 7 });
  });
  it("omits to/re keys when absent", async () => {
    const p = linkUp(r); void r.link.post({ room: ROOM, text: "x" });
    expect(Object.keys(sentPost(p)).sort()).toEqual(["act", "rid", "room", "t", "text", "v"]);
  });
  it("resolves {ok:false,code} on room_nack, passing the code through (host_unavailable, rate_limited, room_not_allowed...)", async () => {
    const p = linkUp(r);
    for (const code of ["host_unavailable", "rate_limited", "room_not_allowed"]) {
      const pr = r.link.post({ room: ROOM, text: code });
      p.emit({ t: "room_nack", v: 1, rid: p.ofType("room_post").at(-1)!["rid"], code });
      await expect(pr).resolves.toEqual({ ok: false, code });
    }
  });
  it("concurrent posts get distinct rids and resolve independently, out of order", async () => {
    const p = linkUp(r);
    const a = r.link.post({ room: ROOM, text: "a" }); const b = r.link.post({ room: ROOM, text: "b" });
    const [fa, fb] = [sentPost(p, 0), sentPost(p, 1)];
    expect(fa["rid"]).not.toBe(fb["rid"]);
    p.emit({ t: "room_nack", v: 1, rid: fb["rid"], code: "rate_limited" });
    p.emit({ t: "room_ack", v: 1, rid: fa["rid"], id: idOf(1), lamport: 1 });
    await expect(a).resolves.toEqual({ ok: true, id: idOf(1), lamport: 1 });
    await expect(b).resolves.toEqual({ ok: false, code: "rate_limited" });
  });
  it("times out at 5 s with {ok:false,code:\"timeout\"}: pending at 4999 ms, resolved at 5000 ms; a late ack is ignored; timer is gone", async () => {
    const p = linkUp(r);
    let res: PostResult | undefined;
    const pr = r.link.post({ room: ROOM, text: "slow" }).then((x) => { res = x; });
    r.clock.advance(4999); await settle();
    expect(res).toBeUndefined();
    r.clock.advance(1); await pr;
    expect(res).toEqual({ ok: false, code: "timeout" });
    p.emit({ t: "room_ack", v: 1, rid: sentPost(p)["rid"], id: idOf(1), lamport: 1 });
    expect(res).toEqual({ ok: false, code: "timeout" });
  });
  it("an ack clears the timeout timer (no leaked timers once the 20 s ping is the only one)", async () => {
    const p = linkUp(r);
    const base = r.clock.pending();
    const pr = r.link.post({ room: ROOM, text: "x" });
    expect(r.clock.pending()).toBe(base + 1);
    p.emit({ t: "room_ack", v: 1, rid: sentPost(p)["rid"], id: idOf(1), lamport: 1 });
    await pr;
    expect(r.clock.pending()).toBe(base);
  });
  it("ack with an unknown rid or malformed ack does not resolve anything", async () => {
    const p = linkUp(r);
    let done = false; const pr = r.link.post({ room: ROOM, text: "x" }).then((x) => { done = true; return x; });
    p.emit({ t: "room_ack", v: 1, rid: "other", id: idOf(1), lamport: 1 });
    p.emit({ t: "room_ack", v: 1, rid: sentPost(p)["rid"], id: 5, lamport: "x" });
    p.emit({ t: "room_nack", v: 1, rid: sentPost(p)["rid"] });
    await settle(); expect(done).toBe(false);
    r.clock.advance(5000);
    await expect(pr).resolves.toEqual({ ok: false, code: "timeout" });
  });
  it("never rejects: not started, not linked, unreachable, throwing port -> resolves {ok:false, code:string}", async () => {
    const idle = make();
    const r0 = await idle.link.post({ room: ROOM, text: "x" });
    expect(r0.ok).toBe(false);
    const half = make(); half.link.start(); // resyncing, no snapshot yet
    const p1 = half.link.post({ room: ROOM, text: "x" }); half.clock.advance(5000);
    expect((await p1).ok).toBe(false);
    const bad = make(); const port = linkUp(bad); port.throwOnPost = true;
    const p2 = bad.link.post({ room: ROOM, text: "x" }); bad.clock.advance(5000);
    const r2 = await p2;
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(typeof r2.code).toBe("string");
    for (const x of [idle, half, bad]) x.link.stop();
  });
  it("stop() settles pending posts as {ok:false} (never left hanging) and leaves no timers", async () => {
    linkUp(r);
    const pr = r.link.post({ room: ROOM, text: "x" });
    r.link.stop();
    expect((await pr).ok).toBe(false);
    expect(r.clock.pending()).toBe(0);
  });
});
