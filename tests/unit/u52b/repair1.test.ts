import { describe, expect, it } from "vitest";
import type { DeviceStatus } from "../../../src/ai/types";
import { flush, track, world } from "../u47/fixtures";
import type { World } from "../u47/fixtures";

// U52b repair loop 1 (review HOLD): reentrancy of the shared in-flight attempt and waiter retention.
const BOUND = 10_000;
type Def = { p: Promise<DeviceStatus>; resolve(s: DeviceStatus): void; reject(e: unknown): void };
const deferred = (): Def => {
  let resolve!: (s: DeviceStatus) => void; let reject!: (e: unknown) => void;
  const p = new Promise<DeviceStatus>((a, b) => { resolve = a; reject = b; });
  return { p, resolve, reject };
};
/** Never-settling default init that hands its progress forwarder to the test; `sync` values are forwarded synchronously. */
function hang(w: World, sync: number[] = []): { d: Def; fwd: () => (p: number) => void } {
  const d = deferred();
  let f: ((p: number) => void) | undefined;
  w.hybrid.initDevice = (onProgress?: (p: number) => void) => {
    w.hybrid.inits++; f = onProgress;
    for (const v of sync) onProgress?.(v);
    return d.p;
  };
  return { d, fwd: () => { if (f === undefined) throw new Error("init not started"); return f; } };
}

describe("A-U52b-r1 reentrancy: synchronous progress re-entering initDevice", () => {
  it("joiner created inside a synchronous progress callback never gets 'not_initialised'; gets 'downloading' at its bound", async () => {
    const w = await world({ noTransport: true });
    hang(w, [0.2]);
    let joined: Promise<DeviceStatus> | undefined;
    const first = track(w.reg.initDevice(() => { if (joined === undefined) joined = w.reg.initDevice(); }));
    expect(joined).toBeDefined();
    const j = track(joined as Promise<DeviceStatus>);
    await flush();
    expect(j.done).toBe(false);
    await w.clock.advance(BOUND - 1);
    expect(j.done).toBe(false);
    expect(first.done).toBe(false);
    await w.clock.advance(1);
    expect(j.val).toEqual({ state: "downloading", progress: 0.2 });
    expect(first.val).toEqual({ state: "downloading", progress: 0.2 });
    expect(w.hybrid.inits).toBe(1);
  });
  it("reentrant joiner receives the real status when the attempt settles before its bound", async () => {
    const w = await world({ noTransport: true });
    const { d } = hang(w, [0.5]);
    let joined: Promise<DeviceStatus> | undefined;
    w.reg.initDevice(() => { if (joined === undefined) joined = w.reg.initDevice(); }).catch(() => undefined);
    const j = track(joined as Promise<DeviceStatus>);
    await flush();
    expect(j.done).toBe(false);
    d.resolve({ state: "ready" });
    await flush();
    expect(j.val).toEqual({ state: "ready" });
    expect(w.hybrid.inits).toBe(1);
  });
  it("reentrant joiner receives the real rejection", async () => {
    const w = await world({ noTransport: true });
    const { d } = hang(w, [0.5]);
    let joined: Promise<DeviceStatus> | undefined;
    w.reg.initDevice(() => { if (joined === undefined) joined = w.reg.initDevice(); }).catch(() => undefined);
    const j = track(joined as Promise<DeviceStatus>);
    const boom = new Error("boom");
    d.reject(boom);
    await flush();
    expect(j.done).toBe(true);
    expect(j.err).toBe(boom);
  });
});

describe("A-U52b-r1 retention: sustained bounded retries on a never-settling init", () => {
  it("50 expired retries: later progress reaches only the active callback; late completion still lands", async () => {
    const w = await world({ noTransport: true });
    const { d, fwd } = hang(w);
    const counts: number[] = [];
    for (let i = 0; i < 50; i++) {
      const k = i; counts.push(0);
      const t = track(w.reg.initDevice(() => { counts[k] = (counts[k] ?? 0) + 1; }));
      await w.clock.advance(BOUND);
      expect(t.val).toEqual({ state: "downloading", progress: 0 });
    }
    expect(w.hybrid.inits).toBe(1);
    expect(w.clock.pending).toBe(0);
    let active = 0;
    const live = track(w.reg.initDevice(() => { active++; }));
    fwd()(0.3); fwd()(0.4);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(0);
    expect(active).toBe(2);
    d.resolve({ state: "ready" });
    await flush();
    expect(live.val).toEqual({ state: "ready" });
    expect(w.clock.pending).toBe(0);
    // late completion cleared the in-flight slot: next call is a fresh attempt
    hang(w);
    w.reg.initDevice().catch(() => undefined);
    expect(w.hybrid.inits).toBe(2);
  });
  it("a callback is detached on a single bound expiry (no stale progress)", async () => {
    const w = await world({ noTransport: true });
    const { fwd } = hang(w);
    let n = 0;
    await (async () => { const t = track(w.reg.initDevice(() => { n++; })); await w.clock.advance(BOUND); return t; })();
    fwd()(0.9);
    expect(n).toBe(0);
  });
  it("timer-creation failure: immediate 'downloading' and the callback is detached", async () => {
    const w = await world({ noTransport: true });
    const { fwd } = hang(w);
    const orig = w.clock.setTimeout.bind(w.clock);
    w.clock.setTimeout = () => { throw new Error("no timers"); };
    let n = 0;
    const t = track(w.reg.initDevice(() => { n++; }));
    await flush();
    expect(t.val).toEqual({ state: "downloading", progress: 0 });
    w.clock.setTimeout = orig;
    fwd()(0.7);
    expect(n).toBe(0);
  });
  it("timer-creation failure on a joiner detaches only that joiner", async () => {
    const w = await world({ noTransport: true });
    const { fwd } = hang(w);
    let a = 0; let b = 0;
    track(w.reg.initDevice(() => { a++; }));
    const orig = w.clock.setTimeout.bind(w.clock);
    w.clock.setTimeout = () => { throw new Error("no timers"); };
    const tb = track(w.reg.initDevice(() => { b++; }));
    w.clock.setTimeout = orig;
    await flush();
    expect(tb.val).toEqual({ state: "downloading", progress: 0 });
    fwd()(0.1);
    expect([a, b]).toEqual([1, 0]);
  });
});
