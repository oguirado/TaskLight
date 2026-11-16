// Oracles 1-3: gate, reset, disconnected.
import { describe, expect, it } from "vitest";
import { boot, bootReady, gen, list, mkPort, post, probe, hResult, hNack, helloPush, nackOf, frames, hostRid, RELAY_RID, ENDPOINTS, EP_LOCAL, settle } from "./harness";

describe("O1 gate: nothing reaches the host before a valid model_hello", () => {
  it("not ready: list/probe/generate are answered locally with 0 host sends", () => {
    const h = boot(); const p = mkPort();
    post(h, p, list("r1")); post(h, p, probe("r2")); post(h, p, gen("r3"));
    expect(frames(p)).toEqual([
      { t: "model_hello", v: 1, rid: "r1", endpoints: [] },
      { t: "model_health", v: 1, rid: "r2", id: "local1", state: "needs_setup", rung: null },
      nackOf("r3", "host_absent"),
    ]);
    expect(h.native.sent).toEqual([]);
  });
  it("a host {t:'hello'} alone does not open the gate", () => {
    const h = boot(); const p = mkPort(); h.native.emit({ t: "hello" }); post(h, p, gen("g"));
    expect(frames(p).filter((f) => f["t"] === "model_nack")).toEqual([nackOf("g", "host_absent")]);
    expect(h.native.sent).toEqual([]);
  });
  it("invalid model_hello (extra endpoint key, bad kind, non-array) does not open the gate", () => {
    for (const bad of [
      { t: "model_hello", v: 1, endpoints: [{ ...EP_LOCAL, base_url: "x" }] },
      { t: "model_hello", v: 1, endpoints: [{ ...EP_LOCAL, kind: "other" }] },
      { t: "model_hello", v: 1, endpoints: "nope" },
      { t: "model_hello", v: 2, endpoints: [] },
      { t: "model_hello", v: 1, endpoints: [], extra: 1 },
    ]) {
      const h = boot(); const p = mkPort(); h.native.emit(bad); post(h, p, gen("g"));
      expect(frames(p), JSON.stringify(bad)).toEqual([nackOf("g", "host_absent")]);
      expect(h.native.sent).toEqual([]);
    }
  });
  it("after model_hello: list, probe and generate are forwarded with relay rids; the page rid never reaches the host", () => {
    const h = bootReady(); const p = mkPort();
    post(h, p, list("pl")); post(h, p, probe("pp")); post(h, p, gen("pg", { id: "local1" }));
    // A-U49a: probe and generate share the single host slot (queue.test.ts); release the probe so generate is forwarded
    h.native.emit({ t: "model_health", v: 1, rid: hostRid(h, "model_probe"), id: "local1", state: "available", rung: 3 });
    expect(h.native.sent).toHaveLength(3);
    const [l, pr, g] = h.native.sent;
    expect(l).toEqual({ t: "model_list", v: 1, rid: l!["rid"] });
    expect(pr).toEqual({ t: "model_probe", v: 1, rid: pr!["rid"], id: "local1" });
    expect(g).toMatchObject({ t: "model_generate", v: 1, id: "local1", tier: "standard", max_tokens: 64, rung: 3 });
    expect(Object.keys(g!).sort()).toEqual(["id", "max_tokens", "messages", "rung", "rid", "t", "tier", "v"].sort());
    for (const f of h.native.sent) expect(String(f["rid"])).toMatch(RELAY_RID);
    expect(new Set(h.native.sent.map((f) => f["rid"])).size).toBe(3);
    expect(JSON.stringify(h.native.sent)).not.toMatch(/"rid":"p[lpg]"/);
    expect(frames(p).filter((f) => f["t"] !== "model_health")).toEqual([]);
  });
  it("schema is forwarded verbatim when present", () => {
    const h = bootReady(); const p = mkPort(); const schema = { type: "object", properties: { a: { type: "string" } } };
    post(h, p, gen("g", { rung: 1, schema }));
    expect(h.native.last()["schema"]).toEqual(schema);
  });
  it("replies are rewritten back to the page rid and rebuilt from whitelisted keys", async () => {
    const h = bootReady(); const p = mkPort();
    post(h, p, list("pl")); post(h, p, probe("pp", "local1")); post(h, p, gen("pg"));
    h.native.emit({ t: "model_hello", v: 1, rid: hostRid(h, "model_list"), endpoints: ENDPOINTS });
    h.native.emit({ t: "model_health", v: 1, rid: hostRid(h, "model_probe"), id: "local1", state: "available", rung: 2 });
    await settle();
    h.native.emit(hResult(hostRid(h, "model_generate"), "hello world")); await settle();
    expect(frames(p)).toEqual([
      { t: "model_hello", v: 1, rid: "pl", endpoints: ENDPOINTS },
      { t: "model_health", v: 1, rid: "pp", id: "local1", state: "available", rung: 2 },
      { t: "model_result", v: 1, rid: "pg", text: "hello world" },
    ]);
  });
  it("host nack codes are routed with the page rid", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("pg"));
    h.native.emit(hNack(hostRid(h, "model_generate"), "rate_limited"));
    expect(frames(p)).toEqual([nackOf("pg", "rate_limited")]);
  });
  it("host model_hello pushes {t,v,endpoints} (no rid) to ports that sent a model_* frame, and only to them", () => {
    const h = boot(); const a = mkPort(); const b = mkPort("http://localhost:5173");
    post(h, a, list("x"));
    a.sent.length = 0;
    h.native.emit({ t: "model_hello", v: 1, endpoints: ENDPOINTS });
    expect(frames(a)).toEqual([helloPush(ENDPOINTS as unknown as unknown[])]);
    expect(frames(b)).toEqual([]);
  });
});

describe("O2 reset on host hello", () => {
  it("clears ready+cache: 0 sends afterwards, forwarded pending gets host_absent, push carries []", () => {
    const h = bootReady(); const p = mkPort(); const q = mkPort();
    post(h, p, gen("g1")); post(h, q, list("l1"));
    expect(h.native.sent).toHaveLength(2);
    p.sent.length = 0; q.sent.length = 0;
    h.native.emit({ t: "hello" });
    expect(frames(p)).toEqual(expect.arrayContaining([nackOf("g1", "host_absent"), helloPush([])]));
    expect(frames(p)).toHaveLength(2);
    expect(frames(q)).toEqual(expect.arrayContaining([nackOf("l1", "host_absent"), helloPush([])]));
    const before = h.native.sent.length;
    p.sent.length = 0;
    post(h, p, gen("g2")); post(h, p, list("l2"));
    expect(h.native.sent).toHaveLength(before);
    expect(frames(p)).toEqual([nackOf("g2", "host_absent"), { t: "model_hello", v: 1, rid: "l2", endpoints: [] }]);
  });
  it("a queued (not yet forwarded) request also gets exactly one host_absent (J2)", () => {
    const h = bootReady(); const p = mkPort();
    post(h, p, gen("g1")); post(h, p, gen("g2")); p.sent.length = 0;
    h.native.emit({ t: "hello" });
    const ns = p.ofType("model_nack");
    expect(ns).toHaveLength(2);
    expect(ns).toEqual(expect.arrayContaining([nackOf("g1", "host_absent"), nackOf("g2", "host_absent")]));
    expect(h.native.ofType("model_generate")).toHaveLength(1);
  });
  it("replies for pre-reset rids are late, not delivered", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("g1")); const rid = hostRid(h, "model_generate");
    h.native.emit({ t: "hello" }); p.sent.length = 0;
    h.native.emit(hResult(rid));
    expect(frames(p)).toEqual([]);
    expect(h.relay.stats().late).toBe(1);
  });
  it("a new model_hello after the reset re-opens the gate", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, list("a"));
    h.native.emit({ t: "hello" }); h.native.emit({ t: "model_hello", v: 1, endpoints: [EP_LOCAL] }); p.sent.length = 0;
    const n = h.native.sent.length; post(h, p, gen("g"));
    expect(h.native.sent).toHaveLength(n + 1);
    expect(frames(p)).toEqual([]);
  });
});

describe("O3 native disconnected", () => {
  it("connected() false: 0 sends, host_absent; relay resets and pushes []", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, list("seen")); p.sent.length = 0;
    const n = h.native.sent.length; h.native.up = false;
    post(h, p, gen("g1"));
    expect(h.native.sent).toHaveLength(n);
    expect(frames(p)).toEqual(expect.arrayContaining([nackOf("g1", "host_absent")]));
    expect(frames(p)).toEqual(expect.arrayContaining([helloPush([])]));
  });
  it("after reconnect the gate stays closed until a new model_hello", () => {
    const h = bootReady(); const p = mkPort();
    h.native.up = false; post(h, p, gen("g1")); h.native.up = true; p.sent.length = 0;
    const n = h.native.sent.length; post(h, p, gen("g2"));
    expect(frames(p)).toEqual([nackOf("g2", "host_absent")]);
    expect(h.native.sent).toHaveLength(n);
  });
  it("send() returning false (port dropped mid-call) answers host_absent and keeps the relay usable", () => {
    const h = bootReady(); const p = mkPort();
    const orig = h.native.send.bind(h.native); h.native.send = () => false;
    post(h, p, gen("g1"));
    expect(frames(p).filter((f) => f["t"] === "model_nack")).toEqual([nackOf("g1", "host_absent")]);
    h.native.send = orig; h.native.emit({ t: "hello" }); h.native.emit({ t: "model_hello", v: 1, endpoints: ENDPOINTS });
    p.sent.length = 0; post(h, p, gen("g2"));
    expect(h.native.ofType("model_generate").length).toBe(1);
  });
});
