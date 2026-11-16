// A-U49r1 (repair loop 1): bounded selection ops, contained onFrame registration, clock failures, host rung null.
import { describe, expect, it } from "vitest";
import { createModelRelay } from "../../../extension/src/model_relay";
import {
  FakeNative, FakeStore, FakeClock, ENDPOINTS, boot, bootReady, mkPort, post, frames, nackOf, settle,
  selGet, selSet, gen, list, probe, hostRid, hResult, hHealth,
} from "./harness";

/** Store whose ops never settle until released by hand. */
class HangStore extends FakeStore {
  hang = true;
  private releases: Array<() => void> = [];
  override async get(k: string): Promise<unknown> {
    if (!this.hang) return super.get(k);
    await new Promise<void>((r) => this.releases.push(r));
    return { v: 1, all: "late1" };
  }
  override async set(k: string, v: unknown): Promise<void> {
    if (!this.hang) return super.set(k, v);
    await new Promise<void>((r) => this.releases.push(r));
  }
  releaseAll(): void { const rs = this.releases; this.releases = []; for (const r of rs) r(); }
}
const SEL_MS = 2_000;
const selFrame = (rid: string, selection: unknown) => ({ t: "model_sel", v: 1, rid, selection });

describe("R1 selection ops are bounded (2,000 ms)", () => {
  for (const op of ["get", "set"] as const) {
    it(`never-settling store.${op} -> store_failed at the budget, rid released, late completion ignored`, async () => {
      const store = new HangStore(); const h = boot(store); const p = mkPort();
      const msg = op === "get" ? selGet("s") : selSet("s", { all: "local1" });
      post(h, p, msg); await settle();
      await h.clock.advance(SEL_MS - 1);
      expect(frames(p)).toEqual([]);
      await h.clock.advance(1);
      expect(frames(p)).toEqual([nackOf("s", "store_failed")]);
      // rid reusable: a second op with the same rid is accepted (not bad_request), and it settles normally
      store.hang = false;
      post(h, p, op === "get" ? selGet("s") : selSet("s", { all: "local1" })); await settle();
      expect(frames(p)).toHaveLength(2);
      expect(frames(p)[1]).toEqual(op === "get" ? selFrame("s", {}) : selFrame("s", { all: "local1" }));
      // the first op completes late: nothing more is delivered
      store.releaseAll(); await settle();
      expect(frames(p)).toHaveLength(2);
    });
  }
  it("settled selection ops leave no timer behind", async () => {
    const h = boot(); const p = mkPort();
    post(h, p, selGet("s")); await settle();
    expect(frames(p)).toEqual([selFrame("s", {})]);
    expect(h.clock.pending()).toBe(0);
  });
});

describe("R2 native.onFrame registration throws", () => {
  it("relay is constructed; model_list answered locally; generate host_absent; nothing sent", () => {
    const native = new FakeNative();
    native.onFrame = () => { throw new Error("onFrame boom"); };
    let relay: ReturnType<typeof createModelRelay> | undefined;
    expect(() => { relay = createModelRelay({ native, clock: new FakeClock(), store: new FakeStore() }); }).not.toThrow();
    const p = mkPort();
    relay!.onPortMessage(p, list("l"));
    relay!.onPortMessage(p, gen("g"));
    expect(frames(p)).toEqual([{ t: "model_hello", v: 1, rid: "l", endpoints: [] }, nackOf("g", "host_absent")]);
    expect(native.sent).toEqual([]);
  });
});

describe("R3 clock failures", () => {
  it("setTimer throwing at acceptance: exactly one local terminal reply per kind, nothing forwarded", () => {
    const h = bootReady();
    h.clock.setTimer = () => { throw new Error("timer boom"); };
    const p = mkPort();
    post(h, p, gen("g")); post(h, p, probe("pr")); post(h, p, list("l"));
    expect(frames(p)).toEqual([
      nackOf("g", "host_absent"),
      { t: "model_health", v: 1, rid: "pr", id: "local1", state: "needs_setup", rung: null },
      { t: "model_hello", v: 1, rid: "l", endpoints: [] },
    ]);
    expect(h.native.sent).toEqual([]);
    // rids released: no duplicate-rid bad_request on reuse
    post(h, p, gen("g"));
    expect(frames(p)[3]).toEqual(nackOf("g", "host_absent"));
  });
  it("setTimer throwing for a selection op: store_failed, store untouched", async () => {
    const h = boot(); h.clock.setTimer = () => { throw new Error("timer boom"); };
    const p = mkPort(); post(h, p, selSet("s", { all: "local1" })); await settle();
    expect(frames(p)).toEqual([nackOf("s", "store_failed")]);
    expect(h.store.writes).toEqual([]);
  });
  it("disarm throwing: entry still removed, slot released, next queued request forwarded", () => {
    const h = bootReady();
    const real = h.clock.setTimer.bind(h.clock);
    h.clock.setTimer = (ms: number, fn: () => void) => { real(ms, fn); return () => { throw new Error("disarm boom"); }; };
    const p = mkPort();
    post(h, p, gen("g1")); post(h, p, gen("g2"));
    expect(h.native.ofType("model_generate")).toHaveLength(1);
    h.native.emit(hResult(hostRid(h, "model_generate", 0), "one"));
    expect(frames(p)).toEqual([{ t: "model_result", v: 1, rid: "g1", text: "one" }]);
    expect(h.native.ofType("model_generate")).toHaveLength(2);
    h.native.emit(hResult(hostRid(h, "model_generate", 1), "two"));
    expect(frames(p)[1]).toEqual({ t: "model_result", v: 1, rid: "g2", text: "two" });
    expect(h.relay.stats().pending).toBe(0);
  });
});

describe("R4 host model_health with rung null (A-U49b)", () => {
  it("host rung null -> bad_reply (null only in local answers)", () => {
    const h = bootReady(ENDPOINTS); const p = mkPort(); post(h, p, probe("p1"));
    h.native.emit(hHealth(hostRid(h, "model_probe"), "local1", "needs_setup", null));
    expect(frames(p)).toEqual([nackOf("p1", "bad_reply")]);
  });
});
