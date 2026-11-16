// A-U47r1: fail-first regressions for the cross-family review (Sol) HOLD findings 1-5 on src/providers/registry.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetPolicy } from "./policyRef";
import { LOC, TEXT, flush, okResult, track, world } from "./fixtures";
import { TIMEOUTS_MS } from "../../../src/providers";
import { chainFallback } from "../../../src/providers/registry";
import type { EndpointInfo } from "../../../src/providers";

vi.mock("../../../src/privacy/policy", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  const ref = await import("./policyRef");
  return { ...orig, assertProviderAllowed: ref.policyProxy };
});
beforeEach(() => { resetPolicy(); });

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const CREQ = (mode: string, signal: AbortSignal = new AbortController().signal) =>
  ({ prompt: "CLASSIFY", constraint: { type: "string", enum: ["a", "b"] }, mode: mode as "ONLY_IN_CLOUD", signal });

describe("finding 1: transport.cancel throwing never strands the request", () => {
  it("timeout path: deaf generate + throwing cancel -> settles at budget, offline, hop answers, no timer left", async () => {
    const w = await world({ endpoints: [LOC], selection: { all: "loc" }, gen: { loc: "deaf" } });
    w.tr.cancel = (id: string) => { w.tr.cancels.push(id); throw new Error("cancel boom"); };
    const p = track(w.call("summary", "standard"));
    await w.clock.advance(TIMEOUTS_MS.local);
    expect(p.done).toBe(true);
    expect(p.err).toBeUndefined();
    expect(w.tr.cancels).toEqual(["loc"]);
    expect(p.val).toMatchObject({ ok: true, providerId: "firebase-hybrid", fallback: true });
    expect(w.reg.list().find((d) => d.id === "loc")?.health).toBe("offline");
    expect(w.clock.pending).toBe(0);
  });
  it("abort path: deaf generate + throwing cancel -> settles ABORTED, no hop, no timer left", async () => {
    const w = await world({ endpoints: [LOC], selection: { all: "loc" }, gen: { loc: "deaf" } });
    w.tr.cancel = (id: string) => { w.tr.cancels.push(id); throw new Error("cancel boom"); };
    const ac = new AbortController();
    const p = track(w.call("summary", "standard", { signal: ac.signal }));
    await flush();
    ac.abort();
    await flush();
    expect(p.done).toBe(true);
    expect(p.err).toBeUndefined();
    expect(p.val).toMatchObject({ ok: false, code: "ABORTED" });
    expect(w.hybridRuns()).toBe(0);
    expect(w.clock.pending).toBe(0);
  });
});

describe("finding 2: a throwing makeHybrid is a Firebase failure (hop), not a rejected chain", () => {
  it("firebase-ondevice selected at standard, makeHybrid throws -> FIREBASE_FAILED hop to the default succeeds", async () => {
    const w = await world({ noTransport: true, selection: { all: "firebase-ondevice" }, hybridSource: "IN_CLOUD" });
    w.deps.makeHybrid = () => { throw new Error("factory boom"); };
    const p = track(w.call("summary", "standard"));
    await flush();
    expect(p.done).toBe(true);
    expect(p.err).toBeUndefined();
    expect(p.val).toMatchObject({ ok: true, providerId: "firebase-hybrid", source: "IN_CLOUD", fallback: true });
    expect(w.hybrid.runs).toHaveLength(1);
  });
  it("private (no hop): throwing makeHybrid -> ok:false resolved, never rejects", async () => {
    const w = await world({ noTransport: true });
    w.deps.makeHybrid = () => { throw new Error("factory boom"); };
    const p = track(w.call("summary", "private"));
    await flush();
    expect(p.done).toBe(true);
    expect(p.err).toBeUndefined();
    expect(p.val).toMatchObject({ ok: false, code: "FIREBASE_FAILED" });
  });
});

describe("finding 3: Firebase and list() are bounded by deps.clock; caller abort settles Firebase", () => {
  it("never-settling hybrid.run + caller abort -> ABORTED promptly, no hop, no timer left", async () => {
    const w = await world({ noTransport: true, hybrid: () => never() });
    const ac = new AbortController();
    const p = track(w.call("summary", "standard", { signal: ac.signal }));
    await flush();
    expect(p.done).toBe(false);
    ac.abort();
    await flush();
    expect(p.done).toBe(true);
    expect(p.val).toMatchObject({ ok: false, code: "ABORTED", fallback: false });
    expect(w.clock.pending).toBe(0);
  });
  it("never-settling hybrid.run -> pending at ceiling-1, FIREBASE_FAILED at ceiling (120,000 ms)", async () => {
    const w = await world({ noTransport: true, hybrid: () => never() });
    const p = track(w.call("summary", "standard"));
    await w.clock.advance(TIMEOUTS_MS.ceiling - 1);
    expect(p.done).toBe(false);
    await w.clock.advance(1);
    expect(p.done).toBe(true);
    expect(p.val).toMatchObject({ ok: false, code: "FIREBASE_FAILED", providerId: "firebase-hybrid" });
    expect(w.clock.pending).toBe(0);
  });
  it("a late Firebase completion after the deadline is ignored", async () => {
    let release: (v: unknown) => void = () => undefined;
    const late = new Promise((res) => { release = res; });
    const w = await world({ noTransport: true, hybrid: () => late });
    const p = track(w.call("summary", "standard"));
    await w.clock.advance(TIMEOUTS_MS.ceiling);
    expect(p.done).toBe(true);
    release(okResult("summary", "IN_CLOUD"));
    await flush();
    expect(p.val).toMatchObject({ ok: false, code: "FIREBASE_FAILED" });
  });
  it("never-settling on-device overlay as primary at standard -> deadline then hop to the default", async () => {
    const w = await world({ noTransport: true, selection: { all: "firebase-ondevice" }, ondevice: () => never(), hybridSource: "IN_CLOUD" });
    const p = track(w.call("summary", "standard"));
    await w.clock.advance(TIMEOUTS_MS.ceiling);
    expect(p.done).toBe(true);
    expect(p.val).toMatchObject({ ok: true, providerId: "firebase-hybrid", fallback: true });
    expect(w.clock.pending).toBe(0);
  });
  it("never-settling transport.list -> refresh completes at the probe budget with the Firebase group only", async () => {
    const w = await world({ endpoints: [LOC], refresh: false });
    w.tr.list = (): Promise<EndpointInfo[]> => { w.tr.listCalls++; return never(); };
    const p = track(w.reg.refresh());
    await w.clock.advance(TIMEOUTS_MS.probe - 1);
    expect(p.done).toBe(false);
    await w.clock.advance(1);
    expect(p.done).toBe(true);
    expect(p.err).toBeUndefined();
    expect((p.val as { id: string }[]).map((d) => d.id)).toEqual(["firebase-hybrid", "firebase-ondevice", "firebase-cloud"]);
    expect(w.clock.pending).toBe(0);
  });
});

describe("finding 4: classifier ONLY_IN_CLOUD goes through the cloud overlay, never cloud for private", () => {
  it("default selection, deps.hybrid would answer ON_DEVICE -> cloud overlay answers IN_CLOUD, deps.hybrid not called", async () => {
    const w = await world({ noTransport: true, hybridSource: "ON_DEVICE" });
    const out = await w.reg.asClassifierPort("standard")(CREQ("ONLY_IN_CLOUD"));
    expect(w.hybrid.runs).toHaveLength(0);
    expect(w.overlays.cloud?.runs).toHaveLength(1);
    expect(out?.source).toBe("IN_CLOUD");
  });
  it("private tier with ONLY_IN_CLOUD: no cloud overlay is built or run", async () => {
    const w = await world({ noTransport: true });
    await w.reg.asClassifierPort("private")(CREQ("ONLY_IN_CLOUD"));
    expect(w.overlays.cloud).toBeUndefined();
    expect(w.makeCalls.some((c) => c.mode_status === "ONLY_IN_CLOUD")).toBe(false);
    expect(w.hybrid.runs).toHaveLength(0);
  });
  it("kill switch with ONLY_IN_CLOUD: no cloud call and no on-device substitute -> null", async () => {
    const w = await world({ noTransport: true, gates: { externalEnabled: true, remoteEnabled: true, killSwitchCloud: true } });
    const out = await w.reg.asClassifierPort("standard")(CREQ("ONLY_IN_CLOUD"));
    expect(out).toBeNull();
    expect(w.overlays.cloud?.runs.length ?? 0).toBe(0);
    expect(w.hybrid.runs).toHaveLength(0);
  });
});

describe("finding 5: fallback is computed from the actual answerer and keeps the inner Firebase flag", () => {
  it("classifier ONLY_ON_DEVICE with default: answerer firebase-ondevice != candidate firebase-hybrid -> fallback true", () => {
    expect(chainFallback("firebase-hybrid", "firebase-ondevice", false)).toBe(true);
    expect(chainFallback("firebase-hybrid", "firebase-hybrid", false)).toBe(false);
    expect(chainFallback("firebase-hybrid", "firebase-hybrid", true)).toBe(true);
  });
  it("generate: default answers with inner fallback:true -> GenerateResult fallback true", async () => {
    const w = await world({ noTransport: true, hybrid: () => okResult("summary", "IN_CLOUD", true) });
    const r = await w.call("summary", "standard");
    expect(r).toMatchObject({ ok: true, providerId: "firebase-hybrid", fallback: true });
  });
  it("generate: plain default answer stays fallback false (non-vacuity)", async () => {
    const w = await world({ noTransport: true });
    const r = await w.call("summary", "standard");
    expect(r).toMatchObject({ ok: true, fallback: false, text: JSON.stringify({ headline: "h", summary: "s" }) });
    expect(TEXT["summary"]).toBeDefined();
  });
});
