// Oracles 10 and 11: cancel and port close.
import { describe, expect, it } from "vitest";
import { bootReady, gen, list, probe, cancel, mkPort, post, hResult, hNack, hostRid, nackOf, frames, wire } from "./harness";

describe("O10 cancel", () => {
  it("queued: removed, local cancelled, 0 host sends, never forwarded afterwards", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("g1")); post(h, p, gen("g2")); const n = h.native.sent.length;
    post(h, p, cancel("g2"));
    expect(frames(p)).toEqual([nackOf("g2", "cancelled")]); expect(h.native.sent).toHaveLength(n);
    h.native.emit(hResult(hostRid(h, "model_generate", 0)));
    expect(h.native.ofType("model_generate")).toHaveLength(1); expect(h.relay.stats().queued).toBe(0);
  });
  it("in flight: exactly one model_cancel with the relay rid; host's cancelled nack is routed to the page rid", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("g1")); const rid = hostRid(h, "model_generate");
    post(h, p, cancel("g1"));
    expect(h.native.ofType("model_cancel")).toEqual([{ t: "model_cancel", v: 1, rid }]);
    expect(frames(p)).toEqual([]);
    h.native.emit(hNack(rid, "cancelled"));
    expect(frames(p)).toEqual([nackOf("g1", "cancelled")]);
  });
  it("a second cancel for the same in-flight rid sends no second model_cancel", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("g1")); post(h, p, cancel("g1")); post(h, p, cancel("g1"));
    expect(h.native.ofType("model_cancel")).toHaveLength(1);
  });
  it("in-flight probe is cancelled the same way", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, probe("p1")); const rid = hostRid(h, "model_probe");
    post(h, p, cancel("p1")); expect(h.native.ofType("model_cancel")).toEqual([{ t: "model_cancel", v: 1, rid }]);
  });
  it("unknown rid: no frame to the page and nothing to the host", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, cancel("nope"));
    expect(frames(p)).toEqual([]); expect(h.native.sent).toEqual([]);
  });
  it("already-settled rid: silence", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("g1")); h.native.emit(hResult(hostRid(h, "model_generate"))); p.sent.length = 0; const n = h.native.sent.length;
    post(h, p, cancel("g1")); expect(frames(p)).toEqual([]); expect(h.native.sent).toHaveLength(n);
  });
  it("a port cannot cancel another port's request with the same page rid", () => {
    const h = bootReady(); const A = mkPort(); const B = mkPort(); post(h, A, gen("x"));
    post(h, B, cancel("x"));
    expect(h.native.ofType("model_cancel")).toEqual([]); expect(frames(B)).toEqual([]);
  });
  it("cancelling an in-flight request lets the next queued one run once the host nack arrives", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, gen("g1")); post(h, p, gen("g2")); const rid = hostRid(h, "model_generate");
    post(h, p, cancel("g1")); h.native.emit(hNack(rid, "cancelled"));
    expect(h.native.ofType("model_generate")).toHaveLength(2);
  });
  it("cancel of a list in flight does not break the relay (J5: only the page-side outcome is pinned)", () => {
    const h = bootReady(); const p = mkPort(); post(h, p, list("l")); expect(() => post(h, p, cancel("l"))).not.toThrow();
  });
});

describe("O11 port close", () => {
  it("queued dropped, in-flight cancelled at the host, nothing delivered to the closed port after", () => {
    const h = bootReady(); const A = mkPort(); const B = mkPort();
    post(h, A, gen("a1")); post(h, A, gen("a2")); post(h, B, gen("b1"));
    const rid = hostRid(h, "model_generate", 0);
    A.peerClose(); h.relay.onPortClosed(A);
    expect(h.native.ofType("model_cancel")).toEqual([{ t: "model_cancel", v: 1, rid }]);
    expect(h.native.ofType("model_generate")).toHaveLength(1);
    h.native.emit(hNack(rid, "cancelled")); h.native.emit(hResult(rid));
    expect(frames(A)).toEqual([]);
    expect(h.native.ofType("model_generate")).toHaveLength(2); // a2 was dropped; b1 runs next
    expect(h.native.ofType("model_generate")[1]!["rid"]).not.toBe(rid);
    h.native.emit(hResult(hostRid(h, "model_generate", 1), "to-B"));
    expect(B.ofType("model_result")).toEqual([{ t: "model_result", v: 1, rid: "b1", text: "to-B" }]);
    expect(wire(A)).toBe("[[]]"); // A-U49a: wire() wraps A.sent in an array; empty port serialises as [[]]
  });
  it("closing a port with only queued entries sends no host frame", () => {
    const h = bootReady(); const A = mkPort(); const B = mkPort(); post(h, B, gen("b")); post(h, A, gen("a")); const n = h.native.sent.length;
    A.peerClose(); h.relay.onPortClosed(A);
    expect(h.native.sent).toHaveLength(n); expect(h.relay.stats().queued).toBe(0);
  });
  it("closing is idempotent and tolerates unknown ports; pending map is emptied", () => {
    const h = bootReady(); const A = mkPort(); post(h, A, list("l"));
    expect(() => { h.relay.onPortClosed(A); h.relay.onPortClosed(A); h.relay.onPortClosed(mkPort()); }).not.toThrow();
    expect(h.relay.stats().pending).toBe(0);
  });
  it("a closed port gets no push on the next host hello", () => {
    const h = bootReady(); const A = mkPort(); post(h, A, list("l")); A.sent.length = 0; h.relay.onPortClosed(A);
    h.native.emit({ t: "hello" }); h.native.emit({ t: "model_hello", v: 1, endpoints: [] });
    expect(frames(A)).toEqual([]);
  });
  it("timers of a closed port's requests are cleared", async () => {
    const h = bootReady(); const A = mkPort(); post(h, A, gen("a")); post(h, A, gen("b")); h.relay.onPortClosed(A);
    await h.clock.advance(120000); expect(frames(A)).toEqual([]);
    expect(h.native.ofType("model_cancel")).toHaveLength(1);
  });
});
