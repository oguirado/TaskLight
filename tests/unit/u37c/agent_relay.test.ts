// U37c oracle: extension/src/agent_relay.ts createAgentRelay (SPEC_U37 "Hop B" + "U37c"). Red until implemented.
import { beforeEach, describe, expect, it } from "vitest";
import { createAgentRelay, type AgentRelay } from "../../../extension/src/agent_relay";
import { FakeExtClock, FakeNative, ExtPort, ROOM, roomEvent, idOf } from "./harness";

const RID_RE = /^[A-Za-z0-9_-]{1,64}$/;
let native: FakeNative; let relay: AgentRelay; let clock: FakeExtClock;
beforeEach(() => { native = new FakeNative(); clock = new FakeExtClock(); relay = createAgentRelay({ native, clock }); });

const sync = (rid: string, since: Record<string, unknown> = { [ROOM]: 0 }) => ({ t: "room_sync", v: 1, rid, since });
const post = (rid: string, text = "hi", extra: Record<string, unknown> = {}) => ({ t: "room_post", v: 1, rid, room: ROOM, act: "question", text, ...extra });
const port = (): ExtPort => new ExtPort({ origin: "https://site.test" });
/** Subscribes a port with a valid room_sync and returns the relay rid used toward native. */
function subscribe(p: ExtPort, rid = "s"): string {
  relay.onPortMessage(p, sync(rid));
  return native.ofType("room_sync").at(-1)!["rid"] as string;
}
const big = (n: number): string => "x".repeat(n);

describe("page -> native: room_sync", () => {
  it("valid room_sync is forwarded with a rewritten rid and the same since", () => {
    const p = port();
    relay.onPortMessage(p, sync("page-rid-1", { demo: 7, other: 0 }));
    expect(native.sent).toHaveLength(1);
    const f = native.sent[0]!;
    expect(f).toMatchObject({ t: "room_sync", v: 1, since: { demo: 7, other: 0 } });
    expect(f["rid"]).toMatch(RID_RE);
    expect(f["rid"]).not.toBe("page-rid-1");
  });
  it.each([
    ["non-object", 5], ["null", null], ["array", []], ["missing v", { t: "room_sync", rid: "a", since: {} }], ["v=2", { t: "room_sync", v: 2, rid: "a", since: {} }],
    ["missing rid", { t: "room_sync", v: 1, since: {} }], ["rid with space", sync("a b")], ["rid empty", sync("")], ["rid 65 chars", sync(big(65))],
    ["since not object", { t: "room_sync", v: 1, rid: "a", since: 3 }], ["since array", { t: "room_sync", v: 1, rid: "a", since: [] }],
    ["since negative", sync("a", { demo: -1 })], ["since float", sync("a", { demo: 1.5 })], ["since string", sync("a", { demo: "1" })],
    ["since bad room slug", sync("a", { "Bad Room": 1 })], ["since room too long", sync("a", { ["a".repeat(49)]: 1 })],
    ["unknown t", { t: "room_event", v: 1, rid: "a", room: ROOM }],
  ])("rejects %s (never reaches native, never throws)", (_n, msg) => {
    const p = port();
    expect(() => relay.onPortMessage(p, msg)).not.toThrow();
    expect(native.sent).toEqual([]);
    expect(relay.stats().rejected).toBeGreaterThanOrEqual(1);
  });
  it("more than 12 rooms in since is rejected; exactly 12 is accepted", () => {
    const since = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`r${i}`, 0]));
    relay.onPortMessage(port(), sync("a", since(13)));
    expect(native.sent).toEqual([]);
    relay.onPortMessage(port(), sync("b", since(12)));
    expect(native.sent).toHaveLength(1);
  });
  it("a frame longer than 65,536 serialized chars is rejected even if the known fields are valid", () => {
    const p = port();
    relay.onPortMessage(p, { ...sync("a"), pad: big(65_600) });
    expect(native.sent).toEqual([]);
    expect(relay.stats().rejected).toBe(1);
  });
});

describe("page -> native: room_post", () => {
  it("valid post is forwarded with rewritten rid; only known fields survive", () => {
    const p = port();
    relay.onPortMessage(p, post("pp1", "hello", { to: "worker-1", re: idOf(3), extraneous: "drop-me" }));
    expect(native.sent).toHaveLength(1);
    const f = native.sent[0]!;
    expect(f).toMatchObject({ t: "room_post", v: 1, room: ROOM, act: "question", text: "hello", to: "worker-1", re: idOf(3) });
    expect(f["rid"]).toMatch(RID_RE);
    expect(f["rid"]).not.toBe("pp1");
    expect(f).not.toHaveProperty("extraneous");
  });
  it("optional to/re are omitted (not undefined keys) when absent", () => {
    relay.onPortMessage(port(), post("pp1"));
    expect(Object.keys(native.sent[0]!).sort()).toEqual(["act", "rid", "room", "t", "text", "v"]);
  });
  it("text bounds are in UTF-8 bytes: 4096 bytes ok (ascii and 2-byte), 4097 rejected, 2049 two-byte chars rejected", () => {
    relay.onPortMessage(port(), post("a", big(4096)));
    relay.onPortMessage(port(), post("b", "é".repeat(2048)));
    expect(native.ofType("room_post")).toHaveLength(2);
    relay.onPortMessage(port(), post("c", big(4097)));
    relay.onPortMessage(port(), post("d", "é".repeat(2049)));
    relay.onPortMessage(port(), post("e", "€".repeat(1366))); // 4098 bytes, only 1366 chars
    expect(native.ofType("room_post")).toHaveLength(2);
  });
  it.each([
    ["empty text", post("a", "")], ["text not string", post("a", 5 as unknown as string)], ["act answer", post("a", "x", { act: "answer" })],
    ["missing act", { t: "room_post", v: 1, rid: "a", room: ROOM, text: "x" }], ["bad room slug", post("a", "x", { room: "Bad Room" })],
    ["missing room", { t: "room_post", v: 1, rid: "a", act: "question", text: "x" }], ["bad rid", post("a b")], ["v=2", { ...post("a"), v: 2 }],
    ["to not string", post("a", "x", { to: 5 })], ["re not string", post("a", "x", { re: {} })],
  ])("rejects %s", (_n, msg) => {
    relay.onPortMessage(port(), msg);
    expect(native.sent).toEqual([]);
    expect(relay.stats().rejected).toBe(1);
  });
  it("a post whose serialization exceeds 65,536 chars is rejected (oversize `to`)", () => {
    relay.onPortMessage(port(), post("a", "x", { to: big(66_000) }));
    expect(native.sent).toEqual([]);
  });
});

describe("rid rewriting: replies reach only the requesting port", () => {
  it("two ports using the same page rid get distinct relay rids; ack/nack go to the right port with the ORIGINAL rid", () => {
    const a = port(); const b = port();
    relay.onPortMessage(a, post("r1", "from a"));
    relay.onPortMessage(b, post("r1", "from b"));
    const [fa, fb] = native.sent;
    expect(fa!["rid"]).not.toBe(fb!["rid"]);
    native.emit({ t: "room_ack", v: 1, rid: fb!["rid"], id: idOf(9), lamport: 9 });
    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([{ t: "room_ack", v: 1, rid: "r1", id: idOf(9), lamport: 9 }]);
    native.emit({ t: "room_nack", v: 1, rid: fa!["rid"], code: "rate_limited" });
    expect(a.sent).toEqual([{ t: "room_nack", v: 1, rid: "r1", code: "rate_limited" }]);
    expect(b.sent).toHaveLength(1);
  });
  it("a reply with an unknown rid, or the same rid twice, is dropped (and counted as rejected)", () => {
    const a = port();
    relay.onPortMessage(a, post("r1"));
    const rid = native.sent[0]!["rid"];
    native.emit({ t: "room_ack", v: 1, rid: "never-issued", id: idOf(1), lamport: 1 });
    expect(a.sent).toEqual([]);
    native.emit({ t: "room_ack", v: 1, rid, id: idOf(1), lamport: 1 });
    native.emit({ t: "room_ack", v: 1, rid, id: idOf(1), lamport: 1 });
    expect(a.sent).toHaveLength(1);
    expect(relay.stats().rejected).toBeGreaterThanOrEqual(2);
  });
  it("replay room_event (with rid) and room_synced go only to the requesting port, rid restored; other subscribed ports see nothing", () => {
    const a = port(); const b = port();
    const ra = subscribe(a, "sa"); subscribe(b, "sb");
    native.emit({ t: "room_event", v: 1, room: ROOM, floor: "ONLY_ON_DEVICE", event: roomEvent(1), rid: ra });
    native.emit({ t: "room_synced", v: 1, rid: ra, room: ROOM, upto: 1, more: false });
    expect(a.sent).toEqual([
      { t: "room_event", v: 1, room: ROOM, floor: "ONLY_ON_DEVICE", event: roomEvent(1), rid: "sa" },
      { t: "room_synced", v: 1, rid: "sa", room: ROOM, upto: 1, more: false },
    ]);
    expect(b.sent).toEqual([]);
  });
  it("a replay room_event carrying an unknown rid is NOT broadcast", () => {
    const a = port(); subscribe(a);
    native.emit({ t: "room_event", v: 1, room: ROOM, floor: "ONLY_ON_DEVICE", event: roomEvent(1), rid: "ghost" });
    expect(a.sent).toEqual([]);
  });
});

describe("live fan-out", () => {
  const live = { t: "room_event", v: 1, room: ROOM, floor: "PREFER_ON_DEVICE", event: roomEvent(5) };
  it("a room_event without rid reaches every subscribed port unchanged (no rid key)", () => {
    const a = port(); const b = port(); const c = port();
    subscribe(a); subscribe(b);
    native.emit(live);
    expect(a.sent).toEqual([live]);
    expect(b.sent).toEqual([live]);
    expect(c.sent).toEqual([]);
  });
  it("a port that only posted (never room_sync) is not subscribed: it gets its ack but no live events", () => {
    const p = port();
    relay.onPortMessage(p, post("x"));
    native.emit(live);
    expect(p.sent).toEqual([]);
    native.emit({ t: "room_ack", v: 1, rid: native.sent[0]!["rid"], id: idOf(2), lamport: 2 });
    expect(p.sent).toHaveLength(1);
  });
  it("room_hello from native is forwarded to every subscribed port", () => {
    const a = port(); const b = port(); subscribe(a); subscribe(b);
    const hello = { t: "room_hello", v: 1, rooms: [{ room: ROOM, floor: "ONLY_ON_DEVICE" }], agent: "wall-user" };
    native.emit(hello);
    expect(a.sent).toEqual([hello]); expect(b.sent).toEqual([hello]);
  });
  it("a port whose postMessage throws is dropped without breaking delivery to the others", () => {
    const a = port(); const b = port(); subscribe(a); subscribe(b);
    a.disconnected = true; // FakePort.postMessage throws once closed
    expect(() => { native.emit(live); }).not.toThrow();
    expect(b.sent).toEqual([live]);
    native.emit(live);
    expect(b.sent).toHaveLength(2);
  });
});

describe("native -> page validation (size/shape checks both ways)", () => {
  it("never forwards `event` (Router channel), unknown t, non-objects, or oversize frames", () => {
    const a = port(); subscribe(a);
    native.emit({ t: "event", v: 1, seq: 1, projectId: "p", payload: {} });
    native.emit({ t: "mystery", v: 1 });
    native.emit("string"); native.emit(null); native.emit(42);
    native.emit({ t: "room_event", v: 1, room: ROOM, floor: "ONLY_ON_DEVICE", event: { ...roomEvent(1), pad: big(65_600) } });
    expect(a.sent).toEqual([]);
    expect(relay.stats().rejected).toBeGreaterThanOrEqual(1);
  });
  it.each([
    ["room_event without event object", { t: "room_event", v: 1, room: ROOM, floor: "ONLY_ON_DEVICE", event: "x" }],
    ["room_event bad room", { t: "room_event", v: 1, room: "Bad Room", floor: "ONLY_ON_DEVICE", event: roomEvent(1) }],
    ["room_event bad floor", { t: "room_event", v: 1, room: ROOM, floor: "ANYWHERE", event: roomEvent(1) }],
    ["room_event v=2", { t: "room_event", v: 2, room: ROOM, floor: "ONLY_ON_DEVICE", event: roomEvent(1) }],
    ["room_hello without rooms", { t: "room_hello", v: 1, agent: "wall-user" }],
    ["room_hello rooms not array", { t: "room_hello", v: 1, rooms: {}, agent: "wall-user" }],
  ])("drops malformed %s", (_n, frame) => {
    const a = port(); subscribe(a);
    native.emit(frame);
    expect(a.sent).toEqual([]);
  });
});

describe("pending rids", () => {
  it("at most 32 pending rids per port: the 33rd gets a room_nack with the page rid, is not forwarded; an ack frees a slot", () => {
    const a = port();
    for (let i = 0; i < 32; i++) relay.onPortMessage(a, post(`p${i}`, `m${i}`));
    expect(native.ofType("room_post")).toHaveLength(32);
    relay.onPortMessage(a, post("p32", "overflow"));
    expect(native.ofType("room_post")).toHaveLength(32);
    expect(a.sent).toHaveLength(1);
    expect(a.sent[0]).toMatchObject({ t: "room_nack", v: 1, rid: "p32" });
    const code = (a.sent[0] as { code?: unknown }).code;
    expect(typeof code).toBe("string");
    expect(code).not.toBe("");
    native.emit({ t: "room_ack", v: 1, rid: native.sent[0]!["rid"], id: idOf(1), lamport: 1 });
    relay.onPortMessage(a, post("p33", "fits now"));
    expect(native.ofType("room_post")).toHaveLength(33);
    expect(relay.stats().nacked).toBe(1);
  });
  it("the cap is per port: a second port still has its full budget", () => {
    const a = port(); const b = port();
    for (let i = 0; i < 32; i++) relay.onPortMessage(a, post(`p${i}`));
    relay.onPortMessage(b, post("b0"));
    expect(native.ofType("room_post")).toHaveLength(33);
    expect(b.sent).toEqual([]);
  });
  it("syncs and posts share the same pending budget", () => {
    const a = port();
    for (let i = 0; i < 16; i++) relay.onPortMessage(a, sync(`s${i}`));
    for (let i = 0; i < 16; i++) relay.onPortMessage(a, post(`p${i}`));
    relay.onPortMessage(a, post("over"));
    expect(native.sent).toHaveLength(32);
    expect(a.sent[0]).toMatchObject({ t: "room_nack", rid: "over" });
  });
});

describe("host_unavailable", () => {
  it.each([["room_sync", sync("q1")], ["room_post", post("q1")]])("native down: %s -> room_nack host_unavailable with the page rid, nothing forwarded", (_n, msg) => {
    native.up = false;
    const a = port();
    relay.onPortMessage(a, msg);
    expect(native.sent).toEqual([]);
    expect(a.sent).toEqual([{ t: "room_nack", v: 1, rid: "q1", code: "host_unavailable" }]);
    expect(relay.stats().nacked).toBe(1);
    expect(relay.stats().pending).toBe(0); // the rid is not left pending
  });
  it("send() returning false while connected() says true also yields host_unavailable and frees the rid", () => {
    const a = port();
    native.send = () => false;
    relay.onPortMessage(a, post("q1"));
    expect(a.sent).toEqual([{ t: "room_nack", v: 1, rid: "q1", code: "host_unavailable" }]);
    expect(relay.stats().pending).toBe(0);
  });
  it("send() throwing is contained and nacks host_unavailable", () => {
    const a = port();
    native.send = () => { throw new Error("boom"); };
    expect(() => { relay.onPortMessage(a, post("q1")); }).not.toThrow();
    expect(a.sent).toEqual([{ t: "room_nack", v: 1, rid: "q1", code: "host_unavailable" }]);
  });
  it("recovers when native comes back", () => {
    native.up = false;
    const a = port(); relay.onPortMessage(a, post("q1"));
    native.up = true; relay.onPortMessage(a, post("q2"));
    expect(native.ofType("room_post")).toHaveLength(1);
  });
});

describe("onPortClosed", () => {
  it("frees the port's pending rids, drops late replies silently, and stops live fan-out to it", () => {
    const a = port(); const b = port();
    subscribe(a); subscribe(b);
    relay.onPortMessage(a, post("p1"));
    const rid = native.ofType("room_post")[0]!["rid"];
    const before = relay.stats();
    expect(before.ports).toBe(2); expect(before.pending).toBeGreaterThanOrEqual(1);
    relay.onPortClosed(a);
    const after = relay.stats();
    expect(after.ports).toBe(1);
    expect(after.pending).toBe(before.pending - 2); // a's sync + a's post
    const aCount = a.sent.length; const bCount = b.sent.length;
    native.emit({ t: "room_ack", v: 1, rid, id: idOf(1), lamport: 1 });
    native.emit({ t: "room_event", v: 1, room: ROOM, floor: "ONLY_ON_DEVICE", event: roomEvent(2) });
    expect(a.sent).toHaveLength(aCount);
    expect(b.sent).toHaveLength(bCount + 1);
  });
  it("a new port object starts with a fresh 32-slot budget after the old one closed full", () => {
    const a = port();
    for (let i = 0; i < 32; i++) relay.onPortMessage(a, post(`p${i}`));
    relay.onPortClosed(a);
    const b = port();
    for (let i = 0; i < 32; i++) relay.onPortMessage(b, post(`p${i}`));
    expect(b.sent).toEqual([]);
    expect(relay.stats().pending).toBe(32);
  });
  it("is idempotent and tolerates unknown ports", () => {
    const a = port(); subscribe(a);
    expect(() => { relay.onPortClosed(a); relay.onPortClosed(a); relay.onPortClosed(port()); }).not.toThrow();
    expect(relay.stats()).toMatchObject({ ports: 0, pending: 0 });
  });
});

describe("stats", () => {
  it("starts at zero and counts forwarded (to native), delivered (to pages), rejected, nacked, pending, ports", () => {
    expect(relay.stats()).toEqual({ forwarded: 0, delivered: 0, rejected: 0, nacked: 0, pending: 0, ports: 0 });
    const a = port();
    relay.onPortMessage(a, sync("s"));          // forwarded 1, pending 1, ports 1
    relay.onPortMessage(a, post("p", ""));      // rejected 1
    native.emit({ t: "room_event", v: 1, room: ROOM, floor: "ONLY_ON_DEVICE", event: roomEvent(1) }); // delivered 1
    expect(relay.stats()).toEqual({ forwarded: 1, delivered: 1, rejected: 1, nacked: 0, pending: 1, ports: 1 });
  });
  it("never contains room text (counters only)", () => {
    relay.onPortMessage(port(), post("p", "SECRET-TEXT-123"));
    expect(JSON.stringify(relay.stats())).not.toContain("SECRET-TEXT-123");
    expect(Object.values(relay.stats()).every((v) => typeof v === "number")).toBe(true);
  });
});

describe("hygiene", () => {
  it("the relay never logs (room text is data)", () => {
    const logs: unknown[] = []; const orig = { ...console };
    for (const k of ["log", "info", "warn", "error", "debug"] as const) (console as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => { logs.push(a); };
    try {
      const a = port(); subscribe(a); relay.onPortMessage(a, post("p", "SECRET")); native.emit({ t: "room_nack", v: 1, rid: native.sent.at(-1)!["rid"], code: "room_not_allowed" });
    } finally { Object.assign(console, orig); }
    expect(logs).toEqual([]);
  });
});
