// U47 oracle fixtures: fake Hybrid, fake ModelTransport, fake Clock, world builder. No real timers, no network.
import { createProviderRegistry } from "../../../src/providers";
import type {
  CallTask, ChatMessage, Clock, EndpointInfo, GenerateResult, HealthState, ModelSelection, ModelTransport,
  ProviderDeps, ProviderGates, ProviderRegistry, Rung,
} from "../../../src/providers";
import type { AiConfig, DeviceStatus, Hybrid, TaskRequest, TaskResult } from "../../../src/ai/types";
import type { PrivacyTier, TaskId } from "../../../src/schema";
import { TASK_SCHEMAS } from "../../../src/schema";

export const flush = async (): Promise<void> => { for (let i = 0; i < 80; i++) await Promise.resolve(); };

export const TASKS: readonly TaskId[] = ["status", "summary", "next_action", "plan", "digest", "screenshot"];
export const CALL_TASKS: readonly CallTask[] = [...TASKS, "route", "drift"];
export const TEXT_TASKS: readonly CallTask[] = ["status", "summary", "next_action", "plan", "digest", "route", "drift"];
export const TIERS: readonly PrivacyTier[] = ["private", "standard", "shared"];

export const VALUES: Record<string, unknown> = {
  status: { status: "running" }, summary: { headline: "h", summary: "s" },
  next_action: { next_action: "x", attention: "low" }, screenshot: { status: "idle", note: "n" },
  digest: { needs_you: [], brief: "b" }, plan: { steps: [{ text: "a", state: "todo" }], progress: 50 },
};
/** Valid raw model output per task (what an OpenAI-compatible endpoint returns). */
export const TEXT: Record<string, string> = {
  status: "running", summary: '{"headline":"h","summary":"s"}', next_action: '{"next_action":"x","attention":"low"}',
  screenshot: '{"status":"idle","note":"n"}', digest: '{"needs_you":[],"brief":"b"}',
  plan: '{"steps":[{"text":"a","state":"todo"}],"progress":50}', route: "plan_change", drift: '{"verdict":"ok"}',
};
/** Raw outputs that parse but fail the task validator (JSON mismatch) or are not JSON at all. */
export const INVALID: Record<string, string> = {
  status: "bogus", summary: '{"headline":"h"}', next_action: '{"next_action":"x","attention":"zzz"}',
  plan: '{"steps":[],"progress":"x"}', digest: '{"needs_you":5,"brief":"b"}',
};
export const schemaFor = (task: CallTask): object =>
  (TASK_SCHEMAS as Record<string, { schema: object }>)[task]?.schema ?? { type: "object" };

export const LOC: EndpointInfo = { id: "loc", kind: "local-openai-compatible", label: "Local LM", model: "m-local", loopback: true, has_key: false, allow_private: false };
export const LOCP: EndpointInfo = { ...LOC, id: "locp", label: "Local private", allow_private: true };
export const REM: EndpointInfo = { id: "rem", kind: "remote-openai-compatible", label: "Remote X", model: "m-remote", loopback: false, has_key: true, allow_private: false };
export const REMNK: EndpointInfo = { ...REM, id: "remnk", label: "Remote no key", has_key: false };
export const ALL_ON: ProviderGates = { externalEnabled: true, remoteEnabled: true, killSwitchCloud: false };

export const meta = (task: string) => ({ task, mode: "PREFER_ON_DEVICE", configGen: 1, prompt_version: "v1", called: true });
export const okResult = (task: string, source: string, fallback = false) =>
  ({ ok: true, value: VALUES[task] ?? "firebase-text", source, fallback, meta: meta(task) });
export const failResult = (task: string, code: string, fallback = false) =>
  ({ ok: false, code, fallback, meta: meta(task) });

export type HScript = (req: TaskRequest<TaskId>, n: number) => unknown;

export class FakeHybrid implements Hybrid {
  runs: TaskRequest<TaskId>[] = [];
  applied: Partial<AiConfig>[] = [];
  inits = 0;
  initStatus: DeviceStatus = { state: "ready" };
  progress: number[] = [];
  status: DeviceStatus = { state: "not_initialised" };
  constructor(readonly name: string, private readonly log: string[], private script: HScript | undefined, readonly source: string) {}
  setScript(s: HScript | undefined): void { this.script = s; }
  run<K extends TaskId>(req: TaskRequest<K>): Promise<TaskResult<K>> {
    this.runs.push(req as TaskRequest<TaskId>);
    this.log.push(`hybrid:${this.name}:${req.task}`);
    const out = this.script ? this.script(req as TaskRequest<TaskId>, this.runs.length) : okResult(req.task, this.source);
    return Promise.resolve(out as unknown as TaskResult<K>);
  }
  initDevice(onProgress?: (p: number) => void): Promise<DeviceStatus> {
    this.inits++; for (const p of this.progress) onProgress?.(p);
    return Promise.resolve(this.initStatus);
  }
  deviceStatus(): DeviceStatus { return this.status; }
  applyConfig(cfg: Partial<AiConfig>): { configGen: number; warnings: string[] } {
    this.applied.push(cfg); return { configGen: 100 + this.applied.length, warnings: [`w:${this.name}`] };
  }
}

export class FakeClock implements Clock {
  t = 1_000_000;
  private seq = 0;
  private timers = new Map<number, { at: number; f: () => void }>();
  now(): number { return this.t; }
  setTimeout(f: () => void, ms: number): unknown { const id = ++this.seq; this.timers.set(id, { at: this.t + ms, f }); return id; }
  clearTimeout(h: unknown): void { this.timers.delete(h as number); }
  get pending(): number { return this.timers.size; }
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    await flush();
    for (;;) {
      let best: [number, { at: number; f: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= target && (best === undefined || e[1].at < best[1].at)) best = e;
      if (best === undefined) break;
      this.t = best[1].at; this.timers.delete(best[0]); best[1].f(); await flush();
    }
    this.t = target; await flush();
  }
}

export type GenOut = { ok: true; text: string } | { ok: false; nack: string };
export interface GenReq { id: string; messages: ChatMessage[]; maxTokens: number; schema?: object; rung: Rung; tier: PrivacyTier; signal: AbortSignal }
/** "hang" = abortable never-settling call (rejects AbortError on abort); "deaf" = never settles, ignores signal. */
export type GenScript = GenOut | "hang" | "deaf" | "throw" | ((req: GenReq, n: number) => GenOut | Promise<GenOut>);
export type ProbeScript = { state: HealthState; rung: Rung | null } | "hang" | "reject";

const abortErr = (): Error => Object.assign(new Error("aborted"), { name: "AbortError" });

export class FakeTransport implements ModelTransport {
  endpoints: EndpointInfo[];
  listError = false;
  probes: Record<string, ProbeScript> = {};
  gen: Record<string, GenScript> = {};
  task: CallTask = "summary";
  genCalls: GenReq[] = [];
  probeCalls: string[] = [];
  cancels: string[] = [];
  listCalls = 0;
  constructor(endpoints: EndpointInfo[], private readonly log: string[]) { this.endpoints = endpoints; }
  list(): Promise<EndpointInfo[]> {
    this.listCalls++;
    return this.listError ? Promise.reject(new Error("list down")) : Promise.resolve(structuredClone(this.endpoints));
  }
  probe(id: string, signal: AbortSignal): Promise<{ state: HealthState; rung: Rung | null }> {
    this.probeCalls.push(id); this.log.push(`transport:probe:${id}`);
    const p = this.probes[id] ?? { state: "available" as HealthState, rung: null };
    if (p === "reject") return Promise.reject(new Error("probe down"));
    if (p === "hang") return new Promise((_, rej) => { signal.addEventListener("abort", () => rej(abortErr())); });
    return Promise.resolve(p);
  }
  generate(req: GenReq): Promise<GenOut> {
    this.genCalls.push(req); this.log.push(`transport:generate:${req.id}`);
    const n = this.genCalls.filter((c) => c.id === req.id).length;
    const s = this.gen[req.id] ?? { ok: true as const, text: TEXT[this.sniff(req)] ?? "{}" };
    if (s === "throw") return Promise.reject(new Error("transport boom"));
    if (s === "deaf") return new Promise(() => undefined);
    if (s === "hang") return new Promise((_, rej) => { req.signal.addEventListener("abort", () => rej(abortErr())); });
    if (typeof s === "function") return Promise.resolve(s(req, n));
    return Promise.resolve(s);
  }
  /** Task of a request, read from the schema the adapter sent (rung 1 field, rung 2 system text); falls back to `task`. */
  private sniff(req: GenReq): CallTask {
    for (const t of ["status", "summary", "next_action", "digest", "screenshot"] as const) {
      const sj = JSON.stringify(schemaFor(t));
      if (req.schema !== undefined && JSON.stringify(req.schema) === sj) return t;
      if (req.messages.some((m) => m.role === "system" && m.content.includes(sj))) return t;
    }
    return this.task;
  }
  cancel(id: string): void { this.cancels.push(id); this.log.push(`transport:cancel:${id}`); }
  callsFor(id: string): GenReq[] { return this.genCalls.filter((c) => c.id === id); }
}

export interface WorldOpts {
  endpoints?: EndpointInfo[] | undefined; gates?: ProviderGates | null | undefined; selection?: ModelSelection | undefined;
  config?: Partial<AiConfig> | undefined; noTransport?: boolean | undefined; listError?: boolean | undefined; refresh?: boolean | undefined;
  hybrid?: HScript | undefined; ondevice?: HScript | undefined; cloud?: HScript | undefined; hybridSource?: string | undefined;
  probes?: Record<string, ProbeScript> | undefined; gen?: Record<string, GenScript> | undefined;
}
export interface World {
  reg: ProviderRegistry; deps: ProviderDeps; log: string[]; clock: FakeClock;
  hybrid: FakeHybrid; tr: FakeTransport; makeCalls: Partial<AiConfig>[];
  overlays: { ondevice?: FakeHybrid; cloud?: FakeHybrid };
  call(task: CallTask, tier: PrivacyTier, o?: { prompt?: string; signal?: AbortSignal; maxTokens?: number }): Promise<GenerateResult>;
  hybridRuns(): number;
}

export async function world(o: WorldOpts = {}): Promise<World> {
  const log: string[] = [];
  const clock = new FakeClock();
  const hybrid = new FakeHybrid("default", log, o.hybrid, o.hybridSource ?? "ON_DEVICE");
  const tr = new FakeTransport(o.endpoints ?? [], log);
  tr.listError = o.listError === true; tr.probes = { ...o.probes }; tr.gen = { ...o.gen };
  const makeCalls: Partial<AiConfig>[] = [];
  const overlays: World["overlays"] = {};
  const makeHybrid = (overlay: Partial<AiConfig>): Hybrid => {
    makeCalls.push(overlay);
    const cloud = overlay.mode_status === "ONLY_IN_CLOUD";
    if (!cloud && overlay.mode_status !== "ONLY_ON_DEVICE") throw new Error(`fake makeHybrid: unexpected overlay ${JSON.stringify(overlay)}`);
    const h = new FakeHybrid(cloud ? "cloud" : "ondevice", log, cloud ? o.cloud : o.ondevice, cloud ? "IN_CLOUD" : "ON_DEVICE");
    if (cloud) overlays.cloud = h; else overlays.ondevice = h;
    return h;
  };
  const deps: ProviderDeps = { hybrid, makeHybrid, clock };
  if (!o.noTransport) deps.transport = tr;
  if (o.gates !== null) deps.gates = o.gates ?? ALL_ON;
  if (o.selection !== undefined) deps.selection = o.selection;
  if (o.config !== undefined) deps.config = o.config;
  const reg = createProviderRegistry(deps);
  if (o.refresh !== false && !o.noTransport) await reg.refresh();
  return {
    reg, deps, log, clock, hybrid, tr, makeCalls, overlays,
    call(task, tier, c = {}) {
      tr.task = task;
      const req = { task, tier, prompt: c.prompt ?? "P", schema: schemaFor(task), signal: c.signal ?? new AbortController().signal } as Parameters<ProviderRegistry["generate"]>[0];
      if (c.maxTokens !== undefined) req.maxTokens = c.maxTokens;
      return reg.generate(req);
    },
    hybridRuns: () => hybrid.runs.length + (overlays.ondevice?.runs.length ?? 0) + (overlays.cloud?.runs.length ?? 0),
  };
}

export function track<T>(p: Promise<T>): { done: boolean; val?: T; err?: unknown } {
  const box: { done: boolean; val?: T; err?: unknown } = { done: false };
  p.then((v) => { box.done = true; box.val = v; }, (e: unknown) => { box.done = true; box.err = e; });
  return box;
}
