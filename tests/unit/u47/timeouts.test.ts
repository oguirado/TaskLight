// Acceptance 8: fake-clock timeouts, no real timers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetPolicy } from "./policyRef";
import { LOC, REM, TEXT, flush, track, world } from "./fixtures";
import type { WorldOpts } from "./fixtures";
import { TIMEOUTS_MS } from "../../../src/providers";

vi.mock("../../../src/privacy/policy", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  const ref = await import("./policyRef");
  return { ...orig, assertProviderAllowed: ref.policyProxy };
});
beforeEach(() => { resetPolicy(); });

const mode = (kind: "hang" | "deaf") => [
  ["local", { endpoints: [LOC], selection: { all: "loc" }, gen: { loc: kind } } as WorldOpts, "loc", TIMEOUTS_MS.local],
  ["remote", { endpoints: [REM], selection: { all: "rem" }, gen: { rem: kind } } as WorldOpts, "rem", TIMEOUTS_MS.remote],
] as const;

describe.each(["hang", "deaf"] as const)("generate budget with a %s transport", (kind) => {
  it.each(mode(kind))("%s: pending at budget-1, TIMEOUT at budget: cancel + offline + hop", async (_n, opts, id, budget) => {
    const w = await world(opts);
    const p = track(w.call("summary", "standard"));
    await w.clock.advance(budget - 1);
    expect(p.done).toBe(false);
    expect(w.tr.cancels).toEqual([]);
    expect(w.hybrid.runs).toHaveLength(0);
    expect(w.reg.list().find((d) => d.id === id)?.health).toBe("available");
    await w.clock.advance(1);
    expect(p.done).toBe(true);
    expect(w.tr.cancels).toEqual([id]);
    expect(w.reg.list().find((d) => d.id === id)?.health).toBe("offline");
    expect(w.hybrid.runs).toHaveLength(1);
    expect(p.val).toMatchObject({ ok: true, fallback: true, providerId: "firebase-hybrid" });
    expect(w.log.filter((l) => !l.startsWith("transport:probe"))).toEqual([`transport:generate:${id}`, `transport:cancel:${id}`, "hybrid:default:summary"]);
  });
  it.each(mode(kind))("%s: the inner signal handed to the transport is aborted on expiry", async (_n, opts, _id, budget) => {
    const w = await world(opts);
    const p = track(w.call("summary", "standard"));
    await flush();
    const sig = w.tr.genCalls[0]?.signal;
    expect(sig?.aborted).toBe(false);
    await w.clock.advance(budget);
    expect(p.done).toBe(true);
    expect(sig?.aborted).toBe(true);
  });
  it.each(mode(kind))("%s: after a timeout the endpoint is offline: next call hops with zero transport generate", async (_n, opts, id, budget) => {
    const w = await world(opts);
    const p = track(w.call("summary", "standard"));
    await w.clock.advance(budget);
    expect(p.done).toBe(true);
    const before = w.tr.genCalls.length;
    const r = await w.call("summary", "standard");
    expect(w.tr.genCalls.length).toBe(before);
    expect(r).toMatchObject({ ok: true, fallback: true, providerId: "firebase-hybrid" });
    expect(w.reg.list().find((d) => d.id === id)?.health).toBe("offline");
  });
});

describe("budgets are per kind and use deps.clock only", () => {
  it("local expires at 30,000 ms while a remote call is still within its 60,000 ms", async () => {
    const w = await world({ endpoints: [LOC, REM], selection: { groups: { capsule: "loc", digest: "rem" } }, gen: { loc: "hang", rem: "hang" } });
    const a = track(w.call("summary", "standard"));
    const b = track(w.call("digest", "standard"));
    await w.clock.advance(TIMEOUTS_MS.local);
    expect(a.done).toBe(true);
    expect(b.done).toBe(false);
    await w.clock.advance(TIMEOUTS_MS.remote - TIMEOUTS_MS.local - 1);
    expect(b.done).toBe(false);
    await w.clock.advance(1);
    expect(b.done).toBe(true);
    expect(w.tr.cancels.sort()).toEqual(["loc", "rem"]);
  });
  it("budgets never exceed the 120,000 ms ceiling", async () => {
    expect(TIMEOUTS_MS.local).toBeLessThanOrEqual(TIMEOUTS_MS.ceiling);
    const w = await world({ endpoints: [REM], selection: { all: "rem" }, gen: { rem: "deaf" } });
    const p = track(w.call("summary", "standard"));
    await w.clock.advance(TIMEOUTS_MS.ceiling);
    expect(p.done).toBe(true);
  });
  it("a successful call leaves no armed timer and nothing fires later (no cancel, health unchanged)", async () => {
    const w = await world({ endpoints: [LOC], selection: { all: "loc" } });
    const r = await w.call("summary", "standard");
    expect(r).toMatchObject({ ok: true, source: "LOCAL_SERVER" });
    expect(w.clock.pending).toBe(0);
    await w.clock.advance(TIMEOUTS_MS.ceiling * 2);
    expect(w.tr.cancels).toEqual([]);
    expect(w.reg.list().find((d) => d.id === "loc")?.health).toBe("available");
  });
  it("a nack settles immediately without waiting for the budget, and leaves no timer", async () => {
    const w = await world({ endpoints: [LOC], selection: { all: "loc" }, gen: { loc: { ok: false, nack: "http_error" } } });
    const r = await w.call("summary", "standard");
    expect(r).toMatchObject({ ok: true, fallback: true });
    expect(w.clock.pending).toBe(0);
  });
  it("a late transport answer after the timeout is ignored (no second answer, one hop only)", async () => {
    let release: (v: { ok: true; text: string }) => void = () => undefined;
    const late = new Promise<{ ok: true; text: string }>((res) => { release = res; });
    const w = await world({ endpoints: [LOC], selection: { all: "loc" }, gen: { loc: () => late } });
    const p = track(w.call("summary", "standard"));
    await w.clock.advance(TIMEOUTS_MS.local);
    expect(p.done).toBe(true);
    release({ ok: true, text: TEXT["summary"] ?? "" });
    await flush();
    expect(w.hybrid.runs).toHaveLength(1);
    expect(p.val).toMatchObject({ ok: true, providerId: "firebase-hybrid", fallback: true });
  });
});

describe("probe budget 1,500 ms", () => {
  it("a hanging probe is pending at 1,499 and the endpoint is offline at 1,500; others unaffected; refresh resolves", async () => {
    const w = await world({ endpoints: [REM, LOC], probes: { loc: "hang", rem: { state: "available", rung: 2 } }, refresh: false });
    const p = track(w.reg.refresh());
    await w.clock.advance(TIMEOUTS_MS.probe - 1);
    expect(p.done).toBe(false);
    await w.clock.advance(1);
    expect(p.done).toBe(true);
    expect(w.reg.list().find((d) => d.id === "loc")?.health).toBe("offline");
    expect(w.reg.list().find((d) => d.id === "rem")?.health).toBe("available");
  });
  it("a timed-out probe recovers at the next refresh", async () => {
    const w = await world({ endpoints: [LOC], probes: { loc: "hang" }, refresh: false });
    const p = track(w.reg.refresh());
    await w.clock.advance(TIMEOUTS_MS.probe);
    expect(p.done).toBe(true);
    w.tr.probes["loc"] = { state: "available", rung: 1 };
    await w.reg.refresh();
    expect(w.reg.list().find((d) => d.id === "loc")).toMatchObject({ health: "available", rung: 1 });
  });
  it("no timer is left armed after a probe expired", async () => {
    const w = await world({ endpoints: [LOC], probes: { loc: "hang" }, refresh: false });
    const p = track(w.reg.refresh());
    await flush();
    await w.clock.advance(TIMEOUTS_MS.probe);
    expect(p.done).toBe(true);
    expect(w.clock.pending).toBe(0);
  });
  it("a fast probe leaves no armed timer", async () => {
    const w = await world({ endpoints: [LOC] });
    expect(w.clock.pending).toBe(0);
  });
});
