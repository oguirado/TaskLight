import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetPolicy } from "../u47/policyRef";
import { flush, track, world, TEXT } from "../u47/fixtures";
import type { World, WorldOpts } from "../u47/fixtures";
import { createProviderRegistry } from "../../../src/providers";
import type { FirebaseTextFn, FirebaseTextRequest, ModelSelection, ProviderRegistry, ProviderGates } from "../../../src/providers";
import type { ModeName } from "../../../src/ai/types";
import type { PrivacyTier } from "../../../src/schema";

vi.mock("../../../src/privacy/policy", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  const ref = await import("../u47/policyRef");
  return { ...orig, assertProviderAllowed: ref.policyProxy };
});
beforeEach(() => { resetPolicy(); });

const CONSTRAINT = { type: "string", enum: ["plan_change", "other"] };
const DRIFT_SCHEMA = { type: "object", properties: { verdict: { type: "string" } } };
const GATES_KILL: ProviderGates = { externalEnabled: true, remoteEnabled: true, killSwitchCloud: true };
type Reply = { text: string; source: "ON_DEVICE" | "IN_CLOUD" };
type Script = (req: FirebaseTextRequest, n: number) => Promise<Reply> | Reply;

interface FT { w: World; reg: ProviderRegistry; calls: FirebaseTextRequest[]; modes(): ModeName[] }
async function ft(o: WorldOpts = {}, script?: Script): Promise<FT> {
  const w = await world({ noTransport: true, ...o });
  const calls: FirebaseTextRequest[] = [];
  const fn: FirebaseTextFn = (req) => {
    calls.push(req);
    const out = script ? script(req, calls.length) : { text: req.task === "route" ? TEXT["route"]! : TEXT["drift"]!, source: "ON_DEVICE" as const };
    return Promise.resolve(out);
  };
  const reg = createProviderRegistry({ ...w.deps, firebaseText: fn });
  return { w, reg, calls, modes: () => calls.map((c) => c.mode) };
}
const route = (reg: ProviderRegistry, tier: PrivacyTier, mode: ModeName, signal = new AbortController().signal) =>
  reg.asClassifierPort(tier)({ prompt: "route me", constraint: CONSTRAINT, mode, signal } as never);
const drift = (reg: ProviderRegistry, tier: PrivacyTier, signal = new AbortController().signal) =>
  reg.asDriftPort(tier).generate("drift prompt", DRIFT_SCHEMA, signal);
const noRuns = (w: World): void => { expect(w.hybridRuns()).toBe(0); expect(w.makeCalls).toHaveLength(0); };

describe("D-U47-2 route through firebaseText", () => {
  it("B4 firebase-hybrid default: one call {task:'route', mode: classifier mode, prompt, schema=constraint, signal}; no Hybrid.run", async () => {
    const f = await ft();
    const sig = new AbortController().signal;
    const r = await route(f.reg, "standard", "PREFER_ON_DEVICE", sig);
    expect(r).toEqual({ text: "plan_change", source: "ON_DEVICE" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ task: "route", mode: "PREFER_ON_DEVICE", prompt: "route me", schema: CONSTRAINT });
    expect(f.calls[0]!.signal).toBeInstanceOf(AbortSignal);
    noRuns(f.w);
  });
  it.each(["PREFER_ON_DEVICE", "ONLY_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD"] as ModeName[])(
    "B4 firebase-hybrid forwards classifier mode %s (standard tier)", async (mode) => {
      const f = await ft();
      await route(f.reg, "standard", mode);
      expect(f.modes()).toEqual([mode]);
      noRuns(f.w);
    });
  it.each(["PREFER_ON_DEVICE", "ONLY_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD"] as ModeName[])(
    "B4 firebase-ondevice selection pins ONLY_ON_DEVICE whatever the classifier mode (%s)", async (mode) => {
      const f = await ft({ selection: { groups: { routing: "firebase-ondevice" } } });
      await route(f.reg, "standard", mode);
      expect(f.modes()).toEqual(["ONLY_ON_DEVICE"]);
      noRuns(f.w);
    });
  it.each(["PREFER_ON_DEVICE", "ONLY_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD"] as ModeName[])(
    "B4 firebase-cloud selection pins ONLY_IN_CLOUD whatever the classifier mode (%s)", async (mode) => {
      const f = await ft({ selection: { groups: { routing: "firebase-cloud" } } });
      await route(f.reg, "standard", mode);
      expect(f.modes()).toEqual(["ONLY_IN_CLOUD"]);
      noRuns(f.w);
    });
  it("private tier never reaches the cloud: ONLY_IN_CLOUD classifier mode is not forwarded as a cloud call", async () => {
    const f = await ft();
    await route(f.reg, "private", "ONLY_IN_CLOUD");
    expect(f.modes()).not.toContain("ONLY_IN_CLOUD");
    expect(f.modes()).not.toContain("PREFER_IN_CLOUD");
    noRuns(f.w);
  });
  it("private tier with the default selection resolves to on-device: ONLY_ON_DEVICE", async () => {
    const f = await ft();
    await route(f.reg, "private", "PREFER_ON_DEVICE");
    expect(f.modes()).toEqual(["ONLY_ON_DEVICE"]);
  });
  it("the IN_CLOUD source is passed through", async () => {
    const f = await ft({}, () => ({ text: "plan_change", source: "IN_CLOUD" }));
    expect(await route(f.reg, "standard", "ONLY_IN_CLOUD")).toEqual({ text: "plan_change", source: "IN_CLOUD" });
  });
  it("rejection -> classifier returns null (FIREBASE_FAILED surfaced as no answer)", async () => {
    const f = await ft({}, () => Promise.reject(new Error("fb down")));
    expect(await route(f.reg, "standard", "PREFER_ON_DEVICE")).toBeNull();
    noRuns(f.w);
  });
  it("a synchronous throw from firebaseText is contained (null, no escape)", async () => {
    const f = await ft({}, () => { throw new Error("sync"); });
    expect(await route(f.reg, "standard", "PREFER_ON_DEVICE")).toBeNull();
  });
});

describe("D-U47-2 drift through firebaseText", () => {
  it("B4 default firebase-hybrid, standard tier: PREFER_ON_DEVICE, schema and prompt verbatim, text not status-validated, source mapped", async () => {
    const f = await ft({}, () => ({ text: '{"verdict":"drift"}', source: "IN_CLOUD" }));
    const r = await drift(f.reg, "standard");
    expect(r).toEqual({ text: '{"verdict":"drift"}', source: "cloud" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ task: "drift", mode: "PREFER_ON_DEVICE", prompt: "drift prompt", schema: DRIFT_SCHEMA });
    noRuns(f.w);
  });
  it("ON_DEVICE maps to 'device'", async () => {
    const f = await ft();
    expect((await drift(f.reg, "shared")).source).toBe("device");
    expect(f.modes()).toEqual(["PREFER_ON_DEVICE"]);
  });
  it("private tier -> ONLY_ON_DEVICE", async () => {
    const f = await ft();
    await drift(f.reg, "private");
    expect(f.modes()).toEqual(["ONLY_ON_DEVICE"]);
    noRuns(f.w);
  });
  it("kill switch (cloud off) on firebase-hybrid -> ONLY_ON_DEVICE", async () => {
    const f = await ft({ gates: GATES_KILL });
    await drift(f.reg, "standard");
    expect(f.modes()).toEqual(["ONLY_ON_DEVICE"]);
  });
  it("firebase-ondevice selection -> ONLY_ON_DEVICE; firebase-cloud selection -> ONLY_IN_CLOUD (standard)", async () => {
    const a = await ft({ selection: { groups: { drift: "firebase-ondevice" } } });
    await drift(a.reg, "standard");
    expect(a.modes()).toEqual(["ONLY_ON_DEVICE"]);
    const b = await ft({ selection: { groups: { drift: "firebase-cloud" } } });
    await drift(b.reg, "standard");
    expect(b.modes()).toEqual(["ONLY_IN_CLOUD"]);
    noRuns(a.w); noRuns(b.w);
  });
  it("no Hybrid.run with task 'status' (nor any task) on route or drift, over the whole mode/tier sweep", async () => {
    const f = await ft();
    for (const tier of ["private", "standard", "shared"] as PrivacyTier[]) {
      await drift(f.reg, tier);
      for (const m of ["PREFER_ON_DEVICE", "ONLY_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD"] as ModeName[]) await route(f.reg, tier, m);
    }
    expect(f.calls.length).toBeGreaterThanOrEqual(15);
    expect(f.w.hybrid.runs).toHaveLength(0);
    noRuns(f.w);
  });
  it("generate({task:'drift'}) uses the same path and mode table", async () => {
    const f = await ft();
    const r = await f.reg.generate({ task: "drift", tier: "standard", prompt: "p", schema: DRIFT_SCHEMA, signal: new AbortController().signal });
    expect(r).toMatchObject({ ok: true, text: TEXT["drift"], source: "ON_DEVICE" });
    expect(f.calls[0]).toMatchObject({ task: "drift", mode: "PREFER_ON_DEVICE" });
    noRuns(f.w);
  });
});

describe("D-U47-2 failure, hop, bound, abort", () => {
  const gen = (reg: ProviderRegistry, signal = new AbortController().signal) =>
    reg.generate({ task: "drift", tier: "standard", prompt: "p", schema: DRIFT_SCHEMA, signal });
  it("rejection -> FIREBASE_FAILED on the terminal provider (no hop)", async () => {
    const f = await ft({}, () => Promise.reject(new Error("fb")));
    expect(await gen(f.reg)).toMatchObject({ ok: false, code: "FIREBASE_FAILED", providerId: "firebase-hybrid" });
    expect(f.calls).toHaveLength(1);
    noRuns(f.w);
  });
  it("hop rules unchanged: firebase-ondevice failing hops once to firebase-hybrid (PREFER_ON_DEVICE), fallback true", async () => {
    const f = await ft({ selection: { groups: { drift: "firebase-ondevice" } } },
      (_r, n) => (n === 1 ? Promise.reject(new Error("fb")) : { text: '{"verdict":"ok"}', source: "ON_DEVICE" as const }));
    const r = await gen(f.reg);
    expect(r).toMatchObject({ ok: true, fallback: true });
    expect(f.modes()).toEqual(["ONLY_ON_DEVICE", "PREFER_ON_DEVICE"]);
    noRuns(f.w);
  });
  it("never-settling firebaseText is bounded by the 120,000 ms ceiling -> FIREBASE_FAILED", async () => {
    const f = await ft({}, () => new Promise<Reply>(() => undefined));
    const t = track(gen(f.reg));
    await f.w.clock.advance(119_999);
    expect(t.done).toBe(false);
    await f.w.clock.advance(1);
    expect(t.val).toMatchObject({ ok: false, code: "FIREBASE_FAILED" });
    expect(f.w.clock.pending).toBe(0);
  });
  it("pre-aborted signal -> ABORTED, firebaseText not called", async () => {
    const f = await ft();
    const ac = new AbortController(); ac.abort();
    expect(await gen(f.reg, ac.signal)).toMatchObject({ ok: false, code: "ABORTED" });
    expect(f.calls).toHaveLength(0);
  });
  it("abort while pending -> ABORTED, timer disarmed", async () => {
    const f = await ft({}, () => new Promise<Reply>(() => undefined));
    const ac = new AbortController();
    const t = track(gen(f.reg, ac.signal));
    await flush();
    ac.abort();
    await flush();
    expect(t.val).toMatchObject({ ok: false, code: "ABORTED" });
    expect(f.w.clock.pending).toBe(0);
  });
});

describe("D-U47-2 scope: only route/drift; absent dep keeps the old path", () => {
  it("status/summary/screenshot still go through Hybrid.run even when firebaseText is supplied", async () => {
    const f = await ft();
    for (const task of ["status", "summary", "screenshot"] as const) {
      const r = await f.reg.generate({ task, tier: "standard", prompt: "p", schema: {}, signal: new AbortController().signal });
      expect(r.ok).toBe(true);
    }
    expect(f.calls).toHaveLength(0);
    expect(f.w.hybrid.runs.map((r) => r.task).concat((f.w.overlays.ondevice?.runs ?? []).map((r) => r.task)).sort()).toEqual(["screenshot", "status", "summary"]);
  });
  it("B4 absent firebaseText: route and drift still reach Hybrid.run as task 'status' with projectId '' (control, green by design)", async () => {
    const w = await world({ noTransport: true });
    await w.reg.asClassifierPort("standard")({ prompt: "r", constraint: CONSTRAINT, mode: "PREFER_ON_DEVICE", signal: new AbortController().signal } as never);
    await w.reg.asDriftPort("standard").generate("d", DRIFT_SCHEMA, new AbortController().signal).catch(() => undefined);
    const runs = w.hybrid.runs;
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.task === "status" && r.projectId === "")).toBe(true);
  });
  it("registry without firebaseText is unaffected by a sibling registry that has it (no shared state)", async () => {
    const f = await ft();
    await route(f.reg, "standard", "PREFER_ON_DEVICE");
    const before = f.w.hybrid.runs.length;
    await f.w.reg.asClassifierPort("standard")({ prompt: "r", constraint: CONSTRAINT, mode: "PREFER_ON_DEVICE", signal: new AbortController().signal } as never);
    expect(f.w.hybrid.runs.length).toBe(before + 1);
    expect(f.calls).toHaveLength(1);
  });
});
void ({} as ModelSelection);
