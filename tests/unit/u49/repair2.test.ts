// A-U49r2 (repair loop 2): policy re-checked at launch for queued generates; selection writes never
// let an older write overwrite a newer acknowledged selection.
import { describe, expect, it } from "vitest";
import {
  FakeStore, EP_LOCAL, EP_PRIV, EP_CLOUD, boot, bootReady, mkPort, post, frames, nacks, nackOf, settle,
  selGet, selSet, gen, hostRid, hResult, helloPush, SEL_KEY,
} from "./harness";

describe("P1 policy is re-evaluated at launch for queued generates", () => {
  const flips: Array<[string, Record<string, unknown>]> = [
    ["allow_private true -> false", { ...EP_PRIV, allow_private: false }],
    ["kind local -> remote", { ...EP_PRIV, kind: "remote-openai-compatible", loopback: false }],
  ];
  for (const [name, changed] of flips) {
    it(`${name} while queued: no model_generate for priv1, page gets policy, FIFO continues`, () => {
      const h = bootReady(); const p = mkPort();
      post(h, p, gen("g1"));                                        // occupies the slot
      post(h, p, gen("pv", { id: "priv1", tier: "private" }));      // allowed now, queued
      post(h, p, gen("g2"));                                        // next queued request
      expect(h.native.ofType("model_generate")).toHaveLength(1);
      h.native.emit(helloPush([EP_LOCAL, changed, EP_CLOUD]));      // unsolicited policy change
      h.native.emit(hResult(hostRid(h, "model_generate", 0), "one"));
      const gens = h.native.ofType("model_generate");
      expect(gens.some((f) => f["id"] === "priv1")).toBe(false);
      expect(nacks(p)).toEqual([nackOf("pv", "policy")]);
      expect(gens).toHaveLength(2);
      expect(gens[1]?.["id"]).toBe("local1");
      h.native.emit(hResult(hostRid(h, "model_generate", 1), "two"));
      expect(frames(p).filter((f) => f["t"] === "model_result").map((f) => f["rid"])).toEqual(["g1", "g2"]);
      expect(h.relay.stats().pending).toBe(0);
      expect(h.relay.stats().queued).toBe(0);
    });
  }
  it("still allowed at launch: queued private generate is forwarded unchanged", () => {
    const h = bootReady(); const p = mkPort();
    post(h, p, gen("g1")); post(h, p, gen("pv", { id: "priv1", tier: "private" }));
    h.native.emit(helloPush([EP_LOCAL, EP_PRIV, EP_CLOUD]));
    h.native.emit(hResult(hostRid(h, "model_generate", 0)));
    expect(h.native.ofType("model_generate")[1]?.["id"]).toBe("priv1");
    expect(nacks(p)).toEqual([]);
  });
});

/** Store whose set() calls are held while `hold` is true; a released held set commits, then resolves. */
class DeferredStore extends FakeStore {
  hold = true;
  commits: unknown[] = [];
  private held: Array<() => void> = [];
  override async set(k: string, v: unknown): Promise<void> {
    if (this.hold) await new Promise<void>((r) => this.held.push(r));
    this.commits.push(structuredClone(v));
    return super.set(k, v);
  }
  heldCount(): number { return this.held.length; }
  release(i = 0): void { const r = this.held.splice(i, 1)[0]; if (r !== undefined) r(); }
}
const ackRids = (p: ReturnType<typeof mkPort>): string[] =>
  frames(p).filter((f) => f["t"] === "model_sel").map((f) => String(f["rid"]));

describe("S1 selection writes: an acknowledged selection is never overwritten by an older write", () => {
  it("timed-out older set commits after a newer acknowledged set: final value is the newer one", async () => {
    const store = new DeferredStore(); const h = boot(store); const p = mkPort();
    post(h, p, selSet("a", { all: "local1" })); await settle();
    await h.clock.advance(2_000);
    expect(frames(p)).toEqual([nackOf("a", "store_failed")]);
    store.hold = false;
    post(h, p, selSet("b", { all: "priv1" })); await settle();
    const acked = ackRids(p).includes("b");
    store.release(0); await settle(); await h.clock.advance(5_000); await settle();
    if (acked) expect(store.data.get(SEL_KEY)).toEqual({ v: 1, all: "priv1" });
    else expect(nacks(p)).toContainEqual(nackOf("b", "store_failed"));
    // a later acknowledged set is the final persisted value
    post(h, p, selSet("c", { all: "cloud1" })); await settle(); await h.clock.advance(5_000); await settle();
    expect(ackRids(p)).toContain("c");
    expect(store.data.get(SEL_KEY)).toEqual({ v: 1, all: "cloud1" });
    post(h, p, selGet("g")); await settle();
    expect(frames(p).at(-1)).toEqual({ t: "model_sel", v: 1, rid: "g", selection: { all: "cloud1" } });
  });
  it("two in-budget sets in order A then B, A's set finishes last: both acked, final value is B", async () => {
    const store = new DeferredStore(); const h = boot(store); const p = mkPort();
    post(h, p, selSet("a", { all: "local1" })); await settle();
    store.hold = false;
    post(h, p, selSet("b", { all: "priv1" })); await settle();
    await h.clock.advance(500);
    store.release(0); await settle(); await h.clock.advance(100); await settle();
    expect(ackRids(p).sort()).toEqual(["a", "b"]);
    expect(ackRids(p)).toEqual(["a", "b"]);
    expect(store.data.get(SEL_KEY)).toEqual({ v: 1, all: "priv1" });
  });
});
