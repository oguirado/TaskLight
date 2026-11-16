// U93 oracle seam. Names not fixed in SPEC.md are a documented harness ABI.
import type { PrivacyTier, InferenceSource } from "../schema";
import type { ProviderErrorCode, GenerateRequest, ModelSelection, ResolvedChain } from "../providers/types";

export type LiaisonKind = "draft" | "summary" | "clarify";
export type LiaisonState = "empty" | "starting" | "ready" | "degraded" | "paused" | "error";
export interface LiaisonInput {
  room: string; task_id: string; micro_id?: string;
  human: { id: string; text: string }; tier: PrivacyTier;
  rules: string; projection: unknown;
  history: readonly { id: string; text: string; [key: string]: unknown }[];
  cursor: number;
}
export interface LiaisonBinding { providerId: string | null; generation: number }
export type LiaisonSelection = Omit<ModelSelection, "groups"> & {
  groups?: NonNullable<ModelSelection["groups"]> & { liaison?: string };
};
export type LiaisonGenerateRequest = Omit<GenerateRequest, "task"> & { task: "liaison" };
export type LiaisonProviderResult =
  | { ok: true; text: string; providerId: string; modelLabel?: string; source: InferenceSource; fallback: boolean }
  | { ok: false; code: ProviderErrorCode; providerId: string; fallback: boolean; detail?: string };
export interface LiaisonProviderPort {
  select(selection: LiaisonSelection): void;
  getSelection?(): LiaisonSelection;
  resolve(task: "liaison", tier: PrivacyTier): ResolvedChain;
  generate(request: LiaisonGenerateRequest): Promise<LiaisonProviderResult>;
}
export interface DraftStorage {
  setItem(key: string, value: string): void | Promise<void>;
  getItem?(key: string): string | null | Promise<string | null>;
}
export interface LiaisonOutput { kind: LiaisonKind; text: string; refs: string[] }
export interface LiaisonAttribution {
  providerId: string; modelLabel?: string; source: InferenceSource | "rules";
  fallback: boolean; reason?: string; admission?: string;
}
export type LiaisonResult =
  | { ok: true; output: LiaisonOutput; attribution: LiaisonAttribution }
  | { ok: false; code: ProviderErrorCode | "PERSIST_FAILED"; reason?: string };
export interface LiaisonIdentity {
  readonly room: string; readonly task_id: string; readonly tier: PrivacyTier;
  readonly human: Readonly<LiaisonInput["human"]>;
  readonly generation: number | undefined; readonly requestId: number;
}
export interface LiaisonSnapshot {
  state: LiaisonState; reason: string; input?: LiaisonInput; result?: LiaisonResult;
  identity?: LiaisonIdentity;
}
export interface LiaisonController {
  generate(input: LiaisonInput, kind?: LiaisonKind): Promise<LiaisonResult>;
  setBinding(room: string, binding: LiaisonBinding | undefined, task_id?: string): void;
  setContext(input: LiaisonInput): void;
  snapshot(): LiaisonSnapshot;
  subscribe(listener: () => void): () => void;
  pause(): void;
  resume(): void;
  destroy(): void;
}
export interface LiaisonDeps { registry: LiaisonProviderPort; storage?: DraftStorage }

type LiaisonFailure = Extract<LiaisonResult, { ok: false }>;
type LiaisonSuccess = Extract<LiaisonResult, { ok: true }>;

const LIAISON_KINDS: ReadonlySet<string> = new Set<string>(["draft", "summary", "clarify"]);
const VALID_TIERS: ReadonlySet<string> = new Set<string>(["private", "standard", "shared"]);
const RULES_CODES: ReadonlySet<string> = new Set<string>([
  "OFFLINE", "TIMEOUT", "NEEDS_SETUP", "NACK", "FIREBASE_FAILED", "BODY_TOO_LARGE",
]);
export const LIAISON_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["draft", "summary", "clarify"] },
    text: { type: "string" },
    refs: { type: "array", items: { type: "string" } },
  },
  required: ["kind", "text", "refs"],
  additionalProperties: false,
} as const;

const PAUSED_REASON = "Liaison locally suspended; executor status unchanged";
const MAX_TEXT = 2000;
const MAX_REFS = 20;
const HISTORY_WINDOW = 20;

function storageKey(room: string, taskId: string): string {
  return `tasklight.liaison.v1:${room}:${taskId}`;
}

function defaultStorage(): DraftStorage {
  return {
    setItem: (key: string, value: string): void => {
      globalThis.localStorage.setItem(key, value);
    },
    getItem: (key: string): string | null => globalThis.localStorage.getItem(key),
  };
}

function validateOutput(raw: string, historyIds: ReadonlySet<string>, requestedKind: LiaisonKind): LiaisonOutput | { reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reason: "Output is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { reason: "Output must be a closed JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== "kind" || keys[1] !== "refs" || keys[2] !== "text") {
    return { reason: "Output must contain exactly kind, text and refs" };
  }
  const kind: unknown = record["kind"];
  if (typeof kind !== "string" || !LIAISON_KINDS.has(kind)) {
    return { reason: "Output kind must be draft, summary or clarify" };
  }
  if (kind !== requestedKind) return { reason: `Output kind must match requested ${requestedKind}` };
  const text: unknown = record["text"];
  if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT || text.trim().length === 0) {
    return { reason: "Output text must be non-whitespace 1..2000 characters" };
  }
  const refs: unknown = record["refs"];
  if (!Array.isArray(refs) || refs.length > MAX_REFS) {
    return { reason: "Output refs must be an array of at most 20 entries" };
  }
  for (const ref of refs as unknown[]) {
    if (typeof ref !== "string" || !historyIds.has(ref)) {
      return { reason: "Output refs must name input history events" };
    }
  }
  return { kind: kind as LiaisonKind, text, refs: [...(refs as string[])] };
}

function safeStringifyProjection(projection: unknown): string {
  try {
    const out: unknown = JSON.stringify(projection);
    return typeof out === "string" ? out : String(projection ?? "");
  } catch {
    return typeof projection === "string" ? projection : "";
  }
}

function buildPrompt(input: LiaisonInput, kind: LiaisonKind): string {
  const window = input.history.slice(-HISTORY_WINDOW);
  const parts: string[] = [];
  parts.push(`[kind] ${kind}`);
  parts.push(`[rules]\n${input.rules}`);
  const humanId = input.human.id.replace(/[^A-Za-z0-9_.:-]/g, "_");
  parts.push(`[human:${humanId}]\n${input.human.text}`);
  parts.push(`[projection]\n${safeStringifyProjection(input.projection)}`);
  if (typeof input.micro_id === "string" && input.micro_id !== "") {
    parts.push(`[micro_id] ${input.micro_id}`);
  }
  parts.push(`[history]\n${JSON.stringify(window.map(({ id, text }) => ({ id, text })))}`);
  return parts.join("\n");
}

// Bound injected ports even when they ignore AbortSignal. The underlying promise
// remains observed after cancellation, including a late rejection.
class PendingOperationError extends Error {
  constructor(readonly code: "ABORTED" | "TIMEOUT") { super(code === "TIMEOUT" ? "Liaison operation timed out" : "Liaison request aborted"); }
}
function bounded<T>(start: () => T | PromiseLike<T>, signal: AbortSignal, timeout: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(new PendingOperationError("ABORTED")); return; }
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (ok: boolean, value: unknown): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (ok) resolve(value as T); else reject(value);
    };
    const onAbort = (): void => settle(false, new PendingOperationError("ABORTED"));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      timer = setTimeout(() => settle(false, new PendingOperationError("TIMEOUT")), timeout);
      if (signal.aborted) { onAbort(); return; }
      Promise.resolve(start()).then(value => settle(true, value), error => settle(false, error));
    } catch (error) { settle(false, error); }
  });
}
const PERSIST_DEADLINE_MS = 10_000;
const GENERATION_DEADLINE_MS = 120_000;

export function createLiaisonController(deps: LiaisonDeps): LiaisonController {
  const registry = deps.registry;
  const storage = deps.storage ?? defaultStorage();
  let state: LiaisonState = "empty";
  let reason = "No liaison generation yet";
  let lastInput: LiaisonInput | undefined;
  let lastResult: LiaisonResult | undefined;
  let identity: LiaisonIdentity | undefined;
  const listeners = new Set<() => void>();
  const roomBindings = new Map<string, LiaisonBinding>();
  const taskBindings = new Map<string, LiaisonBinding>();
  // Queue raw storage completion, never its abort/deadline race. A cancelled
  // write may still commit; no newer write to that key may overtake it.
  const writes = new Map<string, Promise<void>>();
  let paused = false;
  let destroyed = false;
  let seq = 0;
  let droveSelection = false;
  let inflight: { identity: LiaisonIdentity; ac: AbortController } | undefined;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* isolate subscribers */ }
    }
  };
  const taskKey = (room: string, taskId: string): string => JSON.stringify([room, taskId]);
  const effectiveBinding = (room: string, taskId: string): LiaisonBinding | undefined =>
    taskBindings.get(taskKey(room, taskId)) ?? roomBindings.get(room);
  const publish = (nextState: LiaisonState, nextReason: string, result?: LiaisonResult): void => {
    state = nextState; reason = nextReason;
    if (result !== undefined) lastResult = result;
    notify();
  };
  const abort = (): void => {
    seq += 1;
    const old = inflight; inflight = undefined;
    old?.ac.abort();
  };
  const invalidate = (): void => {
    abort(); lastResult = undefined; identity = undefined;
    state = paused ? "paused" : "empty";
    reason = paused ? PAUSED_REASON : "Context changed; generate a new liaison draft";
  };
  const sameContext = (a: Pick<LiaisonInput, "room" | "task_id" | "tier" | "human">,
    b: Pick<LiaisonInput, "room" | "task_id" | "tier" | "human">): boolean =>
    a.room === b.room && a.task_id === b.task_id && a.tier === b.tier
      && a.human.id === b.human.id && a.human.text === b.human.text;
  const capture = (input: LiaisonInput): LiaisonInput => {
    const snapshot = { ...input, human: { ...input.human } };
    if (typeof snapshot.human.id !== "string" || typeof snapshot.human.text !== "string" || typeof snapshot.rules !== "string"
      || !Array.isArray(snapshot.history)) throw new Error("Invalid liaison input or history");
    const history = snapshot.history.map(entry => {
      if (entry === null || typeof entry !== "object" || typeof entry.id !== "string" || entry.id.trim() === ""
        || typeof entry.text !== "string") throw new Error("History events require string IDs and text");
      return { ...entry };
    });
    return { ...snapshot, history };
  };
  const abortedResult = (): LiaisonFailure => ({ ok: false, code: "ABORTED", reason: "Liaison request aborted; late output discarded" });

  const generate = async (provided: LiaisonInput, kind: LiaisonKind = "draft"): Promise<LiaisonResult> => {
    // Supersede before *every* early return, including a missing privacy floor.
    abort(); lastResult = undefined; identity = undefined;
    if (destroyed) return abortedResult();
    let input: LiaisonInput;
    try { input = capture(provided); } catch (error) {
      lastInput = undefined;
      const result: LiaisonFailure = { ok: false, code: "SCHEMA_REJECT",
        reason: error instanceof Error ? error.message : "Invalid liaison input" };
      publish(paused ? "paused" : "error", result.reason!, result); return result;
    }
    lastInput = input;
    const failEarly = (nextState: LiaisonState, message: string): LiaisonFailure => {
      const result: LiaisonFailure = { ok: false, code: "BLOCKED", reason: message };
      publish(nextState, message, result); return result;
    };
    if (paused) return failEarly("paused", PAUSED_REASON);
    if (!VALID_TIERS.has(input.tier)) return failEarly("error", "Missing or unrecognized host privacy floor; liaison blocked");
    const binding = effectiveBinding(input.room, input.task_id);
    if (binding?.providerId === null) return failEarly("empty", "No liaison provider bound for this room/task; inference skipped");
    const scope: LiaisonIdentity = Object.freeze({ room: input.room, task_id: input.task_id, tier: input.tier,
      human: Object.freeze({ ...input.human }), generation: binding?.generation, requestId: seq });
    identity = scope;
    const ac = new AbortController();
    const current = { identity: scope, ac };
    inflight = current;
    const stale = (): boolean => destroyed || ac.signal.aborted || scope.requestId !== seq
      || lastInput === undefined || !sameContext(scope, lastInput)
      || effectiveBinding(scope.room, scope.task_id)?.generation !== scope.generation;
    const finish = (result: LiaisonResult, nextState: LiaisonState, message: string): LiaisonResult => {
      if (stale()) return abortedResult();
      if (inflight === current) inflight = undefined;
      publish(nextState, message, result); return result;
    };
    publish("starting", "Generating liaison draft");
    try {
      const key = storageKey(input.room, input.task_id);
      const value = JSON.stringify({ human: input.human, cursor: input.cursor });
      await bounded(() => {
        const previous = writes.get(key) ?? Promise.resolve();
        const raw = previous.catch(() => {}).then(async () => {
          if (stale()) throw new PendingOperationError("ABORTED");
          await storage.setItem(key, value);
          if (storage.getItem !== undefined && await storage.getItem(key) !== value) {
            throw new Error("Pending draft persistence could not be verified");
          }
        });
        writes.set(key, raw);
        const cleanup = (): void => { if (writes.get(key) === raw) writes.delete(key); };
        void raw.then(cleanup, cleanup);
        return raw;
      }, ac.signal, PERSIST_DEADLINE_MS);
    } catch (error) {
      if (stale()) return abortedResult();
      const result: LiaisonFailure = { ok: false, code: "PERSIST_FAILED",
        reason: error instanceof Error ? error.message : "Pending draft storage failed" };
      // Publish the storage failure before cancelling its still-pending port.
      const out = finish(result, "error", result.reason!); ac.abort(); return out;
    }
    if (stale()) return abortedResult();
    if (binding !== undefined || droveSelection) {
      try {
        const selection = registry.getSelection?.() ?? {};
        const groups = { ...selection.groups };
        if (binding?.providerId !== undefined && binding.providerId !== null) groups.liaison = binding.providerId;
        else delete groups.liaison;
        registry.select({ ...selection, groups });
        droveSelection = binding !== undefined;
      } catch (error) {
        const result: LiaisonFailure = { ok: false, code: "BLOCKED",
          reason: error instanceof Error ? error.message : "Provider selection failed" };
        return finish(result, "error", result.reason!);
      }
    }
    if (stale()) return abortedResult();
    let blockedReason: string | undefined;
    try {
      const chain = registry.resolve("liaison", scope.tier);
      if (chain.blocked !== undefined) blockedReason = `Selected provider blocked: ${chain.blocked}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Provider policy resolution failed";
      return finish({ ok: false, code: "BLOCKED", reason: message }, "error", message);
    }
    const admission = `Admitted by ${scope.tier} room policy${blockedReason === undefined ? "" : `; ${blockedReason}`}`;
    let request: LiaisonGenerateRequest;
    try {
      request = { task: "liaison", tier: scope.tier, room: scope.room,
        prompt: buildPrompt(input, kind), schema: LIAISON_SCHEMA, signal: ac.signal };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not build liaison prompt";
      return finish({ ok: false, code: "SCHEMA_REJECT", reason: message }, "error", message);
    }
    if (stale()) return abortedResult();
    const historyIds = new Set(input.history.slice(-HISTORY_WINDOW).map(entry => entry.id));
    let provider: LiaisonProviderResult;
    try {
      provider = await bounded(() => registry.generate(request), ac.signal, GENERATION_DEADLINE_MS);
    } catch (error) {
      if (stale()) return abortedResult();
      if (error instanceof PendingOperationError && error.code === "TIMEOUT") {
        const result: LiaisonFailure = { ok: false, code: "TIMEOUT", reason: error.message };
        const out = finish(result, "error", error.message); ac.abort(); return out;
      }
      provider = { ok: false, code: "OFFLINE", providerId: "firebase-hybrid", fallback: false,
        detail: error instanceof Error ? error.message : "Provider call failed" };
    }
    if (stale()) return abortedResult();
    if (!provider.ok) {
      const detail = provider.detail || `Provider failed (${provider.code})`;
      if (RULES_CODES.has(provider.code)) {
        const checked = validateOutput(JSON.stringify({ kind: "draft", text: input.human.text, refs: [] }), historyIds, "draft");
        if ("reason" in checked) return finish({ ok: false, code: "SCHEMA_REJECT", reason: checked.reason }, "error", checked.reason);
        const result: LiaisonSuccess = { ok: true, output: checked,
          attribution: { providerId: "rules", source: "rules", fallback: true, admission,
            reason: `${blockedReason === undefined ? "" : `${blockedReason}; `}${detail}; Rules fallback` } };
        return finish(result, "degraded", result.attribution.reason!);
      }
      return finish({ ok: false, code: provider.code, reason: detail }, "error", detail);
    }
    const checked = validateOutput(provider.text, historyIds, kind);
    if ("reason" in checked) return finish({ ok: false, code: "SCHEMA_REJECT", reason: checked.reason }, "error", checked.reason);
    const attribution: LiaisonAttribution = { providerId: provider.providerId, source: provider.source, fallback: provider.fallback,
      admission };
    if (provider.modelLabel) attribution.modelLabel = provider.modelLabel;
    if (provider.fallback) attribution.reason = `${blockedReason === undefined ? "" : `${blockedReason}; `}Fallback provider answered`;
    return finish({ ok: true, output: checked, attribution }, provider.fallback ? "degraded" : "ready",
      provider.fallback ? attribution.reason! : "Liaison ready");
  };

  const setBinding = (room: string, binding: LiaisonBinding | undefined, task_id?: string): void => {
    if (destroyed) return;
    const before = lastInput === undefined ? undefined : effectiveBinding(lastInput.room, lastInput.task_id);
    const map = task_id === undefined ? roomBindings : taskBindings;
    const key = task_id === undefined ? room : taskKey(room, task_id);
    if (binding === undefined) map.delete(key); else map.set(key, { ...binding });
    const after = lastInput === undefined ? undefined : effectiveBinding(lastInput.room, lastInput.task_id);
    if (before?.generation !== after?.generation || before?.providerId !== after?.providerId) { invalidate(); notify(); }
  };
  const setContext = (input: LiaisonInput): void => {
    if (destroyed) return;
    let nextInput: LiaisonInput;
    try { nextInput = capture(input); } catch (error) {
      invalidate(); lastInput = undefined;
      const message = error instanceof Error ? error.message : "Invalid liaison context";
      publish(paused ? "paused" : "error", message, { ok: false, code: "SCHEMA_REJECT", reason: message }); return;
    }
    const changed = lastInput === undefined || !sameContext(lastInput, nextInput);
    if (changed) invalidate();
    lastInput = nextInput;
    if (changed) notify();
  };
  return {
    generate, setBinding, setContext,
    snapshot: (): LiaisonSnapshot => ({ state, reason, ...(lastInput === undefined ? {} : { input: capture(lastInput) }),
      ...(lastResult === undefined ? {} : { result: lastResult }), ...(identity === undefined ? {} : { identity }) }),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    pause: () => { if (!destroyed) { paused = true; abort(); publish("paused", PAUSED_REASON); } },
    resume: () => {
      if (destroyed || !paused) return;
      paused = false;
      if (lastResult?.ok === true) publish(lastResult.attribution.fallback ? "degraded" : "ready",
        lastResult.attribution.reason ?? "Liaison ready");
      else if (lastResult?.ok === false && lastResult.reason !== PAUSED_REASON) publish("error", lastResult.reason ?? lastResult.code);
      else { lastResult = undefined; publish("empty", "No liaison generation yet"); }
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true; invalidate(); publish("error", "Liaison destroyed"); listeners.clear();
    },
  };
}
