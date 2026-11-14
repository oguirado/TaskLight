import { slotId } from './jobKey';
import type {
  Admission,
  CapsuleTask,
  DeviceState,
  InferenceMode,
  Job,
  JobKey,
  Lane,
  LedgerCounter,
  ObservedEvent,
  PublishedCapsule,
  QueueSnapshot,
  ReconcileConfig,
  Reconciler,
  ReconcilerDeps,
} from './types';

interface SlotState {
  readonly projectId: string;
  readonly task: CapsuleTask;
  knownRev: number;
  latestTemplateHash: string;
  latestIncarnation: string;
  latestTier: Job['tier'];
  lastAdmission: Admission | undefined;
  retryRev: number | undefined;
  deferredRefresh: boolean;
}

interface PendingEntry {
  job: Job;
  seq: number;
  gen: number;
}

interface InFlightEntry {
  job: Job;
  controller: AbortController;
  settled: boolean;
  cancelTimeout: () => void;
  gen: number;
}

// Snapshot the caller's config object so a later poisoned accessor on that
// object can never wedge dispatch or timers. Every field is read exactly
// once; a throwing read propagates before anything is installed.
function snapshotConfig(c: ReconcileConfig): ReconcileConfig {
  const ondevice_concurrency = c.ondevice_concurrency;
  const cloud_concurrency = c.cloud_concurrency;
  const min_inference_interval_ms = c.min_inference_interval_ms;
  const queue_max_depth_factor = c.queue_max_depth_factor;
  const prompt_version = c.prompt_version;
  const kill_switch_cloud = c.kill_switch_cloud;
  const mode_status = c.mode_status;
  const mode_summary = c.mode_summary;
  const mode_next_action = c.mode_next_action;
  const mode_screenshot = c.mode_screenshot;
  const inference_timeout_ms = c.inference_timeout_ms;
  return {
    ondevice_concurrency,
    cloud_concurrency,
    min_inference_interval_ms,
    queue_max_depth_factor,
    prompt_version,
    kill_switch_cloud,
    mode_status,
    mode_summary,
    mode_next_action,
    mode_screenshot,
    inference_timeout_ms,
  };
}

// Required config: every scheduling number must be usable by the
// scheduler. Non-finite or negative values would disable admission
// bounds or permanently strand pending jobs (B4/B5/DISP_03), so they
// are rejected before installation. Concurrencies require an integer
// count; interval and depth factor may be fractional. Operates on the
// snapshot, never the caller's live object.
function assertValidConfig(c: ReconcileConfig): void {
  function nonNegativeInt(name: string, value: unknown): void {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new TypeError(name + ' must be a finite non-negative integer');
    }
  }
  function nonNegative(name: string, value: unknown): void {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError(name + ' must be a finite non-negative number');
    }
  }
  nonNegativeInt('ondevice_concurrency', c.ondevice_concurrency);
  nonNegativeInt('cloud_concurrency', c.cloud_concurrency);
  nonNegative('min_inference_interval_ms', c.min_inference_interval_ms);
  nonNegative('queue_max_depth_factor', c.queue_max_depth_factor);
  const v: unknown = c.inference_timeout_ms;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new TypeError('inference_timeout_ms must be a finite positive number');
  }
}

export function createReconciler(deps: ReconcilerDeps, initialCfg: ReconcileConfig): Reconciler {
  const initial = snapshotConfig(initialCfg);
  assertValidConfig(initial);
  let cfg = initial;
  let disposed = false;
  let deviceState: DeviceState = 'available';
  let seqCounter = 0;

  // ---- fault-contained port accessors -------------------------------
  // Injected callbacks may throw, return malformed shapes, or expose
  // throwing getters. Every call site below goes through one of these:
  // none of them ever throws.
  function safeNow(): number | undefined {
    try {
      return deps.clock.now();
    } catch {
      return undefined;
    }
  }
  function mustNow(): number | null {
    try {
      return deps.clock.now();
    } catch {
      return null;
    }
  }
  function safeLedger(c: LedgerCounter): void {
    try {
      deps.ledger.inc(c);
    } catch {
      // Best-effort accounting (observe paths): never corrupt state.
    }
  }
  function ledgerOrBlock(c: LedgerCounter): boolean {
    try {
      deps.ledger.inc(c);
      return true;
    } catch {
      return false;
    }
  }
  function normalizeCancel(raw: unknown): () => void {
    if (typeof raw === 'function') {
      const fn = raw as () => void;
      return (): void => {
        try {
          fn();
        } catch {
          // A throwing cancel handle is swallowed: timers are best-effort.
        }
      };
    }
    return (): void => {};
  }
  function safeCallCancel(fn: unknown): void {
    normalizeCancel(fn)();
  }
  function safeSetTimer(ms: number, fn: () => void): unknown {
    try {
      return deps.clock.setTimer(ms, fn);
    } catch {
      return undefined;
    }
  }
  type ReadResult = { readonly ok: true; readonly v: PublishedCapsule | undefined } | { readonly ok: false };
  function safeStoreRead(projectId: string): ReadResult {
    try {
      return { ok: true, v: deps.store.read(projectId) };
    } catch {
      return { ok: false };
    }
  }
  type IncResult = { readonly ok: true; readonly v: string | undefined } | { readonly ok: false };
  function safeCurrentIncarnation(projectId: string): IncResult {
    try {
      return { ok: true, v: deps.store.currentIncarnation(projectId) };
    } catch {
      return { ok: false };
    }
  }
  type CasResult = { readonly ok: true; readonly v: boolean } | { readonly ok: false };
  function safeCompareAndPublish(projectId: string, expectedRev: number, next: PublishedCapsule): CasResult {
    try {
      return { ok: true, v: deps.store.compareAndPublish(projectId, expectedRev, next) };
    } catch {
      return { ok: false };
    }
  }
  function safeAbort(controller: AbortController): void {
    try {
      controller.abort();
    } catch {
      // Internal controller: containment is defence in depth.
    }
  }

  const registered = new Set<string>();
  // Authorization/state epoch (review required fix): bumped on privacy
  // promotion, registration changes, disposal, and prompt changes so a
  // publication guard can detect a state change that reverted to a
  // passing value inside an injected callback. Pure checks after the
  // callbacks already catch non-reverted changes.
  let authEpoch = 0;
  // Registration generation: bumped on register and unregister so work
  // carrying an older token can neither publish nor recreate a job, even
  // after the project is re-registered under the same id.
  const genByProject = new Map<string, number>();
  function genFor(projectId: string): number {
    return genByProject.get(projectId) ?? 0;
  }
  function isCurrent(gen: number, projectId: string): boolean {
    return registered.has(projectId) && gen === genFor(projectId);
  }
  // Project-wide privacy tier (B11): once private, a project stays private
  // across every task slot, so a private observation on one task protects
  // in-flight or queued cloud work on another task of the same project.
  const projectTier = new Map<string, Job['tier']>();
  const slots = new Map<string, SlotState>();
  const pending: PendingEntry[] = [];
  const inFlight: InFlightEntry[] = [];
  const lastStart = new Map<string, number>();
  const timers = new Set<() => void>();
  let intervalCancel: (() => void) | null = null;
  let intervalDeadline: number | null = null;
  let dispatchCancel: (() => void) | null = null;
  let dispatchDeadline: number | null = null;

  function bound(): number {
    return cfg.queue_max_depth_factor * registered.size;
  }

  function setRetry(slot: SlotState, rev: number): void {
    if (slot.retryRev === undefined || rev > slot.retryRev) slot.retryRev = rev;
  }

  function clearRetryCovered(slot: SlotState, completedRev: number): void {
    if (slot.retryRev !== undefined && slot.retryRev <= completedRev) slot.retryRev = undefined;
  }

  // Deterministic overflow policy when N or the depth factor shrinks:
  // evict newest (latest in FIFO order) pending entries until within bound,
  // flagging each evicted slot for re-admission on the next observe.
  function enforceBound(): void {
    while (pending.length > bound() && pending.length > 0) {
      let newestIdx = 0;
      for (let i = 1; i < pending.length; i++) {
        const a = pending[i];
        const b = pending[newestIdx];
        if (a !== undefined && b !== undefined && byOrder(a, b) > 0) newestIdx = i;
      }
      const evicted = pending.splice(newestIdx, 1)[0];
      if (evicted !== undefined) {
        const s = slots.get(slotId(evicted.job.key.projectId, evicted.job.task));
        if (s !== undefined) setRetry(s, evicted.job.key.observedRev);
      }
    }
  }

  function modeForTask(task: CapsuleTask): InferenceMode {
    switch (task) {
      case 'status':
        return cfg.mode_status;
      case 'summary':
        return cfg.mode_summary;
      case 'next_action':
        return cfg.mode_next_action;
      case 'screenshot':
        return cfg.mode_screenshot;
    }
  }

  function laneForMode(mode: InferenceMode, device: DeviceState): Lane {
    switch (mode) {
      case 'ONLY_ON_DEVICE':
        return 'on_device';
      case 'ONLY_IN_CLOUD':
        return 'cloud';
      case 'PREFER_IN_CLOUD':
        return 'cloud';
      case 'PREFER_ON_DEVICE':
        return device === 'available' ? 'on_device' : 'cloud';
    }
  }

  function tierForProject(projectId: string, fallback: Job['tier']): Job['tier'] {
    return projectTier.get(projectId) ?? fallback;
  }

  // Returns effective mode/lane under current config and device state, or
  // undefined when REFUSE kill_switch_cloud applies (B10).
  function effectiveMode(tier: Job['tier'], base: InferenceMode): { mode: InferenceMode; lane: Lane } | undefined {
    if (tier === 'private') {
      return { mode: 'ONLY_ON_DEVICE', lane: 'on_device' };
    }
    if (cfg.kill_switch_cloud) {
      if (base === 'ONLY_IN_CLOUD') return undefined;
      if (base === 'PREFER_ON_DEVICE' || base === 'PREFER_IN_CLOUD' || base === 'ONLY_ON_DEVICE') {
        return { mode: 'ONLY_ON_DEVICE', lane: 'on_device' };
      }
    }
    return { mode: base, lane: laneForMode(base, deviceState) };
  }

  // Resolve a queued job against the CURRENT config (B10 hot swap applies
  // at dispatch, not only at enqueue time). Privacy is read per project, so
  // a private tier observed on any task of the project forces every task to
  // on-device.
  function resolveFor(job: Job): { mode: InferenceMode; lane: Lane } | undefined {
    return effectiveMode(tierForProject(job.key.projectId, job.tier), modeForTask(job.task));
  }

  function isDeviceBlocked(mode: InferenceMode): boolean {
    return mode === 'ONLY_ON_DEVICE' && deviceState === 'unavailable';
  }

  function inFlightCounts(): Record<Lane, number> {
    const c: Record<Lane, number> = { on_device: 0, cloud: 0 };
    for (const e of inFlight) c[e.job.lane]++;
    return c;
  }

  // FIFO order by enqueuedAt; seq is the deterministic arrival tie-break.
  function byOrder(a: PendingEntry, b: PendingEntry): number {
    if (a.job.enqueuedAt !== b.job.enqueuedAt) return a.job.enqueuedAt - b.job.enqueuedAt;
    return a.seq - b.seq;
  }

  function pendingIndexOfSlot(sid: string): number {
    return pending.findIndex((p) => slotId(p.job.key.projectId, p.job.task) === sid);
  }

  function hasInflightSlot(sid: string): boolean {
    return inFlight.some((e) => slotId(e.job.key.projectId, e.job.task) === sid);
  }

  function isIntervalBlocked(projectId: string): boolean {
    const ls = lastStart.get(projectId);
    return ls !== undefined && deps.clock.now() < ls + cfg.min_inference_interval_ms;
  }

  // Virtual FIFO dispatch state strictly before `job` at `now`: each
  // predecessor that would actually start consumes its lane and its
  // per-project interval (B5/B6/B9). Kill-switch-refused,
  // device-blocked, interval-blocked and lane-blocked predecessors
  // start nothing and consume nothing. Admission and dispatch use the
  // same simulation so they agree.
  function virtualBefore(job: Job, nowOverride?: number): { counts: Record<Lane, number>; virtLast: Map<string, number> } {
    const counts = inFlightCounts();
    const virtLast = new Map(lastStart);
    const now = nowOverride ?? deps.clock.now();
    const ordered = [...pending].sort(byOrder);
    for (const p of ordered) {
      // `job` itself never counts; when it is not yet queued every pending
      // entry precedes it (new jobs always carry the largest seq).
      if (p.job === job) break;
      const r = resolveFor(p.job);
      if (r === undefined) continue;
      if (isDeviceBlocked(r.mode)) continue;
      const ls = virtLast.get(p.job.key.projectId);
      if (ls !== undefined && now < ls + cfg.min_inference_interval_ms) continue;
      const cap = r.lane === 'on_device' ? cfg.ondevice_concurrency : cfg.cloud_concurrency;
      if (counts[r.lane] >= cap) continue;
      counts[r.lane]++;
      virtLast.set(p.job.key.projectId, now);
    }
    return { counts, virtLast };
  }

  // Timer scheduling is total: it never throws, even from timer callbacks,
  // and a failed arm leaves no stale deadline that could suppress a later
  // schedule.
  function scheduleDispatch(ms: number): void {
    try {
      if (disposed) return;
      const nowVal = safeNow();
      if (nowVal === undefined) return;
      const deadline = nowVal + ms;
      if (dispatchCancel !== null && dispatchDeadline !== null && dispatchDeadline <= deadline) return;
      if (dispatchCancel !== null) {
        safeCallCancel(dispatchCancel);
        timers.delete(dispatchCancel);
        dispatchCancel = null;
        dispatchDeadline = null;
      }
      let cancel: () => void = (): void => {};
      const raw = safeSetTimer(ms, () => {
        timers.delete(cancel);
        dispatchCancel = null;
        dispatchDeadline = null;
        tryDispatch();
      });
      if (raw === undefined) return;
      cancel = normalizeCancel(raw);
      dispatchCancel = cancel;
      dispatchDeadline = deadline;
      timers.add(cancel);
    } catch {
      return;
    }
  }

  // B6 wake-up: cancellable timer with a tracked deadline, so a shorter
  // interval (config hot swap) replaces a later wake-up with an earlier one.
  // Total like scheduleDispatch.
  function scheduleIntervalWakeup(deadline: number): void {
    try {
      if (disposed) return;
      if (intervalCancel !== null && intervalDeadline !== null && intervalDeadline === deadline) return;
      const nowVal = safeNow();
      if (nowVal === undefined) return;
      if (intervalCancel !== null) {
        safeCallCancel(intervalCancel);
        timers.delete(intervalCancel);
        intervalCancel = null;
        intervalDeadline = null;
      }
      const delay = Math.max(0, deadline - nowVal);
      let cancel: () => void = (): void => {};
      const raw = safeSetTimer(delay, () => {
        timers.delete(cancel);
        intervalCancel = null;
        intervalDeadline = null;
        tryDispatch();
      });
      if (raw === undefined) return;
      cancel = normalizeCancel(raw);
      intervalCancel = cancel;
      intervalDeadline = deadline;
      timers.add(cancel);
    } catch {
      return;
    }
  }

  // Evaluate admission for a queued job under current config/state.
  // Interval and lane predictions run through `virtualBefore`, so an
  // eligible predecessor that starts now makes a second job for the
  // same project interval-throttled and never reserves its free lane.
  function evaluateAdmission(job: Job, nowOverride?: number): Admission {
    const r = resolveFor(job);
    if (r === undefined) {
      return { kind: 'REFUSE', reason: 'kill_switch_cloud' };
    }
    const now = nowOverride ?? deps.clock.now();
    if (isDeviceBlocked(r.mode)) {
      return { kind: 'THROTTLE', reason: 'device_not_ready', retryAt: now };
    }
    const { counts, virtLast } = virtualBefore(job, now);
    const ls = virtLast.get(job.key.projectId);
    if (ls !== undefined && now < ls + cfg.min_inference_interval_ms) {
      return { kind: 'THROTTLE', reason: 'interval', retryAt: ls + cfg.min_inference_interval_ms };
    }
    const cap = r.lane === 'on_device' ? cfg.ondevice_concurrency : cfg.cloud_concurrency;
    if (counts[r.lane] >= cap) {
      return { kind: 'THROTTLE', reason: 'lane_full', retryAt: now };
    }
    return { kind: 'ADMIT', lane: r.lane };
  }

  // Current admission for the B2 no-op path. A pending job is re-evaluated
  // under current config; otherwise the slot's last actual admission is
  // preserved instead of a hardcoded default.
  function currentAdmission(slot: SlotState, sid: string): Admission {
    const idx = pendingIndexOfSlot(sid);
    if (idx >= 0) {
      const p = pending[idx];
      if (p !== undefined) return evaluateAdmission(p.job);
    }
    return slot.lastAdmission ?? { kind: 'ADMIT', lane: 'on_device' };
  }

  function markNeedsRequeue(job: Job): void {
    const slot = slots.get(slotId(job.key.projectId, job.task));
    if (slot !== undefined) setRetry(slot, job.key.observedRev);
  }

  function removeInFlight(entry: InFlightEntry): void {
    safeCallCancel(entry.cancelTimeout);
    timers.delete(entry.cancelTimeout);
    const i = inFlight.indexOf(entry);
    if (i >= 0) inFlight.splice(i, 1);
  }

  // Start a job. Total: every injected-port failure releases the lane,
  // retains revision-scoped retry intent, and schedules progress. The only
  // exits are the initial setup below or the outcome callbacks, which are
  // themselves total, so no unhandled rejection can originate here.
  function startJob(job: Job, lane: Lane, gen: number): void {
    const effectiveJob: Job = lane === job.lane ? job : { ...job, lane };
    const failStart = (entry: InFlightEntry | undefined, cancel: (() => void) | undefined): void => {
      if (entry !== undefined) {
        entry.settled = true;
        if (cancel !== undefined) {
          safeCallCancel(cancel);
          timers.delete(cancel);
        } else {
          safeCallCancel(entry.cancelTimeout);
          timers.delete(entry.cancelTimeout);
        }
        const i = inFlight.indexOf(entry);
        if (i >= 0) inFlight.splice(i, 1);
      }
      try {
        markNeedsRequeue(effectiveJob);
      } catch {
        return;
      }
      scheduleDispatch(0);
    };
    let controller: AbortController;
    let entry: InFlightEntry | undefined;
    let cancel: () => void = (): void => {};
    try {
      controller = new AbortController();
      const startNow = deps.clock.now();
      lastStart.set(effectiveJob.key.projectId, startNow);
      const entryObj: InFlightEntry = { job: effectiveJob, controller, settled: false, cancelTimeout: (): void => {}, gen };
      entry = entryObj;
      inFlight.push(entryObj);
      const raw = safeSetTimer(cfg.inference_timeout_ms, () => {
        try {
          timers.delete(cancel);
          if (entryObj.settled) return;
          entryObj.settled = true;
          safeAbort(entryObj.controller);
          const i = inFlight.indexOf(entryObj);
          if (i >= 0) inFlight.splice(i, 1);
          try {
            markNeedsRequeue(effectiveJob);
          } catch {
            return;
          }
          scheduleDispatch(0);
        } catch {
          return;
        }
      });
      if (raw === undefined) {
        // Timeout timer could not be armed: never hold the lane.
        failStart(entry, undefined);
        return;
      }
      cancel = normalizeCancel(raw);
      entryObj.cancelTimeout = cancel;
      timers.add(cancel);
    } catch {
      // Clock failure while arming: release without leaking the lane.
      try {
        failStart(entry, undefined);
      } catch {
        return;
      }
      return;
    }
    const armedEntry = entry as InFlightEntry;

    let outcome: unknown;
    try {
      outcome = deps.infer.run(
        { key: effectiveJob.key, task: effectiveJob.task, mode: effectiveJob.mode },
        controller.signal,
      );
    } catch {
      failStart(armedEntry, cancel);
      return;
    }
    const onOk = (res: unknown): void => {
      const entry = armedEntry;
      try {
        if (entry.settled || disposed || controller.signal.aborted) return;
        if (!isCurrent(entry.gen, effectiveJob.key.projectId)) return;
        let rawValue: string;
        let sourceValue: 'ON_DEVICE' | 'IN_CLOUD';
        try {
          if (typeof res !== 'object' || res === null) throw new Error('malformed inference outcome');
          const rawProp: unknown = (res as { raw: unknown }).raw;
          const srcProp: unknown = (res as { inferenceSource: unknown }).inferenceSource;
          if (typeof rawProp !== 'string') throw new Error('malformed inference raw');
          if (srcProp !== 'ON_DEVICE' && srcProp !== 'IN_CLOUD') throw new Error('malformed inference source');
          rawValue = rawProp;
          sourceValue = srcProp;
        } catch {
          entry.settled = true;
          removeInFlight(entry);
          try {
            markNeedsRequeue(effectiveJob);
          } catch {
            return;
          }
          scheduleDispatch(0);
          return;
        }
        entry.settled = true;
        removeInFlight(entry);
        scheduleDispatch(0);
        handleOutcome(effectiveJob, rawValue, sourceValue, entry.gen);
      } catch {
        return;
      }
    };
    const onErr = (): void => {
      const entry = armedEntry;
      try {
        if (entry.settled || disposed) return;
        entry.settled = true;
        removeInFlight(entry);
        try {
          markNeedsRequeue(effectiveJob);
        } catch {
          return;
        }
        scheduleDispatch(0);
      } catch {
        return;
      }
    };
    let thenFn: unknown;
    try {
      thenFn = (outcome as { then?: unknown } | null | undefined)?.then;
    } catch {
      failStart(armedEntry, cancel);
      return;
    }
    if (typeof thenFn !== 'function') {
      failStart(armedEntry, cancel);
      return;
    }
    let derived: unknown;
    try {
      derived = (outcome as { then: (a: (r: unknown) => void, b: () => void) => unknown }).then(onOk, onErr);
    } catch {
      failStart(armedEntry, cancel);
      return;
    }
    // Swallow any rejection of the derived promise (hostile thenable
    // landmine): outcome handlers above are total, but the thenable's own
    // `then` implementation can still reject the derived promise.
    try {
      const catchFn: unknown = (derived as { catch?: unknown } | null | undefined)?.catch;
      if (typeof catchFn === 'function') {
        (catchFn as (handler: () => void) => void).call(derived, (): void => {});
      }
    } catch {
      return;
    }
  }

  // Centralized publication validity (B11, B12.1-B12.3, B17): every effect
  // boundary consults the same predicate after any injected callback
  // and immediately before each CAS attempt. A failing store read is
  // treated as blocked (drop with retry), never as evidence of absence.
  type PublicationBlock = 'disposed' | 'unregistered' | 'privacy' | 'incarnation' | 'prompt_template' | 'stale_rev' | 'ok';
  function publicationBlocker(job: Job, source: 'ON_DEVICE' | 'IN_CLOUD', gen: number): PublicationBlock {
    // Injected port calls FIRST. Any reentrant observe/unregister/
    // updateConfig/dispose inside them mutates projectTier, registration,
    // cfg, or disposed. Every pure check below runs AFTER, so the guard
    // sees post-callback state and cannot return ok on stale privacy.
    const epochBefore = authEpoch;
    const pub = safeStoreRead(job.key.projectId);
    // Incarnation lives in the store, so a mutation inside either port
    // call (h.store.inc.set during the callback) is invisible to pure
    // checks. Read until two consecutive reads agree: the value
    // returned at the mutation call is pre-mutation, the next one
    // post-mutation, so a single mutation always shows up as a change.
    // A caller that mutates on every call never stabilizes -> blocked.
    let inc = safeCurrentIncarnation(job.key.projectId);
    let unstable = false;
    for (let i = 0; i < 16 && inc.ok; i++) {
      const again = safeCurrentIncarnation(job.key.projectId);
      if (!again.ok || again.v === inc.v) { break; }
      if (i === 15) unstable = true;
      inc = again;
    }
    if (unstable) return 'stale_rev';
    const slot = slots.get(slotId(job.key.projectId, job.task));
    if (disposed) return 'disposed';
    if (!isCurrent(gen, job.key.projectId)) return 'unregistered';
    // B11: private + IN_CLOUD is discarded and never published. Project-wide
    // tier governs at effect time.
    const effTier = tierForProject(job.key.projectId, slot?.latestTier ?? job.tier);
    if (effTier === 'private' && source === 'IN_CLOUD') return 'privacy';
    if (!inc.ok) return 'stale_rev';
    if (inc.v !== job.incarnation) return 'incarnation';
    // B12.2 prompt / template against current config and latest slot metadata
    const latestHash = slot?.latestTemplateHash ?? job.key.templateHash;
    if (job.key.promptVersion !== cfg.prompt_version || job.key.templateHash !== latestHash) {
      return 'prompt_template';
    }
    // B12.3 strictly greater than published source. Older-than-latest is
    // allowed when it passes this check (no knownRev comparison here).
    if (!pub.ok) return 'stale_rev';
    let src: number;
    try {
      src = pub.v === undefined ? -1 : pub.v.source_observed_rev;
    } catch {
      return 'stale_rev';
    }
    if (!(job.key.observedRev > src)) return 'stale_rev';
    // Epoch reverted to a passing value inside a callback (e.g. prompt
    // flipped and flipped back): still block, as state changed.
    if (authEpoch !== epochBefore) return 'stale_rev';
    return 'ok';
  }

  // Total: every injected-port failure, every malformed return shape, and
  // every hostile getter is consumed here. A failure drops the result,
  // records retry intent, schedules progress, and never escapes.
  function handleOutcome(job: Job, raw: string, source: 'ON_DEVICE' | 'IN_CLOUD', gen: number): void {
    const sid = slotId(job.key.projectId, job.task);
    const slot = slots.get(sid);
    const drop = (): void => {
      try {
        if (slot !== undefined) setRetry(slot, job.key.observedRev);
      } catch {
        return;
      }
    };
    // Handle a publication blocker: queue current work for prompt/template
    // drift, otherwise retain retry intent. Returns true when blocked.
    const applyBlock = (b: PublicationBlock): boolean => {
      switch (b) {
        case 'ok':
          return false;
        case 'disposed':
        case 'unregistered':
          return true;
        case 'privacy':
        case 'incarnation':
        case 'stale_rev':
          drop();
          return true;
        case 'prompt_template':
          enqueueFresh(job, sid, gen);
          return true;
      }
    };
    try {
      const entryBlock = publicationBlocker(job, source, gen);
      if (applyBlock(entryBlock)) return;
      // B12.4 validator. A throwing injected callback or a malformed
      // return must not escape the Promise continuation: consume it,
      // retain retry intent so the same accepted observation dispatches
      // again, and publish nothing.
      let verdict: { readonly dropped: true } | { readonly rejected: true } | { readonly patch: Readonly<Record<string, unknown>> };
      try {
        const v: unknown = deps.validator.validate(job.task, raw);
        if (typeof v !== 'object' || v === null) {
          verdict = { dropped: true };
        } else {
          let okRaw: unknown;
          let patchRaw: unknown;
          let readFailed = false;
          try {
            okRaw = (v as { ok: unknown }).ok;
          } catch {
            readFailed = true;
          }
          if (!readFailed && okRaw === true) {
            try {
              patchRaw = (v as { patch: unknown }).patch;
            } catch {
              readFailed = true;
            }
          }
          if (readFailed) {
            verdict = { dropped: true };
          } else if (okRaw === false) {
            verdict = { rejected: true };
          } else if (okRaw === true && typeof patchRaw === 'object' && patchRaw !== null) {
            verdict = { patch: patchRaw as Readonly<Record<string, unknown>> };
          } else {
            verdict = { dropped: true };
          }
        }
      } catch {
        verdict = { dropped: true };
      }
      if ('dropped' in verdict) {
        drop();
        return;
      }
      // Validator is an injected callback: effects after reentrant disposal
      // are forbidden (B17), including ledger and publish.
      if (disposed) return;
      if ('rejected' in verdict) {
        safeLedger('schema_rejects');
        drop();
        return;
      }
      const patch = verdict.patch;
      // Post-validator revalidation of every entry precondition (B11,
      // B12.1-B12.3, B17). The validator may have reentered through
      // observe, updateConfig, store mutation or dispose.
      const post = publicationBlocker(job, source, gen);
      if (applyBlock(post)) return;
      // B13 guarded publish with one re-read/retry. Publishing an older
      // revision is allowed when it passes B12.3, but observed_rev must
      // keep the latest known observation so a lower-rev task cannot
      // downgrade it.
      const read0 = safeStoreRead(job.key.projectId);
      if (!read0.ok) {
        drop();
        return;
      }
      const pub = read0.v;
      let preservedObservedRev = job.key.observedRev;
      let expected0: number;
      try {
        if (pub !== undefined && pub.observed_rev > preservedObservedRev) preservedObservedRev = pub.observed_rev;
        expected0 = pub?.rev ?? 0;
      } catch {
        // Hostile capsule: unreadable evidence blocks publication.
        drop();
        return;
      }
      for (const s of slots.values()) {
        if (s.projectId === job.key.projectId && s.knownRev > preservedObservedRev) preservedObservedRev = s.knownRev;
      }
      const now0 = mustNow();
      if (now0 === null) {
        drop();
        return;
      }
      const next0: PublishedCapsule = {
        rev: expected0 + 1,
        observed_rev: preservedObservedRev,
        source_observed_rev: job.key.observedRev,
        incarnation: job.incarnation,
        inference_source: source,
        updated_at: now0,
        patch,
      };
      // Immediately before the first CAS: same guard after any injected
      // callback.
      const preCas0 = publicationBlocker(job, source, gen);
      if (applyBlock(preCas0)) return;
      // B14 ledger: ledger is an injected callback whose reentrancy may
      // promote project privacy or dispose the reconciler. A throwing
      // ledger drops the result before publication. Revalidate after
      // each increment and cease further effects on a late block.
      const counter: LedgerCounter = source === 'ON_DEVICE' ? 'on_device' : 'in_cloud';
      if (!ledgerOrBlock(counter)) {
        drop();
        return;
      }
      const postLedger0 = publicationBlocker(job, source, gen);
      if (applyBlock(postLedger0)) return;
      if (job.mode === 'PREFER_ON_DEVICE' && source === 'IN_CLOUD') {
        if (!ledgerOrBlock('fallbacks')) {
          drop();
          return;
        }
      }
      const postLedger1 = publicationBlocker(job, source, gen);
      if (applyBlock(postLedger1)) return;
      // Final independent revalidation immediately before CAS: post-ledger
      // callbacks may have mutated authorization state, so re-check with no
      // intervening injected callback between this guard and the CAS.
      // Loop the whole guard until two consecutive evaluations agree, max 8,
      // else refuse publication.
      let finalVerdict: PublicationBlock = 'stale_rev';
      {
        let prevVerdict: PublicationBlock | null = null;
        let agreed = false;
        for (let attempt = 0; attempt < 8; attempt++) {
          const verdict = publicationBlocker(job, source, gen);
          if (verdict !== prevVerdict) {
            prevVerdict = verdict;
            finalVerdict = verdict;
            continue;
          }
          agreed = true;
          finalVerdict = verdict;
          break;
        }
        if (!agreed) {
          finalVerdict = 'stale_rev';
        }
      }
      if (applyBlock(finalVerdict)) return;
      const cas0 = safeCompareAndPublish(job.key.projectId, expected0, next0);
      if (!cas0.ok) {
        drop();
        return;
      }
      if (cas0.v) {
        if (slot !== undefined) clearRetryCovered(slot, job.key.observedRev);
        return;
      }
      const read1 = safeStoreRead(job.key.projectId);
      if (!read1.ok) {
        drop();
        return;
      }
      const re = read1.v;
      // Retry re-applies the full guard (B12.1/B12.3 + B11/B12.2/B17)
      // against the re-read state.
      const retryBlock = publicationBlocker(job, source, gen);
      if (applyBlock(retryBlock)) return;
      try {
        if (re !== undefined && re.observed_rev > preservedObservedRev) preservedObservedRev = re.observed_rev;
      } catch {
        drop();
        return;
      }
      for (const s of slots.values()) {
        if (s.projectId === job.key.projectId && s.knownRev > preservedObservedRev) preservedObservedRev = s.knownRev;
      }
      let expected1: number;
      try {
        expected1 = re?.rev ?? 0;
      } catch {
        drop();
        return;
      }
      const now1 = mustNow();
      if (now1 === null) {
        drop();
        return;
      }
      const next1: PublishedCapsule = { ...next0, rev: expected1 + 1, observed_rev: preservedObservedRev, updated_at: now1 };
      // Immediately before the retry CAS: identical guard.
      const preCas1 = publicationBlocker(job, source, gen);
      if (applyBlock(preCas1)) return;
      const cas1 = safeCompareAndPublish(job.key.projectId, expected1, next1);
      if (!cas1.ok) {
        drop();
        return;
      }
      if (slot !== undefined) {
        if (cas1.v) clearRetryCovered(slot, job.key.observedRev);
        else setRetry(slot, job.key.observedRev);
      }
    } catch {
      // Last-resort containment for anything the per-effect guards did not
      // anticipate (hostile capsule shapes, hostile getters).
      drop();
      scheduleDispatch(0);
      return;
    }
  }

  // Build a fresh job from a slot's latest metadata (B12.2 refresh), or
  // undefined when the kill switch refuses the slot's mode (B10).
  function freshJobFor(slot: SlotState): Job | undefined {
    if (slot.knownRev < 0) return undefined;
    const tier = tierForProject(slot.projectId, slot.latestTier);
    const eff = effectiveMode(tier, modeForTask(slot.task));
    if (eff === undefined) return undefined;
    const key: JobKey = {
      projectId: slot.projectId,
      observedRev: slot.knownRev,
      promptVersion: cfg.prompt_version,
      templateHash: slot.latestTemplateHash,
    };
    return {
      key,
      task: slot.task,
      incarnation: slot.latestIncarnation,
      tier,
      mode: eff.mode,
      lane: eff.lane,
      enqueuedAt: deps.clock.now(),
    };
  }

  // Consume deferred B12.2 refreshes (flagged when the queue was full) as
  // soon as pending capacity exists. Runs inside tryDispatch, so newly
  // enqueued jobs join the same dispatch pass; the flag survives while the
  // queue stays full (B4 bound is never bypassed).
  function drainDeferredRefreshes(): void {
    if (disposed) return;
    for (const slot of slots.values()) {
      try {
        if (!slot.deferredRefresh) continue;
        if (!registered.has(slot.projectId)) continue;
        const sid = slotId(slot.projectId, slot.task);
        if (pendingIndexOfSlot(sid) >= 0 || hasInflightSlot(sid)) continue;
        if (pending.length >= bound()) continue;
        const job = freshJobFor(slot);
        if (job === undefined) {
          // Kill-switch refusal of a deferred refresh: record the refusal
          // and retain same-revision retry intent instead of silently
          // dropping it.
          if (slot.knownRev >= 0 && effectiveMode(tierForProject(slot.projectId, slot.latestTier), modeForTask(slot.task)) === undefined) {
            safeLedger('refusals');
            slot.lastAdmission = { kind: 'REFUSE', reason: 'kill_switch_cloud' };
            setRetry(slot, slot.knownRev);
            slot.deferredRefresh = false;
          }
          continue;
        }
        pending.push({ job, seq: seqCounter++, gen: genFor(slot.projectId) });
        pending.sort(byOrder);
        slot.deferredRefresh = false;
        clearRetryCovered(slot, job.key.observedRev);
        slot.lastAdmission = evaluateAdmission(job);
      } catch {
        continue;
      }
    }
  }

  // Fresh enqueue after a B12.2 mismatch, rebuilt from the slot's latest
  // metadata so a newer pending revision is never downgraded (B3).
  function enqueueFresh(prev: Job, sid: string, gen: number): void {
    try {
      if (disposed) return;
      if (!isCurrent(gen, prev.key.projectId)) return;
      const slot = slots.get(sid);
      const tier = tierForProject(prev.key.projectId, slot?.latestTier ?? prev.tier);
      const eff = effectiveMode(tier, modeForTask(prev.task));
      if (eff === undefined) {
        safeLedger('refusals');
        if (slot !== undefined) {
          setRetry(slot, slot.knownRev);
          slot.lastAdmission = { kind: 'REFUSE', reason: 'kill_switch_cloud' };
        }
        return;
      }
      const job: Job = slot !== undefined
        ? {
            key: {
              projectId: slot.projectId,
              observedRev: slot.knownRev,
              promptVersion: cfg.prompt_version,
              templateHash: slot.latestTemplateHash,
            },
            task: slot.task,
            incarnation: slot.latestIncarnation,
            tier,
            mode: eff.mode,
            lane: eff.lane,
            enqueuedAt: deps.clock.now(),
          }
        : {
            key: {
              projectId: prev.key.projectId,
              observedRev: prev.key.observedRev,
              promptVersion: cfg.prompt_version,
              templateHash: prev.key.templateHash,
            },
            task: prev.task,
            incarnation: prev.incarnation,
            tier,
            mode: eff.mode,
            lane: eff.lane,
            enqueuedAt: deps.clock.now(),
          };
      const idx = pendingIndexOfSlot(sid);
      if (idx >= 0) {
        const old = pending[idx];
        if (old !== undefined) {
          // Preserve the queued position; only the key/metadata refresh.
          old.job = { ...job, enqueuedAt: old.job.enqueuedAt };
        }
      } else {
        if (pending.length >= bound()) {
          // Deferred refresh intent: drainDeferredRefreshes refills this as
          // soon as capacity exists (B4).
          if (slot !== undefined) slot.deferredRefresh = true;
          return;
        }
        pending.push({ job, seq: seqCounter++, gen });
        pending.sort(byOrder);
      }
      if (slot !== undefined) {
        clearRetryCovered(slot, job.key.observedRev);
        slot.deferredRefresh = false;
        slot.lastAdmission = evaluateAdmission(job);
      }
      scheduleDispatch(0);
    } catch {
      // Clock failure while refreshing: retain retry intent in the caller.
      try {
        const slot = slots.get(sid);
        if (slot !== undefined) setRetry(slot, prev.key.observedRev);
      } catch {
        return;
      }
      return;
    }
  }

  function tryDispatchInner(): void {
    if (disposed) return;
    drainDeferredRefreshes();
    if (disposed) return;
    const ordered = [...pending].sort(byOrder);
    let earliestIntervalRetry: number | undefined;
    for (const entry of ordered) {
      if (disposed) return;
      // A captured entry superseded by a newer observe (coalescing replaces
      // the pending object) must never dispatch; only entries still in the
      // current pending set are eligible (B3, reentrant infer/ledger).
      if (pending.indexOf(entry) < 0) continue;
      try {
        if (!isCurrent(entry.gen, entry.job.key.projectId)) {
          const pi = pending.indexOf(entry);
          if (pi >= 0) pending.splice(pi, 1);
          continue;
        }
        const job = entry.job;
        // Recompute the effective mode at dispatch time so the current kill
        // switch and modes govern queued work (B10, config hot swap).
        const resolved = resolveFor(job);
        if (resolved === undefined) {
          const pi = pending.indexOf(entry);
          if (pi >= 0) pending.splice(pi, 1);
          // Dispatch-time kill-switch refusal (B10, section 4): record the
          // refusal and keep same-revision retry intent so the work is not
          // silently stranded when the switch clears.
          const sid = slotId(job.key.projectId, job.task);
          const refusedSlot = slots.get(sid);
          if (refusedSlot !== undefined) {
            setRetry(refusedSlot, job.key.observedRev);
            refusedSlot.lastAdmission = { kind: 'REFUSE', reason: 'kill_switch_cloud' };
          }
          safeLedger('refusals');
          // Ledger is an injected callback: a reentrant dispose ends dispatch.
          if (disposed) return;
          continue;
        }
        const dispatchJob: Job = resolved.mode === job.mode && resolved.lane === job.lane
          ? job
          : { ...job, mode: resolved.mode, lane: resolved.lane };
        // Preserve pending-entry identity: mutating in place keeps the later
        // indexOf/splice valid so the dispatched job actually leaves pending.
        if (dispatchJob !== job) {
          entry.job = dispatchJob;
        }
        if (isDeviceBlocked(resolved.mode)) continue;
        const ls = lastStart.get(job.key.projectId);
        if (ls !== undefined && deps.clock.now() < ls + cfg.min_inference_interval_ms) {
          const retryAt = ls + cfg.min_inference_interval_ms;
          if (earliestIntervalRetry === undefined || retryAt < earliestIntervalRetry) earliestIntervalRetry = retryAt;
          continue;
        }
        const cap = resolved.lane === 'on_device' ? cfg.ondevice_concurrency : cfg.cloud_concurrency;
        if (inFlightCounts()[resolved.lane] >= cap) continue;
        const pi = pending.indexOf(entry);
        if (pi >= 0) pending.splice(pi, 1);
        // Truthful admission after dispatch-time rerouting (B10): the slot's
        // cached admission must reflect the lane actually occupied, so a
        // later equal-revision observe reports ADMIT lane:<actual> (B2),
        // not the stale enqueue-time lane.
        const dispatchedSid = slotId(dispatchJob.key.projectId, dispatchJob.task);
        const dispatchedSlot = slots.get(dispatchedSid);
        if (dispatchedSlot !== undefined) {
          dispatchedSlot.lastAdmission = { kind: 'ADMIT', lane: resolved.lane };
        }
        startJob(dispatchJob, resolved.lane, entry.gen);
        // infer.run is an injected callback: a reentrant dispose (B17) or a
        // newer observe replacing later pending entries ends or constrains
        // this loop on its next iteration guards.
        if (disposed) return;
        // Snapshot membership for the next captured entry is rechecked from
        // current pending at the top of the loop.
      } catch {
        // One entry's injected-port failure never aborts the pass: later
        // pending jobs still dispatch. The failed entry stays pending;
        // clock faults are exempt from the wake-up guarantee, and every
        // non-clock port is already contained above.
        continue;
      }
    }
    if (disposed) return;
    if (earliestIntervalRetry !== undefined) {
      scheduleIntervalWakeup(earliestIntervalRetry);
    }
  }

  // Total: timer callbacks call this directly, so no exception may escape
  // into a clock callback (V2 analogue) or stranding wake-ups.
  function tryDispatch(): void {
    try {
      tryDispatchInner();
    } catch {
      return;
    }
  }

  return {
    registerProject(projectId: string): void {
      genByProject.set(projectId, genFor(projectId) + 1);
      registered.add(projectId);
      authEpoch++;
    },
    unregisterProject(projectId: string): void {
      authEpoch++;
      genByProject.set(projectId, genFor(projectId) + 1);
      registered.delete(projectId);
      lastStart.delete(projectId);
      projectTier.delete(projectId);
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i]?.job.key.projectId === projectId) pending.splice(i, 1);
      }
      // Abort outstanding inference for this registration: settled entries
      // ignore late resolutions, and the gen bump blocks any that slip
      // through from publishing or recreating work. Every cancel/abort is
      // contained so one faulty handle cannot skip the rest.
      for (let i = inFlight.length - 1; i >= 0; i--) {
        const e = inFlight[i];
        if (e !== undefined && e.job.key.projectId === projectId) {
          e.settled = true;
          safeAbort(e.controller);
          safeCallCancel(e.cancelTimeout);
          timers.delete(e.cancelTimeout);
          inFlight.splice(i, 1);
        }
      }
      for (const [k, v] of [...slots]) if (v.projectId === projectId) slots.delete(k);
      enforceBound();
      // Releasing a lane must wake surviving pending work without any
      // further external action (review BLOCKING 1).
      scheduleDispatch(0);
    },
    observe(ev: ObservedEvent): Admission {
      if (disposed) return { kind: 'REFUSE', reason: 'disposed' };
      // Snapshot every field before any mutation: a throwing accessor
      // propagates with the reconciler untouched, so no half-observed
      // state can wedge later passes.
      const projectId = ev.projectId;
      if (!registered.has(projectId)) return { kind: 'REFUSE', reason: 'unknown_project' };
      const incarnation = ev.incarnation;
      const observedRev = ev.observedRev;
      const templateHash = ev.templateHash;
      const tier = ev.tier;
      const task = ev.task;
      if (!Number.isInteger(observedRev) || observedRev < 0) throw new TypeError('observedRev must be an integer >= 0');
      // Fetch the clock before any slot metadata advances: a throwing
      // clock then leaves the revision entirely unseen, so it cannot
      // consume the revision without work (B2/DISP_03). Every enqueue
      // and admission below reuses this value, so no clock call remains
      // after knownRev advances.
      const nowEarly = deps.clock.now();

      const sid = slotId(projectId, task);
      let slot = slots.get(sid);
      if (slot === undefined) {
        // knownRev -1 keeps revision 0 distinct from "never seen" (B2).
        slot = {
          projectId,
          task,
          knownRev: -1,
          latestTemplateHash: templateHash,
          latestIncarnation: incarnation,
          latestTier: tier,
          lastAdmission: undefined,
          retryRev: undefined,
          deferredRefresh: false,
        };
        slots.set(sid, slot);
      }

      if (observedRev < slot.knownRev) {
        // No state change here, but re-arm dispatch so previously
        // stranded pending work recovers on the next observation.
        scheduleDispatch(0);
        return currentAdmission(slot, sid);
      }
      if (observedRev === slot.knownRev) {
        if (pendingIndexOfSlot(sid) >= 0 || hasInflightSlot(sid)) {
          scheduleDispatch(0);
          return currentAdmission(slot, sid);
        }
        // Idle slot at the known revision: re-admit after a failed attempt
        // (error/degraded states), otherwise preserve the last outcome.
        // Equal revisions are B2-rejected and never mutate project policy;
        // the governing tier is the already-promoted projectTier.
        // Retry uses the accepted slot metadata, never the repeated event's
        // metadata: a late equal-revision observation cannot replace
        // previously accepted template/incarnation/tier (B2, section 4).
        const projTier = tierForProject(projectId, slot.latestTier);
        if (slot.retryRev === observedRev) {
          const eff = effectiveMode(projTier, modeForTask(task));
          if (eff === undefined) {
            safeLedger('refusals');
            slot.lastAdmission = { kind: 'REFUSE', reason: 'kill_switch_cloud' };
            return slot.lastAdmission;
          }
          if (pending.length >= bound()) {
            safeLedger('refusals');
            slot.lastAdmission = { kind: 'REFUSE', reason: 'queue_full' };
            return slot.lastAdmission;
          }
          const key: JobKey = { projectId, observedRev, promptVersion: cfg.prompt_version, templateHash: slot.latestTemplateHash };
          const job: Job = {
            key,
            task,
            incarnation: slot.latestIncarnation,
            tier: projTier,
            mode: eff.mode,
            lane: eff.lane,
            enqueuedAt: nowEarly,
          };
          pending.push({ job, seq: seqCounter++, gen: genFor(projectId) });
          pending.sort(byOrder);
          clearRetryCovered(slot, job.key.observedRev);
          slot.deferredRefresh = false;
          const admission = evaluateAdmission(job, nowEarly);
          slot.lastAdmission = admission;
          scheduleDispatch(0);
          return admission;
        }
        if (slot.lastAdmission !== undefined) return slot.lastAdmission;
        return currentAdmission(slot, sid);
      }

      // observedRev > knownRev: only a valid newer observation may
      // mutate project policy (CONTRACT_DECISIONS). A valid private
      // observation promotes project privacy for the registration
      // lifetime; lower/equal observations never reach here (B2).
      if (tier === 'private') {
        if (projectTier.get(projectId) !== 'private') authEpoch++;
        projectTier.set(projectId, 'private');
      } else if (!projectTier.has(projectId)) {
        projectTier.set(projectId, tier);
      }
      const projTier = tierForProject(projectId, tier);

      // observedRev > knownRev: raise the slot and coalesce (B2, B3).
      slot.knownRev = observedRev;
      slot.latestTemplateHash = templateHash;
      slot.latestIncarnation = incarnation;
      slot.latestTier = tier;

      const base = modeForTask(task);
      const eff = effectiveMode(projTier, base);
      if (eff === undefined) {
        safeLedger('refusals');
        // Refused intent is retained so a later equal-revision observation
        // re-admits once the blocking condition clears (section 4).
        // Pending work coalesces toward the latest known revision even
        // when temporarily refused: an older pending entry for this slot
        // is superseded by the refused newer revision, never dispatched.
        setRetry(slot, observedRev);
        slot.lastAdmission = { kind: 'REFUSE', reason: 'kill_switch_cloud' };
        const obsolete = pendingIndexOfSlot(sid);
        if (obsolete >= 0) pending.splice(obsolete, 1);
        return slot.lastAdmission;
      }

      const existing = pendingIndexOfSlot(sid);
      if (existing >= 0) {
        // Coalescing replacement: never refuses (B4).
        const key: JobKey = { projectId, observedRev, promptVersion: cfg.prompt_version, templateHash };
        const job: Job = {
          key,
          task,
          incarnation,
          tier: projTier,
          mode: eff.mode,
          lane: eff.lane,
          enqueuedAt: nowEarly,
        };
        pending[existing] = { job, seq: seqCounter++, gen: genFor(projectId) };
        pending.sort(byOrder);
        clearRetryCovered(slot, job.key.observedRev);
        slot.deferredRefresh = false;
        const admission = evaluateAdmission(job, nowEarly);
        slot.lastAdmission = admission;
        scheduleDispatch(0);
        return admission;
      }

      // B4 bounds pending jobs only; in-flight work holds no queue slot.
      if (pending.length >= bound()) {
        safeLedger('refusals');
        // Refused intent is retained so a later equal-revision observation
        // re-admits once the queue drains (section 4).
        setRetry(slot, observedRev);
        slot.lastAdmission = { kind: 'REFUSE', reason: 'queue_full' };
        return slot.lastAdmission;
      }

      const key: JobKey = { projectId, observedRev, promptVersion: cfg.prompt_version, templateHash };
      const job: Job = {
        key,
        task,
        incarnation,
        tier: projTier,
        mode: eff.mode,
        lane: eff.lane,
        enqueuedAt: nowEarly,
      };
      pending.push({ job, seq: seqCounter++, gen: genFor(projectId) });
      pending.sort(byOrder);
      clearRetryCovered(slot, job.key.observedRev);
      slot.deferredRefresh = false;
      const admission = evaluateAdmission(job, nowEarly);
      slot.lastAdmission = admission;
      scheduleDispatch(0);
      return admission;
    },
    updateConfig(next: ReconcileConfig): void {
      const snap = snapshotConfig(next);
      assertValidConfig(snap);
      if (snap.prompt_version !== cfg.prompt_version) authEpoch++;
      cfg = snap;
      enforceBound();
      scheduleDispatch(0);
    },
    setDeviceState(s: DeviceState): void {
      deviceState = s;
      scheduleDispatch(0);
    },
    freshness(projectId: string): 'fresh' | 'stale' {
      // Missing or unreadable evidence is stale (B15); a failing store can
      // never make a capsule look fresh nor throw into the caller.
      try {
        const read = safeStoreRead(projectId);
        if (!read.ok) return 'stale';
        const pub = read.v;
        if (pub === undefined) return 'stale';
        let known: number;
        let sourceRev: number;
        try {
          known = pub.observed_rev;
          sourceRev = pub.source_observed_rev;
        } catch {
          return 'stale';
        }
        for (const s of slots.values()) {
          if (s.projectId === projectId && s.knownRev > known) known = s.knownRev;
        }
        return known > sourceRev ? 'stale' : 'fresh';
      } catch {
        return 'stale';
      }
    },
    snapshot(): QueueSnapshot {
      return {
        pending: [...pending].sort(byOrder).map((p) => p.job),
        inFlight: inFlightCounts(),
        bound: bound(),
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      authEpoch++;
      for (const cancel of [...timers]) safeCallCancel(cancel);
      timers.clear();
      dispatchCancel = null;
      dispatchDeadline = null;
      intervalCancel = null;
      intervalDeadline = null;
      lastStart.clear();
      projectTier.clear();
      for (const e of inFlight) {
        e.settled = true;
        safeAbort(e.controller);
      }
      inFlight.splice(0);
    },
  };
}
