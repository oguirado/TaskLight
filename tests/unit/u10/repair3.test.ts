import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeHarness, ev, flush, CFG } from './harness';
import type { Harness } from './harness';

afterEach(() => vi.unstubAllGlobals());

const cloudPublished = (h: Harness) => h.store.casCalls.filter((c) => c.next.inference_source === 'IN_CLOUD' && c.result);

describe('R3-1 privacy transition: cloud result for a slot that became private is never published (B11)', () => {
  it('in-flight cloud job, newer private observation, IN_CLOUD outcome is discarded', async () => {
    const h = makeHarness({ cfg: { mode_status: 'PREFER_IN_CLOUD' } });
    h.r.observe(ev('P1', 1, { tier: 'standard' }));
    await h.clock.advance(0);
    expect(h.infer.calls.length).toBe(1);
    expect(h.infer.calls[0]!.req.mode).toBe('PREFER_IN_CLOUD');
    h.r.observe(ev('P1', 2, { tier: 'private' }));
    h.infer.calls[0]!.resolve({ inferenceSource: 'IN_CLOUD' });
    await flush();
    await h.clock.advance(0);
    expect(cloudPublished(h)).toEqual([]);
    expect(h.store.caps.get('P1')?.inference_source).not.toBe('IN_CLOUD');
    expect(h.ledger.counts.in_cloud).toBe(0);
  });
  it('still discarded after the interval elapses and later work runs', async () => {
    const h = makeHarness({ cfg: { mode_status: 'ONLY_IN_CLOUD' } });
    h.r.observe(ev('P1', 1, { tier: 'shared' }));
    await h.clock.advance(0);
    h.r.observe(ev('P1', 2, { tier: 'private' }));
    await h.clock.advance(20000);
    h.infer.calls[0]!.resolve({ inferenceSource: 'IN_CLOUD' });
    await flush();
    expect(cloudPublished(h)).toEqual([]);
    expect(h.store.caps.get('P1')?.inference_source).not.toBe('IN_CLOUD');
  });
});

describe('R3-2 same-revision observation re-admits once the refusing condition clears (B2, B4, B10, section 4)', () => {
  it('queue_full refusal: after the queue drains, repeating the event is admitted', async () => {
    const h = makeHarness({ cfg: { queue_max_depth_factor: 1 } });
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    expect(h.r.observe(ev('P1', 1, { task: 'summary' })).kind).not.toBe('REFUSE');
    const refused = h.r.observe(ev('P1', 1, { task: 'next_action' }));
    expect(refused).toEqual({ kind: 'REFUSE', reason: 'queue_full' });
    h.infer.calls[0]!.resolve();
    await flush();
    await h.clock.advance(20000);
    expect(h.r.snapshot().pending.length).toBe(0);
    const again = h.r.observe(ev('P1', 1, { task: 'next_action' }));
    expect(again.kind).not.toBe('REFUSE');
    for (let i = 0; i < 4; i++) {
      await h.clock.advance(20000);
      for (const c of h.infer.calls) c.resolve();
      await flush();
    }
    expect(h.infer.calls.some((c) => c.req.task === 'next_action')).toBe(true);
  });
  it('kill_switch_cloud refusal: after the switch clears, repeating the event is admitted and runs', async () => {
    const h = makeHarness({ cfg: { mode_status: 'ONLY_IN_CLOUD', kill_switch_cloud: true } });
    expect(h.r.observe(ev('P1', 1))).toEqual({ kind: 'REFUSE', reason: 'kill_switch_cloud' });
    h.r.updateConfig({ ...CFG, mode_status: 'ONLY_IN_CLOUD', kill_switch_cloud: false });
    const again = h.r.observe(ev('P1', 1));
    expect(again.kind).not.toBe('REFUSE');
    await h.clock.advance(0);
    expect(h.infer.calls.length).toBe(1);
    expect(h.infer.calls[0]!.req.mode).toBe('ONLY_IN_CLOUD');
  });
});

describe('R3-3 lowering min_inference_interval_ms brings the next dispatch earlier (B6)', () => {
  it('earlier wake-up replaces the later one', async () => {
    const h = makeHarness();
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    expect(h.infer.calls.length).toBe(1);
    const a = h.r.observe(ev('P1', 2));
    expect(a).toEqual({ kind: 'THROTTLE', reason: 'interval', retryAt: 20000 });
    await h.clock.advance(1000);
    h.infer.calls[0]!.resolve();
    await flush();
    h.r.updateConfig({ ...CFG, min_inference_interval_ms: 5000 });
    await h.clock.advance(3999);
    expect(h.infer.calls.length).toBe(1);
    await h.clock.advance(1);
    expect(h.clock.t).toBe(5000);
    expect(h.infer.calls.length).toBe(2);
    expect(h.infer.calls[1]!.req.key.observedRev).toBe(2);
  });
});

describe('R3-4 a refresh deferred because the queue was full is eventually enqueued (B4, B12.2)', () => {
  it('prompt_version change with full pending: status is refreshed on v2 without any new observation', async () => {
    const h = makeHarness();
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    h.r.observe(ev('P1', 1, { task: 'summary' }));
    h.r.observe(ev('P1', 1, { task: 'next_action' }));
    expect(h.r.snapshot().pending.length).toBe(2);
    h.r.updateConfig({ ...CFG, prompt_version: 'v2' });
    h.infer.calls[0]!.resolve();
    await flush();
    const done = new Set<number>([0]);
    for (let i = 0; i < 12; i++) {
      await h.clock.advance(20000);
      h.infer.calls.forEach((c, idx) => { if (!done.has(idx)) { done.add(idx); c.resolve(); } });
      await flush();
      expect(h.r.snapshot().pending.length).toBeLessThanOrEqual(h.r.snapshot().bound);
    }
    expect(h.infer.calls.some((c) => c.req.task === 'status' && c.req.key.promptVersion === 'v2')).toBe(true);
  });
});
