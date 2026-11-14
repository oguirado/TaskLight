import { vi } from 'vitest';
import { createReconciler } from '../../../src/reconcile/index';
import type {
  CapsuleStore, CapsuleTask, Clock, InferenceOutcome, InferencePort, InferenceRequest, LedgerCounter,
  LedgerPort, ObservedEvent, PublishedCapsule, ReconcileConfig, Reconciler, ValidatorPort,
} from '../../../src/reconcile/types';

export const CFG: ReconcileConfig = {
  ondevice_concurrency: 1, cloud_concurrency: 2, min_inference_interval_ms: 20000,
  queue_max_depth_factor: 2, prompt_version: 'v1', kill_switch_cloud: false,
  mode_status: 'PREFER_ON_DEVICE', mode_summary: 'PREFER_ON_DEVICE', mode_next_action: 'PREFER_ON_DEVICE',
  mode_screenshot: 'ONLY_ON_DEVICE', inference_timeout_ms: 60000,
};

export class FakeClock implements Clock {
  t = 0;
  private timers: { at: number; seq: number; fn: () => void }[] = [];
  private seq = 0;
  setTimerCalls = 0;
  now(): number { return this.t; }
  setTimer(ms: number, fn: () => void): () => void {
    this.setTimerCalls++;
    const e = { at: this.t + ms, seq: this.seq++, fn };
    this.timers.push(e);
    return () => { this.timers = this.timers.filter((x) => x !== e); };
  }
  /** Advance time, firing due timers in order, flushing microtasks between. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
      await flush();
    }
    this.t = target;
    await flush();
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

export interface Call {
  req: InferenceRequest;
  signal: AbortSignal;
  resolve(o?: Partial<InferenceOutcome>): void;
  reject(e?: unknown): void;
}

export class FakeInfer implements InferencePort {
  calls: Call[] = [];
  run(req: InferenceRequest, signal: AbortSignal): Promise<InferenceOutcome> {
    return new Promise<InferenceOutcome>((res, rej) => {
      this.calls.push({
        req, signal,
        resolve: (o) => res({ raw: '{}', inferenceSource: 'ON_DEVICE', ...o }),
        reject: (e) => rej(e ?? new Error('boom')),
      });
    });
  }
}

export class FakeStore implements CapsuleStore {
  caps = new Map<string, PublishedCapsule>();
  inc = new Map<string, string>();
  casCalls: { projectId: string; expectedRev: number; next: PublishedCapsule; result: boolean }[] = [];
  /** run once before the next CAS attempt (simulates a concurrent writer) */
  beforeCas: (() => void) | undefined;
  forceFalse = false;
  read(p: string): PublishedCapsule | undefined { return this.caps.get(p); }
  currentIncarnation(p: string): string | undefined { return this.inc.get(p); }
  compareAndPublish(p: string, expectedRev: number, next: PublishedCapsule): boolean {
    const hook = this.beforeCas; this.beforeCas = undefined; hook?.();
    const cur = this.caps.get(p)?.rev ?? 0;
    const ok = !this.forceFalse && cur === expectedRev;
    if (ok) this.caps.set(p, next);
    this.casCalls.push({ projectId: p, expectedRev, next, result: ok });
    return ok;
  }
  seed(p: string, c: Partial<PublishedCapsule> & { rev: number }, incarnation = 'A'): void {
    this.caps.set(p, {
      observed_rev: 0, source_observed_rev: 0, incarnation, inference_source: 'ON_DEVICE',
      updated_at: 0, patch: {}, ...c,
    });
    this.inc.set(p, incarnation);
  }
}

export class FakeLedger implements LedgerPort {
  counts: Record<LedgerCounter, number> = { on_device: 0, in_cloud: 0, fallbacks: 0, refusals: 0, schema_rejects: 0 };
  inc(c: LedgerCounter): void { this.counts[c]++; }
}

export const okValidator: ValidatorPort = { validate: (_t, raw) => ({ ok: true, patch: { raw } }) };
export const rejectValidator: ValidatorPort = { validate: () => ({ ok: false, reason: 'bad' }) };

export interface Harness {
  r: Reconciler; clock: FakeClock; infer: FakeInfer; store: FakeStore; ledger: FakeLedger; raf: ReturnType<typeof vi.fn>;
}

export function makeHarness(opts: { cfg?: Partial<ReconcileConfig>; validator?: ValidatorPort; projects?: string[]; incarnation?: string } = {}): Harness {
  const clock = new FakeClock(); const infer = new FakeInfer(); const store = new FakeStore(); const ledger = new FakeLedger();
  const raf = vi.fn();
  vi.stubGlobal('requestAnimationFrame', raf);
  const r = createReconciler({ infer, validator: opts.validator ?? okValidator, store, clock, ledger }, { ...CFG, ...opts.cfg });
  for (const p of opts.projects ?? ['P1']) {
    r.registerProject(p);
    store.inc.set(p, opts.incarnation ?? 'A');
  }
  return { r, clock, infer, store, ledger, raf };
}

export function ev(projectId: string, observedRev: number, over: Partial<ObservedEvent> = {}): ObservedEvent {
  return { projectId, incarnation: 'A', observedRev, templateHash: 'h', tier: 'standard', task: 'status' as CapsuleTask, ...over };
}
