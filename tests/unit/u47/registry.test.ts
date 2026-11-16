import { beforeEach, describe, expect, it, vi } from "vitest";
import { policyCalls, resetPolicy, setPolicyOverride } from "./policyRef";
import { ALL_ON, LOC, LOCP, REM, REMNK, flush, world } from "./fixtures";
import type { WorldOpts } from "./fixtures";
import type { CallTask, ModelSelection } from "../../../src/providers";
import { FIREBASE_IDS } from "../../../src/providers";
import type { PrivacyTier } from "../../../src/schema";

vi.mock("../../../src/privacy/policy", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  const ref = await import("./policyRef");
  return { ...orig, assertProviderAllowed: ref.policyProxy };
});

beforeEach(() => { resetPolicy(); });
const EPS = [LOC, LOCP, REM, REMNK];
const ids = (r: { list(): readonly { id: string }[] }): string[] => r.list().map((d) => d.id);

describe("registry composition (list / refresh)", () => {
  it("before refresh: exactly the three Firebase descriptors in FIREBASE_IDS order, kind = id", async () => {
    const w = await world({ endpoints: EPS, refresh: false });
    expect(ids(w.reg)).toEqual([...FIREBASE_IDS]);
    expect(w.reg.list().map((d) => d.kind)).toEqual([...FIREBASE_IDS]);
    expect(w.tr.listCalls).toBe(0);
  });
  it("refresh appends externals in model_hello order after the Firebase group and returns list()", async () => {
    const w = await world({ endpoints: [REM, LOC], refresh: false });
    const r = await w.reg.refresh();
    expect(r.map((d) => d.id)).toEqual([...FIREBASE_IDS, "rem", "loc"]);
    expect(r).toEqual(w.reg.list());
    expect(w.reg.list().find((d) => d.id === "loc")).toMatchObject({ kind: "local-openai-compatible", label: "Local LM" });
    expect(w.reg.list().find((d) => d.id === "rem")).toMatchObject({ kind: "remote-openai-compatible", label: "Remote X" });
  });
  it("an endpoint whose id collides with a Firebase id is dropped (and never probed)", async () => {
    const w = await world({ endpoints: [{ ...LOC, id: "firebase-hybrid" }, LOC], refresh: false });
    await w.reg.refresh();
    expect(ids(w.reg)).toEqual([...FIREBASE_IDS, "loc"]);
    expect(w.reg.list()[0]?.kind).toBe("firebase-hybrid");
    expect(w.tr.probeCalls).not.toContain("firebase-hybrid");
  });
  it("no transport: Firebase group only, refresh does not throw", async () => {
    const w = await world({ noTransport: true });
    await expect(w.reg.refresh()).resolves.toHaveLength(3);
    expect(ids(w.reg)).toEqual([...FIREBASE_IDS]);
  });
  it("transport.list() rejects: Firebase group only, no throw, default hybrid still answers", async () => {
    const w = await world({ endpoints: EPS, listError: true, refresh: false });
    await expect(w.reg.refresh()).resolves.toHaveLength(3);
    const r = await w.call("summary", "standard");
    expect(r.ok).toBe(true);
    expect(w.hybrid.runs).toHaveLength(1);
  });
  it("refresh probes every kept external endpoint exactly once", async () => {
    const w = await world({ endpoints: EPS, refresh: false });
    await w.reg.refresh();
    for (const id of ["loc", "locp", "rem"]) expect(w.tr.probeCalls.filter((x) => x === id)).toHaveLength(1);
    expect(new Set(w.tr.probeCalls).size).toBe(w.tr.probeCalls.length);
  });
  it("Firebase descriptors are not blocked by default", async () => {
    const w = await world({ endpoints: [LOC] });
    for (const d of w.reg.list().filter((x) => (FIREBASE_IDS as readonly string[]).includes(x.id))) expect(d.health).not.toBe("blocked");
  });
  it("firebase-cloud is blocked (remote_config) when killSwitchCloud, at construction and via applyRemoteConfig", async () => {
    const w = await world({ gates: { ...ALL_ON, killSwitchCloud: true } });
    await w.reg.refresh();
    expect(w.reg.list().find((d) => d.id === "firebase-cloud")).toMatchObject({ health: "blocked", blockedReason: "remote_config" });
    const w2 = await world({ noTransport: true });
    w2.reg.applyRemoteConfig({}, { ...ALL_ON, killSwitchCloud: true });
    expect(w2.reg.list().find((d) => d.id === "firebase-cloud")).toMatchObject({ health: "blocked", blockedReason: "remote_config" });
    w2.reg.applyRemoteConfig({}, ALL_ON);
    expect(w2.reg.list().find((d) => d.id === "firebase-cloud")?.health).not.toBe("blocked");
  });
});

describe("health state machine (table, SPEC_U47)", () => {
  const health = (w: { reg: { list(): readonly { id: string; health: string; rung?: unknown }[] } }, id: string) => w.reg.list().find((d) => d.id === id);
  it("probe available -> available, rung cached on the descriptor", async () => {
    const w = await world({ endpoints: [LOC, LOCP], probes: { loc: { state: "available", rung: 1 }, locp: { state: "available", rung: 3 } } });
    expect(health(w, "loc")).toMatchObject({ health: "available", rung: 1 });
    expect(health(w, "locp")).toMatchObject({ health: "available", rung: 3 });
  });
  it("remote without key -> needs_setup (any state), even if the probe claims available", async () => {
    const w = await world({ endpoints: [REMNK], probes: { remnk: { state: "available", rung: 2 } } });
    expect(health(w, "remnk")?.health).toBe("needs_setup");
  });
  it.each([
    ["needs_setup", { state: "needs_setup" as const, rung: null }, "needs_setup"],
    ["offline", { state: "offline" as const, rung: null }, "offline"],
    ["rejects", "reject" as const, "offline"],
  ])("probe %s -> %s", async (_n, probe, expected) => {
    const w = await world({ endpoints: [LOC], probes: { loc: probe } });
    expect(health(w, "loc")?.health).toBe(expected);
  });
  it("offline -> available at the next refresh when the probe succeeds", async () => {
    const w = await world({ endpoints: [LOC], probes: { loc: "reject" } });
    expect(health(w, "loc")?.health).toBe("offline");
    w.tr.probes["loc"] = { state: "available", rung: 2 };
    await w.reg.refresh();
    expect(health(w, "loc")).toMatchObject({ health: "available", rung: 2 });
  });
  it("available -> offline when generate throws/rejects (transport error), hop taken", async () => {
    const w = await world({ endpoints: [LOC], selection: { all: "loc" }, gen: { loc: "throw" } });
    const r = await w.call("summary", "standard");
    expect(r).toMatchObject({ ok: true, fallback: true, providerId: "firebase-hybrid" });
    expect(health(w, "loc")?.health).toBe("offline");
  });
  it.each(["timeout", "offline"])("nack %s -> offline", async (nack) => {
    const w = await world({ endpoints: [LOC], selection: { all: "loc" }, gen: { loc: { ok: false, nack } } });
    await w.call("summary", "standard");
    expect(health(w, "loc")?.health).toBe("offline");
  });
  it("nack policy -> blocked (Amendment W0-R)", async () => {
    const w = await world({ endpoints: [LOC], selection: { all: "loc" }, gen: { loc: { ok: false, nack: "policy" } } });
    await w.call("summary", "standard");
    expect(health(w, "loc")?.health).toBe("blocked");
  });
  it.each(["bad_reply", "rate_limited", "http_error", "busy"])("nack %s leaves the endpoint available (only TIMEOUT/OFFLINE move it)", async (nack) => {
    const w = await world({ endpoints: [LOC], selection: { all: "loc" }, gen: { loc: { ok: false, nack } } });
    await w.call("summary", "standard");
    expect(health(w, "loc")?.health).toBe("available");
  });
  it("needs_setup and offline endpoints hop with ZERO transport.generate", async () => {
    for (const [ep, probe] of [[REMNK, undefined], [LOC, "reject" as const]] as const) {
      const w = await world({ endpoints: [ep], selection: { all: ep.id }, probes: probe ? { [ep.id]: probe } : {} });
      const r = await w.call("summary", "standard");
      expect(w.tr.genCalls).toHaveLength(0);
      expect(r).toMatchObject({ ok: true, fallback: true, providerId: "firebase-hybrid" });
      expect(w.hybrid.runs).toHaveLength(1);
    }
  });
});

describe("select / resolve", () => {
  type Exp = { primary: string; hop: string | null; blocked?: string | "none" };
  const SEL = (s: ModelSelection): ModelSelection => s;
  const CASES: [string, ModelSelection, CallTask, PrivacyTier, Exp][] = [
    ["default standard", {}, "status", "standard", { primary: "firebase-hybrid", hop: null, blocked: "none" }],
    ["default shared", {}, "summary", "shared", { primary: "firebase-hybrid", hop: null, blocked: "none" }],
    ["default private -> on-device (cloud-capable default is private-denied)", {}, "status", "private", { primary: "firebase-ondevice", hop: null }],
    ["local standard", SEL({ all: "loc" }), "status", "standard", { primary: "loc", hop: "firebase-hybrid", blocked: "none" }],
    ["local shared", SEL({ all: "loc" }), "status", "shared", { primary: "loc", hop: "firebase-hybrid", blocked: "none" }],
    ["local private without allow_private", SEL({ all: "loc" }), "status", "private", { primary: "firebase-ondevice", hop: null, blocked: "policy" }],
    ["local private with allow_private", SEL({ all: "locp" }), "status", "private", { primary: "locp", hop: "firebase-ondevice", blocked: "none" }],
    ["remote standard", SEL({ all: "rem" }), "digest", "standard", { primary: "rem", hop: "firebase-hybrid", blocked: "none" }],
    ["remote shared", SEL({ all: "rem" }), "digest", "shared", { primary: "firebase-hybrid", hop: null, blocked: "policy" }],
    ["remote private", SEL({ all: "rem" }), "digest", "private", { primary: "firebase-ondevice", hop: null, blocked: "policy" }],
    ["ondevice standard hops to hybrid", SEL({ all: "firebase-ondevice" }), "status", "standard", { primary: "firebase-ondevice", hop: "firebase-hybrid", blocked: "none" }],
    ["ondevice private = terminal, no hop", SEL({ all: "firebase-ondevice" }), "status", "private", { primary: "firebase-ondevice", hop: null, blocked: "none" }],
    ["cloud standard hops to hybrid", SEL({ all: "firebase-cloud" }), "status", "standard", { primary: "firebase-cloud", hop: "firebase-hybrid", blocked: "none" }],
    ["cloud private denied", SEL({ all: "firebase-cloud" }), "status", "private", { primary: "firebase-ondevice", hop: null, blocked: "policy" }],
    ["hybrid explicit", SEL({ all: "firebase-hybrid" }), "status", "standard", { primary: "firebase-hybrid", hop: null, blocked: "none" }],
    ["unknown id standard", SEL({ all: "ghost" }), "status", "standard", { primary: "firebase-hybrid", hop: null, blocked: "unknown_id" }],
    ["unknown id private stays on-device (step 6 beats step 3)", SEL({ all: "ghost" }), "status", "private", { primary: "firebase-ondevice", hop: null, blocked: "unknown_id" }],
    ["screenshot ignores selection (local)", SEL({ all: "loc" }), "screenshot", "standard", { primary: "firebase-ondevice", hop: null }],
    ["screenshot ignores selection (remote, private)", SEL({ all: "rem", groups: { capsule: "rem" } }), "screenshot", "private", { primary: "firebase-ondevice", hop: null }],
    ["screenshot ignores selection (cloud, shared)", SEL({ all: "firebase-cloud" }), "screenshot", "shared", { primary: "firebase-ondevice", hop: null }],
  ];
  it.each(CASES)("%s", async (_n, selection, task, tier, exp) => {
    const w = await world({ endpoints: EPS, selection });
    const r = w.reg.resolve(task, tier);
    expect(r.primary).toBe(exp.primary);
    expect(r.hop).toBe(exp.hop);
    if (exp.blocked === "none") expect(r.blocked).toBeUndefined();
    else if (exp.blocked !== undefined) expect(r.blocked).toBe(exp.blocked);
  });

  it("every task with empty selection and no transport resolves to firebase-hybrid (standard) [acceptance 1]", async () => {
    const w = await world({ noTransport: true });
    for (const t of ["status", "summary", "next_action", "plan", "digest", "route", "drift"] as CallTask[]) {
      expect(w.reg.resolve(t, "standard")).toMatchObject({ primary: "firebase-hybrid", hop: null });
    }
  });
  it("group beats all; missing group falls back to all; missing both to default", async () => {
    const w = await world({ endpoints: EPS, selection: { all: "firebase-cloud", groups: { capsule: "loc", digest: "rem", routing: "locp", drift: "loc" } } });
    for (const t of ["status", "summary", "next_action", "plan"] as CallTask[]) expect(w.reg.resolve(t, "standard").primary).toBe("loc");
    expect(w.reg.resolve("digest", "standard").primary).toBe("rem");
    expect(w.reg.resolve("route", "standard").primary).toBe("locp");
    expect(w.reg.resolve("drift", "standard").primary).toBe("loc");
    w.reg.select({ all: "loc", groups: { digest: "rem" } });
    expect(w.reg.resolve("status", "standard").primary).toBe("loc");
    expect(w.reg.resolve("route", "standard").primary).toBe("loc");
    expect(w.reg.resolve("digest", "standard").primary).toBe("rem");
    w.reg.select({ groups: { digest: "rem" } });
    expect(w.reg.resolve("status", "standard").primary).toBe("firebase-hybrid");
  });
  it("select() takes effect on the next resolve and select({}) returns to the default (replace semantics)", async () => {
    const w = await world({ endpoints: EPS });
    expect(w.reg.resolve("status", "standard").primary).toBe("firebase-hybrid");
    w.reg.select({ all: "loc" });
    expect(w.reg.resolve("status", "standard").primary).toBe("loc");
    w.reg.select({});
    expect(w.reg.resolve("status", "standard").primary).toBe("firebase-hybrid");
  });
  it("unknown ids are kept: the endpoint appearing at a later refresh becomes selectable", async () => {
    const w = await world({ endpoints: [LOC], selection: { all: "later" } });
    expect(w.reg.resolve("status", "standard")).toMatchObject({ primary: "firebase-hybrid", blocked: "unknown_id" });
    w.tr.endpoints = [LOC, { ...LOC, id: "later" }];
    await w.reg.refresh();
    expect(w.reg.resolve("status", "standard")).toMatchObject({ primary: "later", hop: "firebase-hybrid" });
  });
  it("deps.selection seeds the initial selection", async () => {
    const w = await world({ endpoints: [LOC], selection: { groups: { drift: "loc" } } });
    expect(w.reg.resolve("drift", "standard").primary).toBe("loc");
    expect(w.reg.resolve("status", "standard").primary).toBe("firebase-hybrid");
  });
  it("resolve never throws on hostile input (unknown task/tier)", async () => {
    const w = await world({ endpoints: [REM], selection: { all: "rem" } });
    expect(() => w.reg.resolve("chat" as CallTask, "standard")).not.toThrow();
    const r = w.reg.resolve("status", "PUBLIC" as PrivacyTier);
    expect(r.primary).toBe("firebase-ondevice");
    expect(r.hop).toBeNull();
  });
});

describe("Remote Config gates beat selection (acceptance 10)", () => {
  const sel = (id: string): WorldOpts => ({ endpoints: EPS, selection: { all: id } });
  it("externalEnabled=false blocks local and remote -> remote_config, terminal answers", async () => {
    for (const id of ["loc", "rem"]) {
      const w = await world({ ...sel(id), gates: { ...ALL_ON, externalEnabled: false } });
      expect(w.reg.resolve("status", "standard")).toEqual({ primary: "firebase-hybrid", hop: null, blocked: "remote_config" });
    }
  });
  it("remoteEnabled=false blocks remote only", async () => {
    const wr = await world({ ...sel("rem"), gates: { ...ALL_ON, remoteEnabled: false } });
    expect(wr.reg.resolve("status", "standard")).toMatchObject({ primary: "firebase-hybrid", blocked: "remote_config" });
    const wl = await world({ ...sel("loc"), gates: { ...ALL_ON, remoteEnabled: false } });
    expect(wl.reg.resolve("status", "standard")).toMatchObject({ primary: "loc", hop: "firebase-hybrid" });
  });
  it("killSwitchCloud blocks firebase-cloud selection (remote_config), local stays selectable", async () => {
    const wc = await world({ ...sel("firebase-cloud"), gates: { ...ALL_ON, killSwitchCloud: true } });
    expect(wc.reg.resolve("status", "standard")).toEqual({ primary: "firebase-hybrid", hop: null, blocked: "remote_config" });
    const wl = await world({ ...sel("loc"), gates: { ...ALL_ON, killSwitchCloud: true } });
    expect(wl.reg.resolve("status", "standard").primary).toBe("loc");
  });
  it("missing gate object = fail-closed: external and remote blocked, Firebase unaffected", async () => {
    const w = await world({ endpoints: EPS, selection: { all: "loc" }, gates: null });
    expect(w.reg.resolve("status", "standard")).toMatchObject({ primary: "firebase-hybrid", hop: null, blocked: "remote_config" });
    w.reg.select({ all: "rem" });
    expect(w.reg.resolve("status", "standard")).toMatchObject({ blocked: "remote_config" });
    w.reg.select({ all: "firebase-ondevice" });
    expect(w.reg.resolve("status", "standard")).toMatchObject({ primary: "firebase-ondevice", hop: "firebase-hybrid" });
  });
  it("missing individual flags count as false (fail-closed)", async () => {
    const w = await world({ ...sel("loc"), gates: {} });
    expect(w.reg.resolve("status", "standard").blocked).toBe("remote_config");
    const w2 = await world({ ...sel("rem"), gates: { externalEnabled: true } });
    expect(w2.reg.resolve("status", "standard").blocked).toBe("remote_config");
  });
  it("applyRemoteConfig replaces the gates at run time (both directions)", async () => {
    const w = await world(sel("loc"));
    expect(w.reg.resolve("status", "standard").primary).toBe("loc");
    w.reg.applyRemoteConfig({}, { ...ALL_ON, externalEnabled: false });
    expect(w.reg.resolve("status", "standard")).toMatchObject({ primary: "firebase-hybrid", blocked: "remote_config" });
    w.reg.applyRemoteConfig({}, ALL_ON);
    expect(w.reg.resolve("status", "standard").primary).toBe("loc");
  });
});

describe("privacy gate delegation (U47 never re-implements section 2.3)", () => {
  it("calls assertProviderAllowed(policyTask, tier, kind, {loopback, allowPrivate, endpointEnabled}) for the candidate", async () => {
    const w = await world({ endpoints: [LOCP, REM, REMNK], selection: { all: "locp" } });
    policyCalls.length = 0;
    w.reg.resolve("digest", "private");
    expect(policyCalls.find((c) => c.kind === "local-openai-compatible")).toMatchObject({
      task: "digest", tier: "private", opts: { loopback: true, allowPrivate: true, endpointEnabled: true } });
    w.reg.select({ all: "rem" }); policyCalls.length = 0;
    w.reg.resolve("status", "shared");
    expect(policyCalls.find((c) => c.kind === "remote-openai-compatible")).toMatchObject({
      task: "status", tier: "shared", opts: { loopback: false, allowPrivate: false, endpointEnabled: true } });
    w.reg.select({ all: "remnk" }); policyCalls.length = 0;
    w.reg.resolve("status", "standard");
    expect(policyCalls.find((c) => c.kind === "remote-openai-compatible")?.opts.endpointEnabled).toBe(false);
  });
  it.each(["route", "drift"] as CallTask[])("%s is asked of the policy as task \"status\" (closest text task)", async (t) => {
    const w = await world({ endpoints: [LOC], selection: { all: "loc" } });
    policyCalls.length = 0;
    w.reg.resolve(t, "standard");
    expect(policyCalls.length).toBeGreaterThan(0);
    for (const c of policyCalls) expect(c.task).toBe("status");
  });
  it("loopback=false from the host reaches the policy as loopback:false and blocks (policy)", async () => {
    const w = await world({ endpoints: [{ ...LOC, id: "nl", loopback: false }], selection: { all: "nl" } });
    expect(w.reg.resolve("status", "standard")).toMatchObject({ primary: "firebase-hybrid", hop: null, blocked: "policy" });
    expect(policyCalls.find((c) => c.kind === "local-openai-compatible")?.opts.loopback).toBe(false);
  });
  it("an offline endpoint is still endpointEnabled (health !== needs_setup)", async () => {
    const w = await world({ endpoints: [LOC], selection: { all: "loc" }, probes: { loc: "reject" } });
    policyCalls.length = 0;
    w.reg.resolve("status", "standard");
    expect(policyCalls.find((c) => c.kind === "local-openai-compatible")?.opts.endpointEnabled).toBe(true);
  });
  it("defers verbatim: deny-all policy blocks even local standard; allow-all lets shared remote resolve", async () => {
    const w = await world({ endpoints: [LOC, REM], selection: { all: "loc" } });
    setPolicyOverride(() => ({ ok: false, violation: "LOCAL_ENDPOINT_DISABLED" }));
    expect(w.reg.resolve("status", "standard")).toMatchObject({ primary: "firebase-hybrid", hop: null, blocked: "policy" });
    setPolicyOverride(() => ({ ok: true }));
    w.reg.select({ all: "rem" });
    expect(w.reg.resolve("status", "shared")).toMatchObject({ primary: "rem", hop: "firebase-hybrid" });
  });
  it("the asking tier is passed unchanged for every tier", async () => {
    const w = await world({ endpoints: [LOCP], selection: { all: "locp" } });
    for (const tier of ["private", "standard", "shared"] as PrivacyTier[]) {
      policyCalls.length = 0; w.reg.resolve("status", tier);
      expect(policyCalls.some((c) => c.tier === tier && c.kind === "local-openai-compatible")).toBe(true);
    }
  });
});

describe("Firebase overlays (lazy, once, in sync) and device init", () => {
  const CFG = { max_output_tokens: 123, mode_status: "PREFER_IN_CLOUD", mode_digest: "PREFER_IN_CLOUD", prompt_version: "v7" } as const;
  const MODES = ["mode_status", "mode_summary", "mode_next_action", "mode_digest"] as const;
  it("no makeHybrid call for construction, refresh or default-provider traffic", async () => {
    const w = await world({ endpoints: [LOC] });
    await w.call("summary", "standard"); await w.call("digest", "shared");
    expect(w.makeCalls).toHaveLength(0);
    expect(w.hybrid.runs).toHaveLength(2);
  });
  it("on-device overlay: built once, cfg + every mode_* ONLY_ON_DEVICE, mode_screenshot ONLY_ON_DEVICE", async () => {
    const w = await world({ config: CFG });
    await w.call("screenshot", "standard"); await w.call("screenshot", "private"); await w.call("screenshot", "shared");
    expect(w.makeCalls).toHaveLength(1);
    expect(w.makeCalls[0]).toMatchObject({ max_output_tokens: 123, prompt_version: "v7", mode_screenshot: "ONLY_ON_DEVICE" });
    for (const k of MODES) expect(w.makeCalls[0]?.[k]).toBe("ONLY_ON_DEVICE");
  });
  it("cloud overlay: built once, cfg + every mode_* ONLY_IN_CLOUD except mode_screenshot ONLY_ON_DEVICE", async () => {
    const w = await world({ config: CFG, selection: { all: "firebase-cloud" } });
    await w.call("status", "standard"); await w.call("summary", "standard");
    const cloud = w.makeCalls.filter((c) => c.mode_status === "ONLY_IN_CLOUD");
    expect(cloud).toHaveLength(1);
    expect(cloud[0]).toMatchObject({ max_output_tokens: 123, prompt_version: "v7", mode_screenshot: "ONLY_ON_DEVICE" });
    for (const k of MODES) expect(cloud[0]?.[k]).toBe("ONLY_IN_CLOUD");
  });
  it("applyRemoteConfig re-syncs live overlays (forced modes kept) and never applyConfig-s deps.hybrid with an overlay", async () => {
    const w = await world({ config: CFG });
    await w.call("screenshot", "standard");
    w.reg.applyRemoteConfig({ max_output_tokens: 77 }, ALL_ON);
    const last = w.overlays.ondevice?.applied.at(-1);
    expect(last).toMatchObject({ max_output_tokens: 77, mode_screenshot: "ONLY_ON_DEVICE" });
    for (const k of MODES) expect(last?.[k]).toBe("ONLY_ON_DEVICE");
    for (const a of w.hybrid.applied) expect(a).toEqual({ max_output_tokens: 77 });
  });
  it("an overlay created after applyRemoteConfig starts from the latest cfg", async () => {
    const w = await world({ config: CFG });
    w.reg.applyRemoteConfig({ max_output_tokens: 55 }, ALL_ON);
    expect(w.makeCalls).toHaveLength(0);
    await w.call("screenshot", "standard");
    expect(w.makeCalls[0]).toMatchObject({ max_output_tokens: 55, mode_status: "ONLY_ON_DEVICE" });
  });
  it("initDevice initialises the default and every live overlay and returns the default's status", async () => {
    const w = await world({});
    w.hybrid.initStatus = { state: "ready" };
    await w.call("screenshot", "standard");
    expect(w.overlays.ondevice).toBeDefined();
    if (w.overlays.ondevice) w.overlays.ondevice.initStatus = { state: "failed", detail: "overlay" };
    const seen: number[] = [];
    w.hybrid.progress = [0.25, 1];
    await expect(w.reg.initDevice((p) => seen.push(p))).resolves.toEqual({ state: "ready" });
    expect(w.hybrid.inits).toBe(1);
    expect(w.overlays.ondevice?.inits).toBe(1);
    expect(seen).toEqual([0.25, 1]);
  });
  it("initDevice with no overlay built does not construct one", async () => {
    const w = await world({});
    await w.reg.initDevice();
    expect(w.makeCalls).toHaveLength(0);
    expect(w.hybrid.inits).toBe(1);
  });
  it("initDevice returns the default's status even when it is not ready", async () => {
    const w = await world({});
    w.hybrid.initStatus = { state: "needs_gesture" };
    await expect(w.reg.initDevice()).resolves.toEqual({ state: "needs_gesture" });
  });
  it("registry stays usable after concurrent refreshes (no duplicate descriptors)", async () => {
    const w = await world({ endpoints: [LOC, REM], refresh: false });
    await Promise.all([w.reg.refresh(), w.reg.refresh()]);
    await flush();
    expect(ids(w.reg)).toEqual([...FIREBASE_IDS, "loc", "rem"]);
  });
});
