// U47 provider core: registry, selection, one-hop fallback chain, OpenAI-compatible adapter (SPEC_U47 + Amendment W0-R).
import { assertProviderAllowed } from "../privacy";
import type { ProviderKind } from "../privacy";
import { validateTaskOutput, TASK_SCHEMAS } from "../schema";
import type { InferenceSource, PrivacyTier, Reject, TaskId, ValidateCtx } from "../schema";
import { AI_DEFAULTS } from "../ai/types";
import type { AiConfig, AiErrorCode, DeviceStatus, Hybrid, ModeName, TaskRequest, TaskResult } from "../ai/types";
import type { ClassifierPort } from "../router/types";
import { strictParse, toChatMessages } from "./rungs";
import { DEFAULT_PROVIDER, DEVICE_STATUS_BOUND_MS, FIREBASE_IDS, MAX_BODY_BYTES, TASK_GROUP, TIMEOUTS_MS } from "./types";
import type {
  CallTask, ChatMessage, Clock, DriftSource, EndpointInfo, FirebaseTextFn, GenerateRequest, GenerateResult, HealthState, ModelSelection,
  ModelTransport, ProviderDeps, ProviderDescriptor, ProviderDriftPort, ProviderErrorCode, ProviderGates, ProviderId,
  ProviderRegistry, ResolvedChain, Rung, TaskGroup,
} from "./types";

type FirebaseId = typeof FIREBASE_IDS[number];
const HYBRID: FirebaseId = "firebase-hybrid";
const ONDEVICE: FirebaseId = "firebase-ondevice";
const CLOUD: FirebaseId = "firebase-cloud";
const FIREBASE_SET: ReadonlySet<string> = new Set<string>(FIREBASE_IDS);
const FIREBASE_LABEL: Readonly<Record<FirebaseId, string>> = {
  "firebase-hybrid": "Firebase hybrid", "firebase-ondevice": "Firebase on-device", "firebase-cloud": "Firebase cloud",
};
const TASK_IDS: ReadonlySet<string> = new Set<string>(["status", "summary", "next_action", "plan", "digest", "screenshot"]);
const EXT_KINDS: ReadonlySet<string> = new Set<string>(["local-openai-compatible", "remote-openai-compatible"]);
/** Firebase TaskResult codes that never hop (SPEC_U47 chain execution). */
const FIREBASE_NO_HOP: ReadonlySet<string> = new Set<string>(["INPUT_OVER_BUDGET", "INPUT_REJECTED", "PRIVACY_VIOLATION"]);
/** U48 nacks that move health (Amendment W0-R): timeout/offline -> offline, policy -> blocked; others leave it. */
const NACK_OFFLINE: ReadonlySet<string> = new Set<string>(["timeout", "offline"]);
const MODE_KEYS = ["mode_status", "mode_summary", "mode_next_action", "mode_digest"] as const;
const MAX_TOKENS_CAP = 8192;
const MODE_NAMES: ReadonlySet<string> = new Set<string>(["PREFER_ON_DEVICE", "ONLY_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD"]);
const isModeName = (m: unknown): m is ModeName => typeof m === "string" && MODE_NAMES.has(m);
/** D-U47-1: forwarded progress clamped to [0,1]; none/NaN -> 0, +Infinity -> 1. */
function clampProgress(v: unknown): number {
  if (typeof v !== "number" || Number.isNaN(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

const isTaskId = (t: unknown): t is TaskId => typeof t === "string" && TASK_IDS.has(t);
const isRung = (r: unknown): r is Rung => r === 1 || r === 2 || r === 3;
const isSignal = (s: unknown): s is AbortSignal =>
  typeof s === "object" && s !== null && typeof (s as AbortSignal).addEventListener === "function"
  && typeof (s as AbortSignal).aborted === "boolean";
const freshSignal = (): AbortSignal => new AbortController().signal;

/** Fallback clock for production wiring that omits deps.clock; tests and U52 inject one. */
const HOST_CLOCK: Clock = {
  now: () => 0,
  setTimeout: (f, ms) => globalThis.setTimeout(f, ms),
  clearTimeout: (h) => { globalThis.clearTimeout(h as Parameters<typeof globalThis.clearTimeout>[0]); },
};

/** Runs a side effect (cancel, abort) without letting its exception strand a pending settle. */
function safely(f: () => void): void { try { f(); } catch { /* cancellation is best effort */ } }

/** Arms an injected-clock timer; a throwing `setTimeout` yields `TIMER_FAILED` so callers fail deterministically. */
const TIMER_FAILED: unique symbol = Symbol("timer-failed");
function armTimer(clock: Clock, f: () => void, ms: number): unknown {
  try { return clock.setTimeout(f, ms); } catch { return TIMER_FAILED; }
}
/** Clears an injected-clock timer; a throwing `clearTimeout` never blocks the settle that called it. */
function disarmTimer(clock: Clock, h: unknown): void {
  if (h === TIMER_FAILED) return;
  safely(() => { clock.clearTimeout(h); });
}

/** SPEC_U47: `fallback:true` whenever the answerer is not the step-2 candidate; a Firebase inner fallback is kept. */
export function chainFallback(candidate: ProviderId, answerer: ProviderId, innerFallback: boolean): boolean {
  return answerer !== candidate || innerFallback === true;
}

interface ExtState { info: EndpointInfo; health: HealthState; rung: Rung | null }

type Ok = { ok: true; text: string; value?: unknown; source: InferenceSource; providerId: ProviderId; modelLabel: string;
  inner?: TaskResult<TaskId> };
type Fail = { ok: false; code: ProviderErrorCode; providerId: ProviderId; hop: boolean; detail?: string;
  inner?: TaskResult<TaskId>; rejects?: Reject[] };
type Outcome = Ok | Fail;
type ChainOut = Outcome & { fallback: boolean };

interface ChainReq {
  task: CallTask; tier: PrivacyTier; prompt: string; schema: object; signal: AbortSignal;
  ctx?: ValidateCtx; maxTokens?: number; room?: string;
  taskReq?: TaskRequest<TaskId>;       // asHybrid: forwarded verbatim to Firebase instances
  firebaseMode?: unknown;              // classifier mode: ONLY_ON_DEVICE swaps firebase-hybrid for the on-device overlay
}

function groupOf(task: CallTask): TaskGroup | undefined {
  if (task === "route") return "routing";
  if (task === "drift") return "drift";
  if (isTaskId(task) && task !== "screenshot") return TASK_GROUP[task];
  return undefined;
}

function validEndpoint(e: unknown): e is EndpointInfo {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return typeof r["id"] === "string" && r["id"] !== "" && typeof r["kind"] === "string" && EXT_KINDS.has(r["kind"]);
}

function utf8Bytes(s: string): number { return new TextEncoder().encode(s).length; }

export function createProviderRegistry(deps: ProviderDeps): ProviderRegistry {
  const transport: ModelTransport | undefined = deps.transport;
  const clock: Clock = deps.clock ?? HOST_CLOCK;
  let cfg: Partial<AiConfig> = { ...(deps.config ?? {}) };
  let gates: ProviderGates = { ...(deps.gates ?? {}) };
  let selection: ModelSelection = copySelection(deps.selection);
  let exts: ExtState[] = [];
  let refreshSeq = 0;
  const overlays: { ondevice?: Hybrid; cloud?: Hybrid } = {};

  function copySelection(s: ModelSelection | undefined): ModelSelection {
    const out: ModelSelection = {};
    if (s === undefined || s === null || typeof s !== "object") return out;
    if (typeof s.all === "string") out.all = s.all;
    if (typeof s.groups === "object" && s.groups !== null) out.groups = { ...s.groups };
    return out;
  }

  const flag = (v: boolean | undefined): boolean => v === true;
  const killed = (): boolean => flag(gates.killSwitchCloud);
  const ext = (id: ProviderId): ExtState | undefined => exts.find((e) => e.info.id === id);

  // ---- Firebase overlays ----------------------------------------------------------------------
  function overlayCfg(mode: ModeName): Partial<AiConfig> {
    const o: Partial<AiConfig> = { ...cfg };
    for (const k of MODE_KEYS) o[k] = mode;
    o.mode_screenshot = "ONLY_ON_DEVICE";
    return o;
  }
  function overlay(which: "ondevice" | "cloud"): Hybrid {
    const have = overlays[which];
    if (have !== undefined) return have;
    const h = deps.makeHybrid(overlayCfg(which === "ondevice" ? "ONLY_ON_DEVICE" : "ONLY_IN_CLOUD"));
    overlays[which] = h;
    return h;
  }
  function resyncOverlays(): void {
    if (overlays.ondevice) overlays.ondevice.applyConfig(overlayCfg("ONLY_ON_DEVICE"));
    if (overlays.cloud) overlays.cloud.applyConfig(overlayCfg("ONLY_IN_CLOUD"));
  }

  // ---- descriptors ----------------------------------------------------------------------------
  function list(): readonly ProviderDescriptor[] {
    const fb: ProviderDescriptor[] = FIREBASE_IDS.map((id) => {
      const d: ProviderDescriptor = { id, kind: id, label: FIREBASE_LABEL[id], health: "available" };
      if (id === CLOUD && killed()) { d.health = "blocked"; d.blockedReason = "remote_config"; }
      return d;
    });
    const ex = exts.map((e): ProviderDescriptor => {
      const d: ProviderDescriptor = { id: e.info.id, kind: e.info.kind, label: e.info.label, health: e.health, rung: e.rung };
      if (e.health === "blocked") d.blockedReason = "policy";
      return d;
    });
    return [...fb, ...ex];
  }

  // ---- refresh / probe ------------------------------------------------------------------------
  function probeOne(info: EndpointInfo, tr: ModelTransport): Promise<ExtState> {
    if (info.kind === "remote-openai-compatible" && info.has_key !== true) {
      return Promise.resolve({ info, health: "needs_setup", rung: null });
    }
    return new Promise<ExtState>((resolve) => {
      let done = false;
      const ac = new AbortController();
      let timer: unknown;
      const finish = (health: HealthState, rung: Rung | null): void => {
        if (done) return;
        done = true; disarmTimer(clock, timer); resolve({ info, health, rung });
      };
      timer = armTimer(clock, () => {
        if (done) return;
        done = true; safely(() => { ac.abort(); }); resolve({ info, health: "offline", rung: null });
      }, Math.min(TIMEOUTS_MS.probe, TIMEOUTS_MS.ceiling));
      // No bounded probe without a timer: the endpoint is offline until a later refresh, transport is not called.
      if (timer === TIMER_FAILED) { finish("offline", null); return; }
      let p: Promise<{ state: HealthState; rung: Rung | null }>;
      try { p = Promise.resolve(tr.probe(info.id, ac.signal)); } catch (e) { p = Promise.reject(e); }
      p.then((r) => {
        const st = typeof r === "object" && r !== null ? r.state : undefined;
        if (st === "available") finish("available", isRung(r.rung) ? r.rung : null);
        else if (st === "needs_setup") finish("needs_setup", null);
        else if (st === "blocked") finish("blocked", null);
        else finish("offline", null);
      }, () => { finish("offline", null); });
    });
  }

  /** `transport.list()` bounded by the refresh budget (TIMEOUTS_MS.probe); expiry or reject = Firebase group only. */
  function boundedList(tr: ModelTransport): Promise<unknown> {
    return new Promise<unknown>((res) => {
      let done = false;
      let timer: unknown;
      const settle = (v: unknown): void => { if (done) return; done = true; disarmTimer(clock, timer); res(v); };
      timer = armTimer(clock, () => { settle([]); }, Math.min(TIMEOUTS_MS.probe, TIMEOUTS_MS.ceiling));
      // No bounded list without a timer: Firebase group only, transport.list is not called.
      if (timer === TIMER_FAILED) { settle([]); return; }
      let p: Promise<unknown>;
      try { p = Promise.resolve(tr.list()); } catch (e) { p = Promise.reject(e); }
      p.then((v) => { settle(v); }, () => { settle([]); });
    });
  }

  async function refresh(): Promise<ProviderDescriptor[]> {
    const seq = ++refreshSeq;
    const tr = transport;
    if (tr === undefined) { exts = []; return [...list()]; }
    const infos: unknown = await boundedList(tr);
    const kept: EndpointInfo[] = [];
    const seen = new Set<string>();
    for (const e of Array.isArray(infos) ? (infos as unknown[]) : []) {
      if (!validEndpoint(e) || FIREBASE_SET.has(e.id) || seen.has(e.id)) continue;
      seen.add(e.id); kept.push(e);
    }
    const next = await Promise.all(kept.map((i) => probeOne(i, tr)));
    if (seq === refreshSeq) exts = next;
    return [...list()];
  }

  // ---- selection / resolve --------------------------------------------------------------------
  function candidateOf(task: CallTask): ProviderId {
    if (task === "screenshot") return ONDEVICE;
    const g = groupOf(task);
    const fromGroup = g !== undefined ? selection.groups?.[g] : undefined;
    return fromGroup ?? selection.all ?? DEFAULT_PROVIDER;
  }
  const terminalOf = (tier: PrivacyTier): ProviderId =>
    ((tier as string) === "standard" || (tier as string) === "shared") ? HYBRID : ONDEVICE;
  const policyTaskOf = (task: CallTask): TaskId => (task === "route" || task === "drift" ? "status" : (task as TaskId));

  function resolve(task: CallTask, tier: PrivacyTier): ResolvedChain {
    if (task === "screenshot") return { primary: ONDEVICE, hop: null, blocked: undefined };
    const T = terminalOf(tier);
    const candidate = candidateOf(task);
    const blockedTo = (why: ProviderDescriptor["blockedReason"]): ResolvedChain => ({ primary: T, hop: null, blocked: why });

    let kind: ProviderKind;
    let opts: { loopback: boolean; allowPrivate: boolean; endpointEnabled: boolean };
    if (FIREBASE_SET.has(candidate)) {
      kind = candidate as FirebaseId;
      opts = { loopback: false, allowPrivate: false, endpointEnabled: true };
    } else {
      const e = ext(candidate);
      if (e === undefined) return blockedTo("unknown_id");
      kind = e.info.kind;
      opts = { loopback: e.info.loopback === true, allowPrivate: e.info.allow_private === true, endpointEnabled: e.health !== "needs_setup" };
    }
    // Remote Config gates (missing = false). A7 ruling: kill_switch_cloud also blocks remote providers (U50).
    if (kind === "local-openai-compatible" && !flag(gates.externalEnabled)) return blockedTo("remote_config");
    if (kind === "remote-openai-compatible"
      && (!flag(gates.externalEnabled) || !flag(gates.remoteEnabled) || killed())) return blockedTo("remote_config");
    if (kind === CLOUD && killed()) return blockedTo("remote_config");
    // Privacy (U46 section 2.3, delegated verbatim).
    let allowed = false;
    try { allowed = assertProviderAllowed(policyTaskOf(task), tier, kind, opts).ok === true; } catch { allowed = false; }
    if (!allowed) return blockedTo("policy");
    return { primary: candidate, hop: candidate === T || candidate === HYBRID ? null : T, blocked: undefined };
  }

  // ---- provider calls -------------------------------------------------------------------------
  function firebaseTaskReq(r: ChainReq): TaskRequest<TaskId> {
    if (r.taskReq !== undefined) return r.taskReq;
    const t: TaskRequest<TaskId> = { task: isTaskId(r.task) ? r.task : "status", projectId: "", tier: r.tier, prompt: r.prompt };
    if (r.ctx !== undefined) t.ctx = r.ctx;
    return t;
  }

  /** Firebase instance for a call; may throw (makeHybrid). Classifier modes pick the matching overlay for the default. */
  function firebaseInstance(id: FirebaseId, r: ChainReq): { inst: Hybrid; pid: FirebaseId } | "blocked" {
    if (id === ONDEVICE) return { inst: overlay("ondevice"), pid: ONDEVICE };
    if (id === CLOUD) return { inst: overlay("cloud"), pid: CLOUD };
    if (r.firebaseMode === "ONLY_ON_DEVICE") return { inst: overlay("ondevice"), pid: ONDEVICE };
    if (r.firebaseMode === "ONLY_IN_CLOUD") {
      // privacy > RC kill switch > mode: cloud only for standard/shared, never under the kill switch, U46 must allow it.
      if (!cloudModeAllowed(r)) return "blocked";
      return { inst: overlay("cloud"), pid: CLOUD };
    }
    return { inst: deps.hybrid, pid: HYBRID };
  }

  function mapFirebase(pid: FirebaseId, res: TaskResult<TaskId>): Outcome {
    if (typeof res !== "object" || res === null) return { ok: false, code: "FIREBASE_FAILED", providerId: pid, hop: true, detail: "no result" };
    if (res.ok) {
      const v: unknown = res.value;
      let text: string;
      try { text = typeof v === "string" ? v : (JSON.stringify(v) ?? ""); } catch { text = ""; }
      return { ok: true, text, value: v, source: res.source, providerId: pid, modelLabel: FIREBASE_LABEL[pid], inner: res };
    }
    const code: ProviderErrorCode = res.code === "PRIVACY_VIOLATION" ? "BLOCKED" : "FIREBASE_FAILED";
    return { ok: false, code, providerId: pid, hop: !FIREBASE_NO_HOP.has(res.code), detail: res.code, inner: res };
  }

  /** Cloud-mode admission for firebase-hybrid: privacy > RC kill switch > mode (standard/shared, U46 must allow). */
  function cloudModeAllowed(r: ChainReq): boolean {
    if (terminalOf(r.tier) !== HYBRID || killed()) return false;
    try {
      return assertProviderAllowed(policyTaskOf(r.task), r.tier, CLOUD,
        { loopback: false, allowPrivate: false, endpointEnabled: true }).ok === true;
    } catch { return false; }
  }

  /**
   * D-U47-2: route/drift through deps.firebaseText. Mode table: ondevice -> ONLY_ON_DEVICE, cloud -> ONLY_IN_CLOUD,
   * hybrid -> classifier mode (route) or private/kill switch ? ONLY_ON_DEVICE : PREFER_ON_DEVICE (drift). No overlay built.
   */
  function firebaseTextPlan(id: FirebaseId, r: ChainReq): { pid: FirebaseId; mode: ModeName } | "blocked" {
    if (id === ONDEVICE) return { pid: ONDEVICE, mode: "ONLY_ON_DEVICE" };
    if (id === CLOUD) return { pid: CLOUD, mode: "ONLY_IN_CLOUD" };
    if (r.task === "drift") {
      return { pid: HYBRID, mode: terminalOf(r.tier) !== HYBRID || killed() ? "ONLY_ON_DEVICE" : "PREFER_ON_DEVICE" };
    }
    const mode: ModeName = isModeName(r.firebaseMode) ? r.firebaseMode : "PREFER_ON_DEVICE";
    if (mode === "ONLY_ON_DEVICE") return { pid: ONDEVICE, mode };
    if (mode === "ONLY_IN_CLOUD") return cloudModeAllowed(r) ? { pid: CLOUD, mode } : "blocked";
    return { pid: HYBRID, mode };
  }

  /**
   * Firebase call bounded by deps.clock: deadline TIMEOUTS_MS.ceiling (120,000 ms, the `inference_timeout_ms` default,
   * src/config/keys.ts:13; Hybrid owns its inner budget, this only guarantees settling). Expiry -> FIREBASE_FAILED (hop);
   * caller abort -> ABORTED (no hop); late completions are ignored. Overlay creation failures are FIREBASE_FAILED too.
   */
  function boundedFirebase(pid: FirebaseId, signal: AbortSignal, start: (inner: AbortSignal) => Promise<Outcome>): Promise<Outcome> {
    if (signal.aborted) return Promise.resolve({ ok: false, code: "ABORTED", providerId: pid, hop: false });
    return new Promise<Outcome>((resolveOut) => {
      let done = false;
      let timer: unknown;
      const inner = new AbortController();
      const settle = (o: Outcome): void => {
        if (done) return;
        done = true;
        disarmTimer(clock, timer);
        safely(() => { signal.removeEventListener("abort", onAbort); });
        resolveOut(o);
      };
      const onAbort = (): void => {
        settle({ ok: false, code: "ABORTED", providerId: pid, hop: false });
        safely(() => { inner.abort(); });
      };
      timer = armTimer(clock, () => {
        settle({ ok: false, code: "FIREBASE_FAILED", providerId: pid, hop: true, detail: "timeout" });
        safely(() => { inner.abort(); });
      }, TIMEOUTS_MS.ceiling);
      if (timer === TIMER_FAILED) {
        done = true;
        resolveOut({ ok: false, code: "FIREBASE_FAILED", providerId: pid, hop: true, detail: "timer creation failed" });
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      let p: Promise<Outcome>;
      try { p = Promise.resolve(start(inner.signal)); } catch (e) { p = Promise.reject(e); }
      p.then((o) => { settle(o); }, (e: unknown) => {
        settle({ ok: false, code: "FIREBASE_FAILED", providerId: pid, hop: true, detail: e instanceof Error ? e.message : "run threw" });
      });
    });
  }

  function callFirebaseText(fn: FirebaseTextFn, id: FirebaseId, r: ChainReq): Promise<Outcome> {
    const plan = firebaseTextPlan(id, r);
    if (plan === "blocked") return Promise.resolve({ ok: false, code: "BLOCKED", providerId: CLOUD, hop: false, detail: "ONLY_IN_CLOUD not allowed" });
    const { pid, mode } = plan;
    const task = r.task as "route" | "drift";
    return boundedFirebase(pid, r.signal, (inner) => Promise.resolve(fn({ task, mode, prompt: r.prompt, schema: r.schema, signal: inner }))
      .then((out): Outcome => {
        const o = typeof out === "object" && out !== null ? out : undefined;
        if (o === undefined || typeof o.text !== "string" || (o.source !== "ON_DEVICE" && o.source !== "IN_CLOUD")) {
          return { ok: false, code: "FIREBASE_FAILED", providerId: pid, hop: true, detail: "bad firebaseText result" };
        }
        return { ok: true, text: o.text, source: o.source, providerId: pid, modelLabel: FIREBASE_LABEL[pid] };
      }));
  }

  function callFirebase(id: FirebaseId, r: ChainReq): Promise<Outcome> {
    const fn = deps.firebaseText;
    if (typeof fn === "function" && r.taskReq === undefined && (r.task === "route" || r.task === "drift")) {
      return callFirebaseText(fn, id, r);
    }
    let sel: { inst: Hybrid; pid: FirebaseId } | "blocked";
    try { sel = firebaseInstance(id, r); } catch (e) {
      return Promise.resolve({ ok: false, code: "FIREBASE_FAILED", providerId: id, hop: true,
        detail: e instanceof Error ? e.message : "overlay creation failed" });
    }
    if (sel === "blocked") return Promise.resolve({ ok: false, code: "BLOCKED", providerId: CLOUD, hop: false, detail: "ONLY_IN_CLOUD not allowed" });
    const { inst, pid } = sel;
    return boundedFirebase(pid, r.signal, () => Promise.resolve(inst.run(firebaseTaskReq(r))).then((res) => {
      try { return mapFirebase(pid, res); } catch { return { ok: false, code: "FIREBASE_FAILED", providerId: pid, hop: true, detail: "bad result" } as Outcome; }
    }));
  }

  /** Generation-driven mutation, applied only while `st` is still the installed state (a refresh replaces it). */
  const isCurrent = (st: ExtState): boolean => exts.includes(st);
  function setHealth(st: ExtState, h: HealthState): void { if (isCurrent(st)) st.health = h; }

  function defaultMaxTokens(req: number | undefined): number {
    if (typeof req === "number" && Number.isInteger(req) && req >= 1 && req <= MAX_TOKENS_CAP) return req;
    const c = cfg.max_output_tokens ?? AI_DEFAULTS.max_output_tokens;
    return Number.isInteger(c) && c >= 1 ? Math.min(c, MAX_TOKENS_CAP) : AI_DEFAULTS.max_output_tokens;
  }

  function callExternal(id: ProviderId, r: ChainReq): Promise<Outcome> {
    const e = ext(id);
    const fail = (code: ProviderErrorCode, detail?: string, rejects?: Reject[]): Outcome => {
      const f: Fail = { ok: false, code, providerId: id, hop: code !== "ABORTED" && code !== "BLOCKED" };
      if (detail !== undefined) f.detail = detail;
      if (rejects !== undefined) f.rejects = rejects;
      return f;
    };
    const tr = transport;
    if (e === undefined || tr === undefined) return Promise.resolve(fail("NEEDS_SETUP", "no transport or endpoint"));
    if (e.health === "needs_setup") return Promise.resolve(fail("NEEDS_SETUP"));
    if (e.health === "offline") return Promise.resolve(fail("OFFLINE"));
    // Host-reported or policy-nacked endpoint: no transport call, one hop (code NACK, see report).
    if (e.health === "blocked") return Promise.resolve(fail("NACK", "endpoint blocked"));
    if (r.signal.aborted) return Promise.resolve(fail("ABORTED"));

    const rung: Rung = e.rung ?? 2;
    const messages: ChatMessage[] = toChatMessages(r.prompt, r.schema, rung);
    const maxTokens = defaultMaxTokens(r.maxTokens);
    const inner = new AbortController();
    const treq: Parameters<ModelTransport["generate"]>[0] = { id, messages, maxTokens, rung, tier: r.tier, signal: inner.signal };
    if (rung === 1) treq.schema = r.schema;
    if (r.room !== undefined) treq.room = r.room;
    let bodyBytes: number;
    try {
      const sized: Record<string, unknown> = { id, messages, maxTokens, schema: treq.schema, rung, tier: r.tier };
      if (r.room !== undefined) sized["room"] = r.room;
      bodyBytes = utf8Bytes(JSON.stringify(sized));
    } catch { return Promise.resolve(fail("BODY_TOO_LARGE", "unserialisable request")); }
    if (bodyBytes > MAX_BODY_BYTES) return Promise.resolve(fail("BODY_TOO_LARGE"));

    const isLocal = e.info.kind === "local-openai-compatible";
    const budget = Math.min(isLocal ? TIMEOUTS_MS.local : TIMEOUTS_MS.remote, TIMEOUTS_MS.ceiling);
    const source: InferenceSource = isLocal ? "LOCAL_SERVER" : "REMOTE_PROVIDER";
    const modelLabel = typeof e.info.label === "string" && e.info.label !== "" ? e.info.label : String(e.info.model ?? id);
    const signal = r.signal;

    return new Promise<Outcome>((resolveOut) => {
      let done = false;
      let timer: unknown;
      const onAbort = (): void => {
        if (done) return;
        done = true;
        disarmTimer(clock, timer);
        safely(() => { inner.abort(); });
        safely(() => { tr.cancel(id); });
        resolveOut(fail("ABORTED"));
      };
      const finish = (o: Outcome): void => {
        if (done) return;
        done = true;
        disarmTimer(clock, timer);
        safely(() => { signal.removeEventListener("abort", onAbort); });
        resolveOut(o);
      };
      timer = armTimer(clock, () => {
        if (done) return;
        done = true;
        safely(() => { signal.removeEventListener("abort", onAbort); });
        setHealth(e, "offline");
        safely(() => { inner.abort(); });
        safely(() => { tr.cancel(id); });
        resolveOut(fail("TIMEOUT"));
      }, budget);
      // No bounded call without a timer: fail before the transport is touched; health is not a transport fact.
      if (timer === TIMER_FAILED) { done = true; resolveOut(fail("TIMEOUT", "timer creation failed")); return; }
      signal.addEventListener("abort", onAbort, { once: true });

      let p: Promise<{ ok: true; text: string } | { ok: false; nack: string }>;
      try { p = Promise.resolve(tr.generate(treq)); } catch (err) { p = Promise.reject(err); }
      p.then((out) => {
        if (done) return;
        if (typeof out !== "object" || out === null) { finish(fail("SCHEMA_REJECT", "no reply")); return; }
        if (out.ok !== true) {
          const nack = typeof (out as { nack?: unknown }).nack === "string" ? (out as { nack: string }).nack : "unknown";
          if (NACK_OFFLINE.has(nack)) setHealth(e, "offline");
          else if (nack === "policy") setHealth(e, "blocked");
          if (rung === 1 && isCurrent(e)) e.rung = 2;
          finish(fail("NACK", nack));
          return;
        }
        let text: unknown = out.text;
        if (typeof text !== "string") { finish(fail("SCHEMA_REJECT", "non-string reply")); return; }
        if (rung === 3) {
          const s = strictParse(text);
          if (s === null) { finish(fail("SCHEMA_REJECT", "rung 3 strict parse")); return; }
          text = s;
        }
        const t = text as string;
        if (isTaskId(r.task)) {
          const v = validateTaskOutput(r.task, t, r.ctx);
          if (!v.ok) { finish(fail("SCHEMA_REJECT", "validator", v.errors)); return; }
          finish({ ok: true, text: t, value: v.value, source, providerId: id, modelLabel });
          return;
        }
        finish({ ok: true, text: t, source, providerId: id, modelLabel });
      }, (err: unknown) => {
        if (done) return;
        setHealth(e, "offline");
        finish(fail("OFFLINE", err instanceof Error ? err.message : "transport error"));
      });
    });
  }

  function callProvider(id: ProviderId, r: ChainReq): Promise<Outcome> {
    return FIREBASE_SET.has(id) ? callFirebase(id as FirebaseId, r) : callExternal(id, r);
  }

  async function runChain(r: ChainReq): Promise<ChainOut> {
    const candidate = candidateOf(r.task);
    if (r.signal.aborted) return { ok: false, code: "ABORTED", providerId: candidate, hop: false, fallback: false };
    const chain = resolve(r.task, r.tier);
    const fb = (o: Outcome): boolean => chainFallback(candidate, o.providerId, o.inner?.fallback === true);
    const first = await callProvider(chain.primary, r);
    if (first.ok || !first.hop || chain.hop === null) return { ...first, fallback: fb(first) };
    if (r.signal.aborted) return { ok: false, code: "ABORTED", providerId: first.providerId, hop: false, fallback: fb(first) };
    const second = await callProvider(chain.hop, r);
    return { ...second, fallback: true };
  }

  function toGenerateResult(o: ChainOut): GenerateResult {
    if (o.ok) return { ok: true, text: o.text, source: o.source, providerId: o.providerId, modelLabel: o.modelLabel, fallback: o.fallback };
    const g: GenerateResult = { ok: false, code: o.code, providerId: o.providerId, fallback: o.fallback };
    if (o.detail !== undefined) g.detail = o.detail;
    return g;
  }

  function chainReqOf(req: GenerateRequest): ChainReq {
    const r: ChainReq = {
      task: req.task, tier: req.tier, prompt: req.prompt, schema: req.schema,
      signal: isSignal(req.signal) ? req.signal : freshSignal(),
    };
    if (req.ctx !== undefined) r.ctx = req.ctx;
    if (req.maxTokens !== undefined) r.maxTokens = req.maxTokens;
    if (typeof req.room === "string") r.room = req.room;
    return r;
  }

  async function generate(req: GenerateRequest): Promise<GenerateResult> {
    return toGenerateResult(await runChain(chainReqOf(req)));
  }

  /**
   * D-U47-1: one in-flight default init shared by every caller; overlays start in the background (never awaited,
   * rejections swallowed). Each call races the attempt against its own DEVICE_STATUS_BOUND_MS on deps.clock: settle
   * first -> that status (rejection propagates); bound first -> `downloading` with the last forwarded progress.
   * A-U52b-r1: the attempt is installed with its real waiter set BEFORE deps.hybrid.initDevice runs, so a caller that
   * re-enters from a synchronous progress callback joins the real attempt. One completion dispatcher per attempt;
   * each caller is a removable waiter (progress callback included) detached on every settlement path.
   */
  type InitOutcome = { ok: true; st: DeviceStatus } | { ok: false; e: unknown };
  interface InitWaiter { onProgress: ((p: number) => void) | undefined; settle(o: InitOutcome): void }
  interface InitAttempt { last: number | undefined; waiters: Set<InitWaiter> }
  let initInFlight: InitAttempt | null = null;

  function launchInit(att: InitAttempt): void {
    const forward = (v: number): void => {
      att.last = v;
      for (const w of [...att.waiters]) {
        const f = w.onProgress;
        if (f !== undefined && att.waiters.has(w)) safely(() => { f(v); });
      }
    };
    let raw: Promise<DeviceStatus>;
    try { raw = Promise.resolve(deps.hybrid.initDevice(forward)); } catch (e) { raw = Promise.reject(e); }
    const dispatch = (o: InitOutcome): void => {
      if (initInFlight === att) initInFlight = null;
      const ws = [...att.waiters];
      att.waiters.clear();
      for (const w of ws) w.settle(o);
    };
    // single dispatcher; a rejection landing after every bound is swallowed here
    raw.then((st) => { dispatch({ ok: true, st }); }, (e: unknown) => { dispatch({ ok: false, e }); });
    for (const o of [overlays.ondevice, overlays.cloud]) {
      if (o === undefined) continue;
      try { Promise.resolve(o.initDevice()).catch(() => undefined); } catch { /* overlay readiness is not the default's status */ }
    }
  }

  function initDevice(onProgress?: (p: number) => void): Promise<DeviceStatus> {
    let res!: (s: DeviceStatus) => void;
    let rej!: (e: unknown) => void;
    const out = new Promise<DeviceStatus>((a, b) => { res = a; rej = b; });
    let a = initInFlight;
    const fresh = a === null;
    if (a === null) { a = { last: undefined, waiters: new Set() }; initInFlight = a; }
    const att = a;
    let settled = false;
    let timer: unknown;
    const downloading = (): DeviceStatus => ({ state: "downloading", progress: clampProgress(att.last) });
    const w: InitWaiter = {
      onProgress: typeof onProgress === "function" ? onProgress : undefined,
      settle: (o) => {
        if (settled) return;
        settled = true; att.waiters.delete(w);
        if (timer !== undefined) disarmTimer(clock, timer);
        if (o.ok) res(o.st); else rej(o.e);
      },
    };
    // waiter registered before the init call so synchronously forwarded progress reaches the caller
    att.waiters.add(w);
    if (fresh) launchInit(att);
    if (settled) return out;
    timer = armTimer(clock, () => {
      if (settled) return;
      settled = true; att.waiters.delete(w); res(downloading());
    }, DEVICE_STATUS_BOUND_MS);
    if (timer === TIMER_FAILED) { settled = true; att.waiters.delete(w); res(downloading()); }
    return out;
  }

  // ---- adapters -------------------------------------------------------------------------------
  const EXT_ERR: Readonly<Partial<Record<ProviderErrorCode, AiErrorCode>>> = {
    TIMEOUT: "CLOUD_UNAVAILABLE", OFFLINE: "CLOUD_UNAVAILABLE", NACK: "CLOUD_UNAVAILABLE", NEEDS_SETUP: "CLOUD_UNAVAILABLE",
    BODY_TOO_LARGE: "CLOUD_UNAVAILABLE", ABORTED: "CLOUD_UNAVAILABLE", FIREBASE_FAILED: "CLOUD_UNAVAILABLE",
    BLOCKED: "PRIVACY_VIOLATION", SCHEMA_REJECT: "SCHEMA_REJECT",
  };

  const hybridView: Hybrid = {
    async run<K extends TaskId>(req: TaskRequest<K>): Promise<TaskResult<K>> {
      const task = req.task as TaskId;
      const schema = (TASK_SCHEMAS as Record<string, { schema: object } | undefined>)[task]?.schema ?? {};
      const r: ChainReq = { task, tier: req.tier, prompt: req.prompt, schema, signal: freshSignal(), taskReq: req as TaskRequest<TaskId> };
      if (req.ctx !== undefined) r.ctx = req.ctx;
      const o = await runChain(r);
      const meta = { task, mode: "PREFER_ON_DEVICE" as ModeName, configGen: -1,
        prompt_version: cfg.prompt_version ?? AI_DEFAULTS.prompt_version, called: true };
      if (o.inner !== undefined) return { ...o.inner, fallback: o.inner.fallback || o.fallback } as TaskResult<K>;
      if (o.ok) return { ok: true, value: o.value, source: o.source, fallback: o.fallback, meta } as TaskResult<K>;
      const out: { ok: false; code: AiErrorCode; fallback: boolean; meta: typeof meta; rejects?: Reject[]; detail?: string } =
        { ok: false, code: EXT_ERR[o.code] ?? "CLOUD_UNAVAILABLE", fallback: o.fallback, meta };
      if (o.code === "SCHEMA_REJECT" && o.rejects !== undefined) out.rejects = o.rejects;
      if (o.detail !== undefined) out.detail = o.detail;
      return out as TaskResult<K>;
    },
    initDevice: (onProgress?: (p: number) => void) => initDevice(onProgress),
    deviceStatus: () => deps.hybrid.deviceStatus(),
    applyConfig(patch: Partial<AiConfig>) {
      const out = deps.hybrid.applyConfig(patch);
      cfg = { ...cfg, ...(patch ?? {}) };
      resyncOverlays();
      return out;
    },
  };

  const DRIFT_SOURCE: Readonly<Record<string, DriftSource>> = {
    ON_DEVICE: "device", IN_CLOUD: "cloud", LOCAL_SERVER: "local", REMOTE_PROVIDER: "remote",
  };

  return {
    refresh,
    list,
    select(sel: ModelSelection): void { selection = copySelection(sel); },
    applyRemoteConfig(patch: Partial<AiConfig>, g: ProviderGates): void {
      cfg = { ...cfg, ...(patch ?? {}) };
      gates = typeof g === "object" && g !== null ? { ...g } : {};
      resyncOverlays();
    },
    resolve,
    initDevice,
    generate,
    asHybrid: () => hybridView,
    asClassifierPort(tier: PrivacyTier): ClassifierPort {
      return async (req) => {
        try {
          const r: ChainReq = {
            task: "route", tier, prompt: req.prompt, schema: req.constraint,
            signal: isSignal(req.signal) ? req.signal : freshSignal(), firebaseMode: req.mode,
          };
          const o = await runChain(r);
          return o.ok ? { text: o.text, source: o.source } : null;
        } catch {
          return null;
        }
      };
    },
    asDriftPort(tier: PrivacyTier): ProviderDriftPort {
      return {
        async generate(prompt: string, schema: object, signal: AbortSignal, room?: string): Promise<{ text: string; source: DriftSource }> {
          const chain: ChainReq = { task: "drift", tier, prompt, schema, signal: isSignal(signal) ? signal : freshSignal() };
          if (typeof room === "string") chain.room = room;
          const o = await runChain(chain);
          if (!o.ok) throw new Error(`provider drift port: ${o.code}${o.detail !== undefined ? ` (${o.detail})` : ""}`);
          const source = DRIFT_SOURCE[o.source];
          if (source === undefined) throw new Error("provider drift port: unrecognised inference source");
          return { text: o.text, source };
        },
      };
    },
  };
}
