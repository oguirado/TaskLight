// Oracle helpers for U17: capsule builders, fake hybrid / clock / ledger. Independent of the unit under test.
import type { Attention, CapsuleState, DigestItem, PrivacyTier, TaskId } from "../../../src/schema";
import type { AiErrorCode, TaskRequest, TaskResult } from "../../../src/ai";
import type { DigestCapsuleIn, DigestConfig, DigestDeps, DigestInput, DigestRecord } from "../../../src/digest";

export const NOW = 10_000_000;
export const flush = async (n = 8): Promise<void> => { for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0)); };
export const CFG: DigestConfig = { ondevice_max_input_tokens: 7300, prompt_frame_chars: 1200, min_inference_interval_ms: 20000, prompt_version: "v1" };
export const FRAME = "F".repeat(1200);

export interface CapOpts {
  tier?: PrivacyTier; status?: string; attention?: Attention; rev?: number; waiting?: number; lens?: string;
  headline?: string; summary?: string; next_action?: string; now?: number;
}
export function cap(id: string, o: CapOpts = {}): DigestCapsuleIn {
  const now = o.now ?? NOW;
  const state: Record<string, unknown> = {
    lens_id: o.lens ?? "dev", rev: o.rev ?? 1, observed_rev: o.rev ?? 1,
    status: o.status ?? "running", attention: o.attention ?? "none", inference_source: "ON_DEVICE",
    updated_at: now - (o.waiting ?? 1000), writer_uid: "u1",
  };
  if (o.headline !== undefined) state["headline"] = o.headline;
  if (o.summary !== undefined) state["summary"] = o.summary;
  if (o.next_action !== undefined) state["next_action"] = o.next_action;
  return { projectId: id, tier: o.tier ?? "standard", state: state as unknown as CapsuleState };
}
export const pid = (i: number): string => "p" + String(i).padStart(2, "0");

export function rec(over: Partial<DigestRecord> = {}): DigestRecord {
  return { needs_you: [], brief: "", origin: "ON_DEVICE", fallback: false, truncated: false, revVector: {},
    prompt_version: "v1", builtAt: NOW, invalidInputs: 0, ...over };
}

export type Script = (req: TaskRequest<TaskId>, n: number) => TaskResult<"digest"> | Promise<TaskResult<"digest">>;
const meta = { task: "digest", mode: "PREFER_IN_CLOUD", configGen: 1, prompt_version: "v1", called: true } as const;
export const okRes = (needs: DigestItem[] = [], brief = "brief", source: "ON_DEVICE" | "IN_CLOUD" = "IN_CLOUD", fallback = false): TaskResult<"digest"> =>
  ({ ok: true, value: { needs_you: needs, brief }, source, fallback, meta: { ...meta } });
export const failRes = (code: AiErrorCode, extra: Record<string, unknown> = {}): TaskResult<"digest"> =>
  ({ ok: false, code, fallback: false, meta: { ...meta }, ...extra } as TaskResult<"digest">);

export function makeTimers(start = NOW) {
  let t = start;
  const list: Array<{ ms: number; at: number; fn: () => void; cancelled: boolean; fired: boolean }> = [];
  return {
    list, now: () => t,
    setTimer(ms: number, fn: () => void): () => void {
      const e = { ms, at: t + ms, fn, cancelled: false, fired: false }; list.push(e);
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
      t = target; await flush();
    },
  };
}

export function makeEnv(script: Script = () => okRes()) {
  const timers = makeTimers();
  const calls: Array<TaskRequest<TaskId>> = [];
  const ledger = { on_device: 0, in_cloud: 0, fallbacks: 0, schema_rejects: 0 };
  const prompts: DigestInput[] = [];
  const env = {
    timers, calls, ledger, prompts, script,
    runArgCounts: [] as number[],
    deps: {
      hybrid: {
        run: (async (...args: unknown[]) => {
          env.runArgCounts.push(args.length);
          const req = args[0] as TaskRequest<TaskId>;
          calls.push(req);
          return env.script(req, calls.length);
        }) as unknown as DigestDeps["hybrid"]["run"],
      },
      buildPrompt(input: DigestInput): string { prompts.push(input); return FRAME + input.serialized; },
      clock: { now: () => timers.now(), setTimer: (ms: number, fn: () => void) => timers.setTimer(ms, fn) },
      ledger: { inc(c: keyof typeof ledger) { ledger[c]++; } },
    } as DigestDeps,
  };
  return env;
}
export type Env = ReturnType<typeof makeEnv>;

/** deferred hybrid result */
export function deferred<T>() {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

export const shuffled = <T>(a: readonly T[], seed: number): T[] => {
  const r = [...a]; let s = seed * 2654435761 >>> 0;
  for (let i = r.length - 1; i > 0; i--) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; const j = s % (i + 1); [r[i], r[j]] = [r[j]!, r[i]!]; }
  return r;
};
export const DIGEST_LINE_KEYS = ["projectId", "status", "attention", "waiting_ms", "headline", "next_action", "summary"];
