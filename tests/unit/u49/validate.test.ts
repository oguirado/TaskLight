// Oracles 6 and 7: validator mirror of model_relay.py:80-108 and the third policy gate.
import { describe, expect, it } from "vitest";
import { bootReady, gen, list, probe, cancel, mkPort, post, nackOf, frames, hostRid, hResult, EP_LOCAL, ENDPOINTS, type Rec } from "./harness";

const msgs = (n: number): Rec[] => Array.from({ length: n }, () => ({ role: "user", content: "x" }));
const without = (o: Rec, k: string): Rec => { const c = { ...o }; delete c[k]; return c; };
const bad: Array<[string, Rec]> = [
  ["generate extra key", gen("r", { extra: 1 })],
  ["generate missing tier", without(gen("r"), "tier")],
  ["generate missing rung", without(gen("r"), "rung")],
  ["tier secret", gen("r", { tier: "secret" })],
  ["tier non-string", gen("r", { tier: 1 })],
  ["role tool", gen("r", { messages: [{ role: "tool", content: "x" }] })],
  ["message extra key", gen("r", { messages: [{ role: "user", content: "x", name: "n" }] })],
  ["message missing content", gen("r", { messages: [{ role: "user" }] })],
  ["content non-string", gen("r", { messages: [{ role: "user", content: 5 }] })],
  ["message not an object", gen("r", { messages: ["hi"] })],
  ["messages not an array", gen("r", { messages: "hi" })],
  ["0 messages", gen("r", { messages: [] })],
  ["33 messages", gen("r", { messages: msgs(33) })],
  ["max_tokens 0", gen("r", { max_tokens: 0 })],
  ["max_tokens 8193", gen("r", { max_tokens: 8193 })],
  ["max_tokens float", gen("r", { max_tokens: 1.5 })],
  ["max_tokens string", gen("r", { max_tokens: "64" })],
  ["rung 0", gen("r", { rung: 0 })],
  ["rung 4", gen("r", { rung: 4 })],
  ["rung string", gen("r", { rung: "2" })],
  ["rung 1 without schema", gen("r", { rung: 1 })],
  ["array schema", gen("r", { rung: 1, schema: [] })],
  ["null schema", gen("r", { rung: 2, schema: null })],
  ["string schema", gen("r", { rung: 3, schema: "x" })],
  ["id uppercase", gen("r", { id: "Local1" })],
  ["id 33 chars", gen("r", { id: "a".repeat(33) })],
  ["id leading dash", gen("r", { id: "-a" })],
  ["id non-string", gen("r", { id: 5 })],
  ["v 2", gen("r", { v: 2 })],
  ["v string", gen("r", { v: "1" })],
  ["list extra key", { ...list("r"), id: "x" }],
  ["probe missing id", without(probe("r"), "id")],
  ["probe bad id", probe("r", "a/b")],
  ["probe extra key", { ...probe("r"), tier: "private" }],
  ["cancel extra key", { ...cancel("r"), id: "x" }],
  ["sel_get extra key", { t: "model_sel_get", v: 1, rid: "r", x: 1 }],
];

describe("O6 validator mirror", () => {
  it.each(bad)("%s -> bad_request, 0 host sends", (_n, frame) => {
    const h = bootReady(); const p = mkPort(); post(h, p, frame);
    expect(frames(p)).toEqual([nackOf("r", "bad_request")]);
    expect(h.native.sent).toEqual([]);
  });
  it("bad_request is answered even when the relay is not ready (validation precedes the gate)", () => {
    const h = bootReady(); h.native.emit({ t: "hello" }); const p = mkPort(); p.sent.length = 0;
    post(h, p, gen("r", { tier: "secret" }));
    expect(frames(p).filter((f) => f["t"] === "model_nack")).toEqual([nackOf("r", "bad_request")]);
  });
  it("invalid frame without a valid rid is dropped silently and counted", () => {
    const h = bootReady(); const p = mkPort();
    const before = h.relay.stats().dropped;
    for (const f of [gen("bad rid!"), gen(""), gen("a".repeat(65)), { ...gen("r"), rid: 5 }, without(gen("r"), "rid"), { t: "model_list", v: 1 }]) post(h, p, f);
    expect(frames(p)).toEqual([]); expect(h.native.sent).toEqual([]);
    expect(h.relay.stats().dropped).toBe(before + 6);
  });
  it("non-object messages are dropped and counted without throwing", () => {
    const h = bootReady(); const p = mkPort();
    expect(() => { for (const m of [null, undefined, 5, "str", [], true]) post(h, p, m); }).not.toThrow();
    expect(frames(p)).toEqual([]); expect(h.relay.stats().dropped).toBe(6);
  });
  it("valid frames pass: assistant role, 32 messages, rung 1/2/3, max_tokens 1 and 8192, schema at any rung", () => {
    const h = bootReady(); const p = mkPort();
    const ok: Rec[] = [
      gen("a", { messages: [{ role: "assistant", content: "" }] }), gen("b", { messages: msgs(32) }), gen("c", { rung: 1, schema: {} }),
      gen("d", { rung: 2 }), gen("e", { max_tokens: 1 }), gen("f", { max_tokens: 8192 }), gen("g", { rung: 3, schema: { type: "object" } }),
    ];
    for (const f of ok) { post(h, p, f); const rid = hostRid(h, "model_generate", h.native.ofType("model_generate").length - 1); h.native.emit(hResult(rid)); }
    expect(h.native.ofType("model_generate")).toHaveLength(ok.length);
    expect(p.ofType("model_nack")).toEqual([]);
  });
  it("oversize: serialized UTF-8 frame of 65,537 bytes -> too_large, 0 sends (with a valid rid)", () => {
    const h = bootReady(); const p = mkPort();
    const base = new TextEncoder().encode(JSON.stringify(gen("r", { messages: [{ role: "user", content: "" }] }))).length;
    const f = gen("r", { messages: [{ role: "user", content: "x".repeat(65537 - base) }] });
    expect(new TextEncoder().encode(JSON.stringify(f)).length).toBe(65537);
    post(h, p, f);
    expect(frames(p)).toEqual([nackOf("r", "too_large")]); expect(h.native.sent).toEqual([]);
  });
  it("oversize is measured in UTF-8 bytes, not characters", () => {
    const h = bootReady(); const p = mkPort();
    const f = gen("r", { messages: [{ role: "user", content: "é".repeat(33000) }] }); // 33k chars, ~66k bytes
    expect(JSON.stringify(f).length).toBeLessThan(65536);
    post(h, p, f);
    expect(frames(p)).toEqual([nackOf("r", "too_large")]); expect(h.native.sent).toEqual([]);
  });
  it("a large but legal frame (~60,000 bytes) is forwarded", () => {
    const h = bootReady(); const p = mkPort();
    post(h, p, gen("r", { messages: [{ role: "user", content: "x".repeat(60000) }] }));
    expect(h.native.ofType("model_generate")).toHaveLength(1); expect(frames(p)).toEqual([]);
  });
});

describe("O7 third policy gate (cached endpoint)", () => {
  const cases: Array<[string, string, string, boolean]> = [
    ["remote + private", "cloud1", "private", false],
    ["remote + shared", "cloud1", "shared", false],
    ["local without allow_private + private", "local1", "private", false],
    ["remote + standard", "cloud1", "standard", true],
    ["local + standard", "local1", "standard", true],
    ["local + shared", "local1", "shared", true],
    ["local with allow_private + private", "priv1", "private", true],
    ["uncached id + private (host decides)", "ghost", "private", true],
    ["uncached id + shared (host decides)", "ghost", "shared", true],
  ];
  it.each(cases)("%s", (_n, id, tier, forwarded) => {
    const h = bootReady(ENDPOINTS); const p = mkPort(); post(h, p, gen("r", { id, tier }));
    if (forwarded) { expect(h.native.ofType("model_generate")).toHaveLength(1); expect(frames(p)).toEqual([]); }
    else { expect(h.native.sent).toEqual([]); expect(frames(p)).toEqual([nackOf("r", "policy")]); }
  });
  it("policy refusal does not occupy the slot and is answered while another request is in flight", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("g1")); post(h, p, gen("g2", { id: "cloud1", tier: "private" }));
    expect(frames(p)).toEqual([nackOf("g2", "policy")]); expect(h.relay.stats().queued).toBe(0);
  });
  it("the cache is the endpoints of the latest model_hello (replaced, not merged)", () => {
    const h = bootReady(ENDPOINTS); h.native.emit({ t: "model_hello", v: 1, endpoints: [{ ...EP_LOCAL, allow_private: true }] });
    const p = mkPort(); post(h, p, gen("r", { id: "cloud1", tier: "private" }));
    expect(h.native.ofType("model_generate")).toHaveLength(1);
    post(h, p, gen("s", { id: "local1", tier: "private" }));
    expect(frames(p).filter((f) => f["t"] === "model_nack")).toEqual([]);
  });
});
