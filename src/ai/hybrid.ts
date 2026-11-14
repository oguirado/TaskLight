import { TASK_SCHEMAS, validateTaskOutput } from "../schema";
import type { TaskId, PrivacyTier, ValidateCtx } from "../schema";
import { parseConfig, resolveMode } from "./config";
import { HostForbiddenError } from "./types";
import type { AiConfig, AiErrorCode, DeviceStatus, Hybrid, HybridParamsShape, ModelFactory, ModelHandle,
  ModeName, RunMeta, SdkPart, TaskRequest, TaskResult, ImagePart } from "./types";

export { HostForbiddenError } from "./types";

const TASKS: readonly TaskId[] = ["status", "summary", "next_action", "screenshot", "digest"];
const ALLOWED_MIMES: readonly string[] = ["image/png", "image/jpeg"];

function clampProgress(p: number): number {
  if (!Number.isFinite(p)) return 0;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}
function errMessage(e: unknown): string {
  try {
    if (e instanceof Error) {
      try { return e.message; } catch { return "SDK error"; }
    }
    if (typeof e === "string") return e;
    if (typeof e === "object" && e !== null) {
      let m: unknown;
      try { m = (e as { message?: unknown }).message; } catch { return "SDK error"; }
      if (typeof m === "string") return m;
    }
    try { return String(e); } catch { return "SDK error"; }
  } catch { return "SDK error"; }
}
function isFallback(mode: ModeName, source: "ON_DEVICE" | "IN_CLOUD"): boolean {
  return (mode === "PREFER_ON_DEVICE" && source === "IN_CLOUD")
    || (mode === "PREFER_IN_CLOUD" && source === "ON_DEVICE");
}

export function createHybrid(deps: {
  factory: ModelFactory; origin: string; appCheckReady: boolean; config?: Partial<AiConfig>;
}): Hybrid {
  const factory: ModelFactory = deps.factory;
  if (deps.origin.startsWith("chrome-extension://") || deps.appCheckReady !== true) {
    throw new HostForbiddenError("host forbidden");
  }
  let cfg: AiConfig = parseConfig((deps.config ?? {}) as unknown as Record<string, unknown>).cfg;
  let configGen = 0;
  let status: DeviceStatus = { state: "not_initialised" };
  let attemptSeq = 0;
  const readyHandles = new Set<ModelHandle>();
  // Retired-callback ownership: liveInitAttempt names the only initDevice
  // attempt whose progress callbacks may still mutate status. It is null once
  // that attempt settles or is superseded, so late progress is ignored.
  let liveInitAttempt: number | null = null;
  // Attempt number of the pending automatic re-init started by applyConfig
  // while the device was ready, or null when no auto re-init is in flight.
  // Distinguishes auto re-init "downloading" (repeat rebuilds must re-init
  // again) from gesture-initiated "downloading" (applyConfig abandons it).
  let autoReinitAttempt: number | null = null;
  // Lazy private initialisation bookkeeping. `status` above tracks the five
  // main handles (gesture-initialised via initDevice / auto re-init via
  // applyConfig). A lazily built private handle initialises outside both of
  // those paths, so its pending/failed state is tracked separately and
  // merged into deviceStatus(): while a current lazy initialisation is
  // pending the exposed status is non-ready (downloading), and when the
  // last in-flight lazy initialisation fails the exposed status is failed.
  // Counters are reset by initDevice and applyConfig, and stale lazy
  // settlements (superseded by either) never touch them.
  let lazyPending = 0;
  let lazyFailedDetail: string | null = null;
  // Exposed readiness: base status, unless a lazy private initialisation is
  // pending (download in flight) or the last one failed while the base
  // device is ready.
  const effectiveStatus = (): DeviceStatus => {
    if (status.state === "downloading") return status;
    if (lazyPending > 0) return { state: "downloading", progress: 0 };
    if (lazyFailedDetail !== null && status.state === "ready") return { state: "failed", detail: lazyFailedDetail };
    return status;
  };

  const buildParams = (task: TaskId, mode: ModeName, cfgToUse: AiConfig): HybridParamsShape => {
    const sch = TASK_SCHEMAS[task];
    return {
      mode: factory.modeConst(mode),
      inCloudParams: {
        model: cfgToUse.model_name,
        generationConfig: {
          responseMimeType: sch.mimeType,
          responseSchema: sch.schema,
          maxOutputTokens: cfgToUse.max_output_tokens,
        },
      },
      onDeviceParams: { promptOptions: { responseConstraint: sch.schema } },
    };
  };
  const buildAll = (cfgToUse: AiConfig): Record<TaskId, ModelHandle> => {
    const out = {} as Record<TaskId, ModelHandle>;
    for (const t of TASKS) {
      const mode = resolveMode(t, "standard", cfgToUse);
      out[t] = factory.create(buildParams(t, mode, cfgToUse));
    }
    return out;
  };
  let handles: Record<TaskId, ModelHandle> = buildAll(cfg);
  const privateHandles = new Map<TaskId, ModelHandle>();
  const privateHandle = (task: TaskId, cfgToUse: AiConfig): ModelHandle => {
    const existing = privateHandles.get(task);
    if (existing) return existing;
    const h = factory.create(buildParams(task, "ONLY_ON_DEVICE", cfgToUse));
    privateHandles.set(task, h);
    return h;
  };

  const currentHandles = (): ModelHandle[] => {
    const list: ModelHandle[] = TASKS.map((t) => handles[t]);
    for (const h of privateHandles.values()) list.push(h);
    return list;
  };

  async function run<K extends TaskId>(req: TaskRequest<K>): Promise<TaskResult<K>> {
    // B18: run never rejects. Safe failure metadata is prepared before
    // touching any caller-controlled property; all request reads follow
    // inside the outer exception boundary, so a throwing getter, a throwing
    // iterator, or a thrown ctx copy resolves with SDK_ERROR and
    // meta.called=false instead of rejecting.
    let snapTask = "summary" as K;
    let snapTier: PrivacyTier = "standard";
    let snapPrompt = "";
    let snapImage: { mimeType: string; data: string } | undefined;
    let origCtx: ValidateCtx | undefined;
    let origCtxKnownRef: ReadonlySet<string> | undefined;
    let origSetCopy: Set<string> | null = null;
    let snapCtxSnapshot: ValidateCtx | undefined;
    // Helper to get insulated ctx for validation: if caller mutated the
    // set/ctx during suspension, use snapshot copy; otherwise preserve
    // original reference so identity expectations hold.
    const insulatedCtx = (): ValidateCtx | undefined => {
      if (origCtx === undefined) return undefined;
      // If caller replaced req.ctx object entirely, use snapshot.
      if (req.ctx !== origCtx) return snapCtxSnapshot;
      // Caller may mutate the same ctx object in place during suspension.
      // Snapshot membership decides: any late-added, removed or replaced
      // knownProjectIds (including a Set added where none existed) uses
      // the snapshot, never the mutated caller value.
      const curSet =
        (origCtx as { knownProjectIds?: ReadonlySet<string> | undefined }).knownProjectIds;
      if (origSetCopy === null) {
        if (curSet !== undefined) return snapCtxSnapshot;
        return origCtx;
      }
      if (curSet === undefined || curSet !== origCtxKnownRef) return snapCtxSnapshot;
      // Same Set reference: check content equality
      if (curSet.size !== origSetCopy.size) return snapCtxSnapshot;
      for (const v of origSetCopy) if (!curSet.has(v)) return snapCtxSnapshot;
      return origCtx;
    };
    let snapConfigGen: number = configGen;
    let snapAttempt: number = attemptSeq;
    let snapPromptVersion: string = cfg.prompt_version;
    let snapMode: ModeName = "PREFER_ON_DEVICE";
    let called = false;
    const fallbackMeta = (): RunMeta => ({
      task: snapTask, mode: snapMode, configGen: snapConfigGen,
      prompt_version: snapPromptVersion, called,
    });
    try {
      // Snapshot all validated request inputs before any suspension point.
      // The caller may mutate the request object (task, projectId, tier,
      // prompt, image primitives, ctx sets) after calling run; the snapshot
      // insulates the validated values used for SDK arguments, meta and
      // validation. Caller data is never mutated by run. Reading these
      // properties may throw (accessors, iterator); the outer catch maps
      // that to SDK_ERROR with called=false (B18).
      snapTask = req.task as K;
      void req.projectId;
      snapTier = req.tier;
      snapPrompt = req.prompt;
      if (req.image !== undefined) {
        snapImage = { mimeType: req.image.mimeType, data: req.image.data };
      }
      origCtx = req.ctx;
      origCtxKnownRef = (origCtx as { knownProjectIds?: ReadonlySet<string> | undefined } | undefined)?.knownProjectIds;
      if (origCtxKnownRef !== undefined) {
        origSetCopy = new Set<string>(origCtxKnownRef as Iterable<string>);
      }
      if (origCtx !== undefined) {
        if (origSetCopy !== null) {
          snapCtxSnapshot = { knownProjectIds: new Set<string>(origSetCopy) };
        } else {
          snapCtxSnapshot = {};
        }
      }
      const cfgSnap: AiConfig = cfg;
      snapConfigGen = configGen;
      snapAttempt = attemptSeq;
      snapPromptVersion = cfgSnap.prompt_version;
      snapMode = resolveMode(snapTask, snapTier, cfgSnap);
      const meta = (c: boolean): RunMeta => ({
        task: snapTask, mode: snapMode, configGen: snapConfigGen,
        prompt_version: snapPromptVersion, called: c,
      });
      if (snapPrompt.length > cfgSnap.ondevice_max_input_tokens) {
        return { ok: false, code: "INPUT_OVER_BUDGET", fallback: false, meta: meta(false) };
      }
      const image: { mimeType: string; data: string } | undefined = snapImage;
      const badImage = (snapTask !== "screenshot" && image !== undefined)
        || (snapTask === "screenshot" && image === undefined)
        || (image !== undefined && !ALLOWED_MIMES.includes(image.mimeType));
      if (badImage) {
        return { ok: false, code: "INPUT_REJECTED", fallback: false, meta: meta(false) };
      }
      if (snapMode === "ONLY_ON_DEVICE") {
        // One device-only admission rule for every tier, private included:
        // nothing serves while the exposed device is not ready, whether the
        // pendency is a base download, a lazy private download, or a failed
        // last download. A cached private handle is admitted by exactly this
        // rule and cannot bypass another current initialization.
        if (effectiveStatus().state !== "ready") {
          return { ok: false, code: "DEVICE_NOT_INITIALISED", fallback: false, meta: meta(false) };
        }
      }
      let handle: ModelHandle;
      if (snapTier === "private") {
        const existing = privateHandles.get(snapTask);
        let fresh = false;
        if (existing !== undefined) {
          handle = existing;
        } else {
          try {
            handle = privateHandle(snapTask, cfgSnap);
            fresh = true;
          } catch (e) {
            return { ok: false, code: "SDK_ERROR", fallback: false, detail: errMessage(e), meta: meta(false) };
          }
        }
        if (!readyHandles.has(handle)) {
          if (!fresh) {
            return { ok: false, code: "DEVICE_NOT_INITIALISED", fallback: false, meta: meta(false) };
          }
          const lazyAttempt = attemptSeq;
          const lazyGen = snapConfigGen;
          const isCurrent = (): boolean =>
            attemptSeq === lazyAttempt && configGen === lazyGen && privateHandles.get(snapTask) === handle;
          lazyPending += 1;
          lazyFailedDetail = null;
          const settleSuccess = (): void => {
            if (!isCurrent()) return;
            lazyPending = Math.max(0, lazyPending - 1);
            readyHandles.add(handle);
          };
          const settleFailure = (reason: unknown): void => {
            if (!isCurrent()) return;
            lazyPending = Math.max(0, lazyPending - 1);
            lazyFailedDetail = errMessage(reason);
            privateHandles.delete(snapTask);
            readyHandles.delete(handle);
          };
          try {
            void handle.initializeDeviceModel().then(
              () => {
                settleSuccess();
              },
              (e) => {
                settleFailure(e);
              },
            );
          } catch (e) {
            settleFailure(e);
            return { ok: false, code: "DEVICE_NOT_INITIALISED", fallback: false, meta: meta(false) };
          }
          await Promise.resolve();
          await Promise.resolve();
          // Revalidate after the lazy-path awaits, immediately before
          // generation: the run must still own the same configuration, the
          // same initialization attempt and the same serving handle, the
          // exposed device must still be ready, and the handle must still
          // be marked ready. A new initDevice/applyConfig boundary crossed
          // during the awaits changes attemptSeq/configGen/handle ownership,
          // so the request returns DEVICE_NOT_INITIALISED instead of
          // generating on a stale readiness entry.
          if (!isCurrent() || !readyHandles.has(handle) || effectiveStatus().state !== "ready") {
            return { ok: false, code: "DEVICE_NOT_INITIALISED", fallback: false, meta: meta(false) };
          }
        }
      } else {
        handle = handles[snapTask];
        if (snapMode === "ONLY_ON_DEVICE" && !readyHandles.has(handle)) {
          return { ok: false, code: "DEVICE_NOT_INITIALISED", fallback: false, meta: meta(false) };
        }
      }
      // General pre-generation gate on the device-only path. Any await that
      // happened while selecting and initialising the serving handle (the
      // lazy private path above) may have crossed an initDevice/applyConfig
      // boundary; re-check ownership and exposed readiness here so no code
      // path can generate on stale readiness immediately before the call.
      if (snapMode === "ONLY_ON_DEVICE") {
        const stillServing = snapTier === "private"
          ? privateHandles.get(snapTask) === handle
          : handles[snapTask] === handle;
        if (configGen !== snapConfigGen || attemptSeq !== snapAttempt || !stillServing
          || effectiveStatus().state !== "ready" || !readyHandles.has(handle)) {
          return { ok: false, code: "DEVICE_NOT_INITIALISED", fallback: false, meta: meta(false) };
        }
      }
      const callArg: string | SdkPart[] = image !== undefined
        ? [snapPrompt, { inlineData: { data: image.data, mimeType: image.mimeType } }]
        : snapPrompt;
      let result: { response: { text(): string; inferenceSource?: unknown } };
      try {
        called = true;
        result = await handle.generateContent(callArg);
      } catch (e) {
        const msg = errMessage(e);
        let code: AiErrorCode;
        if (msg.includes("PERMISSION_DENIED")) code = "APP_CHECK_REJECTED";
        else if (snapMode === "ONLY_ON_DEVICE") code = "ON_DEVICE_UNAVAILABLE";
        else if (snapMode === "ONLY_IN_CLOUD") code = "CLOUD_UNAVAILABLE";
        else code = "SDK_ERROR";
        const taskKey = `mode_${snapTask}` as const;
        const configured: unknown = (cfgSnap as unknown as Record<string, unknown>)[taskKey];
        if (cfgSnap.kill_switch_cloud === true && configured === "ONLY_IN_CLOUD") {
          return { ok: false, code, fallback: false, detail: "CLOUD_DISABLED", meta: meta(true) };
        }
        return { ok: false, code, fallback: false, meta: meta(true) };
      }
      let raw: unknown;
      try {
        const response: unknown = (result as { response?: unknown }).response;
        if (response === undefined || response === null) {
          return { ok: false, code: "SDK_ERROR", fallback: false, meta: meta(true) };
        }
        raw = (response as { inferenceSource?: unknown }).inferenceSource;
      } catch {
        return { ok: false, code: "SDK_ERROR", fallback: false, meta: meta(true) };
      }
      let source: "ON_DEVICE" | "IN_CLOUD";
      if (raw === factory.sourceConst.ON_DEVICE) source = "ON_DEVICE";
      else if (raw === factory.sourceConst.IN_CLOUD) source = "IN_CLOUD";
      else return { ok: false, code: "BAD_SOURCE", fallback: false, meta: meta(true) };
      if (snapMode === "ONLY_ON_DEVICE" && source === "IN_CLOUD") {
        return { ok: false, code: "PRIVACY_VIOLATION", source, fallback: false, meta: meta(true) };
      }
      let text: string;
      try {
        text = result.response.text();
      } catch {
        return { ok: false, code: "SDK_ERROR", source, fallback: isFallback(snapMode, source), meta: meta(true) };
      }
      let validated;
      try {
        validated = validateTaskOutput(snapTask, text, insulatedCtx());
      } catch {
        return { ok: false, code: "SDK_ERROR", source, fallback: isFallback(snapMode, source), meta: meta(true) };
      }
      if (!validated.ok) {
        return { ok: false, code: "SCHEMA_REJECT", source, rejects: validated.errors, fallback: isFallback(snapMode, source), meta: meta(true) };
      }
      return {
        ok: true,
        value: validated.value,
        source,
        fallback: isFallback(snapMode, source),
        meta: meta(true),
      };
    } catch {
      return { ok: false, code: "SDK_ERROR", fallback: false, meta: fallbackMeta() };
    }
  }

  async function initDevice(onProgress?: (p: number) => void): Promise<DeviceStatus> {
    const attempt: number = ++attemptSeq;
    liveInitAttempt = attempt;
    autoReinitAttempt = null;
    lazyPending = 0;
    lazyFailedDetail = null;
    const list = currentHandles();
    const progresses: number[] = list.map(() => 0);
    status = { state: "downloading", progress: 0 };
    let failedDetail: string | null = null;
    const noteFailure = (reason: unknown): void => {
      if (attempt !== attemptSeq || failedDetail !== null) return;
      failedDetail = errMessage(reason);
      status = { state: "failed", detail: failedDetail };
    };
    const promises: Promise<void>[] = list.map((h, i) => {
      try {
        return h.initializeDeviceModel((p: number) => {
          if (attempt !== attemptSeq || attempt !== liveInitAttempt) return;
          if (failedDetail !== null) return;
          progresses[i] = clampProgress(p);
          let m = 1;
          for (const v of progresses) if (v < m) m = v;
          status = { state: "downloading", progress: m };
          if (onProgress) {
            try { onProgress(m); } catch { return; }
          }
        }).then(
          () => {
            if (attempt === attemptSeq) readyHandles.add(h);
          },
          (e: unknown) => {
            noteFailure(e);
            throw e;
          },
        );
      } catch (e) {
        noteFailure(e);
        return Promise.reject(e);
      }
    });
    const settled = await Promise.allSettled(promises);
    if (attempt !== attemptSeq) {
      return status;
    }
    liveInitAttempt = null;
    if (failedDetail !== null) {
      status = { state: "failed", detail: failedDetail };
    } else {
      const failed = settled.find((s) => s.status === "rejected");
      if (failed && failed.status === "rejected") {
        status = { state: "failed", detail: errMessage(failed.reason) };
      } else {
        status = { state: "ready" };
      }
    }
    return status;
  }

  function applyConfig(patch: Partial<AiConfig>): { configGen: number; warnings: string[] } {
    const merged = { ...cfg, ...patch } as unknown as Record<string, unknown>;
    const parsed = parseConfig(merged);
    const wasReady = status.state === "ready";
    const wasDownloading = status.state === "downloading";
    const wasAutoPending = autoReinitAttempt !== null;
    const shouldReinit = wasReady || wasAutoPending;
    const nextHandles: Record<TaskId, ModelHandle> = buildAll(parsed.cfg);
    const nextPrivateHandles = new Map<TaskId, ModelHandle>();
    for (const t of Array.from(privateHandles.keys())) {
      nextPrivateHandles.set(t, factory.create(buildParams(t, "ONLY_ON_DEVICE", parsed.cfg)));
    }
    const attempt: number = ++attemptSeq;
    cfg = parsed.cfg;
    configGen += 1;
    readyHandles.clear();
    handles = nextHandles;
    privateHandles.clear();
    for (const [t, h] of nextPrivateHandles) {
      privateHandles.set(t, h);
    }
    liveInitAttempt = null;
    lazyPending = 0;
    lazyFailedDetail = null;
    if (shouldReinit) {
      const fresh = currentHandles();
      autoReinitAttempt = attempt;
      status = { state: "downloading", progress: 0 };
      let failed = false;
      const noteFailure = (): void => {
        if (attempt !== attemptSeq || failed) return;
        failed = true;
        status = { state: "needs_gesture" };
      };
      const promises: Promise<void>[] = fresh.map((h) => {
        try {
          return h.initializeDeviceModel().then(
            () => undefined,
            (e: unknown) => {
              noteFailure();
              throw e;
            },
          );
        } catch (e) {
          noteFailure();
          return Promise.reject(e);
        }
      });
      void Promise.allSettled(promises).then((res) => {
        if (attempt !== attemptSeq) return;
        autoReinitAttempt = null;
        if (failed || res.some((s) => s.status === "rejected")) {
          status = { state: "needs_gesture" };
        } else {
          for (const h of fresh) readyHandles.add(h);
          status = { state: "ready" };
        }
      });
    } else if (wasDownloading) {
      autoReinitAttempt = null;
      status = { state: "not_initialised" };
    } else {
      autoReinitAttempt = null;
    }
    return { configGen, warnings: parsed.warnings };
  }

  return {
    run,
    initDevice,
    deviceStatus: (): DeviceStatus => effectiveStatus(),
    applyConfig,
  };
}
