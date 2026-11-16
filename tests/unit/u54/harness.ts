// U54 harness: u10 fakes + a ledger that also records incExternal. Sources are plain strings (cast) so
// the tests compile and run before U46 widens the shared types.
import { vi } from 'vitest';
import { createReconciler } from '../../../src/reconcile/index';
import type {
  CapsuleTask, InferenceMode, LedgerCounter, LedgerPort, PrivacyTier, ReconcileConfig, Reconciler, ValidatorPort,
} from '../../../src/reconcile/types';
import { CFG, FakeClock, FakeInfer, FakeStore, ev, flush, okValidator } from '../u10/harness';

export { CFG, ev, flush };

export type Src = 'ON_DEVICE' | 'IN_CLOUD' | 'LOCAL_SERVER' | 'REMOTE_PROVIDER';
export const OLD: readonly Src[] = ['ON_DEVICE', 'IN_CLOUD'];
export const EXTERNAL: readonly Src[] = ['LOCAL_SERVER', 'REMOTE_PROVIDER'];
export const EXT_COUNTER: Record<string, string> = { LOCAL_SERVER: 'local_server', REMOTE_PROVIDER: 'remote_provider' };

export class ExtLedger implements LedgerPort {
  counts: Record<LedgerCounter, number> = { on_device: 0, in_cloud: 0, fallbacks: 0, refusals: 0, schema_rejects: 0 };
  ext: string[] = [];
  inc(c: LedgerCounter): void { this.counts[c]++; }
  incExternal(c: string): void { this.ext.push(c); }
  get total(): number { return Object.values(this.counts).reduce((a, b) => a + b, 0) + this.ext.length; }
}

/** Ledger of a pre-U54 port: no incExternal at all. */
export class OldLedger implements LedgerPort {
  counts: Record<LedgerCounter, number> = { on_device: 0, in_cloud: 0, fallbacks: 0, refusals: 0, schema_rejects: 0 };
  inc(c: LedgerCounter): void { this.counts[c]++; }
  get total(): number { return Object.values(this.counts).reduce((a, b) => a + b, 0); }
}

export interface H<L extends LedgerPort> {
  r: Reconciler; clock: FakeClock; infer: FakeInfer; store: FakeStore; ledger: L;
}

export function makeH<L extends LedgerPort = ExtLedger>(
  opts: { cfg?: Partial<ReconcileConfig>; ledger?: L; validator?: ValidatorPort } = {},
): H<L> {
  const clock = new FakeClock(); const infer = new FakeInfer(); const store = new FakeStore();
  const ledger = (opts.ledger ?? new ExtLedger()) as L;
  vi.stubGlobal('requestAnimationFrame', vi.fn());
  const r = createReconciler({ infer, validator: opts.validator ?? okValidator, store, clock, ledger }, { ...CFG, ...opts.cfg });
  r.registerProject('P1'); store.inc.set('P1', 'A');
  return { r, clock, infer, store, ledger };
}

export interface Scenario { tier: PrivacyTier; task: CapsuleTask; mode: InferenceMode }

/** Run one job to its outcome with `source`; returns the harness after the outcome is processed. */
export async function runJob<L extends LedgerPort>(
  h: H<L>, sc: Scenario, source: string,
): Promise<H<L>> {
  h.r.observe(ev('P1', 1, { tier: sc.tier, task: sc.task }));
  await h.clock.advance(0);
  if (h.infer.calls.length === 0) return h;
  h.infer.calls[0]!.resolve({ inferenceSource: source as never });
  await flush();
  await h.clock.advance(20000);
  return h;
}

/** Config that makes `task` run under `mode` (private tier is forced ONLY_ON_DEVICE by the reconciler). */
export function cfgFor(task: CapsuleTask, mode: InferenceMode): Partial<ReconcileConfig> {
  const key = (`mode_${task}`) as keyof ReconcileConfig;
  return { [key]: mode } as Partial<ReconcileConfig>;
}

export async function fresh<L extends LedgerPort = ExtLedger>(
  sc: Scenario, source: string, ledger?: L,
): Promise<H<L>> {
  const h = makeH<L>({ cfg: cfgFor(sc.task, sc.mode), ...(ledger ? { ledger } : {}) });
  return runJob(h, sc, source);
}

export const published = (h: { store: FakeStore }): boolean => h.store.casCalls.some((c) => c.result);
