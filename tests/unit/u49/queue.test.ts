// Oracles 8 and 9: serialization queue and timeouts (fake clock).
import { describe, expect, it } from "vitest";
import { bootReady, gen, list, probe, mkPort, post, hResult, hHealth, hNack, hostRid, nackOf, frames, settle, type H } from "./harness";
import type { FakePort } from "./harness";

const gens = (h: H) => h.native.ofType("model_generate");

describe("O8 queue", () => {
  it("1 in flight + 8 queued: the 10th gets busy; only one generate is on the wire", () => {
    const h = bootReady(); const p = mkPort();
    for (let i = 0; i < 9; i++) post(h, p, gen(`g${i}`));
    expect(frames(p)).toEqual([]); expect(gens(h)).toHaveLength(1);
    expect(h.relay.stats().queued).toBe(8);
    post(h, p, gen("g9"));
    expect(frames(p)).toEqual([nackOf("g9", "busy")]); expect(gens(h)).toHaveLength(1);
  });
  it("the first reply releases the next in FIFO order, one at a time", () => {
    const h = bootReady(); const p = mkPort();
    for (let i = 0; i < 4; i++) post(h, p, gen(`g${i}`));
    for (let i = 0; i < 4; i++) {
      expect(gens(h)).toHaveLength(i + 1);
      h.native.emit(hResult(hostRid(h, "model_generate", i), `t${i}`));
    }
    expect(p.ofType("model_result").map((f) => f["rid"])).toEqual(["g0", "g1", "g2", "g3"]);
    expect(gens(h)).toHaveLength(4);
  });
  it("after the queue drains, a new request is forwarded immediately and the overflow slot is free again", () => {
    const h = bootReady(); const p = mkPort();
    for (let i = 0; i < 9; i++) post(h, p, gen(`g${i}`));
    for (let i = 0; i < 9; i++) h.native.emit(hResult(hostRid(h, "model_generate", i)));
    expect(gens(h)).toHaveLength(9); expect(h.relay.stats().queued).toBe(0);
    post(h, p, gen("n")); expect(gens(h)).toHaveLength(10);
  });
  it("probe and generate share the single slot", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, probe("p1")); post(h, p, gen("g1"));
    expect(h.native.ofType("model_probe")).toHaveLength(1); expect(gens(h)).toHaveLength(0);
    h.native.emit(hHealth(hostRid(h, "model_probe")));
    expect(gens(h)).toHaveLength(1);
  });
  it("model_list bypasses the queue, even with 8 queued", () => {
    const h = bootReady(); const p = mkPort();
    for (let i = 0; i < 9; i++) post(h, p, gen(`g${i}`));
    post(h, p, list("l")); expect(h.native.ofType("model_list")).toHaveLength(1);
    expect(frames(p)).toEqual([]);
  });
  it("host busy passes through and still releases the slot", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("g1")); post(h, p, gen("g2"));
    h.native.emit(hNack(hostRid(h, "model_generate", 0), "busy"));
    expect(frames(p)).toEqual([nackOf("g1", "busy")]); expect(gens(h)).toHaveLength(2);
  });
  it("requests of different ports share one queue (FIFO across ports)", () => {
    const h = bootReady(); const A = mkPort(); const B = mkPort();
    post(h, A, gen("a")); post(h, B, gen("b")); post(h, A, gen("c"));
    h.native.emit(hResult(hostRid(h, "model_generate", 0), "1")); h.native.emit(hResult(hostRid(h, "model_generate", 1), "2"));
    expect(B.ofType("model_result")).toHaveLength(1); expect(gens(h)).toHaveLength(3);
  });
  it("a throwing page port does not stall the queue", () => {
    const h = bootReady(); const A = mkPort(); const B = mkPort(); post(h, A, gen("a")); post(h, B, gen("b"));
    A.disconnected = true;
    expect(() => h.native.emit(hResult(hostRid(h, "model_generate", 0)))).not.toThrow();
    expect(gens(h)).toHaveLength(2);
  });
});

describe("O9 timeouts (budget = host budget + 2,000 ms, armed at acceptance)", () => {
  const timeoutOf = (p: FakePort, rid: string) => p.ofType("model_nack").filter((f) => f["rid"] === rid && f["code"] === "timeout");

  it("probe: silent at 3,499 ms; at 3,500 ms timeout + one host model_cancel with the relay rid", async () => {
    const h = bootReady(); const p = mkPort(); post(h, p, probe("p")); const rid = hostRid(h, "model_probe");
    await h.clock.advance(3499);
    expect(frames(p)).toEqual([]); expect(h.native.ofType("model_cancel")).toEqual([]);
    await h.clock.advance(1);
    expect(frames(p)).toEqual([nackOf("p", "timeout")]);
    expect(h.native.ofType("model_cancel")).toEqual([{ t: "model_cancel", v: 1, rid }]);
  });
  it("local generate (id cached local): 32,000 ms", async () => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("g", { id: "local1" })); const rid = hostRid(h, "model_generate");
    await h.clock.advance(31999); expect(frames(p)).toEqual([]);
    await h.clock.advance(1);
    expect(frames(p)).toEqual([nackOf("g", "timeout")]); expect(h.native.ofType("model_cancel")).toEqual([{ t: "model_cancel", v: 1, rid }]);
  });
  it("remote generate: 62,000 ms", async () => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("g", { id: "cloud1" })); const rid = hostRid(h, "model_generate");
    await h.clock.advance(61999); expect(frames(p)).toEqual([]);
    await h.clock.advance(1);
    expect(frames(p)).toEqual([nackOf("g", "timeout")]); expect(h.native.ofType("model_cancel")).toEqual([{ t: "model_cancel", v: 1, rid }]);
  });
  it("uncached generate id: 62,000 ms", async () => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("g", { id: "ghost" }));
    await h.clock.advance(61999); expect(frames(p)).toEqual([]);
    await h.clock.advance(1); expect(frames(p)).toEqual([nackOf("g", "timeout")]);
  });
  it("list: 2,000 ms -> timeout to the page (host cancel for list not pinned, J5)", async () => {
    const h = bootReady(); const p = mkPort(); post(h, p, list("l"));
    await h.clock.advance(1999); expect(frames(p)).toEqual([]);
    await h.clock.advance(1); expect(frames(p)).toEqual([nackOf("l", "timeout")]);
  });
  it("a reply after the timeout is not delivered (late), the slot is free and the next request is forwarded", async () => {
    const h = bootReady(); const p = mkPort(); post(h, p, probe("p")); post(h, p, gen("g")); const rid = hostRid(h, "model_probe");
    expect(gens(h)).toHaveLength(0);
    await h.clock.advance(3500);
    expect(gens(h)).toHaveLength(1);
    p.sent.length = 0;
    h.native.emit(hHealth(rid)); expect(frames(p)).toEqual([]); expect(h.relay.stats().late).toBe(1);
  });
  it("a reply in time clears the timer: no timeout, no cancel, no pending timers", async () => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("g", { id: "cloud1" }));
    expect(h.clock.pending()).toBeGreaterThanOrEqual(1);
    h.native.emit(hResult(hostRid(h, "model_generate")));
    await settle(); expect(h.clock.pending()).toBe(0);
    await h.clock.advance(120000);
    expect(p.ofType("model_nack")).toEqual([]); expect(h.native.ofType("model_cancel")).toEqual([]);
  });
  it("a queued request times out in the queue at its own budget, with no host cancel, without disturbing the in-flight one", async () => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("g", { id: "cloud1" })); post(h, p, probe("q"));
    await h.clock.advance(3499); expect(frames(p)).toEqual([]);
    await h.clock.advance(1);
    expect(frames(p)).toEqual([nackOf("q", "timeout")]);
    expect(h.native.ofType("model_cancel")).toEqual([]); expect(h.native.ofType("model_probe")).toEqual([]);
    expect(h.relay.stats().queued).toBe(0);
    h.native.emit(hResult(hostRid(h, "model_generate"))); expect(p.ofType("model_result")).toHaveLength(1);
  });
  it("timers are armed once at acceptance: the queued budget starts when accepted, not when forwarded", async () => {
    const h = bootReady(); const p = mkPort(); post(h, p, probe("p1")); await h.clock.advance(3000); post(h, p, probe("p2"));
    h.native.emit(hHealth(hostRid(h, "model_probe", 0))); // p2 forwarded at t=3000, accepted at t=3000
    await h.clock.advance(3499); expect(frames(p).filter((f) => f["rid"] === "p2")).toEqual([]);
    await h.clock.advance(1); expect(frames(p).filter((f) => f["rid"] === "p2")).toEqual([nackOf("p2", "timeout")]);
  });
});
