// Repair r9 (cross-family review r8, BLOCKING; threat model DISP_03 items: injected-port failures,
// invalid numeric configuration). Public API + harness fakes only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReconciler } from '../../../src/reconcile/index';
import { CFG, ev, flush, makeHarness, okValidator, FakeClock, FakeInfer, FakeStore, FakeLedger } from './harness';
import type { ReconcileConfig } from '../../../src/reconcile/types';

afterEach(() => vi.unstubAllGlobals());

function tryCall(fn: () => unknown): void { try { fn(); } catch { /* injected clock error may propagate */ } }

describe('r9-1 throwing clock during observe must not lose the revision', () => {
  for (const failAt of [1, 2, 3]) {
    for (const mode of ['first', 'coalescing'] as const) {
      it(`clock.now throws on call #${failAt} (${mode} observe); repeated observe recovers`, async () => {
        const h = makeHarness();
        if (mode === 'coalescing') {
          h.r.observe(ev('P1', 1));
          await h.clock.advance(0);
          h.infer.calls[0]!.resolve();
          await flush();
          await h.clock.advance(30000);
        }
        const before = h.infer.calls.length;
        const rev = mode === 'first' ? 1 : 2;
        const origNow = h.clock.now.bind(h.clock);
        let n = 0;
        let armed = true;
        h.clock.now = () => { if (armed && ++n === failAt) throw new Error('clock unavailable'); return origNow(); };
        tryCall(() => h.r.observe(ev('P1', rev)));
        armed = false;
        h.clock.now = origNow;
        // Recovery: either the work/retry intent was retained (time alone dispatches),
        // or a repeated identical observation re-admits it.
        await h.clock.advance(0);
        tryCall(() => h.r.observe(ev('P1', rev)));
        await h.clock.advance(30000);
        await flush();
        expect(h.infer.calls.length).toBe(before + 1);
        expect(h.infer.calls[before]!.req.key.observedRev).toBe(rev);
      });
    }
  }

  it('after a clock failure a later newer observation also dispatches normally', async () => {
    const h = makeHarness();
    const origNow = h.clock.now.bind(h.clock);
    let armed = true;
    h.clock.now = () => { if (armed) { armed = false; throw new Error('clock unavailable'); } return origNow(); };
    tryCall(() => h.r.observe(ev('P1', 1)));
    tryCall(() => h.r.observe(ev('P1', 2)));
    await h.clock.advance(30000);
    await flush();
    expect(h.infer.calls.length).toBeGreaterThanOrEqual(1);
  });
});

type Key = 'ondevice_concurrency' | 'cloud_concurrency' | 'min_inference_interval_ms' | 'queue_max_depth_factor';
const KEYS: Key[] = ['ondevice_concurrency', 'cloud_concurrency', 'min_inference_interval_ms', 'queue_max_depth_factor'];
const COMMON_BAD: Array<[string, unknown]> = [
  ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity], ['negative', -1],
  ['undefined', undefined], ['string', '2'], ['null', null],
];
const INTEGER_KEYS: Key[] = ['ondevice_concurrency', 'cloud_concurrency'];

function deps() {
  return { infer: new FakeInfer(), validator: okValidator, store: new FakeStore(), clock: new FakeClock(), ledger: new FakeLedger() };
}

describe('r9-2 every numeric config key is validated at create and updateConfig', () => {
  for (const key of KEYS) {
    const bad = [...COMMON_BAD, ...(INTEGER_KEYS.includes(key) ? ([['non-integer', 1.5]] as Array<[string, unknown]>) : [])];
    for (const [label, v] of bad) {
      it(`createReconciler rejects ${key}=${label}`, () => {
        const cfg = { ...CFG, [key]: v } as unknown as ReconcileConfig;
        expect(() => createReconciler(deps(), cfg)).toThrow();
      });
      it(`updateConfig rejects ${key}=${label} and keeps previous config`, async () => {
        const h = makeHarness();
        const cfg = { ...CFG, [key]: v } as unknown as ReconcileConfig;
        expect(() => h.r.updateConfig(cfg)).toThrow();
        // previous config still governs: a job dispatches on the default lane and completes
        h.r.observe(ev('P1', 1));
        await h.clock.advance(0);
        await flush();
        expect(h.infer.calls.length).toBe(1);
        h.infer.calls[0]!.resolve();
        await flush();
        expect(h.store.caps.get("P1")?.observed_rev).toBe(1);
      });
    }
  }

  it('a valid update (finite, non-negative, integer concurrency) is still accepted', () => {
    const h = makeHarness();
    expect(() => h.r.updateConfig({ ...CFG, ondevice_concurrency: 2, cloud_concurrency: 3, min_inference_interval_ms: 0, queue_max_depth_factor: 4 })).not.toThrow();
  });

  it('review inputs: ondevice_concurrency=-1 / NaN, queue_max_depth_factor=NaN, interval=Infinity never reach the scheduler', () => {
    const h = makeHarness();
    for (const patch of [{ ondevice_concurrency: -1 }, { ondevice_concurrency: NaN }, { queue_max_depth_factor: NaN }, { min_inference_interval_ms: Infinity }]) {
      expect(() => h.r.updateConfig({ ...CFG, ...patch })).toThrow();
    }
  });
});
