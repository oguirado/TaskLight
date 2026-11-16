import { afterEach, describe, expect, it } from "vitest";
import { createAgentLink, type AgentLink } from "../../../src/app/agent_link";
import { EXT_ID, FakeAppClock, pageRuntime } from "../u37c/harness";

const links: AgentLink[] = [];
afterEach(() => { for (const link of links.splice(0)) link.stop(); });
const hello = { t: "room_hello", v: 1, agent: "wall-user", rooms: [{ room: "demo", floor: "ONLY_ON_DEVICE" }, { room: "other", floor: "PREFER_ON_DEVICE" }] };
function rig() {
  const clock = new FakeAppClock(); const rt = pageRuntime();
  const link = createAgentLink({ extId: EXT_ID, connect: rt.connect, clock, nonce: () => "u68", since: () => ({ demo: 0, other: 0 }), onRoomEvent: () => {}, onRoomHello: () => {} });
  links.push(link); link.start(); const p = rt.last();
  p.emit({ t: "snapshot", v: 1, nonce: "u68", items: [] }); clock.advance(1);
  p.emit(hello);
  const syncs = () => p.ofType("room_sync");
  const complete = (room = "demo", upto = 500, more = true, rid: unknown = syncs().at(-1)!["rid"]) => {
    p.emit({ t: "room_synced", v: 1, rid, room, upto, more });
    clock.advance(1);
  };
  return { clock, rt, link, p, syncs, complete };
}

describe("U68 room sync continuation", () => {
  it("A3 more true emits exactly one continuation from upto for that room only", () => {
    const r = rig(); const before = r.syncs().length;
    r.complete();
    expect(r.syncs()).toHaveLength(before + 1);
    expect(r.syncs().at(-1)).toMatchObject({ t: "room_sync", v: 1, since: { demo: 500 } });
    expect(Object.keys(r.syncs().at(-1)!["since"] as object)).toEqual(["demo"]);
  });

  it("A3 more false emits no continuation", () => {
    const r = rig(); const before = r.syncs().length;
    r.complete("demo", 500, false);
    expect(r.syncs()).toHaveLength(before);
  });

  it("M2 continues successive pages until the terminal response", () => {
    const r = rig(); const before = r.syncs().length;
    r.complete("demo", 500); r.complete("demo", 1000); r.complete("demo", 1500, false);
    expect(r.syncs().slice(before).map(m => m["since"])).toEqual([{ demo: 500 }, { demo: 1000 }]);
  });

  it("M2 duplicate completion cannot create a second in-flight continuation", () => {
    const r = rig(); const before = r.syncs().length;
    const rid = r.syncs().at(-1)!["rid"];
    r.complete("demo", 500, true, rid);
    r.complete("demo", 500, true, rid);
    expect(r.syncs().slice(before).map(m => m["since"])).toEqual([{ demo: 500 }]);
  });

  it("M2 rooms progress independently while another room has a continuation in flight", () => {
    const r = rig(); const before = r.syncs().length;
    const rid = r.syncs().at(-1)!["rid"];
    r.complete("demo", 500, true, rid); r.complete("other", 42, true, rid);
    expect(r.syncs().slice(before).map(m => m["since"])).toEqual([{ demo: 500 }, { other: 42 }]);
  });

  it("A4 always-more relay stops at exactly 64 continuations per cycle", () => {
    const r = rig(); const before = r.syncs().length;
    for (let i = 1; i <= 70; i++) r.complete("demo", i * 500);
    expect(r.syncs().slice(before)).toHaveLength(64);
    expect(r.syncs().at(-1)).toMatchObject({ since: { demo: 32000 } });
  });

  it("M3 exhaustion in one room does not exhaust another room", () => {
    const r = rig(); const before = r.syncs().length;
    const initial = r.syncs().at(-1)!["rid"];
    for (let i = 1; i <= 65; i++) r.complete("demo", i * 500);
    r.complete("other", 20, true, initial);
    expect(r.syncs().slice(before).filter(m => Object.hasOwn(m["since"] as object, "other"))).toHaveLength(1);
  });

  it("M3 a new hello starts a fresh bounded sync cycle", () => {
    const r = rig();
    for (let i = 1; i <= 65; i++) r.complete("demo", i * 500);
    r.p.emit(hello); const before = r.syncs().length;
    r.complete("demo", 500);
    expect(r.syncs().slice(before).map(m => m["since"])).toEqual([{ demo: 500 }]);
  });

  it.each([
    { upto: "500" }, { upto: 1.5 }, { upto: -1 }, { upto: NaN }, { upto: Infinity },
    { upto: null }, { upto: undefined }, { more: "true" }, { more: 1 }, { more: null }, { more: undefined },
    { room: "unknown" }, { room: "Bad Room" }, { room: null }, { v: 2 },
  ])("A5 malformed completion is ignored without throwing: %j", bad => {
    const r = rig(); const before = r.syncs().length;
    expect(() => {
      r.p.emit({ t: "room_synced", v: 1, rid: r.syncs().at(-1)!["rid"], room: "demo", upto: 500, more: true, ...bad });
      r.clock.advance(1);
    }).not.toThrow();
    expect(r.syncs()).toHaveLength(before);
  });

  it("A5 malformed completion does not poison a subsequent valid response", () => {
    const r = rig(); const before = r.syncs().length;
    r.p.emit({ t: "room_synced", v: 1, rid: r.syncs().at(-1)!["rid"], room: "demo", upto: "bad", more: true });
    r.complete();
    expect(r.syncs()).toHaveLength(before + 1);
  });

  it("M4 stopped link ignores completion and leaves no timers", () => {
    const r = rig(); const before = r.syncs().length;
    r.link.stop(); r.complete();
    expect(r.syncs()).toHaveLength(before);
    expect(r.clock.pending()).toBe(0);
  });

  it("M4 superseded port cannot trigger a continuation on the new port", () => {
    const r = rig(); const old = r.p;
    old.drop(); r.clock.advance(100);
    const current = r.rt.last();
    current.emit({ t: "snapshot", v: 1, nonce: "u68", items: [] }); r.clock.advance(1);
    const before = current.ofType("room_sync").length;
    old.emit({ t: "room_synced", v: 1, rid: "old", room: "demo", upto: 500, more: true }); r.clock.advance(1);
    expect(current.ofType("room_sync")).toHaveLength(before);
  });
});
