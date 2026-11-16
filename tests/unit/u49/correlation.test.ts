// Oracles 4, 5 and 12 (secrets, stop 3): rids, late replies, host reply validation, whitelisting.
import { describe, expect, it } from "vitest";
import { bootReady, boot, gen, list, probe, mkPort, post, hResult, hHealth, hNack, hostRid, nackOf, frames, wire, settle, ENDPOINTS, EP_LOCAL, CANARY_URL, CANARY_KEY, RELAY_RID, type H } from "./harness";

describe("O4 rids", () => {
  it("two ports use page rid 'a': each gets only its own reply; host frames carry m<n>, never 'a'", () => {
    const h = bootReady(); const A = mkPort(); const B = mkPort("http://localhost:5173");
    post(h, A, list("a")); post(h, B, list("a"));
    const [fa, fb] = h.native.sent;
    expect(String(fa!["rid"])).toMatch(RELAY_RID); expect(String(fb!["rid"])).toMatch(RELAY_RID);
    expect(fa!["rid"]).not.toBe(fb!["rid"]);
    expect(JSON.stringify(h.native.sent)).not.toContain('"a"');
    h.native.emit({ t: "model_hello", v: 1, rid: fb!["rid"], endpoints: [EP_LOCAL] });
    expect(A.ofType("model_hello").filter((f) => "rid" in f)).toEqual([]);
    expect(B.ofType("model_hello").filter((f) => "rid" in f)).toEqual([{ t: "model_hello", v: 1, rid: "a", endpoints: [EP_LOCAL] }]);
    h.native.emit({ t: "model_hello", v: 1, rid: fa!["rid"], endpoints: [] });
    expect(A.ofType("model_hello").filter((f) => "rid" in f)).toEqual([{ t: "model_hello", v: 1, rid: "a", endpoints: [] }]);
    expect(B.ofType("model_hello").filter((f) => "rid" in f)).toHaveLength(1);
  });
  it("two ports, generate with the same page rid: serialized, each result goes to its own port", () => {
    const h = bootReady(); const A = mkPort(); const B = mkPort();
    post(h, A, gen("a")); post(h, B, gen("a"));
    expect(h.native.ofType("model_generate")).toHaveLength(1);
    h.native.emit(hResult(hostRid(h, "model_generate", 0), "for-A"));
    expect(A.ofType("model_result")).toEqual([{ t: "model_result", v: 1, rid: "a", text: "for-A" }]);
    expect(B.ofType("model_result")).toEqual([]);
    expect(h.native.ofType("model_generate")).toHaveLength(2);
    h.native.emit(hResult(hostRid(h, "model_generate", 1), "for-B"));
    expect(B.ofType("model_result")).toEqual([{ t: "model_result", v: 1, rid: "a", text: "for-B" }]);
    expect(A.ofType("model_result")).toHaveLength(1);
    expect(hostRid(h, "model_generate", 0)).not.toBe(hostRid(h, "model_generate", 1));
  });
  it("duplicate pending page rid on the same port: bad_request, no second send, first request unaffected", () => {
    const h = bootReady(); const p = mkPort();
    post(h, p, list("a")); post(h, p, list("a"));
    expect(frames(p)).toEqual([nackOf("a", "bad_request")]);
    expect(h.native.sent).toHaveLength(1);
    h.native.emit({ t: "model_hello", v: 1, rid: hostRid(h, "model_list"), endpoints: [] });
    expect(p.ofType("model_hello")).toEqual([{ t: "model_hello", v: 1, rid: "a", endpoints: [] }]);
    post(h, p, list("a"));
    expect(h.native.ofType("model_list")).toHaveLength(2);
  });
  it("a queued request's page rid also counts as pending (duplicate -> bad_request)", () => {
    const h = bootReady(); const p = mkPort();
    post(h, p, gen("g1")); post(h, p, gen("g2")); post(h, p, gen("g2"));
    expect(frames(p)).toEqual([nackOf("g2", "bad_request")]);
  });
  it("relay rids are unique and monotonic across many requests", () => {
    const h = bootReady(); const p = mkPort();
    for (let i = 0; i < 6; i++) post(h, p, list(`r${i}`));
    const rids = h.native.sent.map((f) => String(f["rid"]));
    expect(new Set(rids).size).toBe(6);
    expect(rids.map((r) => Number(r.slice(1)))).toEqual([...rids.map((r) => Number(r.slice(1)))].sort((x, y) => x - y));
  });
});

describe("O5 late replies", () => {
  it("unknown rid and a second reply for a settled rid are not delivered and counted late", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("g")); const rid = hostRid(h, "model_generate");
    h.native.emit(hResult("m999", "x"));
    expect(frames(p)).toEqual([]); expect(h.relay.stats().late).toBe(1);
    h.native.emit(hResult(rid, "first"));
    expect(p.ofType("model_result")).toHaveLength(1);
    h.native.emit(hResult(rid, "second")); h.native.emit(hNack(rid, "busy"));
    expect(p.ofType("model_result")).toHaveLength(1); expect(p.ofType("model_nack")).toEqual([]);
    expect(h.relay.stats().late).toBe(3);
  });
  it("a reply with a non-string or invalid rid is discarded without throwing", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("g"));
    expect(() => { for (const r of [undefined, null, 5, {}, "x y"]) h.native.emit(hResult(r)); h.native.emit("junk"); h.native.emit(null); h.native.emit([]); }).not.toThrow();
    expect(frames(p)).toEqual([]);
  });
  it("unrelated host frames (event, room_*) are ignored by the model relay", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("g"));
    h.native.emit({ t: "event", v: 1, projectId: "p", payload: {} }); h.native.emit({ t: "room_ack", v: 1, rid: "m1" });
    expect(frames(p)).toEqual([]); expect(h.relay.stats().late).toBe(0);
  });
});

describe("host reply validation (exact keys, valid values)", () => {
  const cases: Array<[string, (rid: string) => unknown]> = [
    ["result with extra key", (r) => ({ ...hResult(r), base_url: CANARY_URL })],
    ["result with non-string text", (r) => hResult(r, 5 as unknown as string)],
    ["result missing text", (r) => ({ t: "model_result", v: 1, rid: r })],
    ["result with v 2", (r) => ({ ...hResult(r), v: 2 })],
    ["health reply to a generate (kind mismatch)", (r) => hHealth(r)],
    ["nack with unknown code", (r) => hNack(r, "weird_code")],
    ["nack with local-only code from host", (r) => hNack(r, "store_failed")],
    ["nack with extra key", (r) => ({ ...hNack(r, "busy"), detail: "x" })],
  ];
  it.each(cases)("generate: %s -> page gets bad_reply, nothing leaks, slot released", (_n, mk) => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("g1")); post(h, p, gen("g2"));
    h.native.emit(mk(hostRid(h, "model_generate", 0)));
    expect(p.ofType("model_nack")).toEqual([nackOf("g1", "bad_reply")]);
    expect(p.ofType("model_result")).toEqual([]);
    expect(h.native.ofType("model_generate")).toHaveLength(2);
    expect(wire(p)).not.toContain(CANARY_URL);
  });
  it("probe reply: bad state, bad rung, wrong id, extra key -> bad_reply", () => {
    for (const bad of [hHealth("R", "local1", "bogus"), hHealth("R", "local1", "available", 4), hHealth("R", "other"), { ...hHealth("R"), key: CANARY_KEY }, hHealth("R", "local1", "available", "2")]) {
      const h = bootReady(); const p = mkPort(); post(h, p, probe("p1", "local1"));
      h.native.emit({ ...bad, rid: hostRid(h, "model_probe") });
      expect(frames(p), JSON.stringify(bad)).toEqual([nackOf("p1", "bad_reply")]);
    }
  });
  it("probe reply with rung 1 / 2 / 3 and every state is delivered whitelisted; host rung null -> bad_reply (A-U49b)", () => {
    for (const [state, rung] of [["available", 1], ["needs_setup", null], ["offline", 3], ["blocked", 2]] as const) {
      const h = bootReady(); const p = mkPort(); post(h, p, probe("p1"));
      h.native.emit(hHealth(hostRid(h, "model_probe"), "local1", state, rung));
      if (rung === null) { expect(frames(p)).toEqual([nackOf("p1", "bad_reply")]); continue; }
      expect(frames(p)).toEqual([{ t: "model_health", v: 1, rid: "p1", id: "local1", state, rung }]);
    }
  });
  it("list reply with an extra endpoint key (base_url) -> bad_reply to the page, not the endpoints", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, list("l"));
    h.native.emit({ t: "model_hello", v: 1, rid: hostRid(h, "model_list"), endpoints: [{ ...EP_LOCAL, base_url: CANARY_URL }] });
    expect(frames(p)).toEqual([nackOf("l", "bad_reply")]);
  });
  it("list reply with a missing endpoint key or wrong types -> bad_reply", () => {
    for (const ep of [{ id: "x" }, { ...EP_LOCAL, loopback: "yes" }, { ...EP_LOCAL, id: "BAD ID" }, "str", null]) {
      const h = bootReady(); const p = mkPort(); post(h, p, list("l"));
      h.native.emit({ t: "model_hello", v: 1, rid: hostRid(h, "model_list"), endpoints: [ep] });
      expect(frames(p), JSON.stringify(ep)).toEqual([nackOf("l", "bad_reply")]);
    }
  });
});

describe("O12 secrets (stop 3)", () => {
  it("canary base_url/key in a model_hello push: not ready, never forwarded to any page frame", () => {
    const h = boot(); const p = mkPort(); post(h, p, list("seen")); p.sent.length = 0;
    h.native.emit({ t: "model_hello", v: 1, endpoints: [{ ...EP_LOCAL, base_url: CANARY_URL, key: CANARY_KEY }] });
    post(h, p, gen("g")); post(h, p, list("l2"));
    expect(wire(p)).not.toContain("CANARY"); expect(wire(p)).not.toContain("canary-host");
    expect(frames(p)).toEqual([nackOf("g", "host_absent"), { t: "model_hello", v: 1, rid: "l2", endpoints: [] }]);
    expect(h.store.writes).toEqual([]);
  });
  it("canary in model_result extras: dropped, page gets bad_reply with no canary, store untouched", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("g"));
    h.native.emit({ ...hResult(hostRid(h, "model_generate"), "fine"), base_url: CANARY_URL, key: CANARY_KEY });
    expect(frames(p)).toEqual([nackOf("g", "bad_reply")]);
    expect(wire(p)).not.toMatch(/CANARY|canary-host/); expect(JSON.stringify(h.store.writes)).not.toMatch(/CANARY|canary-host/);
  });
  it("canary in a health extra and in a list reply endpoint: absent from every page frame", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, probe("p")); post(h, p, list("l"));
    h.native.emit({ ...hHealth(hostRid(h, "model_probe")), key: CANARY_KEY });
    h.native.emit({ t: "model_hello", v: 1, rid: hostRid(h, "model_list"), endpoints: [{ ...EP_LOCAL, key: CANARY_KEY }] });
    expect(wire(p)).not.toContain("CANARY");
  });
  it("a valid host frame is rebuilt, not spread: a getter/prototype extra cannot appear", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("g"));
    const reply = Object.create({ base_url: CANARY_URL }) as Record<string, unknown>;
    Object.assign(reply, hResult(hostRid(h, "model_generate"), "fine"));
    h.native.emit(reply);
    expect(JSON.stringify(frames(p))).not.toContain("canary-host");
  });
  it("selection writes carry ids only (no canary) and a canary selection is refused", async () => {
    const h = boot(); const p = mkPort();
    post(h, p, { t: "model_sel_set", v: 1, rid: "s", selection: { all: CANARY_URL } }); await settle();
    post(h, p, { t: "model_sel_set", v: 1, rid: "s2", selection: { all: "ok-id", key: CANARY_KEY } }); await settle();
    expect(h.store.writes).toEqual([]); expect(wire(p)).not.toMatch(/CANARY|canary-host/);
  });
});
