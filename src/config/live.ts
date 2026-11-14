import { configHash } from "./hash";
import { CONFIG_DEFAULTS, KEY_SPECS } from "./keys";
import { parseRemote, toAiConfig, toReconcileConfig } from "./parse";
import type {
  ConfigSnapshot,
  ConfigWarning,
  LiveConfig,
  LiveConfigDeps,
  LiveState,
  WallConfig,
} from "./types";

const MIN_DEV = 60000;
const MIN_PROD = 43200000;
const THROTTLE_BASE = 60000;
const THROTTLE_CAP = 3600000;

const ALL_KEYS = Object.keys(KEY_SPECS);

const RECONCILE_SET: ReadonlySet<string> = new Set([
  "ondevice_concurrency",
  "cloud_concurrency",
  "min_inference_interval_ms",
  "queue_max_depth_factor",
  "prompt_version",
  "kill_switch_cloud",
  "mode_status",
  "mode_summary",
  "mode_next_action",
  "mode_screenshot",
  "inference_timeout_ms",
]);

const AI_SET: ReadonlySet<string> = new Set([
  "mode_status",
  "mode_summary",
  "mode_next_action",
  "mode_screenshot",
  "mode_digest",
  "max_output_tokens",
  "ondevice_max_input_tokens",
  "prompt_version",
  "model_name",
  "kill_switch_cloud",
]);

function isThrottleError(e: unknown): boolean {
  try {
    if (typeof e === "string") return e.includes("FETCH_THROTTLE");
    if (e instanceof Error) return e.message.includes("FETCH_THROTTLE");
    if (e !== null && typeof e === "object") {
      const m = (e as { message?: unknown }).message;
      if (typeof m === "string") return m.includes("FETCH_THROTTLE");
    }
    return false;
  } catch {
    return false;
  }
}

function isThenable(v: unknown): boolean {
  return (
    v !== null &&
    (typeof v === "object" || typeof v === "function") &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

export function createLiveConfig(deps: LiveConfigDeps): LiveConfig {
  let snap: ConfigSnapshot = {
    cfg: Object.freeze({ ...CONFIG_DEFAULTS }),
    gen: 0,
    hash: configHash(CONFIG_DEFAULTS),
    activatedAt: null,
  };
  let liveState: LiveState = "defaults";
  let throttleAttempts = 0;
  let disposed = false;
  let started = false;
  let wasHidden = false;
  let realtimeActive = false;
  let failedReconcile = false;
  let failedAi = false;
  let failedGovernor = false;
  let cancelTimer: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  const subscribers = new Set<
    (s: ConfigSnapshot, w: readonly ConfigWarning[]) => void
  >();

  const minInterval = (): number => (deps.mode === "dev" ? MIN_DEV : MIN_PROD);

  function notify(warnings: readonly ConfigWarning[]): void {
    if (disposed) return;
    for (const fn of [...subscribers]) {
      try {
        fn(snap, warnings);
      } catch {
        // Listener errors never propagate.
      }
    }
  }

  function cancelPending(): void {
    if (cancelTimer !== null) {
      const c = cancelTimer;
      cancelTimer = null;
      try {
        c();
      } catch {
        // Ignore timer teardown errors.
      }
    }
  }

  function scheduleTimer(ms: number, fn: () => void): void {
    cancelPending();
    if (disposed) return;
    const cancel = deps.timers.setTimer(ms, () => {
      cancelTimer = null;
      if (disposed) return;
      fn();
    });
    cancelTimer = cancel;
  }

  function schedulePolling(ms: number): void {
    scheduleTimer(ms, () => {
      void doFetchAndApply().catch(() => undefined);
    });
  }

  function scheduleThrottle(): void {
    throttleAttempts++;
    const delay = Math.min(THROTTLE_BASE * 2 ** (throttleAttempts - 1), THROTTLE_CAP);
    scheduleTimer(delay, () => {
      void doFetchAndApply().catch(() => undefined);
    });
  }

  function callSink(
    key: string,
    fn: () => void,
    markFailed: (failed: boolean) => void,
  ): ConfigWarning | null {
    try {
      const res = fn() as unknown;
      if (isThenable(res)) {
        Promise.resolve(res as Promise<unknown>).catch(() => {
          markFailed(true);
          if (!disposed) notify([{ key, code: "SINK_FAILED" }]);
        });
      }
      return null;
    } catch {
      markFailed(true);
      return { key, code: "SINK_FAILED" };
    }
  }

  function propagate(newCfg: WallConfig, parseWarnings: readonly ConfigWarning[]): boolean {
    if (disposed) return false;
    const newHash = configHash(newCfg);
    if (newHash === snap.hash) return false;
    const oldCfg = snap.cfg;
    const changed = new Set<string>();
    for (const k of ALL_KEYS) {
      if ((newCfg as unknown as Record<string, unknown>)[k] !== (oldCfg as unknown as Record<string, unknown>)[k]) {
        changed.add(k);
      }
    }
    const needReconcile = failedReconcile || [...changed].some((k) => RECONCILE_SET.has(k));
    const needAi = failedAi || [...changed].some((k) => AI_SET.has(k));
    const needGov =
      deps.governor !== undefined &&
      (failedGovernor || changed.has("governor_tier_override"));
    const warnings: ConfigWarning[] = [...parseWarnings];
    if (needReconcile) {
      const w = callSink("reconcile", () => deps.reconcile.updateConfig(toReconcileConfig(newCfg)), (f) => { failedReconcile = f; });
      if (w !== null) {
        warnings.push(w);
      } else if (failedReconcile) {
        failedReconcile = false;
      }
      if (!failedReconcile) failedReconcile = false;
    }
    if (needAi) {
      const w = callSink("ai", () => { deps.ai.applyConfig(toAiConfig(newCfg)); }, (f) => { failedAi = f; });
      if (w !== null) {
        warnings.push(w);
      } else if (failedAi) {
        failedAi = false;
      }
      if (!failedAi) failedAi = false;
    }
    if (needGov && deps.governor !== undefined) {
      const governor = deps.governor;
      const v = newCfg.governor_tier_override;
      const w = callSink("governor", () => governor.setOverride(v === "none" ? null : v), (f) => { failedGovernor = f; });
      if (w !== null) {
        warnings.push(w);
      } else if (failedGovernor) {
        failedGovernor = false;
      }
      if (!failedGovernor) failedGovernor = false;
    }
    const frozen: Readonly<WallConfig> = Object.freeze({ ...newCfg });
    snap = {
      cfg: frozen,
      gen: snap.gen + 1,
      hash: newHash,
      activatedAt: deps.timers.now(),
    };
    notify(Object.freeze([...warnings]));
    return true;
  }

  function applyCurrentRemote(): boolean {
    if (disposed) return false;
    const { cfg, warnings } = parseRemote((k) => deps.rc.getString(k), snap.cfg);
    return propagate(cfg, warnings);
  }

  async function fetchOnce(): Promise<"ok" | "throttle" | "failed" | "disposed"> {
    if (disposed) return "disposed";
    try {
      await deps.rc.fetchAndActivate();
    } catch (e) {
      if (disposed) return "disposed";
      return isThrottleError(e) ? "throttle" : "failed";
    }
    if (disposed) return "disposed";
    return "ok";
  }

  async function doFetchAndApply(): Promise<void> {
    if (disposed) return;
    const outcome = await fetchOnce();
    if (disposed || outcome === "disposed") return;
    if (outcome === "throttle") {
      liveState = "throttled";
      scheduleThrottle();
      return;
    }
    if (outcome === "failed") {
      if (liveState === "throttled") liveState = "polling";
      schedulePolling(minInterval());
      return;
    }
    throttleAttempts = 0;
    if (liveState === "throttled") {
      liveState = realtimeActive ? "realtime" : "polling";
    }
    applyCurrentRemote();
    if (liveState === "polling") {
      schedulePolling(minInterval());
    }
  }

  async function activateThenApply(): Promise<void> {
    try {
      const p = deps.rc.activate() as unknown;
      if (isThenable(p)) await (p as Promise<unknown>);
    } catch {
      return;
    }
    if (disposed) return;
    if (applyCurrentRemote()) {
      liveState = "realtime";
    }
  }

  const handlers = {
    next(updatedKeys: ReadonlySet<string>): void {
      if (disposed) return;
      let relevant = false;
      for (const k of updatedKeys) {
        if (Object.hasOwn(KEY_SPECS, k)) {
          relevant = true;
          break;
        }
      }
      if (!relevant) return;
      activateThenApply().catch(() => undefined);
    },
    error(): void {
      if (disposed) return;
      liveState = "polling";
      realtimeActive = false;
      schedulePolling(minInterval());
    },
    complete(): void {
      if (disposed) return;
      liveState = "polling";
      realtimeActive = false;
      schedulePolling(minInterval());
    },
  };

  return {
    async start(): Promise<ConfigSnapshot> {
      if (started) return snap;
      started = true;
      try {
        const strings: Record<string, string> = {};
        for (const k of ALL_KEYS) strings[k] = String(CONFIG_DEFAULTS[k as keyof WallConfig]);
        try {
          deps.rc.setDefaults(strings);
        } catch {
          // Defaults seeding failure is tolerated; start must still resolve.
        }
        try {
          deps.rc.setMinimumFetchIntervalMillis(minInterval());
        } catch {
          // Interval configuration failure is tolerated.
        }
        try {
          unsubscribe = deps.rc.onConfigUpdate(handlers);
          realtimeActive = true;
        } catch {
          unsubscribe = null;
          realtimeActive = false;
          liveState = "polling";
          schedulePolling(minInterval());
        }
        try {
          await doFetchAndApply();
        } catch {
          // Fetch failures never reject start.
        }
      } catch {
        // start never rejects.
      }
      return snap;
    },
    current(): ConfigSnapshot {
      return snap;
    },
    badge() {
      const text =
        `cfg ${snap.cfg.prompt_version} g${snap.gen} ${snap.hash} ${liveState}` +
        (snap.cfg.kill_switch_cloud ? " cloud-off" : "");
      return {
        text: text.slice(0, 64),
        gen: snap.gen,
        hash: snap.hash,
        promptVersion: snap.cfg.prompt_version,
        cloudOff: snap.cfg.kill_switch_cloud,
        live: liveState,
      };
    },
    subscribe(fn: (s: ConfigSnapshot, w: readonly ConfigWarning[]) => void): () => void {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    onVisibility(visible: boolean): void {
      if (disposed) return;
      if (!visible) {
        wasHidden = true;
        return;
      }
      if (!wasHidden) return;
      wasHidden = false;
      doFetchAndApply().catch(() => undefined);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelPending();
      if (unsubscribe !== null) {
        const u = unsubscribe;
        unsubscribe = null;
        try {
          u();
        } catch {
          // Teardown errors are swallowed.
        }
      }
    },
  };
}
