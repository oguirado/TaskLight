import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentLink, type AgentLink } from "../../../src/app/agent_link";
import { createAgentRelay } from "../../../extension/src/agent_relay";
import { FakePort } from "../u13/harness";
import { createAgentStore } from "../../../src/app/agent_store";
import { EXT_ID, FakeAppClock, FakeExtClock, FakeNative, HELLO, PagePort,
  event, eventFrame, gapFrame, pageRuntime, pythonRelay, synced, template, type Frame } from "./helpers";

const links: AgentLink[] = [];
afterEach(() => { links.splice(0).forEach(link => link.stop()); vi.restoreAllMocks(); });
function rig() {
  const clock = new FakeAppClock();
  const runtime = pageRuntime();
  const onRoomGap = vi.fn<(frame: unknown) => void>();
  const onRoomSynced = vi.fn<(frame: unknown) => void>();
  const onRoomEvent = vi.fn();
  const since = vi.fn(() => ({ demo: 7 }));
  const deps = { extId: EXT_ID, connect: runtime.connect, clock, nonce: () => "u85",
    since, onRoomEvent, onRoomHello: vi.fn(), onRoomGap, onRoomSynced };
  const link = createAgentLink(deps);
  links.push(link);
  link.start();
  const port = runtime.last();
  port.emit({ t: "snapshot", v: 1, nonce: "u85", items: [] });
  clock.advance(1);
  port.emit(HELLO);
  const rid = (): string => String(runtime.last().ofType("room_sync").at(-1)!["rid"]);
  return { link, clock, runtime, port, rid, since, onRoomGap, onRoomSynced, onRoomEvent };
}

describe("M5 page frame contracts and A6 hostile input", () => {
  it.each(["sanitize_failed", "oversize"])("A3 validates and exposes live and matching replay %s gaps", reason => {
    const r = rig();
    const live = gapFrame({ reason });
    const replay = gapFrame({ reason, rid: r.rid() });
    r.port.emit(live); r.port.emit(replay);
    expect(r.onRoomGap.mock.calls.map(c => c[0])).toEqual([live, replay]);
  });

  it("M5 exposes only matching room_synced frames, including continuation then terminal", () => {
    const r = rig();
    const first = synced(r.rid(), 9, true);
    r.port.emit(first);
    const last = synced(r.rid(), 10, false);
    r.port.emit(last);
    expect(r.onRoomSynced.mock.calls.map(c => c[0])).toEqual([first, last]);
  });

  it.each([
    ["path room", { room: "../x" }], ["unknown room", { room: "other" }],
    ["reversed bounds", { from_lamport: 9, to_lamport: 8 }],
    ["zero", { from_lamport: 0 }], ["negative", { from_lamport: -1 }],
    ["fraction", { from_lamport: 7.5 }], ["unsafe", { to_lamport: Number.MAX_SAFE_INTEGER + 1 }],
    ["boolean", { from_lamport: true }], ["missing bound", { to_lamport: undefined }],
    ["missing start", { from_lamport: undefined }], ["missing room", { room: undefined }],
    ["missing version", { v: undefined }], ["missing reason", { reason: undefined }],
    ["zero end", { to_lamport: 0 }], ["negative end", { to_lamport: -1 }],
    ["fractional end", { to_lamport: 8.5 }], ["unsafe start", { from_lamport: Number.MAX_SAFE_INTEGER + 1 }],
    ["string bound", { from_lamport: "8" }], ["null bound", { to_lamport: null }],
    ["version", { v: 2 }], ["reason markup", { reason: "<img src=x onerror=alert(1)>" }],
    ["obsolete rid", { rid: "obsolete" }],
  ] as const)("A6 rejects %s without callbacks, cursor changes or HTML", (_name, over) => {
    const r = rig();
    const before = structuredClone(r.port.sent);
    r.port.emit(gapFrame(over));
    expect(r.onRoomGap).not.toHaveBeenCalled();
    expect(r.onRoomSynced).not.toHaveBeenCalled();
    expect(r.port.sent).toEqual(before);
    expect(r.since()).toEqual({ demo: 7 });
    expect(document.querySelector("img")).toBeNull();
    // A positive witness prevents all-dropped implementations from passing this gate.
    r.port.emit(gapFrame());
    expect(r.onRoomGap).toHaveBeenCalledTimes(1);
  });

  it("M5 ignores obsolete ports after reconnect and accepts the current port", () => {
    const r = rig();
    r.port.drop(); r.clock.advance(100);
    const current = r.runtime.last();
    current.emit({ t: "snapshot", v: 1, nonce: "u85", items: [] });
    r.clock.advance(1); current.emit(HELLO);
    r.port.emit(gapFrame());
    r.port.emit(synced(r.rid()));
    expect(r.onRoomGap).not.toHaveBeenCalled();
    expect(r.onRoomSynced).not.toHaveBeenCalled();
    current.emit(gapFrame());
    current.emit(synced(r.rid()));
    expect(r.onRoomGap).toHaveBeenCalledTimes(1);
    expect(r.onRoomSynced).toHaveBeenCalledTimes(1);
  });

  it("A6 mismatched envelope/event rooms never reach ingestion", () => {
    const r = rig();
    r.port.emit({ ...eventFrame(event(8)), event: event(8, { room: "other" }) });
    expect(r.onRoomEvent).not.toHaveBeenCalled();
    r.port.emit(eventFrame(event(9)));
    expect(r.onRoomEvent).toHaveBeenCalledTimes(1);
  });

  it("M5 room_event replay must match the outstanding room and rid", () => {
    const r = rig();
    r.port.emit(eventFrame(event(8), "obsolete"));
    r.port.emit(eventFrame(event(8, { room: "other" }), r.rid()));
    expect(r.onRoomEvent).not.toHaveBeenCalled();
    r.port.emit(eventFrame(event(8), r.rid()));
    expect(r.onRoomEvent).toHaveBeenCalledTimes(1);
  });

  it("M5 room_hello membership is required for live gaps and events", () => {
    const r = rig();
    r.port.emit({ ...HELLO, rooms: [] });
    r.port.emit(gapFrame()); r.port.emit(eventFrame(event(8)));
    expect(r.onRoomGap).not.toHaveBeenCalled();
    expect(r.onRoomEvent).not.toHaveBeenCalled();
  });
});

describe("A8 production extension prerequisite (Amendment A-U85-1)", () => {
  function transport() {
    const native = new FakeNative();
    const extension = createAgentRelay({ native, clock: new FakeExtClock() });
    const port = new FakePort();
    native.emit(HELLO);
    extension.onPortMessage(port, { t: "room_sync", v: 1, rid: "page-1", since: { demo: 7 } });
    const relayRid = native.ofType("room_sync").at(-1)!["rid"];
    port.sent.length = 0;
    return { native, extension, port, relayRid };
  }

  it.each(["sanitize_failed", "oversize"])("A8 real Python relay %s gap crosses the real extension with rid rewriting", reason => {
    const r = transport();
    const frames = pythonRelay({ triplet: true, reason, mode: "replay", since: 6 }).frames;
    expect(frames.some(f => f.t === "room_gap"), "A3 gap emission gate").toBe(true);
    for (const f of frames) r.native.emit({ ...f, rid: r.relayRid });
    const delivered = r.port.sent as Frame[];
    expect(delivered.map(f => f.t)).toEqual(["room_event", "room_gap", "room_event", "room_synced"]);
    expect(delivered[1]).toEqual(gapFrame({ reason, rid: "page-1" }));
    expect(delivered.every(f => f["rid"] === "page-1")).toBe(true);
    expect(r.extension.stats().rejected).toBe(0);
  });

  it("A8 live gap fans out only to subscribed ports; other frame types remain rejected", () => {
    const r = transport();
    const stranger = new FakePort();
    r.extension.onPortMessage(stranger, { t: "unknown", v: 1, rid: "stranger" });
    const gap = gapFrame();
    r.native.emit(gap);
    expect(r.port.sent).toEqual([gap]);
    expect(stranger.sent).toEqual([]);
    const before = r.extension.stats().rejected;
    r.native.emit({ ...gap, t: "unknown" });
    expect(r.extension.stats().rejected).toBe(before + 1);
    expect(r.port.sent).toEqual([gap]);
  });


  it("A8 matching replay gap uses the production extension and preserves its pending sync until terminal", () => {
    const r = transport();
    r.native.emit(gapFrame({ rid: r.relayRid }));
    expect(r.port.sent).toEqual([gapFrame({ rid: "page-1" })]);
    expect(r.extension.stats().pending).toBe(1);
    r.native.emit(synced(r.relayRid));
    expect(r.port.sent.at(-1)).toEqual(synced("page-1"));
    expect(r.extension.stats().pending).toBe(0);
  });


  it.each([
    { room: "../x" }, { room: "other" }, { from_lamport: 9, to_lamport: 8 },
    { from_lamport: 0 }, { to_lamport: Number.MAX_SAFE_INTEGER + 1 },
    { v: 2 }, { reason: "<img src=x onerror=alert(1)>" }, { rid: "obsolete" },
  ])("A6 extension rejects hostile gap %# without consuming the valid replay", over => {
    const r = transport();
    r.native.emit(gapFrame({ rid: r.relayRid, ...over }));
    expect(r.port.sent).toEqual([]);
    expect(r.extension.stats().pending).toBe(1);
    r.native.emit(gapFrame({ rid: r.relayRid }));
    expect(r.port.sent).toEqual([gapFrame({ rid: "page-1" })]);
    expect(r.extension.stats().pending).toBe(1);
  });

  it("A8 unknown extension frame types are still rejected", () => {
    const r = transport();
    const before = r.extension.stats().rejected;
    r.native.emit({ t: "unknown", v: 1, room: "demo" });
    expect(r.port.sent).toEqual([]);
    expect(r.extension.stats().rejected).toBe(before + 1);
  });

  it("A8 real extension-link-store chain preserves clean replay and rejects cross-room mutation", () => {
    const native = new FakeNative();
    const extension = createAgentRelay({ native, clock: new FakeExtClock() });
    const page = new PagePort();
    const ext = new FakePort();
    ext.postMessage = f => { ext.sent.push(structuredClone(f)); page.emit(f); };
    const originalPost = page.postMessage.bind(page);
    page.postMessage = f => {
      originalPost(f);
      if ((f as Frame).t === "room_sync") extension.onPortMessage(ext, f);
    };
    const store = createAgentStore({ templates: () => template });
    const clock = new FakeAppClock();
    const onRoomGap = vi.fn();
    const deps = { extId: EXT_ID, connect: () => page, clock, nonce: () => "u85",
      since: () => store.since(), onRoomHello: vi.fn(), onRoomGap,
      onRoomEvent: (f: { event: unknown }) => { store.ingest(f.event); } };
    const link = createAgentLink(deps); links.push(link); link.start();
    page.emit({ t: "snapshot", v: 1, nonce: "u85", items: [] });
    clock.advance(1); native.emit(HELLO);
    const relayRid = native.ofType("room_sync").at(-1)!["rid"];
    const replay = pythonRelay();
    for (const f of replay.frames) native.emit({ ...f, rid: relayRid });
    expect(store.plan("demo")?.projection).toEqual(replay.projection);
    const before = store.events("demo");
    native.emit({ ...eventFrame(event(50, { room: "other" })), room: "demo" });
    expect(store.events("other")).toEqual([]);
    expect(store.events("demo")).toEqual(before);
  });
});
