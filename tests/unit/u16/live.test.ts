import { afterEach, describe, expect, test } from "vitest";
import { createLiveConfig } from "../../../src/config/live";
import { renderBadge } from "../../../src/config/badge";
import type { ConfigWarning, LiveConfig } from "../../../src/config/types";
import { ALL_KEYS, REF_DEFAULTS, flush, makeHarness, type Harness } from "./helpers";

const lives: LiveConfig[] = [];
function boot(opts: { mode?: "dev" | "prod"; withGovernor?: boolean } = {}): { h: Harness; live: LiveConfig } {
  const h = makeHarness(opts);
  const live = createLiveConfig(h.deps);
  lives.push(live);
  return { h, live };
}
afterEach(() => { while (lives.length) { try { lives.pop()!.dispose(); } catch { /* stub */ } } });

describe("O1 defaults and start()", () => {
  test("defaults snapshot, gen 0, frozen; setDefaults receives every key as a string before any fetch", async () => {
    const { h, live } = boot();
    const snap = await live.start();
    expect(snap.cfg).toEqual(REF_DEFAULTS);
    expect(snap.gen).toBe(0);
    expect(snap.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(Object.isFrozen(snap.cfg)).toBe(true);
    expect(h.rc.defaults).not.toBeNull();
    expect(Object.keys(h.rc.defaults!).sort()).toEqual(ALL_KEYS);
    expect(Object.keys(h.rc.defaults!)).toHaveLength(20);   // 18 base keys + mode_plan + mode_template
    for (const v of Object.values(h.rc.defaults!)) expect(typeof v).toBe("string");
    expect(h.rc.defaults!["kill_switch_cloud"]).toBe("false");
    expect(h.rc.defaults!["max_output_tokens"]).toBe("200");
    expect(h.rc.log.indexOf("setDefaults")).toBeGreaterThanOrEqual(0);
    expect(h.rc.log.indexOf("setDefaults")).toBeLessThan(h.rc.log.indexOf("fetch"));
    expect(live.current().gen).toBe(0);
  });
  test("fetchAndActivate is called exactly once by start and onConfigUpdate is subscribed (B3, B11)", async () => {
    const { h, live } = boot();
    await live.start();
    expect(h.rc.fetchCalls).toBe(1);
    expect(h.rc.subscribeCalls).toBe(1);
  });
  test("B4: minimumFetchIntervalMillis is 43200000 in prod and 60000 in dev, set before fetch", async () => {
    const p = boot({ mode: "prod" }); await p.live.start();
    expect(p.h.rc.minFetch).toBe(43200000);
    expect(p.h.rc.log.indexOf("setMin")).toBeLessThan(p.h.rc.log.indexOf("fetch"));
    const d = boot({ mode: "dev" }); await d.live.start();
    expect(d.h.rc.minFetch).toBe(60000);
  });
  test("remote values present at start produce gen 1 and one propagation of the changed config", async () => {
    const h = makeHarness(); h.rc.values["max_output_tokens"] = "300";
    const live = createLiveConfig(h.deps); lives.push(live);
    const s = await live.start();
    expect(s.cfg.max_output_tokens).toBe(300);
    expect(s.gen).toBe(1);
    expect(h.aiCalls).toHaveLength(1);
    expect(h.aiCalls[0]!.max_output_tokens).toBe(300);
    expect(h.reconcileCalls).toHaveLength(0);   // max_output_tokens is not in the U10 set
  });
  test("start never rejects: fetch rejects with a plain error -> defaults snapshot, a retry timer exists", async () => {
    const h = makeHarness(); h.rc.fetchImpl = () => Promise.reject(new Error("offline"));
    const live = createLiveConfig(h.deps); lives.push(live);
    const s = await live.start();
    expect(s.cfg).toEqual(REF_DEFAULTS);
    expect(s.gen).toBe(0);
    expect(h.timers.live().length).toBeGreaterThanOrEqual(1);
  });
  test("start never rejects: setDefaults throws -> still resolves with a snapshot", async () => {
    const h = makeHarness(); h.rc.port.setDefaults = () => { throw new Error("sdk"); };
    const live = createLiveConfig(h.deps); lives.push(live);
    await expect(live.start()).resolves.toMatchObject({ gen: 0 });
  });
  test("start never rejects: onConfigUpdate throws on subscribe -> polling fallback", async () => {
    const h = makeHarness(); h.rc.port.onConfigUpdate = () => { throw new Error("no realtime"); };
    const live = createLiveConfig(h.deps); lives.push(live);
    await expect(live.start()).resolves.toBeDefined();
    expect(live.badge().live).toBe("polling");
  });
});

describe("O5 realtime_kill_flip / O6 badge", () => {
  test("activate once, then updateConfig then applyConfig (kill true), gen 0 -> 1, state realtime", async () => {
    const { h, live } = boot();
    await live.start(); h.reset();
    await h.push({ kill_switch_cloud: "true" });
    expect(h.rc.activateCalls).toBe(1);
    expect(h.order).toEqual(["reconcile", "ai"]);
    expect(h.reconcileCalls[0]!.kill_switch_cloud).toBe(true);
    expect(h.aiCalls[0]!.kill_switch_cloud).toBe(true);
    expect(live.current().gen).toBe(1);
    expect(live.current().cfg.kill_switch_cloud).toBe(true);
    expect(live.badge().live).toBe("realtime");
  });
  test("activate happens before re-parse and propagation", async () => {
    const { h, live } = boot();
    await live.start(); h.reset();
    const seen: string[] = [];
    const orig = h.deps.reconcile.updateConfig;
    h.deps.reconcile.updateConfig = (c) => { seen.push(h.rc.activateCalls > 0 ? "after-activate" : "before-activate"); orig(c); };
    await h.push({ kill_switch_cloud: "true" });
    expect(seen).toEqual(["after-activate"]);
  });
  test("badge text, data attributes and no child nodes", async () => {
    const { h, live } = boot();
    await live.start();
    const el = document.createElement("div");
    const before = live.badge(); renderBadge(el, before); const t0 = el.textContent;
    expect(before.text).toMatch(/^cfg v1 g0 [0-9a-f]{8} (defaults|realtime|polling)$/);
    await h.push({ kill_switch_cloud: "true" });
    const after = live.badge(); renderBadge(el, after);
    expect(el.textContent).not.toBe(t0);
    expect(el.textContent).toContain("cloud-off");
    expect(after.text).toMatch(/^cfg v1 g1 [0-9a-f]{8} realtime cloud-off$/);
    expect(after.text.length).toBeLessThanOrEqual(64);
    expect(after.cloudOff).toBe(true);
    expect(after.hash).toBe(live.current().hash);
    expect(el.getAttribute("data-config-gen")).toBe("1");
    expect(el.getAttribute("data-cloud-off")).toBe("true");
    expect(el.getAttribute("data-live")).toBe("realtime");
    expect(el.children.length).toBe(0);
  });
  test("renderBadge writes text only (no HTML) and only the three data attributes", () => {
    const el = document.createElement("div");
    renderBadge(el, { text: "<img src=x onerror=alert(1)>", gen: 3, hash: "abcdef01", promptVersion: "v1", cloudOff: false, live: "polling" });
    expect(el.children.length).toBe(0);
    expect(el.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(el.innerHTML).not.toContain("<img");
    expect(el.getAttribute("data-cloud-off")).not.toBe("true");
    const names = Array.from(el.attributes).map((a) => a.name);
    for (const n of names) expect(["data-config-gen", "data-cloud-off", "data-live"]).toContain(n);
    expect(el.getAttribute("data-config-gen")).toBe("3");
    expect(el.getAttribute("data-live")).toBe("polling");
  });
  test("badge text is capped at 64 chars even with the longest valid prompt_version", async () => {
    const { h, live } = boot();
    await live.start();
    await h.push({ prompt_version: "v999", kill_switch_cloud: "true" });
    expect(live.badge().text.length).toBeLessThanOrEqual(64);
    expect(live.badge().promptVersion).toBe("v999");
  });
});

describe("O7 noop_update (neg)", () => {
  test("unrelated keys do not activate; unchanged relevant value triggers no sink and no gen change", async () => {
    const { h, live } = boot();
    await live.start(); h.reset();
    const hash0 = live.current().hash; const text0 = live.badge().text;
    await h.push({}, ["unrelated_key"]);
    expect(h.rc.activateCalls).toBe(0);
    await h.push({ mode_status: "PREFER_ON_DEVICE" }, ["mode_status"]);
    expect(h.order).toEqual([]);
    expect(live.current().gen).toBe(0);
    expect(live.current().hash).toBe(hash0);
    expect(live.badge().text).toBe(text0);
  });
  test("a key set mixing unrelated and relevant keys still activates", async () => {
    const { h, live } = boot();
    await live.start(); h.reset();
    await h.push({ kill_switch_cloud: "true" }, ["unrelated", "kill_switch_cloud"]);
    expect(h.rc.activateCalls).toBe(1);
    expect(live.current().gen).toBe(1);
  });
  test("flip and flip back: gen increments on each hash change only (0 -> 1 -> 2), same value does nothing", async () => {
    const { h, live } = boot();
    await live.start();
    await h.push({ kill_switch_cloud: "true" });
    await h.push({ kill_switch_cloud: "true" });
    expect(live.current().gen).toBe(1);
    await h.push({ kill_switch_cloud: "false" });
    expect(live.current().gen).toBe(2);
    expect(live.current().hash).toBe(live.current().hash);
  });
  test("subscribers fire only when the snapshot changes, with warnings", async () => {
    const { h, live } = boot();
    const seen: Array<{ gen: number; w: readonly ConfigWarning[] }> = [];
    live.subscribe((s, w) => seen.push({ gen: s.gen, w }));
    await live.start();
    await h.push({ max_output_tokens: "5000" });
    expect(seen.map((s) => s.gen)).toEqual([1]);
    expect(seen[0]!.w.some((w) => w.key === "max_output_tokens" && w.code === "CLAMPED")).toBe(true);
    await h.push({ max_output_tokens: "5000" });
    expect(seen).toHaveLength(1);
  });
  test("unsubscribe stops notifications", async () => {
    const { h, live } = boot();
    let n = 0; const off = live.subscribe(() => { n++; });
    await live.start(); off();
    await h.push({ kill_switch_cloud: "true" });
    expect(n).toBe(0);
  });
});

describe("O8/O9/O10 partitioned propagation (B9)", () => {
  test("O8 reconcile-only: min_inference_interval_ms -> updateConfig once, applyConfig never", async () => {
    const { h, live } = boot();
    await live.start(); h.reset();
    await h.push({ min_inference_interval_ms: "40000" });
    expect(h.reconcileCalls).toHaveLength(1);
    expect(h.reconcileCalls[0]!.min_inference_interval_ms).toBe(40000);
    expect(h.aiCalls).toHaveLength(0);
    expect(h.govCalls).toHaveLength(0);
  });
  test("O8b every U10-only key stays off the AI sink", async () => {
    for (const [k, v] of [["ondevice_concurrency", "2"], ["cloud_concurrency", "3"], ["queue_max_depth_factor", "3"], ["inference_timeout_ms", "30000"]] as const) {
      const { h, live } = boot(); await live.start(); h.reset();
      await h.push({ [k]: v });
      expect(h.reconcileCalls, k).toHaveLength(1);
      expect(h.aiCalls, k).toHaveLength(0);
    }
  });
  test("O9 ai-only: model_name -> applyConfig once, updateConfig never", async () => {
    const { h, live } = boot();
    await live.start(); h.reset();
    await h.push({ model_name: "gemini-3.8-flash" });
    expect(h.aiCalls).toHaveLength(1);
    expect(h.aiCalls[0]!.model_name).toBe("gemini-3.8-flash");
    expect(h.reconcileCalls).toHaveLength(0);
  });
  test("O9b mode_digest and max_output_tokens are AI-only", async () => {
    const { h, live } = boot(); await live.start(); h.reset();
    await h.push({ mode_digest: "ONLY_ON_DEVICE", max_output_tokens: "100" });
    expect(h.aiCalls).toHaveLength(1);
    expect(h.reconcileCalls).toHaveLength(0);
  });
  test("keys in both sets (prompt_version, mode_status) call both sinks once, reconcile first", async () => {
    const { h, live } = boot(); await live.start(); h.reset();
    await h.push({ prompt_version: "v2", mode_status: "PREFER_IN_CLOUD" });
    expect(h.order).toEqual(["reconcile", "ai"]);
    expect(h.reconcileCalls[0]!.prompt_version).toBe("v2");
    expect(h.aiCalls[0]!.mode_status).toBe("PREFER_IN_CLOUD");
  });
  test("a multi-key push yields at most one call per sink", async () => {
    const { h, live } = boot(); await live.start(); h.reset();
    await h.push({ kill_switch_cloud: "true", model_name: "gemini-z", min_inference_interval_ms: "30000", governor_tier_override: "T1" });
    expect(h.reconcileCalls).toHaveLength(1);
    expect(h.aiCalls).toHaveLength(1);
    expect(h.govCalls).toHaveLength(1);
    expect(h.order).toEqual(["reconcile", "ai", "gov"]);
  });
  test("frame budgets and plan/template modes are not pushed to any sink (not live / no sink key)", async () => {
    const { h, live } = boot(); await live.start(); h.reset();
    await h.push({ max_patches_per_frame: "4", frame_js_budget_ms: "6", mode_plan: "ONLY_IN_CLOUD", mode_template: "ONLY_IN_CLOUD" });
    expect(h.reconcileCalls).toHaveLength(0);
    expect(h.aiCalls).toHaveLength(0);
    expect(live.current().gen).toBe(1);
    expect(live.current().cfg.mode_plan).toBe("ONLY_IN_CLOUD");
    expect(live.current().cfg.max_patches_per_frame).toBe(4);
  });
  test("O10 governor override: T3 then none -> setOverride('T3') then setOverride(null)", async () => {
    const { h, live } = boot(); await live.start(); h.reset();
    await h.push({ governor_tier_override: "T3" });
    await h.push({ governor_tier_override: "none" });
    expect(h.govCalls).toEqual(["T3", null]);
  });
  test("governor sink is optional: no governor dep -> no throw, snapshot still advances", async () => {
    const { h, live } = boot({ withGovernor: false }); await live.start();
    await h.push({ governor_tier_override: "T2" });
    expect(live.current().gen).toBe(1);
    expect(live.current().cfg.governor_tier_override).toBe("T2");
  });
  test("clamped and invalid remote values still propagate the clamped/kept value", async () => {
    const { h, live } = boot(); await live.start(); h.reset();
    await h.push({ cloud_concurrency: "99", ondevice_concurrency: "abc" });
    expect(h.reconcileCalls[0]!.cloud_concurrency).toBe(4);
    expect(h.reconcileCalls[0]!.ondevice_concurrency).toBe(1);
  });
  test("screenshot pin holds through the live path (O4 live)", async () => {
    const { h, live } = boot(); await live.start(); h.reset();
    await h.push({ mode_screenshot: "PREFER_IN_CLOUD" });
    expect(live.current().cfg.mode_screenshot).toBe("ONLY_ON_DEVICE");
    expect(h.aiCalls).toHaveLength(0);
    expect(h.reconcileCalls).toHaveLength(0);
  });
  test("a throwing getString for one key keeps that key and applies the rest", async () => {
    const { h, live } = boot(); await live.start(); h.reset();
    h.rc.getStringThrows.add("model_name");
    const seen: ConfigWarning[] = [];
    live.subscribe((_s, w) => seen.push(...w));
    await h.push({ model_name: "gemini-z", cloud_concurrency: "3" });
    expect(live.current().cfg.model_name).toBe("gemini-3.5-flash-lite");
    expect(live.current().cfg.cloud_concurrency).toBe(3);
    expect(seen.some((w) => w.key === "model_name" && w.code === "INVALID_KEPT")).toBe(true);
  });
});

describe("O11/O12/O13 degraded paths", () => {
  test("O11 throttle: three FETCH_THROTTLE rejections schedule 60000, 120000, 240000; state throttled; snapshot unchanged", async () => {
    const h = makeHarness();
    h.rc.fetchImpl = () => Promise.reject(new Error("FETCH_THROTTLE: too many requests"));
    const live = createLiveConfig(h.deps); lives.push(live);
    await live.start();
    await h.timers.fireNext(); await h.timers.fireNext();
    expect(h.timers.list.map((t) => t.ms)).toEqual([60000, 120000, 240000]);
    expect(h.rc.fetchCalls).toBe(3);
    expect(live.badge().live).toBe("throttled");
    expect(live.current().gen).toBe(0);
    expect(live.current().cfg).toEqual(REF_DEFAULTS);
  });
  test("throttle backoff doubles and caps at 3600000", async () => {
    const h = makeHarness();
    h.rc.fetchImpl = () => Promise.reject(new Error("FETCH_THROTTLE"));
    const live = createLiveConfig(h.deps); lives.push(live);
    await live.start();
    for (let i = 0; i < 9; i++) await h.timers.fireNext();
    expect(h.timers.list.map((t) => t.ms)).toEqual([60000, 120000, 240000, 480000, 960000, 1920000, 3600000, 3600000, 3600000, 3600000]);
  });
  test("a throttle retry that succeeds leaves the throttled state and applies the values", async () => {
    const h = makeHarness();
    let n = 0;
    h.rc.fetchImpl = () => (n++ === 0 ? Promise.reject(new Error("FETCH_THROTTLE")) : Promise.resolve(true));
    const live = createLiveConfig(h.deps); lives.push(live);
    await live.start();
    h.rc.values["kill_switch_cloud"] = "true";
    await h.timers.fireNext();
    expect(live.badge().live).not.toBe("throttled");
    expect(live.current().cfg.kill_switch_cloud).toBe(true);
  });
  test("a non-throttle rejection is not reported as throttled", async () => {
    const h = makeHarness();
    h.rc.fetchImpl = () => Promise.reject(new Error("network down"));
    const live = createLiveConfig(h.deps); lives.push(live);
    await live.start();
    expect(live.badge().live).not.toBe("throttled");
  });
  test("a rejection with a non-Error / odd value never escapes start()", async () => {
    const h = makeHarness();
    h.rc.fetchImpl = () => Promise.reject("just a string");
    const live = createLiveConfig(h.deps); lives.push(live);
    await expect(live.start()).resolves.toBeDefined();
  });
  test("O12 observer error -> polling, timer at minimumFetchInterval (prod 43200000), badge shows polling", async () => {
    const { h, live } = boot({ mode: "prod" });
    await live.start(); h.reset();
    const before = h.timers.list.length;
    h.rc.observer!.error(new Error("realtime api disabled")); await flush();
    expect(live.badge().live).toBe("polling");
    expect(live.badge().text).toMatch(/ polling$/);
    const fresh = h.timers.list.slice(before).filter((t) => !t.cancelled);
    expect(fresh.map((t) => t.ms)).toContain(43200000);
  });
  test("O12b observer complete -> polling as well; polling timer fires a fetchAndActivate", async () => {
    const { h, live } = boot({ mode: "dev" });
    await live.start(); h.reset();
    h.rc.observer!.complete(); await flush();
    expect(live.badge().live).toBe("polling");
    h.rc.values["kill_switch_cloud"] = "true";
    await h.timers.advance(60000);
    expect(h.rc.fetchCalls).toBeGreaterThanOrEqual(1);
    expect(live.current().cfg.kill_switch_cloud).toBe(true);
  });
  test("polling keeps repeating at the interval (no stall after the first tick)", async () => {
    const { h, live } = boot({ mode: "dev" });
    await live.start(); h.reset();
    h.rc.observer!.error(new Error("x")); await flush();
    await h.timers.advance(60000 * 3);
    expect(h.rc.fetchCalls).toBe(3);
  });
  test("O13 visibility: hidden then visible -> exactly one extra fetchAndActivate", async () => {
    const { h, live } = boot();
    await live.start(); h.reset();
    live.onVisibility(false); await flush();
    expect(h.rc.fetchCalls).toBe(0);
    live.onVisibility(true); await flush();
    expect(h.rc.fetchCalls).toBe(1);
  });
  test("O13b visible without a prior hidden does not refetch (neg)", async () => {
    const { h, live } = boot();
    await live.start(); h.reset();
    live.onVisibility(true); await flush();
    expect(h.rc.fetchCalls).toBe(0);
  });
  test("O13c visibility refetch applies changed values", async () => {
    const { h, live } = boot();
    await live.start(); h.reset();
    live.onVisibility(false);
    h.rc.values["kill_switch_cloud"] = "true";
    live.onVisibility(true); await flush();
    expect(live.current().cfg.kill_switch_cloud).toBe(true);
    expect(h.order).toEqual(["reconcile", "ai"]);
  });
  test("a rejected activate() inside a realtime update does not leak an unhandled rejection or advance the snapshot", async () => {
    const un: unknown[] = []; const on = (e: unknown) => { un.push(e); };
    process.on("unhandledRejection", on);
    try {
      const { h, live } = boot(); await live.start(); h.reset();
      h.rc.activateImpl = () => Promise.reject(new Error("activate failed"));
      await h.push({ kill_switch_cloud: "true" });
      await flush();
      expect(un).toEqual([]);
      expect(live.current().gen).toBe(0);
    } finally { process.off("unhandledRejection", on); }
  });
  test("overlapping fetches/updates never double-propagate the same config", async () => {
    const { h, live } = boot(); await live.start(); h.reset();
    h.rc.values["kill_switch_cloud"] = "true";
    h.rc.observer!.next(new Set(["kill_switch_cloud"]));
    h.rc.observer!.next(new Set(["kill_switch_cloud"]));
    live.onVisibility(false); live.onVisibility(true);
    await flush();
    expect(h.reconcileCalls).toHaveLength(1);
    expect(h.aiCalls).toHaveLength(1);
    expect(live.current().gen).toBe(1);
  });
});

describe("O14 sink_failure_isolated (B10)", () => {
  test("updateConfig throws on a kill flip: SINK_FAILED, applyConfig still runs, gen 1", async () => {
    const { h, live } = boot(); await live.start(); h.reset();
    h.sinks.reconcileThrows = true;
    const seen: ConfigWarning[] = [];
    live.subscribe((_s, w) => seen.push(...w));
    await h.push({ kill_switch_cloud: "true" });
    expect(h.aiCalls).toHaveLength(1);
    expect(live.current().gen).toBe(1);
    expect(seen.some((w) => w.code === "SINK_FAILED")).toBe(true);
  });
  test("applyConfig and governor throwing are isolated too", async () => {
    const { h, live } = boot(); await live.start(); h.reset();
    h.sinks.aiThrows = true;
    await h.push({ model_name: "gemini-z", governor_tier_override: "T1" });
    expect(h.govCalls).toEqual(["T1"]);
    expect(live.current().gen).toBe(1);
    h.sinks.aiThrows = false; h.sinks.govThrows = true;
    await h.push({ governor_tier_override: "T2" });
    expect(live.current().gen).toBe(2);
  });
  test("the failed sink is retried on the next change with the latest config", async () => {
    const { h, live } = boot(); await live.start(); h.reset();
    h.sinks.reconcileThrows = true;
    await h.push({ kill_switch_cloud: "true" });
    h.sinks.reconcileThrows = false;
    await h.push({ model_name: "gemini-z" });   // AI-only change
    const last = h.reconcileCalls[h.reconcileCalls.length - 1]!;
    expect(h.reconcileCalls.length).toBeGreaterThanOrEqual(2);
    expect(last.kill_switch_cloud).toBe(true);
  });
  test("a sink that returns a rejected promise does not leak an unhandled rejection", async () => {
    const un: unknown[] = []; const on = (e: unknown) => { un.push(e); };
    process.on("unhandledRejection", on);
    try {
      const { h, live } = boot();
      (h.deps.reconcile as { updateConfig: (c: unknown) => unknown }).updateConfig = () => Promise.reject(new Error("async boom"));
      await live.start();
      await h.push({ kill_switch_cloud: "true" }); await flush();
      expect(un).toEqual([]);
      expect(live.current().gen).toBe(1);
    } finally { process.off("unhandledRejection", on); }
  });
});

describe("O15 dispose (B16)", () => {
  test("dispose unsubscribes, ignores later callbacks, cancels timers", async () => {
    const { h, live } = boot(); await live.start(); h.reset();
    const obs = h.rc.observer!;
    live.dispose();
    expect(h.rc.unsubCalls).toBe(1);
    h.rc.values["kill_switch_cloud"] = "true";
    obs.next(new Set(["kill_switch_cloud"])); await flush();
    expect(h.order).toEqual([]);
    expect(h.rc.activateCalls).toBe(0);
    expect(live.current().gen).toBe(0);
    expect(h.timers.live()).toEqual([]);
  });
  test("dispose cancels pending throttle timers and a late fetch resolution does not call sinks", async () => {
    const h = makeHarness();
    let release!: (v: boolean) => void;
    h.rc.fetchImpl = () => new Promise<boolean>((r) => { release = r; });
    const live = createLiveConfig(h.deps); lives.push(live);
    const started = live.start();
    await flush();
    live.dispose();
    h.rc.values["kill_switch_cloud"] = "true";
    release(true); await started.catch(() => undefined); await flush();
    expect(h.order).toEqual([]);
    expect(h.timers.live()).toEqual([]);
  });
  test("dispose is idempotent and visibility after dispose is inert", async () => {
    const { h, live } = boot(); await live.start(); h.reset();
    live.dispose(); expect(() => live.dispose()).not.toThrow();
    live.onVisibility(false); live.onVisibility(true); await flush();
    expect(h.rc.fetchCalls).toBe(0);
    expect(h.rc.unsubCalls).toBe(1);
  });
  test("purity: no logging (B16)", async () => {
    const logs: unknown[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    console.log = console.warn = console.error = console.info = (...a: unknown[]) => { logs.push(a); };
    try {
      const { h, live } = boot(); await live.start();
      await h.push({ max_output_tokens: "99999", kill_switch_cloud: "maybe" });
      h.rc.observer!.error(new Error("x")); await flush();
    } finally { Object.assign(console, orig); }
    expect(logs).toEqual([]);
  });
});
