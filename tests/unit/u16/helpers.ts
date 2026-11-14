// Oracle helpers for U16: independent references and DI fakes. Never import the unit under test for expected values.
import type { AiConfig } from "../../../src/ai/types";
import type { ReconcileConfig } from "../../../src/reconcile/types";
import type { RemoteConfigPort, WallConfig, LiveConfigDeps } from "../../../src/config/types";

export function refFnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 0).toString(16).padStart(8, "0");
}
export function refCanon(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(refCanon).join(",") + "]";
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + refCanon(o[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

/** Independent copy of the spec default table (SPEC_U16 keys + AMEND_C B26 + inference_timeout_ms 120000). */
export const REF_DEFAULTS: WallConfig = {
  mode_status: "PREFER_ON_DEVICE", mode_summary: "PREFER_ON_DEVICE", mode_next_action: "PREFER_ON_DEVICE",
  mode_screenshot: "ONLY_ON_DEVICE", mode_digest: "PREFER_IN_CLOUD",
  mode_plan: "PREFER_ON_DEVICE", mode_template: "PREFER_ON_DEVICE",
  max_output_tokens: 200, ondevice_max_input_tokens: 7300, prompt_version: "v1", model_name: "gemini-3.5-flash-lite",
  kill_switch_cloud: false, ondevice_concurrency: 1, cloud_concurrency: 2,
  min_inference_interval_ms: 20000, queue_max_depth_factor: 2, inference_timeout_ms: 120000,
  max_patches_per_frame: 8, frame_js_budget_ms: 4, governor_tier_override: "none",
};
export const ALL_KEYS = Object.keys(REF_DEFAULTS).sort();
export const AI_KEYS = ["mode_status", "mode_summary", "mode_next_action", "mode_screenshot", "mode_digest",
  "max_output_tokens", "ondevice_max_input_tokens", "prompt_version", "model_name", "kill_switch_cloud"].sort();
export const RECONCILE_KEYS = ["ondevice_concurrency", "cloud_concurrency", "min_inference_interval_ms",
  "queue_max_depth_factor", "prompt_version", "kill_switch_cloud", "mode_status", "mode_summary",
  "mode_next_action", "mode_screenshot", "inference_timeout_ms"].sort();

export const flush = async (n = 8): Promise<void> => { for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0)); };

export function defaultStrings(): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(REF_DEFAULTS)) o[k] = String(v);
  return o;
}

export interface TimerEntry { ms: number; at: number; fn: () => void; cancelled: boolean; fired: boolean }
export function makeTimers(start = 1_000_000) {
  let t = start;
  const list: TimerEntry[] = [];
  return {
    list,
    now: () => t,
    setTimer(ms: number, fn: () => void): () => void {
      const e: TimerEntry = { ms, at: t + ms, fn, cancelled: false, fired: false };
      list.push(e);
      return () => { e.cancelled = true; };
    },
    live: () => list.filter((e) => !e.cancelled && !e.fired),
    async advance(ms: number): Promise<void> {
      const target = t + ms;
      for (;;) {
        const due = list.filter((e) => !e.cancelled && !e.fired && e.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = Math.max(t, due.at); due.fired = true; due.fn(); await flush();
      }
      t = target;
    },
    /** fire the earliest live timer regardless of its delay */
    async fireNext(): Promise<void> {
      const due = list.filter((e) => !e.cancelled && !e.fired).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      t = Math.max(t, due.at); due.fired = true; due.fn(); await flush();
    },
  };
}

export interface Observer { next(k: ReadonlySet<string>): void; error(e: unknown): void; complete(): void }
export function makeRc() {
  const rc = {
    values: {} as Record<string, string>,
    defaults: null as Record<string, string> | null,
    minFetch: null as number | null,
    log: [] as string[],
    fetchCalls: 0, activateCalls: 0, unsubCalls: 0,
    observer: null as Observer | null,
    subscribeCalls: 0,
    fetchImpl: (): Promise<boolean> => Promise.resolve(true),
    activateImpl: (): Promise<boolean> => Promise.resolve(true),
    getStringThrows: new Set<string>(),
    port: null as unknown as RemoteConfigPort,
  };
  rc.port = {
    setDefaults(d) { rc.log.push("setDefaults"); rc.defaults = { ...d }; },
    setMinimumFetchIntervalMillis(ms) { rc.log.push("setMin"); rc.minFetch = ms; },
    fetchAndActivate() { rc.log.push("fetch"); rc.fetchCalls++; return rc.fetchImpl(); },
    activate() { rc.log.push("activate"); rc.activateCalls++; return rc.activateImpl(); },
    getString(k) {
      if (rc.getStringThrows.has(k)) throw new Error("rc boom " + k);
      if (Object.hasOwn(rc.values, k)) return rc.values[k] as string;
      return rc.defaults?.[k] ?? "";
    },
    onConfigUpdate(o) {
      rc.log.push("subscribe"); rc.subscribeCalls++; rc.observer = o;
      return () => { rc.unsubCalls++; };
    },
  };
  return rc;
}

export function makeHarness(opts: { mode?: "dev" | "prod"; withGovernor?: boolean } = {}) {
  const rc = makeRc();
  const timers = makeTimers();
  const order: string[] = [];
  const reconcileCalls: ReconcileConfig[] = [];
  const aiCalls: Partial<AiConfig>[] = [];
  const govCalls: Array<string | null> = [];
  const sinks = { reconcileThrows: false, aiThrows: false, govThrows: false };
  const deps: LiveConfigDeps = {
    rc: rc.port,
    ai: { applyConfig(c) { order.push("ai"); aiCalls.push(c); if (sinks.aiThrows) throw new Error("ai boom"); return { configGen: aiCalls.length, warnings: [] }; } },
    reconcile: { updateConfig(c) { order.push("reconcile"); reconcileCalls.push(c); if (sinks.reconcileThrows) throw new Error("rec boom"); } },
    timers,
    mode: opts.mode ?? "prod",
    ...(opts.withGovernor === false ? {} : { governor: { setOverride(t: string | null) { order.push("gov"); govCalls.push(t); if (sinks.govThrows) throw new Error("gov boom"); } } } as object),
  } as LiveConfigDeps;
  return {
    rc, timers, order, reconcileCalls, aiCalls, govCalls, sinks, deps,
    /** clears sink/rc logs so assertions look only at post-start behaviour */
    reset() { order.length = 0; reconcileCalls.length = 0; aiCalls.length = 0; govCalls.length = 0; rc.log.length = 0; rc.fetchCalls = 0; rc.activateCalls = 0; rc.unsubCalls = 0; },
    /** simulate a real-time push of the given remote values */
    async push(vals: Record<string, string>, keys?: string[]): Promise<void> {
      Object.assign(rc.values, vals);
      rc.observer!.next(new Set(keys ?? Object.keys(vals)));
      await flush();
    },
  };
}
export type Harness = ReturnType<typeof makeHarness>;
