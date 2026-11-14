// S14 failures_and_ids (B11, B17) + raw ids never reach a path or doc (B7).
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { SYNC_LIMITS } from "../../../src/sync";
import { makeEnv, cap, drain, settle, textLeaks, assertB4Paths } from "./harness";

const unhandled: unknown[] = [];
const onUnhandled = (r: unknown): void => { unhandled.push(r); };
beforeEach(() => { unhandled.length = 0; process.on("unhandledRejection", onUnhandled); });
afterEach(async () => { await settle(); process.off("unhandledRejection", onUnhandled); expect(unhandled).toEqual([]); });

describe("S14 failures_and_ids", () => {
  it.each(["throw", "reject"] as const)("port %s: flush resolves, entry kept, backoff doubles 1 s -> 30 s cap", async (mode) => {
    const e = makeEnv();
    e.fs.mode = mode;
    e.sync.putCapsule("p1", cap());
    const st = await e.sync.flush();
    expect(st).toMatchObject({ state: "pending", pending: 1 });
    expect(st.counters.denied).toBe(0);
    expect(e.fs.txnCalls).toBe(1);
    for (let k = 0; k < 7; k++) {
      const delay = Math.min(SYNC_LIMITS.BACKOFF_MIN_MS * 2 ** k, SYNC_LIMITS.BACKOFF_MAX_MS);
      const n = e.fs.txnCalls;
      await e.clock.advance(delay - 1);
      await e.sync.flush();
      expect(e.fs.txnCalls, `no retry before ${delay} ms (round ${k})`).toBe(n);
      await e.clock.advance(1);
      await e.sync.flush();
      expect(e.fs.txnCalls, `one retry at ${delay} ms (round ${k})`).toBe(n + 1);
    }
    expect(e.sync.status().detail).toBe("BACKOFF");
    e.fs.mode = "ok";
    await drain(e);
    expect(e.fs.committedTo("capsules")).toHaveLength(1);
  });
  it("never-settling transaction: 10 s timeout, flush resolves, entry kept, then recovers", async () => {
    const e = makeEnv();
    e.fs.mode = "hang";
    e.sync.putCapsule("p1", cap());
    let resolved = false;
    const p = e.sync.flush().then((s) => { resolved = true; return s; });
    await e.clock.advance(SYNC_LIMITS.TXN_TIMEOUT_MS - 1);
    expect(resolved).toBe(false);
    await e.clock.advance(1);
    const st = await p;
    expect(st).toMatchObject({ state: "pending", pending: 1 });
    e.fs.mode = "ok";
    await drain(e);
    expect(e.fs.committedTo("capsules")).toHaveLength(1);
    expect(e.sync.status().pending).toBe(0);
  });
  it("dispose cancels every timer, resolves even with a hung transaction, and nothing runs afterwards", async () => {
    const e = makeEnv();
    e.fs.mode = "hang";
    e.sync.putCapsule("p1", cap());
    void e.sync.flush();
    await settle();
    const disposed = await Promise.race([e.sync.dispose().then(() => "ok"), new Promise<string>((r) => setTimeout(() => r("stuck"), 200))]);
    expect(disposed).toBe("ok");
    expect(e.clock.timerCount()).toBe(0);
    const n = e.fs.txnCalls;
    await e.clock.advance(120_000);
    expect(e.fs.txnCalls).toBe(n);
    expect(e.clock.timerCount()).toBe(0);
    expect(e.auth.listeners()).toBe(0);
    await expect(e.sync.flush()).resolves.toBeDefined();
  });
  it("dispose after backoff timers were armed leaves 0 timers", async () => {
    const e = makeEnv();
    e.fs.mode = "offline";
    e.sync.putCapsule("p1", cap());
    await e.sync.flush();
    await e.sync.dispose();
    expect(e.clock.timerCount()).toBe(0);
  });
  it.each(["standard", "private"] as const)("raw projectId 'acme-secret' (%s) appears in no path or doc; rid is p_+hash", async (tier) => {
    const e = makeEnv({ tiers: { "acme-secret": tier } });
    e.sync.putCapsule("acme-secret", cap());
    await drain(e);
    await e.clock.advance(2100);
    e.tiers["acme-secret"] = tier === "private" ? "standard" : "private";
    e.sync.setTier("acme-secret", cap());
    await drain(e);
    expect(e.fs.attempted.length).toBeGreaterThan(1);
    expect(textLeaks(e.fs, ["acme-secret", "acme"])).toEqual([]);
    expect(e.fs.attempted.some((r) => r.segs[3] === e.ridOf("acme-secret"))).toBe(true);
    expect(assertB4Paths(e.fs, ["u1"])).toEqual([]);
  });
  it("repeated denial: flush never rejects", async () => {
    const e = makeEnv();
    e.fs.denyCapsule = Infinity;
    e.sync.putCapsule("p1", cap());
    await expect(e.sync.flush()).resolves.toBeDefined();
    await expect(e.sync.flush()).resolves.toBeDefined();
  });
});
