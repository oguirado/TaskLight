import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetPolicy } from "./policyRef";
import { INVALID, LOC, LOCP, REM, TEXT, TEXT_TASKS, failResult, flush, schemaFor, world } from "./fixtures";
import type { WorldOpts } from "./fixtures";
import type { CallTask, GenerateRequest, Rung } from "../../../src/providers";
import { MAX_BODY_BYTES } from "../../../src/providers";

vi.mock("../../../src/privacy/policy", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  const ref = await import("./policyRef");
  return { ...orig, assertProviderAllowed: ref.policyProxy };
});
beforeEach(() => { resetPolicy(); });

const NACKS = ["unknown_endpoint", "needs_setup", "policy", "busy", "too_large", "not_loopback", "redirect", "timeout", "offline",
  "auth", "rate_limited", "rung_unsupported", "http_error", "bad_reply", "reply_too_large", "cancelled"];
const LOCAL: WorldOpts = { endpoints: [LOC, LOCP, REM], selection: { all: "loc" } };
const withRung = (id: string, rung: Rung | null): WorldOpts["probes"] => ({ [id]: { state: "available", rung } });

describe("default provider (acceptance 1)", () => {
  it.each(TEXT_TASKS.filter((t) => t !== "route" && t !== "drift"))("%s: empty selection, no transport -> deps.hybrid.run once, nothing else", async (task) => {
    const w = await world({ noTransport: true, hybridSource: "IN_CLOUD" });
    const r = await w.call(task, "standard", { prompt: "PROMPT" });
    expect(w.hybrid.runs).toHaveLength(1);
    expect(w.hybrid.runs[0]).toMatchObject({ task, tier: "standard", prompt: "PROMPT" });
    expect(w.makeCalls).toHaveLength(0);
    expect(r).toMatchObject({ ok: true, source: "IN_CLOUD", providerId: "firebase-hybrid", fallback: false });
  });
  it.each(["route", "drift"] as CallTask[])("%s: default provider answers once via deps.hybrid", async (task) => {
    const w = await world({ noTransport: true });
    const r = await w.call(task, "standard");
    expect(w.hybrid.runs).toHaveLength(1);
    expect(r).toMatchObject({ ok: true, providerId: "firebase-hybrid", fallback: false });
  });
  it("the ctx of the request reaches Hybrid.run verbatim", async () => {
    const w = await world({ noTransport: true });
    const ctx = { lens: { lens_id: "ops", statuses: ["alpha", "beta"] } };
    await w.reg.generate({ task: "status", tier: "standard", prompt: "p", schema: schemaFor("status"), signal: new AbortController().signal, ctx });
    expect(w.hybrid.runs[0]?.ctx).toEqual(ctx);
  });
  it("a transport is present but unused with the default selection: zero transport generate", async () => {
    const w = await world({ endpoints: [LOC, REM] });
    await w.call("summary", "standard");
    expect(w.tr.genCalls).toHaveLength(0);
    expect(w.hybrid.runs).toHaveLength(1);
  });
});

describe("chain order (acceptance 2)", () => {
  it("non-private: selected local fails -> firebase-hybrid answers; call order asserted", async () => {
    const w = await world({ ...LOCAL, gen: { loc: { ok: false, nack: "offline" } }, hybridSource: "IN_CLOUD" });
    const r = await w.call("summary", "standard");
    expect(w.log.filter((l) => !l.startsWith("transport:probe"))).toEqual(["transport:generate:loc", "hybrid:default:summary"]);
    expect(r).toMatchObject({ ok: true, providerId: "firebase-hybrid", fallback: true });
  });
  it("private: local (allow_private) fails -> on-device overlay answers, deps.hybrid never called", async () => {
    const w = await world({ endpoints: [LOCP], selection: { all: "locp" }, gen: { locp: { ok: false, nack: "http_error" } } });
    const r = await w.call("summary", "private");
    expect(w.log.filter((l) => !l.startsWith("transport:probe"))).toEqual(["transport:generate:locp", "hybrid:ondevice:summary"]);
    expect(w.hybrid.runs).toHaveLength(0);
    expect(r).toMatchObject({ ok: true, source: "ON_DEVICE", providerId: "firebase-ondevice", fallback: true });
  });
  it.each(NACKS)("any U48 nack (%s) from the primary -> exactly one hop to firebase-hybrid", async (nack) => {
    const w = await world({ ...LOCAL, gen: { loc: { ok: false, nack } } });
    const r = await w.call("summary", "standard");
    expect(w.tr.callsFor("loc")).toHaveLength(1);
    expect(w.hybrid.runs).toHaveLength(1);
    expect(r).toMatchObject({ ok: true, fallback: true, providerId: "firebase-hybrid" });
  });
  it("transport.generate throwing -> hop", async () => {
    const w = await world({ ...LOCAL, gen: { loc: "throw" } });
    expect(await w.call("summary", "standard")).toMatchObject({ ok: true, fallback: true });
  });
  it("selected firebase-cloud fails -> firebase-hybrid answers (order [cloud, default])", async () => {
    const w = await world({ selection: { all: "firebase-cloud" }, noTransport: true, cloud: () => failResult("summary", "SDK_ERROR") });
    const r = await w.call("summary", "standard");
    expect(w.log).toEqual(["hybrid:cloud:summary", "hybrid:default:summary"]);
    expect(r).toMatchObject({ ok: true, providerId: "firebase-hybrid", fallback: true });
  });
  it("selected firebase-ondevice (standard) fails -> firebase-hybrid answers (order [ondevice, default])", async () => {
    const w = await world({ selection: { all: "firebase-ondevice" }, noTransport: true, ondevice: () => failResult("summary", "ON_DEVICE_UNAVAILABLE") });
    const r = await w.call("summary", "standard");
    expect(w.log).toEqual(["hybrid:ondevice:summary", "hybrid:default:summary"]);
    expect(r).toMatchObject({ ok: true, fallback: true, providerId: "firebase-hybrid" });
  });
  it("default firebase-hybrid failing has no hop (candidate is the terminal): one call, ok:false", async () => {
    const w = await world({ noTransport: true, hybrid: () => failResult("summary", "SDK_ERROR") });
    const r = await w.call("summary", "standard");
    expect(w.log).toEqual(["hybrid:default:summary"]);
    expect(r).toMatchObject({ ok: false, code: "FIREBASE_FAILED" });
  });
  it("private default goes to the on-device overlay, not deps.hybrid", async () => {
    const w = await world({ noTransport: true });
    const r = await w.call("summary", "private");
    expect(w.hybrid.runs).toHaveLength(0);
    expect(w.overlays.ondevice?.runs).toHaveLength(1);
    expect(r).toMatchObject({ ok: true, providerId: "firebase-ondevice", source: "ON_DEVICE" });
  });
  it.each(["ON_DEVICE_UNAVAILABLE", "CLOUD_UNAVAILABLE", "CLOUD_DISABLED", "APP_CHECK_REJECTED", "SDK_ERROR", "BAD_SOURCE", "SCHEMA_REJECT", "DEVICE_NOT_INITIALISED"])(
    "Firebase primary failure %s hops", async (code) => {
      const w = await world({ selection: { all: "firebase-cloud" }, noTransport: true, cloud: () => failResult("summary", code) });
      await w.call("summary", "standard");
      expect(w.hybrid.runs).toHaveLength(1);
    });
  it.each(["INPUT_OVER_BUDGET", "INPUT_REJECTED", "PRIVACY_VIOLATION"])("Firebase code %s never hops", async (code) => {
    const w = await world({ selection: { all: "firebase-cloud" }, noTransport: true, cloud: () => failResult("summary", code) });
    const r = await w.call("summary", "standard");
    expect(w.log).toEqual(["hybrid:cloud:summary"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["FIREBASE_FAILED", "BLOCKED"]).toContain(r.code);
  });
});

describe("one hop maximum (acceptance 3)", () => {
  it("primary and hop both fail -> exactly 2 calls, ok:false fallback:true", async () => {
    const w = await world({ ...LOCAL, gen: { loc: { ok: false, nack: "timeout" } }, hybrid: () => failResult("summary", "SDK_ERROR") });
    const r = await w.call("summary", "standard");
    expect(w.log.filter((l) => !l.startsWith("transport:probe"))).toEqual(["transport:generate:loc", "hybrid:default:summary"]);
    expect(w.tr.genCalls).toHaveLength(1);
    expect(w.hybrid.runs).toHaveLength(1);
    expect(w.makeCalls).toHaveLength(0);
    expect(r).toMatchObject({ ok: false, fallback: true });
  });
  it("private chain: local + on-device fail -> 2 calls, no cloud-capable instance touched", async () => {
    const w = await world({ endpoints: [LOCP], selection: { all: "locp" }, gen: { locp: { ok: false, nack: "offline" } }, ondevice: () => failResult("summary", "ON_DEVICE_UNAVAILABLE") });
    const r = await w.call("summary", "private");
    expect(w.log.filter((l) => !l.startsWith("transport:probe"))).toEqual(["transport:generate:locp", "hybrid:ondevice:summary"]);
    expect(w.hybrid.runs).toHaveLength(0);
    expect(w.overlays.cloud).toBeUndefined();
    expect(r).toMatchObject({ ok: false, fallback: true });
  });
  it("remote chain: remote + hybrid fail -> 2 calls", async () => {
    const w = await world({ endpoints: [REM], selection: { all: "rem" }, gen: { rem: { ok: false, nack: "auth" } }, hybrid: () => failResult("summary", "CLOUD_UNAVAILABLE") });
    const r = await w.call("summary", "standard");
    expect(w.log.filter((l) => !l.startsWith("transport:probe"))).toEqual(["transport:generate:rem", "hybrid:default:summary"]);
    expect(r).toMatchObject({ ok: false, fallback: true });
  });
  it("cloud + hybrid fail -> 2 calls; ondevice + hybrid fail -> 2 calls", async () => {
    const a = await world({ selection: { all: "firebase-cloud" }, noTransport: true, cloud: () => failResult("status", "SDK_ERROR"), hybrid: () => failResult("status", "SDK_ERROR") });
    expect(await a.call("status", "standard")).toMatchObject({ ok: false, fallback: true });
    expect(a.log).toEqual(["hybrid:cloud:status", "hybrid:default:status"]);
    const b = await world({ selection: { all: "firebase-ondevice" }, noTransport: true, ondevice: () => failResult("status", "SDK_ERROR"), hybrid: () => failResult("status", "SDK_ERROR") });
    expect(await b.call("status", "standard")).toMatchObject({ ok: false, fallback: true });
    expect(b.log).toEqual(["hybrid:ondevice:status", "hybrid:default:status"]);
  });
  it("sequential calls do not accumulate hops (each call: at most one transport + one Firebase call)", async () => {
    const w = await world({ ...LOCAL, gen: { loc: { ok: false, nack: "http_error" } }, hybrid: () => failResult("summary", "SDK_ERROR") });
    for (let i = 0; i < 3; i++) await w.call("summary", "standard");
    expect(w.tr.genCalls).toHaveLength(3);
    expect(w.hybrid.runs).toHaveLength(3);
  });
});

describe("ABORTED never hops", () => {
  it("caller signal already aborted -> ok:false ABORTED, deps.hybrid untouched", async () => {
    const w = await world(LOCAL);
    const ac = new AbortController(); ac.abort();
    const r = await w.call("summary", "standard", { signal: ac.signal });
    expect(r).toMatchObject({ ok: false, code: "ABORTED" });
    expect(w.hybridRuns()).toBe(0);
  });
  it("caller aborts while the endpoint is generating -> ABORTED, no hop", async () => {
    const w = await world({ ...LOCAL, gen: { loc: "hang" } });
    const ac = new AbortController();
    const p = w.call("summary", "standard", { signal: ac.signal });
    await flush();
    ac.abort();
    const r = await p;
    expect(r).toMatchObject({ ok: false, code: "ABORTED" });
    expect(w.hybridRuns()).toBe(0);
    expect(w.reg.list().find((d) => d.id === "loc")?.health).toBe("available");
  });
});

describe("source and provider truth (acceptance 9)", () => {
  it("hop answered by IN_CLOUD -> IN_CLOUD, providerId firebase-hybrid, fallback:true", async () => {
    const w = await world({ ...LOCAL, gen: { loc: { ok: false, nack: "offline" } }, hybridSource: "IN_CLOUD" });
    expect(await w.call("summary", "standard")).toMatchObject({ ok: true, source: "IN_CLOUD", providerId: "firebase-hybrid", fallback: true });
  });
  it("hybrid answering ON_DEVICE is reported ON_DEVICE (SDK truth), providerId stays firebase-hybrid", async () => {
    const w = await world({ noTransport: true, hybridSource: "ON_DEVICE" });
    expect(await w.call("summary", "standard")).toMatchObject({ source: "ON_DEVICE", providerId: "firebase-hybrid" });
  });
  it("never the selection: firebase-cloud selected, hybrid answers -> provider is the answerer, not the selection", async () => {
    const w = await world({ selection: { all: "firebase-cloud" }, noTransport: true, cloud: () => failResult("summary", "SDK_ERROR"), hybridSource: "ON_DEVICE" });
    expect(await w.call("summary", "standard")).toMatchObject({ source: "ON_DEVICE", providerId: "firebase-hybrid", fallback: true });
  });
  it("local answer -> LOCAL_SERVER, providerId = endpoint id, fallback:false, label from the endpoint", async () => {
    const w = await world(LOCAL);
    const r = await w.call("summary", "standard");
    expect(r).toMatchObject({ ok: true, source: "LOCAL_SERVER", providerId: "loc", fallback: false });
    if (r.ok) expect([LOC.label, LOC.model]).toContain(r.modelLabel);
    expect(w.hybridRuns()).toBe(0);
  });
  it("remote answer -> REMOTE_PROVIDER", async () => {
    const w = await world({ endpoints: [REM], selection: { all: "rem" } });
    const r = await w.call("digest", "standard");
    expect(r).toMatchObject({ ok: true, source: "REMOTE_PROVIDER", providerId: "rem", fallback: false });
    if (r.ok) expect([REM.label, REM.model]).toContain(r.modelLabel);
  });
  it("policy-blocked candidate answered by the terminal -> fallback:true and the terminal's provider", async () => {
    const w = await world({ endpoints: [LOC, REM], selection: { all: "rem" } });
    expect(await w.call("summary", "shared")).toMatchObject({ ok: true, providerId: "firebase-hybrid", fallback: true });
    expect(w.tr.genCalls).toHaveLength(0);
  });
  it("unknown selected id answered by firebase-hybrid -> fallback:true", async () => {
    const w = await world({ endpoints: [LOC], selection: { all: "ghost" } });
    expect(await w.call("summary", "standard")).toMatchObject({ ok: true, providerId: "firebase-hybrid", fallback: true });
  });
  it("Remote Config disabled external -> terminal answers, zero transport generate, fallback:true", async () => {
    const w = await world({ ...LOCAL, gates: { externalEnabled: false, remoteEnabled: true } });
    expect(await w.call("summary", "standard")).toMatchObject({ ok: true, providerId: "firebase-hybrid", fallback: true });
    expect(w.tr.genCalls).toHaveLength(0);
  });
  it("modelLabel is always a string", async () => {
    const w = await world({ noTransport: true });
    const r = await w.call("summary", "standard");
    expect(r.ok && typeof r.modelLabel === "string").toBe(true);
  });
});

describe("OpenAI-compatible adapter: rung ladder and transport request", () => {
  it("unknown rung (probe gave null) defaults to the safe floor 2: schema undefined, schema text in the system message", async () => {
    const w = await world({ ...LOCAL, probes: withRung("loc", null) });
    await w.call("summary", "standard", { prompt: "PROMPT" });
    const req = w.tr.genCalls[0];
    expect(req?.rung).toBe(2);
    expect(req?.schema).toBeUndefined();
    expect(req?.messages[0]?.role).toBe("system");
    expect(req?.messages[0]?.content).toContain(JSON.stringify(schemaFor("summary")));
    expect(req?.messages.at(-1)).toEqual({ role: "user", content: "PROMPT" });
  });
  it("rung 1 (probe-cached): schema is handed to the transport (response_format), as given", async () => {
    const w = await world({ ...LOCAL, probes: withRung("loc", 1) });
    await w.call("digest", "standard");
    expect(w.tr.genCalls[0]?.rung).toBe(1);
    expect(w.tr.genCalls[0]?.schema).toEqual(schemaFor("digest"));
  });
  it("rung 3 (probe-cached): plain prompt, no schema anywhere", async () => {
    const w = await world({ ...LOCAL, probes: withRung("loc", 3) });
    await w.call("summary", "standard", { prompt: "PROMPT" });
    const req = w.tr.genCalls[0];
    expect(req?.rung).toBe(3);
    expect(req?.schema).toBeUndefined();
    expect(req?.messages).toEqual([{ role: "user", content: "PROMPT" }]);
  });
  it("rung is cached per endpoint and follows the latest refresh", async () => {
    const w = await world({ endpoints: [LOC, LOCP], selection: { all: "loc", groups: { digest: "locp" } }, probes: { loc: { state: "available", rung: 1 }, locp: { state: "available", rung: 3 } } });
    await w.call("summary", "standard"); await w.call("digest", "standard");
    expect(w.tr.callsFor("loc")[0]?.rung).toBe(1);
    expect(w.tr.callsFor("locp")[0]?.rung).toBe(3);
    w.tr.probes["loc"] = { state: "available", rung: 2 };
    await w.reg.refresh();
    await w.call("summary", "standard");
    expect(w.tr.callsFor("loc")[1]?.rung).toBe(2);
  });
  it("a nack at rung 1 is a primary failure (hop) and lowers the cached rung to 2 for the next call", async () => {
    const w = await world({ ...LOCAL, probes: withRung("loc", 1), gen: { loc: (req) => (req.rung === 1 ? { ok: false, nack: "rung_unsupported" } : { ok: true, text: TEXT["summary"] ?? "" }) } });
    const first = await w.call("summary", "standard");
    expect(first).toMatchObject({ ok: true, providerId: "firebase-hybrid", fallback: true });
    const second = await w.call("summary", "standard");
    expect(w.tr.callsFor("loc").map((c) => c.rung)).toEqual([1, 2]);
    expect(second).toMatchObject({ ok: true, source: "LOCAL_SERVER", providerId: "loc" });
    expect(w.reg.list().find((d) => d.id === "loc")?.rung).toBe(2);
  });
  it("the asking tier is passed to the transport unchanged (second policy gate, Amendment W0-R)", async () => {
    const w = await world({ endpoints: [LOCP, REM], selection: { all: "locp" } });
    for (const tier of ["private", "standard", "shared"] as const) await w.call("summary", tier);
    expect(w.tr.genCalls.map((c) => c.tier)).toEqual(["private", "standard", "shared"]);
    expect(w.tr.genCalls.every((c) => c.id === "locp")).toBe(true);
    w.reg.select({ all: "rem" });
    await w.call("summary", "standard");
    expect(w.tr.callsFor("rem")[0]?.tier).toBe("standard");
  });
  it("maxTokens: explicit value passes through; default is an integer in the U48 range 1..8192", async () => {
    const w = await world(LOCAL);
    await w.call("summary", "standard", { maxTokens: 77 });
    await w.call("summary", "standard");
    expect(w.tr.genCalls[0]?.maxTokens).toBe(77);
    const d = w.tr.genCalls[1]?.maxTokens ?? 0;
    expect(Number.isInteger(d) && d >= 1 && d <= 8192).toBe(true);
  });
  it("the signal given to the transport is a live AbortSignal", async () => {
    const w = await world(LOCAL);
    await w.call("summary", "standard");
    expect(w.tr.genCalls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(w.tr.genCalls[0]?.signal.aborted).toBe(false);
  });
});

describe("request body cap (MAX_BODY_BYTES)", () => {
  const big = (n: number, ch = "a"): string => ch.repeat(n);
  it.each([1, 2, 3] as Rung[])("rung %i: ASCII prompt over the cap -> BODY_TOO_LARGE path: zero transport calls, hop answers", async (rung) => {
    const w = await world({ ...LOCAL, probes: withRung("loc", rung) });
    const r = await w.call("summary", "standard", { prompt: big(MAX_BODY_BYTES + 1) });
    expect(w.tr.genCalls).toHaveLength(0);
    expect(r).toMatchObject({ ok: true, fallback: true, providerId: "firebase-hybrid" });
  });
  it("bytes, not characters: 30,000 two-byte chars (60,000 bytes) is over the cap", async () => {
    const w = await world(LOCAL);
    await w.call("summary", "standard", { prompt: big(30_000, "é") });
    expect(w.tr.genCalls).toHaveLength(0);
  });
  it("bytes, not UTF-16 units: 15,000 emoji (60,000 bytes) is over the cap", async () => {
    const w = await world(LOCAL);
    await w.call("summary", "standard", { prompt: big(15_000, "😀") });
    expect(w.tr.genCalls).toHaveLength(0);
  });
  it("a request comfortably under the cap goes out (40,000 ASCII chars)", async () => {
    const w = await world(LOCAL);
    const r = await w.call("summary", "standard", { prompt: big(40_000) });
    expect(w.tr.genCalls).toHaveLength(1);
    expect(r).toMatchObject({ ok: true, source: "LOCAL_SERVER" });
  });
  it("oversize with the hop also failing -> exactly one Firebase call, ok:false", async () => {
    const w = await world({ ...LOCAL, hybrid: () => failResult("summary", "SDK_ERROR") });
    const r = await w.call("summary", "standard", { prompt: big(MAX_BODY_BYTES + 10) });
    expect(w.hybrid.runs).toHaveLength(1);
    expect(r).toMatchObject({ ok: false, fallback: true });
  });
});

describe("validators decide in every rung (acceptance 7)", () => {
  const VALIDATED = ["status", "summary", "next_action", "plan", "digest"] as const;
  const cases = ([1, 2, 3] as Rung[]).flatMap((r) => VALIDATED.map((t) => [r, t] as const));
  it.each(cases)("rung %i, %s: valid output is accepted as LOCAL_SERVER without a hop", async (rung, task) => {
    const w = await world({ ...LOCAL, probes: withRung("loc", rung) });
    const r = await w.call(task, "standard");
    expect(r).toMatchObject({ ok: true, source: "LOCAL_SERVER", providerId: "loc", fallback: false });
    expect(w.hybridRuns()).toBe(0);
  });
  it.each(cases)("rung %i, %s: validator-invalid output -> hop taken, SCHEMA_REJECT never surfaced", async (rung, task) => {
    const w = await world({ ...LOCAL, probes: withRung("loc", rung), gen: { loc: { ok: true, text: INVALID[task] ?? "" } } });
    const r = await w.call(task, "standard");
    expect(w.tr.genCalls).toHaveLength(1);
    expect(w.hybrid.runs).toHaveLength(1);
    expect(r).toMatchObject({ ok: true, fallback: true, providerId: "firebase-hybrid" });
    expect(r.ok).toBe(true);
  });
  it.each([1, 2, 3] as Rung[])("rung %i: non-JSON garbage and empty output -> hop", async (rung) => {
    for (const text of ["I cannot help with that.", "", "   ", "{\"headline\":"]) {
      const w = await world({ ...LOCAL, probes: withRung("loc", rung), gen: { loc: { ok: true, text } } });
      const r = await w.call("summary", "standard");
      expect(r).toMatchObject({ ok: true, fallback: true, providerId: "firebase-hybrid" });
    }
  });
  it("rung 3: prose around valid JSON is rejected by strictParse -> hop", async () => {
    const w = await world({ ...LOCAL, probes: withRung("loc", 3), gen: { loc: { ok: true, text: `Sure! ${TEXT["summary"]}` } } });
    expect(await w.call("summary", "standard")).toMatchObject({ ok: true, providerId: "firebase-hybrid", fallback: true });
  });
  it("rung 3: accepted text is the trimmed single JSON value", async () => {
    const w = await world({ ...LOCAL, probes: withRung("loc", 3), gen: { loc: { ok: true, text: `\n  ${TEXT["summary"]}  \n` } } });
    const r = await w.call("summary", "standard");
    expect(r).toMatchObject({ ok: true, source: "LOCAL_SERVER" });
    if (r.ok) expect(r.text).toBe(TEXT["summary"]);
  });
  it("rung 3: status bare enum token is accepted; an off-enum token is rejected -> hop", async () => {
    const ok = await world({ ...LOCAL, probes: withRung("loc", 3), gen: { loc: { ok: true, text: " waiting_input\n" } } });
    expect(await ok.call("status", "standard")).toMatchObject({ ok: true, source: "LOCAL_SERVER" });
    const bad = await world({ ...LOCAL, probes: withRung("loc", 3), gen: { loc: { ok: true, text: "waiting for input" } } });
    expect(await bad.call("status", "standard")).toMatchObject({ ok: true, providerId: "firebase-hybrid", fallback: true });
  });
  it("the lens in ctx is what validates status (not a hard-coded vocabulary)", async () => {
    const ctx = { lens: { lens_id: "ops", statuses: ["alpha", "beta"] } };
    const mk = async (text: string) => {
      const w = await world({ ...LOCAL, gen: { loc: { ok: true, text } } });
      w.tr.task = "status";
      const req: GenerateRequest = { task: "status", tier: "standard", prompt: "p", schema: schemaFor("status"), signal: new AbortController().signal, ctx };
      return { w, r: await w.reg.generate(req) };
    };
    const good = await mk("alpha");
    expect(good.r).toMatchObject({ ok: true, source: "LOCAL_SERVER" });
    const bad = await mk("running");
    expect(bad.r).toMatchObject({ ok: true, providerId: "firebase-hybrid", fallback: true });
  });
  it.each([1, 2] as Rung[])("rung %i: route and drift texts are returned unvalidated and verbatim", async (rung) => {
    for (const task of ["route", "drift"] as CallTask[]) {
      const w = await world({ ...LOCAL, probes: withRung("loc", rung), gen: { loc: { ok: true, text: "not json at all" } } });
      const r = await w.call(task, "standard");
      expect(r).toMatchObject({ ok: true, source: "LOCAL_SERVER", providerId: "loc", fallback: false, text: "not json at all" });
      expect(w.hybridRuns()).toBe(0);
    }
  });
  it("a reject does not change health (endpoint stays available)", async () => {
    const w = await world({ ...LOCAL, gen: { loc: { ok: true, text: "bogus" } } });
    await w.call("status", "standard");
    expect(w.reg.list().find((d) => d.id === "loc")?.health).toBe("available");
  });
});
