import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentLink, type AgentLink } from "../../../src/app/agent_link";
import { createAgentStore } from "../../../src/app/agent_store";
import { EXT_ID, FakeAppClock, HELLO, event, eventFrame, fixture, gapFrame,
  pageRuntime, synced, template } from "./helpers";

const links: AgentLink[] = [];
afterEach(() => {
  links.splice(0).forEach(link => link.stop());
  vi.restoreAllMocks();
});

function connect(announce = true) {
  const clock = new FakeAppClock();
  const runtime = pageRuntime();
  const onRoomGap = vi.fn();
  const onRoomSynced = vi.fn();
  const onRoomEvent = vi.fn();
  const deps = { extId: EXT_ID, connect: runtime.connect, clock, nonce: () => "u85-boundary",
    since: () => ({ demo: 7 }), onRoomHello: vi.fn(), onRoomEvent,
    onRoomGap, onRoomSynced };
  const link = createAgentLink(deps);
  links.push(link); link.start();
  const port = runtime.last();
  port.emit({ t: "snapshot", v: 1, nonce: "u85-boundary", items: [] });
  clock.advance(1);
  if (announce) port.emit(HELLO);
  const rid = () => port.ofType("room_sync").at(-1)!["rid"];
  return { port, rid, onRoomGap, onRoomSynced, onRoomEvent };
}

describe("M3/M5 boundary gates with positive witnesses", () => {
  it.each([[1, 1], [7, 9], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]])(
    "M3 accepts inclusive positive safe bounds [%s,%s] without inferring loss", (from, to) => {
      const r = connect();
      const frame = gapFrame({ from_lamport: from, to_lamport: to, rid: r.rid() });
      r.port.emit(frame);
      expect(r.onRoomGap).toHaveBeenCalledExactlyOnceWith(frame);
    });

  it.each([
    ["version", { v: 2 }], ["unsafe room", { room: "../x" }],
    ["unannounced room", { room: "other" }], ["obsolete rid", { rid: "obsolete" }],
    ["missing rid", { rid: undefined }], ["negative upto", { upto: -1 }],
    ["fractional upto", { upto: 8.5 }], ["string upto", { upto: "9" }],
    ["nonboolean more", { more: "false" }],
  ] as const)("M5 ignores malformed or obsolete terminal %s without consuming the replay", (_name, over) => {
    const r = connect();
    const before = structuredClone(r.port.sent);
    r.port.emit({ ...synced(r.rid()), ...over });
    expect(r.onRoomSynced).not.toHaveBeenCalled();
    expect(r.port.sent).toEqual(before);
    const terminal = synced(r.rid());
    r.port.emit(terminal);
    expect(r.onRoomSynced).toHaveBeenCalledExactlyOnceWith(terminal);
    // A second terminal cannot complete a replay which is no longer outstanding.
    r.port.emit(terminal);
    expect(r.onRoomSynced).toHaveBeenCalledTimes(1);
  });

  it("M5 requires hello membership before any gap or event can reach the page", () => {
    const r = connect(false);
    r.port.emit(gapFrame()); r.port.emit(eventFrame(event(8)));
    expect(r.onRoomGap).not.toHaveBeenCalled();
    expect(r.onRoomEvent).not.toHaveBeenCalled();
    r.port.emit(HELLO);
    const gap = gapFrame();
    r.port.emit(gap);
    expect(r.onRoomGap).toHaveBeenCalledExactlyOnceWith(gap);
    r.port.emit(eventFrame(event(9)));
    expect(r.onRoomEvent).toHaveBeenCalledTimes(1);
  });
});

describe("M1/M2 retention and compatibility boundaries", () => {
  it("A1 equal-Lamport display ties keep deterministic newest IDs without pruning operations", () => {
    const store = createAgentStore({ templates: () => template, maxPerRoom: 2 });
    const ops = fixture();
    ops.forEach(ev => expect(store.ingest(ev)).toBe(true));
    const tied = [101, 102, 103].map(id => event(100, {
      id: "e-" + id.toString(16).padStart(16, "0"),
    }));
    [...tied].reverse().forEach(ev => expect(store.ingest(ev)).toBe(true));
    expect(store.events("demo")).toEqual([...ops, ...tied.slice(1)]);
    expect(store.ingest(tied[0])).toBe(false);
    expect(store.events("demo")).toEqual([...ops, ...tied.slice(1)]);
  });

  it("M2 legacy JSONL remains usable independently of the additive checked method", () => {
    const store = createAgentStore({ templates: () => template });
    const first = fixture()[0]!;
    const line = JSON.stringify(first);
    expect(store.ingestJsonl(line + "\n" + line + "\nnull\n{")).toEqual({
      accepted: 1, duplicate: 1, malformed: 1, torn: true,
    });
    expect(store.events("demo")).toEqual([first]);
    expect(store.ingest(first)).toBe(false);
  });
});
