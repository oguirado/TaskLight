import { describe, expect, it } from "vitest";
import * as P from "../../../src/providers";
import { createProviderRegistry } from "../../../src/providers";
import type { Clock } from "../../../src/providers";
import type { DeviceStatus } from "../../../src/ai/types";
import { flush, track, world } from "../u47/fixtures";
import type { World } from "../u47/fixtures";

const BOUND = 10_000;
type Def = { p: Promise<DeviceStatus>; resolve(s: DeviceStatus): void; reject(e: unknown): void };
const deferred = (): Def => {
  let resolve!: (s: DeviceStatus) => void; let reject!: (e: unknown) => void;
  const p = new Promise<DeviceStatus>((a, b) => { resolve = a; reject = b; });
  return { p, resolve, reject };
};
/** Default hybrid initDevice that never settles on its own; `fwd` replays progress values then waits on `d`. */
function hang(w: World, fwd: number[] = []): Def {
  const d = deferred();
  w.hybrid.initDevice = (onProgress?: (p: number) => void) => { w.hybrid.inits++; for (const v of fwd) onProgress?.(v); return d.p; };
  return d;
}
const ready: DeviceStatus = { state: "ready" };

describe("U52b shape (red until the constant exists)", () => {
  it("DEVICE_STATUS_BOUND_MS is exported from src/providers and equals 10,000", () => {
    expect((P as Record<string, unknown>)["DEVICE_STATUS_BOUND_MS"]).toBe(10_000);
  });
});

describe("D-U47-1 initDevice bound", () => {
  it("B1 never-settling default: pending at 9,999 ms, 'downloading' at 10,000 ms (registry.initDevice)", async () => {
    const w = await world({ noTransport: true });
    hang(w);
    const t = track(w.reg.initDevice());
    await w.clock.advance(BOUND - 1);
    expect(t.done).toBe(false);
    await w.clock.advance(1);
    expect(t.done).toBe(true);
    expect(t.val).toEqual({ state: "downloading", progress: 0 });
    expect(w.hybrid.inits).toBe(1);
  });
  it("B1 same through asHybrid().initDevice()", async () => {
    const w = await world({ noTransport: true });
    hang(w);
    const t = track(w.reg.asHybrid().initDevice());
    await w.clock.advance(BOUND - 1);
    expect(t.done).toBe(false);
    await w.clock.advance(1);
    expect(t.val).toEqual({ state: "downloading", progress: 0 });
  });
  it("progress is the last forwarded value; the caller's onProgress still receives every value", async () => {
    const w = await world({ noTransport: true });
    hang(w, [0.2, 0.6]);
    const seen: number[] = [];
    const t = track(w.reg.initDevice((p) => seen.push(p)));
    await w.clock.advance(BOUND);
    expect(t.val).toEqual({ state: "downloading", progress: 0.6 });
    expect(seen).toEqual([0.2, 0.6]);
  });
  it.each([[1.7, 1], [-0.5, 0], [Number.NaN, 0], [Number.POSITIVE_INFINITY, 1]])("forwarded progress %s is clamped to %s", async (raw, want) => {
    const w = await world({ noTransport: true });
    hang(w, [raw]);
    const t = track(w.reg.initDevice());
    await w.clock.advance(BOUND);
    expect(t.val).toEqual({ state: "downloading", progress: want });
  });
  it("default settling before the bound returns its status verbatim and leaves no timer armed", async () => {
    const w = await world({ noTransport: true });
    const d = hang(w);
    const t = track(w.reg.initDevice());
    await w.clock.advance(BOUND - 1000);
    d.resolve({ state: "needs_gesture" });
    await flush();
    expect(t.val).toEqual({ state: "needs_gesture" });
    expect(w.clock.pending).toBe(0);
  });
  it("later resolution: initialisation keeps going after the bound; no rejection, and the next call starts a fresh attempt", async () => {
    const w = await world({ noTransport: true });
    const d = hang(w);
    const t = track(w.reg.initDevice());
    await w.clock.advance(BOUND);
    expect(t.val).toMatchObject({ state: "downloading" });
    d.resolve(ready);
    await w.clock.advance(1);
    expect(w.clock.pending).toBe(0);
    w.hybrid.initDevice = () => { w.hybrid.inits++; return Promise.resolve({ state: "needs_gesture" } as DeviceStatus); };
    await expect(w.reg.initDevice()).resolves.toEqual({ state: "needs_gesture" });
    expect(w.hybrid.inits).toBe(2);
  });
  it("a call joined while the first attempt is in flight gets the real status when it lands inside its own bound", async () => {
    const w = await world({ noTransport: true });
    const d = hang(w);
    const first = track(w.reg.initDevice());
    await w.clock.advance(BOUND);
    expect(first.done).toBe(true);
    const second = track(w.reg.initDevice());
    await w.clock.advance(3000);
    d.resolve(ready);
    await flush();
    expect(second.val).toEqual(ready);
    expect(w.hybrid.inits).toBe(1);
  });
  it("B3 concurrent calls (registry and asHybrid) join one deps.hybrid.initDevice", async () => {
    const w = await world({ noTransport: true });
    const d = hang(w);
    const a = track(w.reg.initDevice());
    const b = track(w.reg.asHybrid().initDevice());
    const c = track(w.reg.initDevice());
    await flush();
    expect(w.hybrid.inits).toBe(1);
    d.resolve(ready);
    await flush();
    expect([a.val, b.val, c.val]).toEqual([ready, ready, ready]);
    expect(w.hybrid.inits).toBe(1);
  });
  it("each joiner races a fresh bound (a call made 6 s later still waits 10 s)", async () => {
    const w = await world({ noTransport: true });
    hang(w);
    const first = track(w.reg.initDevice());
    await w.clock.advance(6000);
    const second = track(w.reg.initDevice());
    await w.clock.advance(4000);
    expect(first.done).toBe(true);
    expect(second.done).toBe(false);
    await w.clock.advance(6000);
    expect(second.val).toMatchObject({ state: "downloading" });
    expect(w.hybrid.inits).toBe(1);
  });
  it("a throwing clock.setTimeout yields 'downloading' at once, init still started once", async () => {
    const w = await world({ noTransport: true });
    hang(w, [0.3]);
    const bad: Clock = { now: () => 0, setTimeout: () => { throw new Error("no timers"); }, clearTimeout: () => undefined };
    const reg = createProviderRegistry({ ...w.deps, clock: bad });
    const t = track(reg.initDevice());
    await flush();
    expect(t.val).toEqual({ state: "downloading", progress: 0.3 });
    expect(w.hybrid.inits).toBe(1);
  });
});

describe("D-U47-1 overlays never block the default status", () => {
  async function withOverlay(): Promise<World> {
    const w = await world({ noTransport: true });
    await w.call("screenshot", "standard"); // builds the on-device overlay
    expect(w.overlays.ondevice).toBeDefined();
    return w;
  }
  it("B2 hung overlay init after a successful default: default 'ready' returned at once, overlay init was started", async () => {
    const w = await withOverlay();
    const ov = w.overlays.ondevice!;
    ov.initDevice = () => { ov.inits++; return new Promise<DeviceStatus>(() => undefined); };
    const t = track(w.reg.initDevice());
    await flush();
    expect(t.val).toEqual(ready);
    expect(ov.inits).toBe(1);
    expect(w.clock.pending).toBe(0);
  });
  it("B2 hung overlay via asHybrid().initDevice() too", async () => {
    const w = await withOverlay();
    const ov = w.overlays.ondevice!;
    ov.initDevice = () => new Promise<DeviceStatus>(() => undefined);
    const t = track(w.reg.asHybrid().initDevice());
    await flush();
    expect(t.val).toEqual(ready);
  });
  it("rejecting overlay init is swallowed (no throw, no unhandled rejection), default status returned", async () => {
    const w = await withOverlay();
    const ov = w.overlays.ondevice!;
    ov.initDevice = () => Promise.reject(new Error("overlay boom"));
    await expect(w.reg.initDevice()).resolves.toEqual(ready);
    await flush();
  });
  it("overlay settling 'failed' does not change the default's status (u47 contract kept)", async () => {
    const w = await withOverlay();
    w.overlays.ondevice!.initStatus = { state: "failed", detail: "overlay" };
    await expect(w.reg.initDevice()).resolves.toEqual(ready);
    expect(w.overlays.ondevice!.inits).toBe(1);
  });
});

describe("D-U47-1 failure is deterministic", () => {
  it("default resolving 'failed' returns that status at once, without waiting for the bound", async () => {
    const w = await world({ noTransport: true });
    w.hybrid.initStatus = { state: "failed", detail: "no model" };
    const t = track(w.reg.initDevice());
    await flush();
    expect(t.val).toEqual({ state: "failed", detail: "no model" });
    expect(w.clock.pending).toBe(0);
  });
  it("default rejecting before the bound propagates the rejection as before (spec: rejection propagates)", async () => {
    const w = await world({ noTransport: true });
    const d = hang(w);
    const t = track(w.reg.initDevice());
    await w.clock.advance(2000);
    d.reject(new Error("init exploded"));
    await flush();
    expect(t.done).toBe(true);
    expect((t.err as Error).message).toBe("init exploded");
    expect(w.clock.pending).toBe(0);
  });
  it("after a failed attempt the next call starts a new one (failure is not cached as in-flight)", async () => {
    const w = await world({ noTransport: true });
    const d = hang(w);
    const t = track(w.reg.initDevice());
    d.reject(new Error("x"));
    await flush();
    expect(t.done).toBe(true);
    w.hybrid.initDevice = () => { w.hybrid.inits++; return Promise.resolve(ready); };
    await expect(w.reg.initDevice()).resolves.toEqual(ready);
    expect(w.hybrid.inits).toBe(2);
  });
  it("default rejecting AFTER the bound is swallowed; the returned 'downloading' stands; next call is fresh", async () => {
    const w = await world({ noTransport: true });
    const d = hang(w);
    const t = track(w.reg.initDevice());
    await w.clock.advance(BOUND);
    expect(t.val).toMatchObject({ state: "downloading" });
    d.reject(new Error("late boom"));
    await flush();
    w.hybrid.initDevice = () => { w.hybrid.inits++; return Promise.resolve({ state: "failed", detail: "second" } as DeviceStatus); };
    await expect(w.reg.initDevice()).resolves.toEqual({ state: "failed", detail: "second" });
    expect(w.hybrid.inits).toBe(2);
  });
});
