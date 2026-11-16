// U37c repair loop 1: regression tests for REVIEW_1 BLOCKING findings (multi-room replay, post() never rejects, stale drift).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState, DriftVerdict } from "../../../src/agents/types";
import type { AgentChatHandlers, AgentChatVM } from "../../../src/agentsui/types";
import type { WallHandlers, WallVM } from "../../../src/views/types";
import { createAgentRelay, type AgentRelay } from "../../../extension/src/agent_relay";
import { createAgentLink } from "../../../src/app/agent_link";
import { startAgentWall, type AgentWall } from "../../../src/app/agent_wall";
import { EXT_ID, ExtPort, FakeAppClock, FakeExtClock, FakeNative, ROOM, idOf, pageRuntime, roomEvent, settle } from "./harness";

const H = vi.hoisted(() => ({
  wallHandle: { update: vi.fn(), destroy: vi.fn() },
  chatHandle: { update: vi.fn(), destroy: vi.fn() },
  mountWall: vi.fn(),
  mountAgentChat: vi.fn(),
  toWallVM: vi.fn(),
  toChatVM: vi.fn(),
}));
vi.mock("../../../src/views", () => ({ mountWall: H.mountWall }));
vi.mock("../../../src/agentsui", () => ({ mountAgentChat: H.mountAgentChat }));
vi.mock("../../../src/app/agent_store", () => ({ toWallVM: H.toWallVM, toChatVM: H.toChatVM, createAgentStore: () => { throw new Error("not used"); } }));

const FLOOR = "ONLY_ON_DEVICE" as const;

/* ---------- 1. relay: multi-room replay ---------- */
describe("review1 #1: agent_relay multi-room room_sync replay", () => {
  let native: FakeNative; let relay: AgentRelay;
  beforeEach(() => { native = new FakeNative(); relay = createAgentRelay({ native, clock: new FakeExtClock() }); });
  const port = (): ExtPort => new ExtPort({ origin: "https://site.test" });
  const synced = (rid: string, room: string, upto = 1) => ({ t: "room_synced", v: 1, rid, room, upto, more: false });
  const revent = (rid: string, room: string, n: number) => ({ t: "room_event", v: 1, rid, room, floor: FLOOR, event: roomEvent(n, room) });
  const rids = (p: ExtPort, t: string) => p.ofType(t).map((m) => m["room"]);

  it("every reply for both requested rooms reaches the requesting port with the page rid", () => {
    const p = port(); const q = port();
    relay.onPortMessage(q, { t: "room_sync", v: 1, rid: "qq", since: { [ROOM]: 0 } }); // another subscribed port
    const qBefore = q.sent.length;
    relay.onPortMessage(p, { t: "room_sync", v: 1, rid: "page-1", since: { [ROOM]: 0, other: 0 } });
    const rid = native.ofType("room_sync").at(-1)!["rid"] as string;
    native.emit(synced(rid, ROOM, 3));
    native.emit(revent(rid, "other", 1));
    native.emit(revent(rid, "other", 2));
    native.emit(synced(rid, "other", 2));
    expect(p.ofType("room_synced").map((m) => [m["room"], m["rid"]])).toEqual([[ROOM, "page-1"], ["other", "page-1"]]);
    expect(p.ofType("room_event").map((m) => [m["room"], m["rid"]])).toEqual([["other", "page-1"], ["other", "page-1"]]);
    expect(rids(p, "room_event")).toEqual(["other", "other"]);
    // other ports receive none of the rid-bound replies
    expect(q.sent.slice(qBefore)).toEqual([]);
  });

  it("room_event replay for the second room arriving between the two room_synced frames is delivered", () => {
    const p = port();
    relay.onPortMessage(p, { t: "room_sync", v: 1, rid: "pg", since: { a: 0, b: 0, c: 0 } });
    const rid = native.ofType("room_sync").at(-1)!["rid"] as string;
    native.emit(synced(rid, "a")); native.emit(revent(rid, "b", 5)); native.emit(synced(rid, "b")); native.emit(revent(rid, "c", 6)); native.emit(synced(rid, "c"));
    expect(p.ofType("room_synced").map((m) => m["room"])).toEqual(["a", "b", "c"]);
    expect(p.ofType("room_event").map((m) => m["room"])).toEqual(["b", "c"]);
  });

  it("the pending rid is released once every requested room has synced (late replies are dropped, pending back to 0)", () => {
    const p = port();
    relay.onPortMessage(p, { t: "room_sync", v: 1, rid: "pg", since: { [ROOM]: 0, other: 0 } });
    const rid = native.ofType("room_sync").at(-1)!["rid"] as string;
    native.emit(synced(rid, ROOM)); native.emit(synced(rid, "other"));
    expect(relay.stats().pending).toBe(0);
    const n = p.sent.length;
    native.emit(synced(rid, ROOM)); native.emit(revent(rid, ROOM, 9));
    expect(p.sent.length).toBe(n);
  });

  it("single-room sync still releases after its room_synced (control)", () => {
    const p = port();
    relay.onPortMessage(p, { t: "room_sync", v: 1, rid: "pg", since: { [ROOM]: 0 } });
    const rid = native.ofType("room_sync").at(-1)!["rid"] as string;
    native.emit(synced(rid, ROOM));
    expect(p.ofType("room_synced")).toHaveLength(1);
    expect(relay.stats().pending).toBe(0);
  });

  it("a second room's replay on one port does not leak to another port with its own pending sync", () => {
    const p = port(); const q = port();
    relay.onPortMessage(p, { t: "room_sync", v: 1, rid: "pp", since: { [ROOM]: 0, other: 0 } });
    relay.onPortMessage(q, { t: "room_sync", v: 1, rid: "qq", since: { [ROOM]: 0 } });
    const [rp, rq] = native.ofType("room_sync").map((m) => m["rid"] as string);
    native.emit(synced(rp!, ROOM)); native.emit(synced(rq!, ROOM));
    native.emit(revent(rp!, "other", 1)); native.emit(synced(rp!, "other"));
    expect(p.ofType("room_synced").map((m) => [m["room"], m["rid"]])).toEqual([[ROOM, "pp"], ["other", "pp"]]);
    expect(q.ofType("room_synced").map((m) => [m["room"], m["rid"]])).toEqual([[ROOM, "qq"]]);
    expect(q.ofType("room_event")).toEqual([]);
  });
});

/* ---------- 2. link: post never rejects ---------- */
describe("review1 #2: agent_link.post never rejects", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => { unhandled.push(e); };
  beforeEach(() => { unhandled.length = 0; process.on("unhandledRejection", onUnhandled); });
  afterEach(() => { process.off("unhandledRejection", onUnhandled); });
  function up() {
    const clock = new FakeAppClock(); const rt = pageRuntime();
    const link = createAgentLink({ extId: EXT_ID, connect: rt.connect, clock, nonce: () => "n1", since: () => ({ [ROOM]: 0 }), onRoomEvent: vi.fn(), onRoomHello: vi.fn() });
    link.start(); const p = rt.last();
    p.emit({ t: "snapshot", v: 1, nonce: "n1", items: [] }); clock.advance(1);
    return { link, clock, p };
  }

  it("clock.setTimeout throwing -> post resolves {ok:false, code:string}; nothing is sent as pending; no unhandled rejection", async () => {
    const { link, clock, p } = up();
    clock.setTimeout = () => { throw new Error("timer"); };
    const res = await link.post({ room: ROOM, text: "q" }).then((r) => r, (e: unknown) => ({ rejected: e }));
    expect(res).toMatchObject({ ok: false });
    expect(typeof (res as { code: unknown }).code).toBe("string");
    expect((res as { code: string }).code.length).toBeGreaterThan(0);
    await settle(10);
    expect(unhandled).toEqual([]);
    link.stop();
    void p;
  });

  it("a rejection-free post after the failed one still works once the timer is healthy again", async () => {
    const { link, clock, p } = up();
    const orig = clock.setTimeout.bind(clock);
    clock.setTimeout = () => { throw new Error("timer"); };
    await link.post({ room: ROOM, text: "bad" });
    clock.setTimeout = orig;
    const prom = link.post({ room: ROOM, text: "good" });
    const sent = p.ofType("room_post").at(-1)!;
    p.emit({ t: "room_ack", v: 1, rid: sent["rid"], id: idOf(1), lamport: 1 });
    expect(await prom).toEqual({ ok: true, id: idOf(1), lamport: 1 });
    link.stop();
  });

  it("clock.clearTimeout throwing in settle does not leave the post unsettled (ack still resolves it)", async () => {
    const { link, clock, p } = up();
    const prom = link.post({ room: ROOM, text: "q" });
    const sent = p.ofType("room_post").at(-1)!;
    clock.clearTimeout = () => { throw new Error("clear"); };
    let out: unknown = "unsettled";
    void prom.then((r) => { out = r; }, (e: unknown) => { out = { rejected: e }; });
    try { p.emit({ t: "room_ack", v: 1, rid: sent["rid"], id: idOf(2), lamport: 2 }); } catch { /* handler must contain it */ }
    await settle(10);
    expect(out).toEqual({ ok: true, id: idOf(2), lamport: 2 });
    expect(unhandled).toEqual([]);
  });

  it("clock.clearTimeout throwing when the port send fails still resolves {ok:false}", async () => {
    const { link, clock, p } = up();
    p.throwOnPost = true;
    clock.clearTimeout = () => { throw new Error("clear"); };
    const res = await link.post({ room: ROOM, text: "q" }).then((r) => r, (e: unknown) => ({ rejected: e }));
    expect(res).toMatchObject({ ok: false });
    expect(typeof (res as { code: unknown }).code).toBe("string");
    expect(unhandled).toEqual([]);
  });
});

/* ---------- 3. wall: stale drift result ---------- */
describe("review1 #3: agent_wall ignores stale drift results", () => {
  const NOW0 = 1_700_000_000_000;
  const DRIFT: DriftVerdict = { verdict: "drift", reason: "h1 edited", source: "rules" };
  const OK: DriftVerdict = { verdict: "on_track", reason: "same", source: "rules" };
  const mk = (agent: string, hash: string): AgentState => ({
    room: "demo", agent, contract: { title: `${agent} plan`, steps: [{ text: "s1" }], hash, version: 1, lamport: 2 },
    stepStates: ["active"], outcomes: [undefined], took: [undefined], lastSeen: NOW0, openQuestions: [], closed: false,
  });
  let clock: FakeAppClock; let states: AgentState[]; let wall: AgentWall | undefined;
  let gates: Map<string, (v: DriftVerdict) => void>;
  const wallVm = (): WallVM => ({ now: "", model: { state: "unavailable", label: "" }, network: "online", workspaces: [], workspace: "", view: "wall", archiveScope: "workspace", tasks: [], agenda: [], archive: [] });
  beforeEach(() => {
    clock = new FakeAppClock(); clock.t = NOW0; gates = new Map();
    document.body.innerHTML = "";
    const wallHost = document.createElement("div"); const chatHost = document.createElement("div"); document.body.append(wallHost, chatHost);
    for (const f of [H.wallHandle.update, H.wallHandle.destroy, H.chatHandle.update, H.chatHandle.destroy, H.mountWall, H.mountAgentChat, H.toWallVM, H.toChatVM]) f.mockReset();
    H.mountWall.mockImplementation((_h: HTMLElement, _v: WallVM, _x?: WallHandlers) => H.wallHandle);
    H.mountAgentChat.mockImplementation((_h: HTMLElement, _v: AgentChatVM, _x?: AgentChatHandlers) => H.chatHandle);
    H.toWallVM.mockImplementation(() => wallVm());
    H.toChatVM.mockImplementation((s: AgentState, _e: unknown, o: { sending: boolean; drift?: DriftVerdict }): AgentChatVM => ({
      room: s.room, agent: s.agent, title: s.agent, messages: [], silent: false, sending: o.sending,
      ...(o.drift ? { drift: { verdict: o.drift.verdict, reason: o.drift.reason, added: [], removed: [], source: o.drift.source } } : {}),
    }));
    states = [mk("wall-user", "u1"), mk("worker-1", "h1")];
    const review = vi.fn((s: AgentState) => (s.agent === "worker-1"
      ? new Promise<DriftVerdict>((res) => { gates.set(s.contract!.hash, res); })
      : Promise.resolve(OK)));
    const store = { ingest: vi.fn(() => true), ingestJsonl: vi.fn(), since: () => ({}), states: () => states, events: () => [] };
    wall = startAgentWall({ wallHost, chatHost, link: { post: vi.fn(async () => ({ ok: true as const, id: idOf(1), lamport: 1 })) }, store, reviewer: { review }, clock, userAgent: "wall-user" } as unknown as Parameters<typeof startAgentWall>[0]); // A-U61a
  });
  afterEach(() => { wall?.destroy(); document.body.innerHTML = ""; });
  const chatDrift = () => (H.toChatVM.mock.calls.at(-1)![2] as { drift?: DriftVerdict }).drift;
  const wallVerdict = () => (H.toWallVM.mock.calls.at(-1)![1] as ReadonlyMap<string, DriftVerdict>).get("agent:demo:worker-1");

  it("A (h1) resolving after B (h2) does not overwrite B's verdict", async () => {
    await settle(10);
    states = [mk("wall-user", "u1"), mk("worker-1", "h2")];
    wall!.refresh(); await settle(10);
    expect([...gates.keys()].sort()).toEqual(["h1", "h2"]);
    gates.get("h2")!(OK); await settle(10);
    expect(chatDrift()).toEqual(OK);
    gates.get("h1")!(DRIFT); await settle(10);
    expect(chatDrift()).toEqual(OK);
    expect(wallVerdict()).toEqual(OK);
  });

  it("A resolving while only h2 is current (B still pending) is not shown", async () => {
    await settle(10);
    states = [mk("wall-user", "u1"), mk("worker-1", "h2")];
    wall!.refresh(); await settle(10);
    gates.get("h1")!(DRIFT); await settle(10);
    expect(chatDrift()).toBeUndefined();
    expect(wallVerdict()).toBeUndefined();
    gates.get("h2")!(OK); await settle(10);
    expect(chatDrift()).toEqual(OK);
    expect(wallVerdict()).toEqual(OK);
  });

  it("a result for the current contract hash is shown (control, no regression)", async () => {
    await settle(10);
    gates.get("h1")!(DRIFT); await settle(10);
    expect(chatDrift()).toEqual(DRIFT);
    expect(wallVerdict()).toEqual(DRIFT);
  });
});
