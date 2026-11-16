// A-U47r2: fail-first regressions for the review HOLD findings on src/providers/registry.ts (repair loop 2):
// (1) throwing injected clock calls never strand settlement nor leak rejections; (2) stale generations never mutate
// the endpoint state installed by a later refresh().
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPolicy } from "./policyRef";
import { LOC, flush, track, world } from "./fixtures";
import type { GenOut } from "./fixtures";
import { TIMEOUTS_MS } from "../../../src/providers";

vi.mock("../../../src/privacy/policy", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  const ref = await import("./policyRef");
  return { ...orig, assertProviderAllowed: ref.policyProxy };
});

const unhandled: unknown[] = [];
const onUnhandled = (e: unknown): void => { unhandled.push(e); };
beforeEach(() => { resetPolicy(); unhandled.length = 0; process.on("unhandledRejection", onUnhandled); });
afterEach(() => { process.off("unhandledRejection", onUnhandled); });
/** Lets Node deliver any pending 'unhandledRejection' event (it fires after the microtask queue drains). */
const macrotask = (): Promise<void> => new Promise((r) => { setImmediate(r); });

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const desc = (w: { reg: { list(): readonly { id: string; health: string; rung?: unknown; blockedReason?: unknown }[] } }, id: string) =>
  w.reg.list().find((d) => d.id === id);

describe("finding 1: injected clock exceptions never prevent settlement", () => {
  it("list path: throwing clearTimeout -> refresh settles, no unhandled rejection", async () => {
    const w = await world({ endpoints: [], refresh: false });
    w.clock.clearTimeout = () => { throw new Error("clear boom"); };
    const p = track(w.reg.refresh());
    await flush(); await macrotask();
    expect(p.done).toBe(true);
    expect(p.err).toBeUndefined();
    expect(unhandled).toEqual([]);
  });
  it("probe path: list clear ok, probe clear throws -> refresh settles with loc available, no unhandled rejection", async () => {
    const w = await world({ endpoints: [LOC], refresh: false, probes: { loc: { state: "available", rung: 2 } } });
    const orig = w.clock.clearTimeout.bind(w.clock);
    let n = 0;
    w.clock.clearTimeout = (h: unknown) => { n++; if (n >= 2) throw new Error("clear boom"); orig(h); };
    const p = track(w.reg.refresh());
    await flush(); await macrotask();
    expect(p.done).toBe(true);
    expect(p.err).toBeUndefined();
    expect(desc(w, "loc")).toMatchObject({ health: "available", rung: 2 });
    expect(unhandled).toEqual([]);
  });
  it("refresh with throwing setTimeout -> settles deterministically (Firebase group only), no rejection", async () => {
    const w = await world({ endpoints: [LOC], refresh: false });
    w.clock.setTimeout = () => { throw new Error("timer boom"); };
    const p = track(w.reg.refresh());
    await flush(); await macrotask();
    expect(p.done).toBe(true);
    expect(p.err).toBeUndefined();
    expect((p.val as { id: string }[]).map((d) => d.id)).toEqual(["firebase-hybrid", "firebase-ondevice", "firebase-cloud"]);
    expect(unhandled).toEqual([]);
  });
  it("probe with throwing setTimeout (list timer ok) -> endpoint offline, no transport.probe call, no rejection", async () => {
    const w = await world({ endpoints: [LOC], refresh: false });
    const orig = w.clock.setTimeout.bind(w.clock);
    let n = 0;
    w.clock.setTimeout = (f: () => void, ms: number) => { n++; if (n >= 2) throw new Error("timer boom"); return orig(f, ms); };
    const p = track(w.reg.refresh());
    await flush(); await macrotask();
    expect(p.done).toBe(true);
    expect(p.err).toBeUndefined();
    expect(desc(w, "loc")).toMatchObject({ health: "offline" });
    expect(w.tr.probeCalls).toEqual([]);
    expect(unhandled).toEqual([]);
  });
  it("generate with throwing setTimeout -> structured ok:false resolution, no transport/Firebase call, no rejection", async () => {
    const w = await world({ endpoints: [LOC], selection: { all: "loc" } });
    w.clock.setTimeout = () => { throw new Error("timer boom"); };
    const p = track(w.call("summary", "standard"));
    await flush(); await macrotask();
    expect(p.done).toBe(true);
    expect(p.err).toBeUndefined();
    expect(p.val).toMatchObject({ ok: false });
    expect(typeof (p.val as { code: unknown }).code).toBe("string");
    expect(w.tr.genCalls).toHaveLength(0);
    expect(w.hybridRuns()).toBe(0);
    expect(unhandled).toEqual([]);
  });
  it("generate with throwing clearTimeout -> success still settles, no rejection", async () => {
    const w = await world({ endpoints: [LOC], selection: { all: "loc" } });
    w.clock.clearTimeout = () => { throw new Error("clear boom"); };
    const p = track(w.call("summary", "standard"));
    await flush(); await macrotask();
    expect(p.done).toBe(true);
    expect(p.val).toMatchObject({ ok: true, providerId: "loc" });
    expect(unhandled).toEqual([]);
  });
});

describe("finding 2: stale generations never mutate the refreshed endpoint state", () => {
  it("stale nack: rung-1 generation nacks after a refresh installed rung 3 -> rung stays 3", async () => {
    const d = deferred<GenOut>();
    const w = await world({ endpoints: [LOC], selection: { all: "loc" }, probes: { loc: { state: "available", rung: 1 } }, gen: { loc: () => d.promise } });
    const p = track(w.call("summary", "standard"));
    await flush();
    expect(w.tr.genCalls[0]?.rung).toBe(1);
    w.tr.probes["loc"] = { state: "available", rung: 3 };
    await w.reg.refresh();
    expect(desc(w, "loc")).toMatchObject({ health: "available", rung: 3 });
    d.resolve({ ok: false, nack: "rung_unsupported" });
    await flush();
    expect(p.done).toBe(true);
    expect(desc(w, "loc")).toMatchObject({ health: "available", rung: 3 });
  });
  it("control: a non-stale rung-1 nack still lowers the cached rung to 2", async () => {
    const w = await world({ endpoints: [LOC], selection: { all: "loc" }, probes: { loc: { state: "available", rung: 1 } },
      gen: { loc: { ok: false, nack: "rung_unsupported" } } });
    await w.call("summary", "standard");
    expect(desc(w, "loc")).toMatchObject({ health: "available", rung: 2 });
  });
  it("stale timeout: an earlier generation expiring after a refresh does not set the new state offline", async () => {
    const w = await world({ endpoints: [LOC], selection: { all: "loc" }, gen: { loc: "deaf" } });
    const p = track(w.call("summary", "standard"));
    await flush();
    await w.reg.refresh();
    await w.clock.advance(TIMEOUTS_MS.local);
    expect(p.done).toBe(true);
    expect(desc(w, "loc")?.health).toBe("available");
  });
  it("stale transport rejection does not set the new state offline", async () => {
    const d = deferred<GenOut>();
    const w = await world({ endpoints: [LOC], selection: { all: "loc" }, gen: { loc: () => d.promise } });
    const p = track(w.call("summary", "standard"));
    await flush();
    await w.reg.refresh();
    d.reject(new Error("late boom"));
    await flush();
    expect(p.done).toBe(true);
    expect(desc(w, "loc")?.health).toBe("available");
  });
  it("stale policy nack: the replacement endpoint does not inherit the obsolete block", async () => {
    const d = deferred<GenOut>();
    const w = await world({ endpoints: [LOC], selection: { all: "loc" }, gen: { loc: () => d.promise } });
    const p = track(w.call("summary", "standard"));
    await flush();
    await w.reg.refresh();
    d.resolve({ ok: false, nack: "policy" });
    await flush();
    expect(p.done).toBe(true);
    expect(desc(w, "loc")?.health).toBe("available");
    expect(desc(w, "loc")?.blockedReason).toBeUndefined();
  });
  it("control: a non-stale policy nack still blocks, a non-stale timeout still sets offline", async () => {
    const a = await world({ endpoints: [LOC], selection: { all: "loc" }, gen: { loc: { ok: false, nack: "policy" } } });
    await a.call("summary", "standard");
    expect(desc(a, "loc")?.health).toBe("blocked");
    const b = await world({ endpoints: [LOC], selection: { all: "loc" }, gen: { loc: "deaf" } });
    const p = track(b.call("summary", "standard"));
    await b.clock.advance(TIMEOUTS_MS.local);
    expect(p.done).toBe(true);
    expect(desc(b, "loc")?.health).toBe("offline");
  });
});
