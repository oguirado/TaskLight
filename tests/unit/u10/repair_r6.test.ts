// Repair r6 regressions (Sol review r5). Public API + FakeClock only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReconciler } from '../../../src/reconcile/index';
import type { ValidatorPort } from '../../../src/reconcile/types';
import { CFG, ev, flush, makeHarness, FakeClock, FakeInfer, FakeStore, FakeLedger, okValidator } from './harness';

afterEach(() => vi.unstubAllGlobals());

const published = (h: ReturnType<typeof makeHarness>, p: string) => h.store.casCalls.filter((c) => c.projectId === p && c.result);

describe('R6-1 work of an unregistered project never publishes (unknown-project refusal)', () => {
  it('outstanding inference resolved after unregisterProject publishes nothing', async () => {
    const h = makeHarness({ projects: ['P1', 'P2'] });
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    expect(h.infer.calls.length).toBe(1);
    h.r.unregisterProject('P1');
    h.infer.calls[0]!.resolve();
    await flush();
    await h.clock.advance(20000);
    expect(published(h, 'P1')).toEqual([]);
    expect(h.store.caps.get('P1')).toBeUndefined();
    expect(h.ledger.counts.on_device).toBe(0);
  });
  it('prompt_version bump before the outstanding result lands does not recreate a job for the removed project', async () => {
    const h = makeHarness({ projects: ['P1', 'P2'] });
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    h.r.unregisterProject('P1');
    h.r.updateConfig({ ...CFG, prompt_version: 'v2' });
    h.infer.calls[0]!.resolve();
    await flush();
    for (let i = 0; i < 4; i++) {
      await h.clock.advance(20000);
      for (const c of h.infer.calls) c.resolve();
      await flush();
    }
    expect(h.infer.calls.filter((c) => c.req.key.projectId === 'P1').length).toBe(1);
    expect(published(h, 'P1')).toEqual([]);
    expect(h.r.snapshot().pending.filter((j) => j.key.projectId === 'P1')).toEqual([]);
  });
  it('control: a still-registered project publishes normally', async () => {
    const h = makeHarness({ projects: ['P1', 'P2'] });
    h.r.observe(ev('P2', 1));
    await h.clock.advance(0);
    h.infer.calls[0]!.resolve();
    await flush();
    expect(published(h, 'P2').length).toBe(1);
  });
});

describe('R6-2 inference_timeout_ms must be finite and positive (B16, required config)', () => {
  const mkDeps = () => ({ infer: new FakeInfer(), validator: okValidator, store: new FakeStore(), clock: new FakeClock(), ledger: new FakeLedger() });
  const bad: Array<[string, unknown]> = [['NaN', NaN], ['negative', -1], ['zero', 0], ['Infinity', Infinity], ['-Infinity', -Infinity], ['undefined', undefined], ['string', '60000']];
  for (const [name, v] of bad) {
    it(`createReconciler rejects ${name}`, () => {
      vi.stubGlobal('requestAnimationFrame', vi.fn());
      expect(() => createReconciler(mkDeps(), { ...CFG, inference_timeout_ms: v as number })).toThrow();
    });
    it(`updateConfig rejects ${name} and leaves the active config in force`, async () => {
      const h = makeHarness();
      expect(() => h.r.updateConfig({ ...CFG, inference_timeout_ms: v as number })).toThrow();
      // active timeout (60000) still releases a never-settling lane
      h.r.observe(ev('P1', 1));
      await h.clock.advance(0);
      expect(h.infer.calls.length).toBe(1);
      await h.clock.advance(60000);
      expect(h.infer.calls[0]!.signal.aborted).toBe(true);
      expect(Object.values(h.r.snapshot().inFlight).reduce((a, b) => a + b, 0)).toBe(0);
    });
  }
  it('control: a valid timeout still aborts and releases the lane at the deadline', async () => {
    const h = makeHarness({ cfg: { inference_timeout_ms: 5000 } });
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    await h.clock.advance(5000);
    expect(h.infer.calls[0]!.signal.aborted).toBe(true);
    expect(Object.values(h.r.snapshot().inFlight).reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe('R6-3 a throwing validator neither escapes nor strands the revision (error recovery)', () => {
  it('no unhandled rejection; repeating the accepted observation dispatches again', async () => {
    let throwOnce = true;
    const validator: ValidatorPort = {
      validate: (t, raw) => {
        if (throwOnce) { throwOnce = false; throw new Error('validator failure'); }
        return okValidator.validate(t, raw);
      },
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const h = makeHarness({ validator });
      expect(h.r.observe(ev('P1', 1)).kind).not.toBe('REFUSE');
      await h.clock.advance(0);
      h.infer.calls[0]!.resolve();
      await flush();
      await new Promise<void>((r) => setTimeout(r, 0));
      await flush();
      expect(unhandled).toEqual([]);
      expect(Object.values(h.r.snapshot().inFlight).reduce((a, b) => a + b, 0)).toBe(0);
      expect(published(h, 'P1')).toEqual([]);
      h.r.observe(ev('P1', 1));
      await h.clock.advance(20000);
      expect(h.infer.calls.filter((c) => c.req.key.observedRev === 1).length).toBe(2);
      h.infer.calls[1]!.resolve();
      await flush();
      expect(published(h, 'P1').length).toBe(1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
