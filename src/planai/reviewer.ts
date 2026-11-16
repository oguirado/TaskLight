import type { DriftSource, DriftVerdict } from "../agents/types";
import type { ModeName } from "../ai/types";
import type { DriftFloor } from "../app/agent_drift";
import { PLANAI_LIMITS } from "./types";
import type { PlanAi, PlanAiPort, PlanAiClock, PlanAiOptions, PlanTaskInput, PlanBriefInput, PlanBrief, BriefContext, ReviewContext, PlanAiFallbackReason } from "./types";
import { TASK_REVIEW_SCHEMA, PLAN_BRIEF_SCHEMA, parseTaskReviewOutput, parsePlanBriefOutput } from "./schema";
import { buildTaskReviewPrompt, buildPlanBriefPrompt } from "./prompt";
import { reviewTaskRules, briefPlanRules } from "./rules";

const defaultClock: PlanAiClock = {
  setTimeout: (cb: () => void, ms: number): unknown => globalThis.setTimeout(cb, ms),
  clearTimeout: (handle: unknown): void => {
    globalThis.clearTimeout(handle as number);
  },
};

const VALID_SOURCES: ReadonlySet<string> = new Set(["device", "cloud", "local", "remote"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function safeReviewRules(task: unknown): DriftVerdict {
  try {
    return reviewTaskRules(task as PlanTaskInput);
  } catch {
    return { verdict: "needs_user", reason: "Review unavailable; operator input required", source: "rules" };
  }
}

function safeBriefRules(plan: unknown): PlanBrief {
  try {
    return briefPlanRules(plan as PlanBriefInput);
  } catch {
    return { brief: "Next: none; 0 blocked", source: "rules" };
  }
}

const states = new Set(["pending", "active", "blocked", "done"]);
const strings = (v: unknown): boolean => Array.isArray(v) && v.every(x => typeof x === "string");
const count = (v: unknown): boolean => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const fields = (v: Record<string, unknown>, keys: string[]): boolean => keys.every(k => typeof v[k] === "string");
function validTask(v: unknown): v is PlanTaskInput {
  return isRecord(v) && fields(v, ["id", "title", "type", "phase", "accept"]) &&
    (states.has(v["status"] as string) || v["status"] === "cancelled") && count(v["rev"]) && strings(v["deps"]) &&
    Array.isArray(v["microtasks"]) && v["microtasks"].every(m => isRecord(m) && fields(m, ["id", "text"]) &&
      states.has(m["state"] as string) && ["accept", "outcome"].every(k => m[k] === undefined || typeof m[k] === "string"));
}
function validPlan(v: unknown): v is PlanBriefInput {
  return isRecord(v) && fields(v, ["planId", "title", "phase"]) &&
    (v["status"] === "active" || v["status"] === "closed") && count(v["rev"]) &&
    count(v["doneMicrotasks"]) && count(v["totalMicrotasks"]) && Array.isArray(v["tasks"]) &&
    v["tasks"].every(t => isRecord(t) && fields(t, ["id", "title"]) &&
      (states.has(t["state"] as string) || t["state"] === "cancelled") && typeof t["ready"] === "boolean" && strings(t["waitsFor"]));
}

type Job = "task_review" | "plan_brief";

export function createPlanAi(opts?: PlanAiOptions): PlanAi {
  const rawClock = opts?.clock;
  const clock: PlanAiClock =
    rawClock !== undefined && rawClock !== null &&
    typeof rawClock.setTimeout === "function" && typeof rawClock.clearTimeout === "function"
      ? rawClock
      : defaultClock;

  const rawTimeout = opts?.timeoutMs;
  const timeoutValidated =
    typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout
      : PLANAI_LIMITS.DEFAULT_TIMEOUT_MS;

  const killSwitch = opts?.killSwitchCloud === true;
  const onFallbackRaw = opts?.onFallback;

  const notify = (job: Job, reason: PlanAiFallbackReason): void => {
    try {
      onFallbackRaw?.(job, reason);
    } catch {
      /* ignore */
    }
  };

  let tail: Promise<void> = Promise.resolve();
  const memo = new Map<string, DriftVerdict | PlanBrief>();

  const enqueue = <T>(fn: () => Promise<T>, signal: AbortSignal | undefined, aborted: () => T): Promise<T> => {
    let started = false;
    let cancelled = false;
    let settleAbort: (value: T) => void = () => undefined;
    const cancellation = new Promise<T>(resolve => { settleAbort = resolve; });
    const onAbort = (): void => {
      if (started || cancelled) return;
      cancelled = true;
      signal?.removeEventListener("abort", onAbort);
      settleAbort(aborted());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const run = tail.then(() => {
      signal?.removeEventListener("abort", onAbort);
      if (cancelled) return cancellation;
      started = true;
      return fn();
    });
    tail = run.then(() => undefined, () => undefined);
    return Promise.race([run, cancellation]);
  };

  function effectiveMode(tier: unknown, floor: unknown): { mode: ModeName; deviceOnly: boolean; effectiveFloor: DriftFloor } {
    const isPrivate = tier === "private";
    const floorNorm: DriftFloor | undefined =
      floor === "ONLY_ON_DEVICE" || floor === "PREFER_ON_DEVICE" ? floor : undefined;
    const effectiveFloor: DriftFloor = isPrivate ? "ONLY_ON_DEVICE" : (floorNorm ?? "PREFER_ON_DEVICE");
    const deviceOnly = effectiveFloor === "ONLY_ON_DEVICE" || killSwitch;
    const mode: ModeName = deviceOnly ? "ONLY_ON_DEVICE" : "PREFER_ON_DEVICE";
    return { mode, deviceOnly, effectiveFloor };
  }

  interface ResolvedPort {
    port: PlanAiPort;
    allowExternal: boolean;
  }

  function resolvePort(mode: ModeName): ResolvedPort | { error: "no_port" } {
    const portOpt: unknown = opts?.port;
    if (portOpt === undefined || portOpt === null) return { error: "no_port" };
    let resolved: unknown;
    let allowExternal = false;
    try {
      if (typeof portOpt === "function") {
        const fn = portOpt as (m: ModeName) => unknown;
        const out = fn(mode);
        if (isRecord(out) && "port" in out) {
          resolved = out["port"];
          allowExternal = out["allowExternal"] === true;
        } else {
          resolved = out;
          allowExternal = false;
        }
      } else {
        resolved = portOpt;
        allowExternal = false;
      }
    } catch {
      return { error: "no_port" };
    }
    if (!isRecord(resolved)) return { error: "no_port" };
    const gen = resolved["generate"];
    if (typeof gen !== "function") return { error: "no_port" };
    const port = resolved as unknown as PlanAiPort;
    if (typeof port.generate !== "function") return { error: "no_port" };
    return { port, allowExternal };
  }

  function isRawPortOpt(): boolean {
    const portOpt: unknown = opts?.port;
    return typeof portOpt !== "function" && portOpt !== undefined && portOpt !== null;
  }

  type PortOutcome =
    | { kind: "value"; value: unknown }
    | { kind: "port_error" }
    | { kind: "timeout" }
    | { kind: "aborted" };

  async function invokePort(
    port: PlanAiPort,
    prompt: string,
    schema: object,
    callerSignal: AbortSignal | undefined,
  ): Promise<PortOutcome> {
    if (callerSignal !== undefined && callerSignal.aborted) return { kind: "aborted" };
    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    let abortResolve: ((v: { kind: "timeout" } | { kind: "aborted" }) => void) | undefined;
    const abortPromise = new Promise<{ kind: "timeout" } | { kind: "aborted" }>((res) => {
      abortResolve = res;
    });
    const timerHandle: unknown = clock.setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
      abortResolve?.({ kind: "timeout" });
    }, timeoutValidated);

    const onCallerAbort = (): void => {
      callerAborted = true;
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
      abortResolve?.({ kind: "aborted" });
    };
    try {
      callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    } catch {
      /* ignore */
    }

    let portPromise: Promise<unknown>;
    try {
      portPromise = Promise.resolve(port.generate(prompt, schema, controller.signal));
    } catch {
      try {
        clock.clearTimeout(timerHandle);
      } catch {
        /* ignore */
      }
      try {
        callerSignal?.removeEventListener("abort", onCallerAbort);
      } catch {
        /* ignore */
      }
      return { kind: "port_error" };
    }

    const settled = await Promise.race([
      portPromise.then(
        (v): PortOutcome => ({ kind: "value", value: v }),
        (): PortOutcome => {
          if (callerAborted) return { kind: "aborted" };
          if (timedOut) return { kind: "timeout" };
          return { kind: "port_error" };
        },
      ),
      abortPromise.then((v): PortOutcome => v),
    ]);

    try {
      clock.clearTimeout(timerHandle);
    } catch {
      /* ignore */
    }
    try {
      callerSignal?.removeEventListener("abort", onCallerAbort);
    } catch {
      /* ignore */
    }
    return settled;
  }

  function sourceGate(value: unknown, deviceOnly: boolean, allowExternal: boolean): { ok: true; source: DriftSource; text: string } | { ok: false; reason: PlanAiFallbackReason } {
    if (!isRecord(value)) return { ok: false, reason: "port_error" };
    const text = value["text"];
    const source = value["source"];
    if (typeof text !== "string" || typeof source !== "string") return { ok: false, reason: "port_error" };
    if (!VALID_SOURCES.has(source)) return { ok: false, reason: "source_rejected" };
    if (deviceOnly && source !== "device") return { ok: false, reason: "source_rejected" };
    if (!deviceOnly && !allowExternal && (source === "local" || source === "remote")) return { ok: false, reason: "source_rejected" };
    return { ok: true, source: source as DriftSource, text };
  }

  async function runReview(task: PlanTaskInput, ctx?: ReviewContext): Promise<DriftVerdict> {
    const fallbackRules = safeReviewRules(task as unknown);
    try {
      if (!validTask(task)) return fallbackRules;
      const tier = ctx?.["tier"];
      const floor = ctx?.["floor"];
      const signal = ctx?.["signal"] as AbortSignal | undefined;
      const memory = ctx?.["memory"];
      const { mode, deviceOnly, effectiveFloor } = effectiveMode(tier, floor);

      if (signal !== undefined && signal.aborted) {
        notify("task_review", "aborted");
        return fallbackRules;
      }

      const resolved = resolvePort(mode);
      if ("error" in resolved) {
        notify("task_review", "no_port");
        return fallbackRules;
      }
      let allowExternal = resolved.allowExternal;
      if (deviceOnly) allowExternal = false;
      if (tier === "private") allowExternal = false;

      if (deviceOnly && isRawPortOpt()) {
        notify("task_review", "privacy_blocked");
        return fallbackRules;
      }

      let prompt: string;
      try {
        prompt = buildTaskReviewPrompt(task, memory);
      } catch {
        return fallbackRules;
      }

      const memoKey = JSON.stringify([effectiveFloor, killSwitch, allowExternal, "task_review", prompt]);
      const cached = memo.get(memoKey);
      if (cached !== undefined && sourceGate({ text: "", source: cached.source }, deviceOnly, allowExternal).ok) {
        return { ...(cached as DriftVerdict) };
      }

      const outcome = await invokePort(resolved.port, prompt, TASK_REVIEW_SCHEMA, signal);
      if (outcome.kind === "timeout") {
        notify("task_review", "timeout");
        return fallbackRules;
      }
      if (outcome.kind === "aborted") {
        notify("task_review", "aborted");
        return fallbackRules;
      }
      if (outcome.kind === "port_error") {
        notify("task_review", "port_error");
        return fallbackRules;
      }
      const gate = sourceGate(outcome.value, deviceOnly, allowExternal);
      if (!gate.ok) {
        notify("task_review", gate.reason);
        return fallbackRules;
      }
      const parsed = parseTaskReviewOutput(gate.text);
      if (!parsed.ok) {
        notify("task_review", parsed.code);
        return fallbackRules;
      }
      const result: DriftVerdict = { verdict: parsed.value.verdict, reason: parsed.value.reason, source: gate.source };
      memo.set(memoKey, { ...result });
      while (memo.size > PLANAI_LIMITS.MEMO_MAX) {
        const first = memo.keys().next().value;
        if (first === undefined) break;
        memo.delete(first);
      }
      return result;
    } catch {
      return fallbackRules;
    }
  }

  async function runBrief(plan: PlanBriefInput, ctx?: BriefContext): Promise<PlanBrief> {
    const fallbackRules = safeBriefRules(plan as unknown);
    try {
      if (!validPlan(plan)) return fallbackRules;
      const c = (ctx ?? {}) as unknown as Record<string, unknown>;
      const tier = c["tier"];
      const floor = c["floor"];
      const signal = c["signal"] as AbortSignal | undefined;
      const { mode, deviceOnly, effectiveFloor } = effectiveMode(tier, floor);

      if (signal !== undefined && signal.aborted) {
        notify("plan_brief", "aborted");
        return fallbackRules;
      }

      const resolved = resolvePort(mode);
      if ("error" in resolved) {
        notify("plan_brief", "no_port");
        return fallbackRules;
      }
      let allowExternal = resolved.allowExternal;
      if (deviceOnly) allowExternal = false;
      if (tier === "private") allowExternal = false;

      if (deviceOnly && isRawPortOpt()) {
        notify("plan_brief", "privacy_blocked");
        return fallbackRules;
      }

      let prompt: string;
      try {
        prompt = buildPlanBriefPrompt(plan);
      } catch {
        return fallbackRules;
      }

      const memoKey = JSON.stringify([effectiveFloor, killSwitch, allowExternal, "plan_brief", prompt]);
      const cached = memo.get(memoKey);
      if (cached !== undefined && sourceGate({ text: "", source: cached.source }, deviceOnly, allowExternal).ok) {
        return { ...(cached as PlanBrief) };
      }

      const outcome = await invokePort(resolved.port, prompt, PLAN_BRIEF_SCHEMA, signal);
      if (outcome.kind === "timeout") {
        notify("plan_brief", "timeout");
        return fallbackRules;
      }
      if (outcome.kind === "aborted") {
        notify("plan_brief", "aborted");
        return fallbackRules;
      }
      if (outcome.kind === "port_error") {
        notify("plan_brief", "port_error");
        return fallbackRules;
      }
      const gate = sourceGate(outcome.value, deviceOnly, allowExternal);
      if (!gate.ok) {
        notify("plan_brief", gate.reason);
        return fallbackRules;
      }
      const parsed = parsePlanBriefOutput(gate.text);
      if (!parsed.ok) {
        notify("plan_brief", parsed.code);
        return fallbackRules;
      }
      const result: PlanBrief = { brief: parsed.value.brief, source: gate.source };
      memo.set(memoKey, { ...result });
      while (memo.size > PLANAI_LIMITS.MEMO_MAX) {
        const first = memo.keys().next().value;
        if (first === undefined) break;
        memo.delete(first);
      }
      return result;
    } catch {
      return fallbackRules;
    }
  }

  return {
    reviewTask: (task: PlanTaskInput, ctx?: ReviewContext): Promise<DriftVerdict> =>
      enqueue(() => runReview(task, ctx), ctx?.signal, () => {
        notify("task_review", "aborted");
        return safeReviewRules(task);
      }),
    briefPlan: (plan: PlanBriefInput, ctx?: BriefContext): Promise<PlanBrief> =>
      enqueue(() => runBrief(plan, ctx), ctx?.signal, () => {
        notify("plan_brief", "aborted");
        return safeBriefRules(plan);
      }),
  };
}
