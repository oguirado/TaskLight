import { describe, expect, it } from "vitest";
import { CONNECTOR_LIMITS, CONNECTOR_PROTOCOL, createConnector } from "../../../src/app/connector";
import type { HostReply, ReplyTarget } from "../../../src/app/types";
import { EXT_ORIGIN, env } from "./harness";

const OTHER = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
function rig(origins: string[] = [EXT_ORIGIN]) {
  const accepted: Array<[string, number, unknown]> = [];
  const replies: Array<{ msg: HostReply; to: string }> = [];
  const src: ReplyTarget = { postMessage: (msg, to) => { replies.push({ msg, to }); } };
  let now = 1000;
  const c = createConnector(env({ extensionOrigins: origins }), { accept: (p, s, pl) => { accepted.push([p, s, pl]); } }, () => now);
  const send = (data: unknown, origin = EXT_ORIGIN, source: ReplyTarget | null = src) => c.onMessage({ origin, data, source });
  const hello = (nonce = "n1", origin = EXT_ORIGIN) => send({ t: "hello", v: 1, nonce }, origin);
  const ev = (seq: number, o: Partial<{ projectId: string; payload: unknown }> = {}, origin = EXT_ORIGIN) =>
    send({ t: "event", v: 1, seq, projectId: "p1", payload: { x: 1 }, ...o }, origin);
  return { c, accepted, replies, send, hello, ev, tick: (ms: number) => { now += ms; }, setNow: (n: number) => { now = n; } };
}
const nackCodes = (r: ReturnType<typeof rig>) => r.replies.flatMap((x) => (x.msg.t === "nack" ? [x.msg.code] : []));

describe("constants", () => {
  it("[TARGET] limits and protocol", () => {
    expect(CONNECTOR_PROTOCOL).toBe(1);
    expect(CONNECTOR_LIMITS).toEqual({ MAX_MSG_CHARS: 65536, MAX_EVENTS_PER_SEC: 50, MAX_PROJECT_ID_CHARS: 128 });
  });
});

describe("O9 origin allowlist (B9)", () => {
  it("valid hello from a foreign origin: silent drop, no reply, sink untouched", () => {
    const r = rig();
    r.hello("n1", "https://evil.example");
    expect(r.replies).toEqual([]);
    expect(r.c.stats()).toEqual({ accepted: 0, nacked: 0, droppedOrigin: 1 });
    r.ev(1, {}, "https://evil.example");
    expect(r.accepted).toEqual([]);
    expect(r.c.stats().droppedOrigin).toBe(2);
  });
  it("prefix/suffix look-alikes and the page's own origin are dropped", () => {
    const r = rig();
    for (const o of [EXT_ORIGIN + ".evil.example", EXT_ORIGIN + "/", "http://localhost:5173", "null", ""]) r.hello("n", o);
    expect(r.replies).toEqual([]);
    expect(r.c.stats().droppedOrigin).toBe(5);
  });
  it("an empty allowlist drops everything", () => {
    const r = rig([]);
    r.hello();
    expect(r.replies).toEqual([]);
    expect(r.c.stats().droppedOrigin).toBe(1);
  });
});

describe("O10 handshake and reply target (B10)", () => {
  it("ack carries the nonce and targets the exact origin, never '*'", () => {
    const r = rig();
    r.hello("n1");
    expect(r.replies).toEqual([{ msg: { t: "ack", v: 1, nonce: "n1" }, to: EXT_ORIGIN }]);
    r.ev(1);
    for (const x of r.replies) { expect(x.to).not.toBe("*"); expect(x.to).toBe(EXT_ORIGIN); }
  });
  it("null source: no throw, no reply", () => {
    const r = rig();
    expect(() => r.send({ t: "hello", v: 1, nonce: "n" }, EXT_ORIGIN, null)).not.toThrow();
    expect(r.replies).toEqual([]);
  });
  it("accepted events reach the sink with (projectId, seq, payload) and count", () => {
    const r = rig();
    r.hello(); r.ev(3, { projectId: "pX", payload: { a: [1] } });
    expect(r.accepted).toEqual([["pX", 3, { a: [1] }]]);
    expect(r.c.stats().accepted).toBe(1);
  });
});

describe("O11 protocol, order, sequence (B11, B12)", () => {
  it("event before hello -> NO_HANDSHAKE with seq, sink 0", () => {
    const r = rig(); r.ev(1);
    expect(r.replies[0]!.msg).toEqual({ t: "nack", v: 1, code: "NO_HANDSHAKE", seq: 1 });
    expect(r.accepted).toHaveLength(0);
  });
  it("hello v2 -> UNSUPPORTED_VERSION and no session is created", () => {
    const r = rig(); r.send({ t: "hello", v: 2, nonce: "n" });
    expect(nackCodes(r)).toEqual(["UNSUPPORTED_VERSION"]);
    r.ev(1);
    expect(nackCodes(r)).toEqual(["UNSUPPORTED_VERSION", "NO_HANDSHAKE"]);
    expect(r.accepted).toHaveLength(0);
  });
  it("seq 5 then 5 -> second SEQ_NOT_MONOTONIC (also for lower), sink 1", () => {
    const r = rig(); r.hello(); r.ev(5); r.ev(5); r.ev(4);
    expect(nackCodes(r)).toEqual(["SEQ_NOT_MONOTONIC", "SEQ_NOT_MONOTONIC"]);
    expect(r.replies[1]!.msg).toMatchObject({ seq: 5 });
    expect(r.accepted).toHaveLength(1);
  });
  it("gaps are fine (strictly increasing, not contiguous)", () => {
    const r = rig(); r.hello(); r.ev(1); r.ev(10); expect(r.accepted).toHaveLength(2);
  });
  it("re-hello (port reconnect) restarts the sequence and acks the new nonce", () => {
    const r = rig(); r.hello("n1"); r.ev(1); r.ev(2); r.hello("n2"); r.ev(1);
    expect(r.accepted).toHaveLength(3);
    expect(r.replies.filter((x) => x.msg.t === "ack").map((x) => (x.msg as { nonce: string }).nonce)).toEqual(["n1", "n2"]);
  });
  it("bye clears the session: next event -> NO_HANDSHAKE", () => {
    const r = rig(); r.hello(); r.send({ t: "bye", v: 1 }); r.ev(1);
    expect(nackCodes(r)).toEqual(["NO_HANDSHAKE"]);
  });
  it("sessions are per origin", () => {
    const r = rig([EXT_ORIGIN, OTHER]); r.hello("a", EXT_ORIGIN); r.ev(1, {}, OTHER);
    expect(nackCodes(r)).toEqual(["NO_HANDSHAKE"]);
    expect(r.replies[r.replies.length - 1]!.to).toBe(OTHER);
    r.hello("b", OTHER); r.ev(1, {}, OTHER); r.ev(2, {}, EXT_ORIGIN);
    expect(r.accepted).toHaveLength(2);
  });
});

describe("shape checks (B11)", () => {
  const cases: Array<[string, unknown]> = [
    ["string", "hello"], ["null", null], ["array", []], ["number", 7], ["unknown t", { t: "boom", v: 1 }],
    ["missing t", { v: 1 }], ["hello nonce not string", { t: "hello", v: 1, nonce: 5 }],
    ["event seq string", { t: "event", v: 1, seq: "1", projectId: "p", payload: 1 }],
    ["event seq fractional", { t: "event", v: 1, seq: 1.5, projectId: "p", payload: 1 }],
    ["event seq NaN", { t: "event", v: 1, seq: NaN, projectId: "p", payload: 1 }],
    ["event projectId number", { t: "event", v: 1, seq: 1, projectId: 4, payload: 1 }],
    ["event projectId empty", { t: "event", v: 1, seq: 1, projectId: "", payload: 1 }],
    ["event projectId 129 chars", { t: "event", v: 1, seq: 1, projectId: "p".repeat(129), payload: 1 }],
  ];
  it.each(cases)("%s -> BAD_SHAPE after handshake, sink untouched", (_n, data) => {
    const r = rig(); r.hello(); r.send(data);
    expect(nackCodes(r)).toEqual(["BAD_SHAPE"]);
    expect(r.accepted).toHaveLength(0);
  });
  it("projectId of exactly 128 chars is accepted", () => {
    const r = rig(); r.hello(); r.ev(1, { projectId: "p".repeat(128) });
    expect(r.accepted).toHaveLength(1);
  });
  it("unserialisable data (cycle / BigInt getter) is nacked, never throws", () => {
    const r = rig(); r.hello();
    const cyc: Record<string, unknown> = { t: "event", v: 1, seq: 1, projectId: "p" }; cyc["payload"] = cyc;
    expect(() => r.send(cyc)).not.toThrow();
    expect(() => r.send({ t: "event", v: 1, seq: 2, projectId: "p", payload: 10n })).not.toThrow();
    expect(r.accepted).toHaveLength(0);
  });
});

describe("O12 size and rate (B11, B13)", () => {
  const sized = (n: number) => {
    const base = { t: "event", v: 1, seq: 1, projectId: "p1", payload: "" };
    const pad = n - JSON.stringify(base).length;
    return { ...base, payload: "x".repeat(pad) };
  };
  it("exactly MAX_MSG_CHARS passes, one more -> TOO_LARGE", () => {
    const ok = sized(65536); expect(JSON.stringify(ok).length).toBe(65536);
    const big = { ...sized(65537), seq: 2 }; expect(JSON.stringify(big).length).toBe(65537);
    const r = rig(); r.hello(); r.send(ok); r.send(big);
    expect(r.accepted).toHaveLength(1);
    expect(nackCodes(r)).toEqual(["TOO_LARGE"]);
  });
  it("51st event at the same nowMs -> THROTTLED; sink = 50; throttled event not queued", () => {
    const r = rig(); r.hello();
    for (let i = 1; i <= 51; i++) r.ev(i);
    expect(r.accepted).toHaveLength(50);
    expect(nackCodes(r)).toEqual(["THROTTLED"]);
    expect(r.replies[r.replies.length - 1]!.msg).toMatchObject({ code: "THROTTLED", seq: 51 });
    r.tick(1001); r.ev(52);
    expect(r.accepted).toHaveLength(51);
    expect(r.accepted.map((a) => a[1])).not.toContain(51);
  });
  it("sliding window: events at t=0 still count at t=999", () => {
    const r = rig(); r.hello(); r.setNow(5000);
    for (let i = 1; i <= 50; i++) r.ev(i);
    r.setNow(5999); r.ev(51);
    expect(nackCodes(r)).toEqual(["THROTTLED"]);
  });
  it("rate budget is not consumed by nacked or foreign messages", () => {
    const r = rig(); r.hello();
    for (let i = 0; i < 100; i++) r.ev(1, { projectId: "" }, EXT_ORIGIN);
    for (let i = 0; i < 100; i++) r.ev(1, {}, "https://evil.example");
    for (let i = 1; i <= 50; i++) r.ev(i);
    expect(r.accepted).toHaveLength(50);
  });
});

describe("B14 payload is never logged", () => {
  it("no console output containing payload text", () => {
    const logs: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
    for (const k of Object.keys(orig) as Array<keyof typeof orig>) console[k] = (...a: unknown[]) => { logs.push(JSON.stringify(a)); };
    try { const r = rig(); r.hello(); r.ev(1, { payload: "SECRET-PAYLOAD-TEXT" }); r.ev(1, { payload: "SECRET-PAYLOAD-TEXT" }); }
    finally { Object.assign(console, orig); }
    expect(logs.join("")).not.toContain("SECRET-PAYLOAD-TEXT");
  });
});
