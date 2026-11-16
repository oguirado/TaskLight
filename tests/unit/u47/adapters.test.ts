// Acceptance 13: asHybrid / asClassifierPort / asDriftPort.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetPolicy } from "./policyRef";
import { LOC, LOCP, REM, TEXT, failResult, okResult, world } from "./fixtures";
import type { WorldOpts } from "./fixtures";
import type { TaskRequest } from "../../../src/ai/types";
import type { TaskId } from "../../../src/schema";

vi.mock("../../../src/privacy/policy", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  const ref = await import("./policyRef");
  return { ...orig, assertProviderAllowed: ref.policyProxy };
});
beforeEach(() => { resetPolicy(); });

const LOCAL: WorldOpts = { endpoints: [LOC, LOCP, REM], selection: { all: "loc" } };
const req = <K extends TaskId>(task: K, extra: Partial<TaskRequest<K>> = {}): TaskRequest<K> =>
  ({ task, projectId: "proj-1", tier: "standard", prompt: "PROMPT", ...extra }) as TaskRequest<K>;

describe("asHybrid", () => {
  it("Firebase answer: the inner TaskResult is returned verbatim (value, source, meta), fallback unchanged when no chain fallback", async () => {
    const inner = { ...okResult("summary", "IN_CLOUD"), meta: { task: "summary", mode: "PREFER_IN_CLOUD", configGen: 42, prompt_version: "v3", called: true } };
    const w = await world({ noTransport: true, hybrid: () => inner });
    const r = await w.reg.asHybrid().run(req("summary"));
    expect(r).toEqual(inner);
    expect(w.hybrid.runs[0]).toEqual(req("summary"));
  });
  it("fallback is OR-ed: chain fallback over a clean inner result -> true", async () => {
    const w = await world({ ...LOCAL, gen: { loc: { ok: false, nack: "offline" } } });
    const r = await w.reg.asHybrid().run(req("summary"));
    expect(r).toMatchObject({ ok: true, fallback: true, source: "ON_DEVICE" });
    expect(w.hybrid.runs).toHaveLength(1);
  });
  it("fallback is OR-ed: inner fallback true without chain fallback -> true", async () => {
    const w = await world({ noTransport: true, hybrid: () => okResult("summary", "IN_CLOUD", true) });
    expect(await w.reg.asHybrid().run(req("summary"))).toMatchObject({ ok: true, fallback: true, source: "IN_CLOUD" });
  });
  it("hop failure surfaces the Firebase TaskResult failure verbatim with fallback:true", async () => {
    const w = await world({ ...LOCAL, gen: { loc: { ok: false, nack: "timeout" } }, hybrid: () => failResult("summary", "CLOUD_UNAVAILABLE") });
    const r = await w.reg.asHybrid().run(req("summary"));
    expect(r).toMatchObject({ ok: false, code: "CLOUD_UNAVAILABLE", fallback: true });
    expect(w.hybrid.runs).toHaveLength(1);
  });
  it("Firebase non-hop codes pass through untouched", async () => {
    const w = await world({ noTransport: true, hybrid: () => failResult("summary", "INPUT_OVER_BUDGET") });
    expect(await w.reg.asHybrid().run(req("summary"))).toMatchObject({ ok: false, code: "INPUT_OVER_BUDGET", fallback: false });
  });
  it("external answer shape: {ok, value (validated), source, fallback, meta{task,mode,configGen:-1,prompt_version,called}}", async () => {
    const w = await world({ ...LOCAL, config: { prompt_version: "v9" } });
    const r = await w.reg.asHybrid().run(req("summary"));
    expect(r).toEqual({ ok: true, value: { headline: "h", summary: "s" }, source: "LOCAL_SERVER", fallback: false,
      meta: { task: "summary", mode: "PREFER_ON_DEVICE", configGen: -1, prompt_version: "v9", called: true } });
    expect(w.hybridRuns()).toBe(0);
  });
  it("external meta.prompt_version defaults to AI_DEFAULTS (v1) and source is REMOTE_PROVIDER for a remote", async () => {
    const w = await world({ endpoints: [REM], selection: { all: "rem" } });
    const r = await w.reg.asHybrid().run(req("digest"));
    expect(r).toMatchObject({ ok: true, source: "REMOTE_PROVIDER", value: { needs_you: [], brief: "b" }, meta: { prompt_version: "v1", configGen: -1, called: true } });
  });
  it("the external request carries prompt and the asking tier; image/projectId are not sent as messages", async () => {
    const w = await world({ endpoints: [LOCP], selection: { all: "locp" } });
    await w.reg.asHybrid().run(req("next_action", { tier: "private", prompt: "ASK" }));
    expect(w.tr.genCalls[0]).toMatchObject({ id: "locp", tier: "private" });
    expect(w.tr.genCalls[0]?.messages.at(-1)).toEqual({ role: "user", content: "ASK" });
    expect(JSON.stringify(w.tr.genCalls[0]?.messages)).not.toContain("proj-1");
  });
  it("SCHEMA_REJECT from the external with a failing hop is not turned into an exception and keeps fallback:true", async () => {
    const w = await world({ ...LOCAL, gen: { loc: { ok: true, text: "bogus" } }, hybrid: () => failResult("status", "SDK_ERROR") });
    const r = await w.reg.asHybrid().run(req("status"));
    expect(r.ok).toBe(false);
    expect(r.fallback).toBe(true);
    if (!r.ok) expect(typeof r.code).toBe("string");
  });
  it("screenshot goes to the on-device overlay with the request verbatim (image kept), never to deps.hybrid or the transport", async () => {
    const w = await world({ ...LOCAL, selection: { all: "rem" } });
    const image = { mimeType: "image/png", data: "AAAA" };
    const r = await w.reg.asHybrid().run(req("screenshot", { image, tier: "shared" }));
    expect(w.overlays.ondevice?.runs[0]?.image).toBe(image);
    expect(w.overlays.ondevice?.runs[0]).toMatchObject({ task: "screenshot", projectId: "proj-1", tier: "shared" });
    expect(w.hybrid.runs).toHaveLength(0);
    expect(w.tr.genCalls).toHaveLength(0);
    expect(r).toMatchObject({ ok: true, source: "ON_DEVICE" });
  });
  it("deviceStatus and initDevice forward to deps.hybrid", async () => {
    const w = await world({ noTransport: true });
    w.hybrid.status = { state: "downloading", progress: 0.5 };
    w.hybrid.initStatus = { state: "needs_gesture" };
    const h = w.reg.asHybrid();
    expect(h.deviceStatus()).toEqual({ state: "downloading", progress: 0.5 });
    await expect(h.initDevice()).resolves.toEqual({ state: "needs_gesture" });
    expect(w.hybrid.inits).toBe(1);
  });
  it("applyConfig forwards to deps.hybrid (verbatim, its return value returned) and re-syncs live overlays", async () => {
    const w = await world({ noTransport: true });
    await w.reg.asHybrid().run(req("screenshot", { tier: "standard" }));
    const out = w.reg.asHybrid().applyConfig({ max_output_tokens: 99 });
    expect(w.hybrid.applied).toEqual([{ max_output_tokens: 99 }]);
    expect(out).toEqual({ configGen: 101, warnings: ["w:default"] });
    expect(w.overlays.ondevice?.applied.at(-1)).toMatchObject({ max_output_tokens: 99, mode_status: "ONLY_ON_DEVICE", mode_screenshot: "ONLY_ON_DEVICE" });
  });
  it("hybrid.run errors for the same TaskId across all task kinds do not throw", async () => {
    const w = await world({ ...LOCAL, gen: { loc: { ok: false, nack: "offline" } } });
    for (const t of ["status", "summary", "next_action", "plan", "digest"] as const) {
      await expect(w.reg.asHybrid().run(req(t))).resolves.toMatchObject({ ok: true, fallback: true });
    }
  });
});

describe("asClassifierPort", () => {
  const CREQ = (extra: object = {}) => ({ prompt: "CLASSIFY", constraint: { type: "string", enum: ["a", "b"] }, mode: "PREFER_ON_DEVICE" as const, signal: new AbortController().signal, ...extra });
  const routing: WorldOpts = { endpoints: [LOC, LOCP, REM], selection: { groups: { routing: "loc" } } };

  it("external answer: {text verbatim, source LOCAL_SERVER}; the constraint is the generate schema; prompt is the user message", async () => {
    const w = await world({ ...routing, probes: { loc: { state: "available", rung: 1 } } });
    w.tr.task = "route";
    const out = await w.reg.asClassifierPort("standard")(CREQ());
    expect(out).toEqual({ text: TEXT["route"], source: "LOCAL_SERVER" });
    expect(w.tr.genCalls[0]?.schema).toEqual({ type: "string", enum: ["a", "b"] });
    expect(w.tr.genCalls[0]?.messages.at(-1)).toEqual({ role: "user", content: "CLASSIFY" });
    expect(w.tr.genCalls[0]?.tier).toBe("standard");
  });
  it("the selection group used is routing (capsule selection does not capture it)", async () => {
    const w = await world({ endpoints: [LOC], selection: { groups: { capsule: "loc" } } });
    await w.reg.asClassifierPort("standard")(CREQ());
    expect(w.tr.genCalls).toHaveLength(0);
  });
  it("ONLY_ON_DEVICE mode with the default selection uses the on-device overlay, not deps.hybrid", async () => {
    const w = await world({ noTransport: true });
    const out = await w.reg.asClassifierPort("standard")(CREQ({ mode: "ONLY_ON_DEVICE" }));
    expect(w.hybrid.runs).toHaveLength(0);
    expect(w.overlays.ondevice?.runs.length).toBeGreaterThanOrEqual(1);
    expect(out).not.toBeNull();
    expect(out?.source).toBe("ON_DEVICE");
    expect(typeof out?.text).toBe("string");
  });
  it("private tier: an endpoint without allow_private is not called; the on-device answer is returned", async () => {
    const w = await world(routing);
    const out = await w.reg.asClassifierPort("private")(CREQ());
    expect(w.tr.genCalls).toHaveLength(0);
    expect(w.hybrid.runs).toHaveLength(0);
    expect(out?.source).toBe("ON_DEVICE");
  });
  it("external failure with a successful hop returns the hop's answer (source of the answerer)", async () => {
    const w = await world({ ...routing, gen: { loc: { ok: false, nack: "timeout" } }, hybridSource: "IN_CLOUD" });
    const out = await w.reg.asClassifierPort("standard")(CREQ());
    expect(out?.source).toBe("IN_CLOUD");
  });
  it.each([
    ["nack + hop failure", { ...routing, gen: { loc: { ok: false, nack: "offline" } }, hybrid: () => failResult("status", "SDK_ERROR") }],
    ["transport throws + hop failure", { ...routing, gen: { loc: "throw" }, hybrid: () => failResult("status", "SDK_ERROR") }],
    ["default provider fails", { noTransport: true, hybrid: () => failResult("status", "SDK_ERROR") }],
    ["on-device overlay fails (private)", { noTransport: true, ondevice: () => failResult("status", "ON_DEVICE_UNAVAILABLE") }],
  ] as [string, WorldOpts][])("any failure -> null, never throws: %s", async (_n, opts) => {
    const w = await world(opts);
    const tier = _n.includes("private") ? "private" : "standard";
    await expect(w.reg.asClassifierPort(tier)(CREQ())).resolves.toBeNull();
  });
  it("hop that rejects (Hybrid.run throws) -> null, no rejection", async () => {
    const w = await world({ ...routing, gen: { loc: { ok: false, nack: "offline" } }, hybrid: () => { throw new Error("hybrid boom"); } });
    await expect(w.reg.asClassifierPort("standard")(CREQ())).resolves.toBeNull();
  });
  it("aborted signal -> null (router maps it to nano_unavailable)", async () => {
    const w = await world({ ...routing, gen: { loc: "hang" } });
    const ac = new AbortController();
    const p = w.reg.asClassifierPort("standard")(CREQ({ signal: ac.signal }));
    ac.abort();
    await expect(p).resolves.toBeNull();
    expect(w.hybridRuns()).toBe(0);
  });
  it("hostile requests never throw synchronously nor reject", async () => {
    const w = await world(routing);
    const port = w.reg.asClassifierPort("standard");
    for (const bad of [{}, { prompt: 5 }, { prompt: "x", constraint: null, mode: "NOPE", signal: null }]) {
      let p: Promise<unknown> | undefined;
      expect(() => { p = port(bad as never); }).not.toThrow();
      await expect(p).resolves.toSatisfy((v: unknown) => v === null || (typeof v === "object" && v !== null));
    }
  });
});

describe("asDriftPort", () => {
  const drift: WorldOpts = { endpoints: [LOC, LOCP, REM], selection: { groups: { drift: "loc" } } };
  const run = (w: Awaited<ReturnType<typeof world>>, tier: "private" | "standard" | "shared" = "standard") =>
    w.reg.asDriftPort(tier).generate("DRIFT", { type: "object" }, new AbortController().signal);

  it("source mapping: local -> \"local\", text verbatim (route/drift unvalidated)", async () => {
    const w = await world({ ...drift, gen: { loc: { ok: true, text: "free text verdict" } } });
    await expect(run(w)).resolves.toEqual({ text: "free text verdict", source: "local" });
    expect(w.tr.genCalls[0]?.messages.at(-1)).toEqual({ role: "user", content: "DRIFT" });
  });
  it("source mapping: remote -> \"remote\"", async () => {
    const w = await world({ endpoints: [REM], selection: { groups: { drift: "rem" } } });
    await expect(run(w)).resolves.toMatchObject({ source: "remote" });
  });
  it("source mapping: Firebase IN_CLOUD -> \"cloud\"; ON_DEVICE -> \"device\"", async () => {
    const c = await world({ noTransport: true, hybridSource: "IN_CLOUD" });
    await expect(run(c)).resolves.toMatchObject({ source: "cloud" });
    const d = await world({ noTransport: true, hybridSource: "ON_DEVICE" });
    await expect(run(d)).resolves.toMatchObject({ source: "device" });
  });
  it("hop answer is mapped by its own source (local failed, hybrid IN_CLOUD -> \"cloud\")", async () => {
    const w = await world({ ...drift, gen: { loc: { ok: false, nack: "offline" } }, hybridSource: "IN_CLOUD" });
    await expect(run(w)).resolves.toMatchObject({ source: "cloud" });
  });
  it("private tier with an endpoint lacking allow_private: on-device answer, \"device\", zero transport", async () => {
    const w = await world(drift);
    await expect(run(w, "private")).resolves.toMatchObject({ source: "device" });
    expect(w.tr.genCalls).toHaveLength(0);
    expect(w.hybrid.runs).toHaveLength(0);
  });
  it("the drift group is used: routing selection does not capture drift", async () => {
    const w = await world({ endpoints: [LOC], selection: { groups: { routing: "loc" } } });
    await run(w);
    expect(w.tr.genCalls).toHaveLength(0);
  });
  it("throws (rejects) on failure, as driftPortFromFactory does", async () => {
    const w = await world({ ...drift, gen: { loc: { ok: false, nack: "offline" } }, hybrid: () => failResult("status", "SDK_ERROR") });
    await expect(run(w)).rejects.toBeDefined();
    const w2 = await world({ noTransport: true, hybrid: () => failResult("status", "SDK_ERROR") });
    await expect(run(w2)).rejects.toBeDefined();
  });
  it("one hop at most through the port too", async () => {
    const w = await world({ ...drift, gen: { loc: { ok: false, nack: "offline" } }, hybrid: () => failResult("status", "SDK_ERROR") });
    await run(w).catch(() => undefined);
    expect(w.tr.genCalls).toHaveLength(1);
    expect(w.hybrid.runs).toHaveLength(1);
  });
});
