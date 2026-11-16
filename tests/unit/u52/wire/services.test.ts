import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDriftReviewer, driftPortFromFactory } from "../../../../src/app/agent_drift";
import { createModelServices } from "../../../../src/app/model_services";
import type { DriftReviewerOptions } from "../../../../src/app/agent_drift";
import type { LiveConfig } from "../../../../src/config/types";
import type { CallTask } from "../../../../src/providers/types";
import { FIREBASE_IDS } from "../../../../src/providers/types";
import { viewSourceKind, chipLabel } from "../../../../src/ui/model_selector";
import { Channel, LOCAL, REMOTE, DRIFT_TEXT, factory, services, hosted, signal, settled, flush, state, store, remoteConfig } from "./fixtures";
import { CONFIG_DEFAULTS } from "../../../../src/config/keys";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function reviewer(service: ReturnType<typeof services>["service"]) {
  // Forward-compatible only at the U52 additive union boundary; no production code is mocked.
  const opts = { port: (mode: Parameters<typeof service.driftPortFor>[0]) => service.driftPortFor(mode) };
  return createDriftReviewer(opts as unknown as DriftReviewerOptions);
}
const taskRequest = (tier: "private" | "standard" | "shared" = "standard", task: "summary" | "screenshot" = "summary") =>
  ({ task, tier, projectId: "oracle", prompt: "fixture prompt" });

describe("W1 W3 default Firebase composition", () => {
  it.each(["PREFER_ON_DEVICE", "ONLY_ON_DEVICE"] as const)("W1 golden %s: factory parameters, prompt, schema and source match the pre-U52 adapter", async mode => {
    const w = services(); const legacy = factory();
    const p = "unique drift prompt"; const schema = { type: "object", required: ["verdict", "reason"] };
    const start = w.sdk.calls.length;
    const actual = await settled(w.service.driftPortFor(mode).port.generate(p, schema, signal()));
    const expected = await settled(driftPortFromFactory(legacy.f, mode).generate(p, schema, signal()));
    expect(actual).toEqual(expected);
    expect(w.sdk.calls.slice(start)).toEqual(legacy.calls);
    expect(w.sdk.prompts).toEqual(legacy.prompts);
    expect(w.sdk.calls.slice(start)).toEqual([{
      mode, inCloudParams: { model: "gemini-3.5-flash-lite", generationConfig: {
        responseMimeType: "application/json", responseSchema: schema, maxOutputTokens: 200,
      } }, onDeviceParams: { promptOptions: { responseConstraint: schema } },
    }]);
    w.service.dispose();
  });
  it("W1 no channel: exactly the Firebase ids and default primaries (private ondevice)", () => {
    const { service } = services();
    expect(service.registry.list().map(p => p.id).sort()).toEqual([...FIREBASE_IDS].sort());
    for (const task of ["status", "summary", "next_action", "plan", "digest", "route", "drift"] satisfies CallTask[]) {
      expect(service.registry.resolve(task, "standard").primary).toBe("firebase-hybrid");
      expect(service.registry.resolve(task, "private").primary).toBe("firebase-ondevice");
    }
    service.dispose();
  });
  it("W3 stop rule 2: every distinct drift review still calls factory.create", async () => {
    const w = services(); const r = reviewer(w.service);
    for (let i = 0; i < 3; i++) {
      const s = state(); s.contract = { ...s.contract!, hash: `new-${i}` };
      const n = w.sdk.calls.length;
      expect((await settled(r.review(s, "PREFER_ON_DEVICE")))?.source).toBe("device");
      expect(w.sdk.calls.length).toBeGreaterThan(n);
    }
    w.service.dispose();
  });
  it("W1 aiSink applyConfig updates registry Firebase overlays", async () => {
    const w = services();
    w.service.aiSink().applyConfig({ kill_switch_cloud: true });
    await settled(w.service.driftPortFor("PREFER_ON_DEVICE").port.generate("p", {}, signal()));
    expect(w.sdk.calls.at(-1)?.mode).toBe("ONLY_ON_DEVICE"); w.service.dispose();
  });
});

describe("W4 W5 W6 W7 provider paths and stop rule 1", () => {
  it.each(["standard", "shared"] as const)("W4 local answer carries %s tier, LOCAL_SERVER source and local chip", async tier => {
    const { service, ch } = await hosted();
    const result = await settled(service.hybrid().run(taskRequest(tier)));
    expect(result).toMatchObject({ ok: true, source: "LOCAL_SERVER", fallback: false });
    expect(ch.of("model_generate")).toHaveLength(1);
    expect(ch.of("model_generate")[0]!["tier"]).toBe(tier);
    if (!result.ok) throw new Error("expected local success");
    expect(viewSourceKind(result.source)).toBe("local");
    expect(chipLabel(result.source, tier)).toBe("Local model"); service.dispose();
  });
  it("W5 offline nack falls back to Firebase ON_DEVICE, fallback true, endpoint health offline", async () => {
    const { service, ch } = await hosted(LOCAL, "offline");
    const result = await settled(service.hybrid().run(taskRequest()));
    expect(result).toMatchObject({ ok: true, source: "ON_DEVICE", fallback: true });
    expect(ch.of("model_generate")).toHaveLength(1);
    expect(service.registry.list().find(p => p.id === LOCAL.id)?.health).toBe("offline"); service.dispose();
  });
  it.each([
    { name: "private remote", ep: REMOTE, tier: "private" as const },
    { name: "shared remote", ep: REMOTE, tier: "shared" as const },
    { name: "private local without allow_private", ep: LOCAL, tier: "private" as const },
  ])("W6 $name: hybrid, drift and classifier never send forbidden endpoint generate", async ({ ep, tier }) => {
    const { service, ch } = await hosted(ep);
    await settled(service.hybrid().run(taskRequest(tier)));
    await settled(service.driftPortFor("ONLY_ON_DEVICE").port.generate("private drift", {}, signal()));
    await settled(service.classifier("private")({ prompt: "private route", constraint: {}, mode: "ONLY_ON_DEVICE", signal: signal() }));
    expect(ch.of("model_generate").filter(f => f["id"] === ep.id)).toEqual([]); service.dispose();
  });
  it.each([LOCAL, { ...LOCAL, id: "private-local", allow_private: true }, REMOTE])("W6 screenshot never sends to $id even when selected", async ep => {
    const { service, ch } = await hosted(ep);
    await settled(service.hybrid().run(taskRequest("standard", "screenshot")));
    expect(ch.of("model_generate")).toEqual([]); service.dispose();
  });
  it("W6 positive private allow_private local is usable by the hybrid seam", async () => {
    const { service, ch } = await hosted({ ...LOCAL, allow_private: true });
    expect(await settled(service.hybrid().run(taskRequest("private")))).toMatchObject({ ok: true, source: "LOCAL_SERVER" });
    expect(ch.of("model_generate")[0]!["tier"]).toBe("private"); service.dispose();
  });
  it.each([
    { mode: "PREFER_ON_DEVICE" as const, source: "local", allow: true },
    { mode: "ONLY_ON_DEVICE" as const, source: "rules", allow: false },
  ])("W7 $mode local answer yields $source verdict with explicit external permission", async ({ mode, source, allow }) => {
    // allow_private deliberately true: ONLY_ON_DEVICE must not silently authorise external verdicts.
    const { service } = await hosted({ ...LOCAL, allow_private: true }, "ok", DRIFT_TEXT);
    expect(service.driftPortFor(mode).allowExternal).toBe(allow);
    expect((await settled(reviewer(service).review(state(), mode)))?.source).toBe(source);
    service.dispose();
  });
  it("W2 unknown selection without hello leaves model channel silent through drift and init", async () => {
    const ch = new Channel(); const { service } = services({ channel: ch });
    service.registry.select({ all: "unknown-id" });
    await settled(service.registry.initDevice());
    await settled(service.driftPortFor("PREFER_ON_DEVICE").port.generate("p", {}, signal()));
    await settled(service.registry.refresh());
    expect(ch.sent).toEqual([]); service.dispose();
  });
});

describe("W8 Remote Config and selection seams", () => {
  it("W8 no rc uses true/true defaults so standard local and remote remain available", async () => {
    const ch = new Channel(); const { service } = services({ channel: ch });
    ch.host([LOCAL, REMOTE]); await flush(); await settled(service.registry.refresh());
    for (const ep of [LOCAL, REMOTE]) {
      service.registry.select({ all: ep.id });
      expect(service.registry.resolve("summary", "standard").primary).toBe(ep.id);
    }
    service.dispose();
  });
  it.each([
    { key: "external_providers_enabled", local: false, remote: false },
    { key: "remote_providers_enabled", local: true, remote: false },
    { key: "kill_switch_cloud", local: true, remote: false },
  ])("W8 $key changes only the specified provider policy", async ({ key, local, remote }) => {
    const rc = remoteConfig({ [key]: key === "kill_switch_cloud" ? "true" : "false" });
    const ch = new Channel(); const { service } = services({ channel: ch, rc: rc.rc });
    ch.host([LOCAL, REMOTE]); await flush(); await settled(service.registry.refresh());
    for (const [ep, allowed] of [[LOCAL, local], [REMOTE, remote]] as const) {
      service.registry.select({ all: ep.id });
      expect(service.registry.resolve("summary", "standard").primary === ep.id).toBe(allowed);
      if (!allowed) expect(service.registry.list().find(p => p.id === ep.id)).toMatchObject({ health: "blocked", blockedReason: "remote_config" });
    }
    service.dispose();
  });
  it("W8 flag-only event activates before re-read; unrelated key does nothing", async () => {
    const rc = remoteConfig(); const ch = new Channel(); const { service } = services({ rc: rc.rc, channel: ch });
    ch.host([LOCAL]); await flush(); await settled(service.registry.refresh()); service.registry.select({ all: LOCAL.id });
    expect(service.registry.resolve("summary", "standard").primary).toBe(LOCAL.id);
    rc.activate.mockClear(); rc.getString.mockClear();
    rc.update("unrelated_key"); await flush(); expect(rc.activate).not.toHaveBeenCalled();
    rc.values["external_providers_enabled"] = "false";
    rc.update("external_providers_enabled"); await flush();
    expect(rc.activate).toHaveBeenCalledTimes(1); expect(rc.getString).toHaveBeenCalledWith("external_providers_enabled");
    expect(rc.activate.mock.invocationCallOrder[0]!).toBeLessThan(rc.getString.mock.invocationCallOrder[0]!);
    expect(service.registry.list().find(p => p.id === LOCAL.id)).toMatchObject({ health: "blocked", blockedReason: "remote_config" });
    service.dispose(); expect(rc.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it("W8 invalid flag retains prior false value, rather than enabling providers", async () => {
    const rc = remoteConfig({ external_providers_enabled: "false" }); const ch = new Channel();
    const { service } = services({ rc: rc.rc, channel: ch }); ch.host([LOCAL]); await flush(); await settled(service.registry.refresh());
    rc.values["external_providers_enabled"] = " FALSE "; service.refreshFlags();
    expect(service.registry.list().find(p => p.id === LOCAL.id)).toMatchObject({ health: "blocked", blockedReason: "remote_config" }); service.dispose();
  });
  it("W8 throwing onConfigUpdate registration is swallowed and defaults still work", () => {
    const rc = remoteConfig(); rc.rc.onConfigUpdate = () => { throw new Error("SDK registration unavailable"); };
    const { service } = services({ rc: rc.rc });
    expect(service.registry.resolve("drift", "standard").primary).toBe("firebase-hybrid"); service.dispose();
  });
  it("W8 kill_switch_cloud-only event activates and re-reads the cloud gate", async () => {
    const rc = remoteConfig(); const ch = new Channel(); const { service } = services({ rc: rc.rc, channel: ch });
    ch.host([REMOTE]); await flush(); await settled(service.registry.refresh()); service.registry.select({ all: REMOTE.id });
    rc.values["kill_switch_cloud"] = "true"; rc.update("kill_switch_cloud"); await flush();
    expect(rc.activate).toHaveBeenCalledTimes(1);
    expect(service.registry.resolve("summary", "standard").primary).not.toBe(REMOTE.id); service.dispose();
  });
  it("W8 live start completion and subscription refresh provider flags", async () => {
    const rc = remoteConfig(); const snap = { cfg: CONFIG_DEFAULTS, gen: 1, hash: "00000000", activatedAt: null };
    let notify: Parameters<LiveConfig["subscribe"]>[0] | undefined;
    const off = vi.fn();
    const live: LiveConfig = {
      start: vi.fn(async () => { rc.values["external_providers_enabled"] = "false"; return snap; }),
      current: () => snap, badge: () => ({ text: "", gen: 1, hash: "00000000", promptVersion: "v1", cloudOff: false, live: "defaults" }),
      subscribe(cb) { notify = cb; return off; }, onVisibility: () => undefined, dispose: () => undefined,
    };
    const ch = new Channel(); const { service } = services({ rc: rc.rc, live, channel: ch });
    ch.host([LOCAL]); await flush(); await settled(service.registry.refresh());
    expect(live.start).toHaveBeenCalledTimes(1);
    expect(service.registry.list().find(p => p.id === LOCAL.id)?.blockedReason).toBe("remote_config");
    rc.values["external_providers_enabled"] = "true"; expect(notify).toBeDefined(); notify!(snap, []); await flush();
    service.registry.select({ all: LOCAL.id }); expect(service.registry.resolve("summary", "standard").primary).toBe(LOCAL.id);
    service.dispose(); expect(off).toHaveBeenCalledTimes(1);
  });
  it("W8 persisted ids load asynchronously and onChange updates registry selection", async () => {
    const s = store({ all: "firebase-cloud" }); const { service } = services({ selectionStore: s.value });
    await flush(); expect(service.registry.resolve("drift", "standard").primary).toBe("firebase-cloud");
    s.push({ groups: { drift: "firebase-ondevice" } }); await flush();
    expect(service.registry.resolve("drift", "standard").primary).toBe("firebase-ondevice"); service.dispose();
  });
});

describe("W10 W11 W12 operational seams", () => {
  it("W10 registry device bound uses the supplied clock, never a real timer", async () => {
    const sdk = factory(); sdk.init.mockImplementation(() => new Promise(() => undefined));
    const w = services({ factory: sdk.f }); const pending = w.service.registry.initDevice();
    await flush(); await w.clock.advance(10_000);
    expect(await settled(pending)).toEqual({ state: "downloading", progress: 0 }); w.service.dispose();
  });
  it("W11 canary prompt never reaches storage, console or selection writes", async () => {
    const canary = "U52_CANARY_f497c_prompt_never_persist"; const s = store(); const ch = new Channel();
    const w = services({ channel: ch, selectionStore: s.value });
    ch.host([LOCAL]); await flush(); await settled(w.service.registry.refresh()); w.service.registry.select({ all: LOCAL.id });
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const methods = console as unknown as Record<string, (...args: unknown[]) => unknown>;
    const names = Object.getOwnPropertyNames(console).filter(k => typeof methods[k] === "function");
    const logs = names.map(k => vi.spyOn(methods, k).mockImplementation(() => undefined));
    await settled(w.service.hybrid().run({ ...taskRequest(), prompt: canary }));
    await settled(w.service.driftPortFor("PREFER_ON_DEVICE").port.generate(canary, {}, signal()));
    await settled(w.service.classifier("standard")({ prompt: canary, constraint: {}, mode: "PREFER_ON_DEVICE", signal: signal() }));
    const saved = JSON.stringify({ storage: storage.mock.calls, logs: logs.map(s => s.mock.calls), selection: s.writes });
    expect(saved).not.toContain(canary); w.service.dispose();
  });
  it("W12 ledger forwards base counters and shares external counts without persistence", () => {
    const { service } = services(); const inc = vi.fn(); const storage = vi.spyOn(Storage.prototype, "setItem");
    const a = service.ledger({ inc }); const b = service.ledger({ inc });
    expect(service.externalCounts()).toEqual({ local_server: 0, remote_provider: 0 });
    a.inc("on_device"); a.incExternal!("local_server"); b.incExternal!("local_server"); a.incExternal!("remote_provider");
    expect(inc.mock.calls).toEqual([["on_device"]]);
    expect(service.externalCounts()).toEqual({ local_server: 2, remote_provider: 1 }); expect(storage).not.toHaveBeenCalled(); service.dispose();
    const fresh = services(); expect(fresh.service.externalCounts()).toEqual({ local_server: 0, remote_provider: 0 }); fresh.service.dispose();
  });
});
