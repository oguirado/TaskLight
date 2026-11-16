import { describe, expect, it } from "vitest";
import { createAgentRelay } from "../../../extension/src/agent_relay";
import { createAgentLink } from "../../../src/app/agent_link";
import { EXT_ID, ExtPort, FakeNative, FakeExtClock, FakeAppClock, PagePort, roomEvent } from "../u37c/harness";

const hello = (room = "demo") => ({ t: "room_hello", v: 1, agent: "wall-user", rooms: [{ room, floor: "ONLY_ON_DEVICE" }] });
const sync = (rid = "initial") => ({ t: "room_sync", v: 1, rid, since: {} });
function rig() {
  const native = new FakeNative();
  const relay = createAgentRelay({ native, clock: new FakeExtClock() });
  const page = () => new ExtPort();
  return { native, relay, page };
}

describe("U68 hello cache", () => {
  it("A1 late subscriber receives cached hello before live and replay events", () => {
    const { native, relay, page } = rig();
    native.emit(hello());
    const p = page();
    relay.onPortMessage(p, sync());
    const rid = native.ofType("room_sync").at(-1)!["rid"];
    native.emit({ t: "room_event", v: 1, room: "demo", floor: "ONLY_ON_DEVICE", event: roomEvent(1), rid });
    native.emit({ t: "room_event", v: 1, room: "demo", floor: "ONLY_ON_DEVICE", event: roomEvent(2) });
    expect(p.sent.map(m => (m as { t?: string })["t"])).toEqual(["room_hello", "room_event", "room_event"]);
    expect(p.sent[0]).toEqual(hello());
  });

  it("A1 cached hello seeds advertised rooms on a connected late page", () => {
    const { native, relay } = rig();
    native.emit({ ...hello(), rooms: [...hello().rooms, { room: "other", floor: "PREFER_ON_DEVICE" }] });
    const port = new PagePort();
    const clock = new FakeAppClock();
    const ext = new ExtPort();
    // Wire the two real components; only transport and clocks are fake.
    ext.postMessage = (frame: unknown) => port.emit(frame);
    const originalPost = port.postMessage.bind(port);
    port.postMessage = (frame: unknown) => {
      originalPost(frame);
      if ((frame as { t?: string }).t === "room_sync") relay.onPortMessage(ext, frame);
    };
    const link = createAgentLink({ extId: EXT_ID, connect: () => port, clock, nonce: () => "u68", since: () => ({}), onRoomHello: () => {}, onRoomEvent: () => {} });
    try {
      link.start();
      port.emit({ t: "snapshot", v: 1, nonce: "u68", items: [] });
      clock.advance(1);
      expect(port.ofType("room_sync").some(m => JSON.stringify(m["since"]) === JSON.stringify({ demo: 0, other: 0 }))).toBe(true);
    } finally { link.stop(); }
  });

  it("A1 every separately subscribing page receives the announcement", () => {
    const { native, relay, page } = rig();
    native.emit(hello());
    const a = page(); const b = page();
    relay.onPortMessage(a, sync("a")); relay.onPortMessage(b, sync("b"));
    expect(a.sent.filter(m => (m as { t?: string })["t"] === "room_hello")).toEqual([hello()]);
    expect(b.sent.filter(m => (m as { t?: string })["t"] === "room_hello")).toEqual([hello()]);
  });

  it("A2 newer valid hello replaces the cached announcement", () => {
    const { native, relay, page } = rig();
    native.emit(hello()); native.emit(hello("other"));
    const p = page(); relay.onPortMessage(p, sync());
    expect(p.sent.filter(m => (m as { t?: string })["t"] === "room_hello")).toEqual([hello("other")]);
  });

  it.each([
    { ...hello(), v: 2 }, { ...hello(), rooms: null },
    { ...hello(), rooms: [{ room: "Bad Room", floor: "ONLY_ON_DEVICE" }] },
    { ...hello(), rooms: [{ room: "demo", floor: "PUBLIC" }] },
  ])("M1 invalid hello cannot replace the last valid announcement: %j", bad => {
    const { native, relay, page } = rig();
    native.emit(hello()); native.emit(bad);
    const p = page(); relay.onPortMessage(p, sync());
    expect(relay.stats().rejected).toBeGreaterThan(0);
    expect(p.sent.filter(m => (m as { t?: string })["t"] === "room_hello")).toEqual([hello()]);
  });

  it("A2 observed native outage clears cache, including after reconnection without a new hello", () => {
    const { native, relay, page } = rig();
    native.emit(hello()); native.up = false;
    const down = page(); relay.onPortMessage(down, sync("down"));
    expect(down.sent.filter(m => (m as { t?: string })["t"] === "room_hello")).toEqual([]);
    native.up = true;
    const after = page(); relay.onPortMessage(after, sync("after"));
    expect(after.sent.filter(m => (m as { t?: string })["t"] === "room_hello")).toEqual([]);
    native.emit(hello("fresh"));
    const fresh = page(); relay.onPortMessage(fresh, sync("fresh"));
    expect(fresh.sent.filter(m => (m as { t?: string })["t"] === "room_hello")).toEqual([hello("fresh")]);
  });

  it("M1 unsubscribed ports receive no live events", () => {
    const { native, relay, page } = rig();
    const p = page();
    relay.onPortMessage(p, { ...sync(), since: null });
    native.emit(hello());
    native.emit({ t: "room_event", v: 1, room: "demo", floor: "ONLY_ON_DEVICE", event: roomEvent(1) });
    expect(p.sent).toEqual([]);
  });
});
