import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeHarness, ev, flush, CFG } from './harness';

afterEach(() => vi.unstubAllGlobals());
const pend = (h: ReturnType<typeof makeHarness>) => h.r.snapshot().pending;

describe('R1 refresh never downgrades pending work (B3, B12.2; review: lost latest revision)', () => {
  it('prompt_version change while rev1 in flight and rev2 pending: rev2 survives and publishes', async () => {
    const h = makeHarness();
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    h.r.observe(ev('P1', 2));
    expect(pend(h)[0]!.key.observedRev).toBe(2);
    h.r.updateConfig({ ...CFG, prompt_version: 'v2' });
    h.infer.calls[0]!.resolve();
    await flush();
    expect(h.store.casCalls.length).toBe(0);
    const p = pend(h).filter((j) => j.task === 'status');
    expect(p.length).toBe(1);
    expect(p[0]!.key.observedRev).toBe(2);
    expect(p[0]!.key.promptVersion).toBe('v2');
    await h.clock.advance(20000);
    expect(h.infer.calls.length).toBe(2);
    expect(h.infer.calls[1]!.req.key.observedRev).toBe(2);
    expect(h.infer.calls[1]!.req.key.promptVersion).toBe('v2');
    h.infer.calls[1]!.resolve();
    await flush();
    expect(h.store.read('P1')?.source_observed_rev).toBe(2);
    expect(h.r.freshness('P1')).toBe('fresh');
  });
});

describe('R2 kill switch applies at dispatch time to queued work (B10)', () => {
  it('queued PREFER_IN_CLOUD is dispatched as ONLY_ON_DEVICE after kill_switch_cloud=true', async () => {
    const h = makeHarness({ cfg: { mode_status: 'PREFER_IN_CLOUD' } });
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    h.infer.calls[0]!.resolve();
    await flush();
    h.r.observe(ev('P1', 2));
    expect(pend(h).length).toBe(1);
    h.r.updateConfig({ ...CFG, mode_status: 'PREFER_IN_CLOUD', kill_switch_cloud: true });
    await h.clock.advance(20000);
    expect(h.infer.calls.length).toBe(2);
    expect(h.infer.calls[1]!.req.mode).toBe('ONLY_ON_DEVICE');
    expect(h.r.snapshot().inFlight.cloud).toBe(0);
  });
  it('queued ONLY_IN_CLOUD is never dispatched after kill_switch_cloud=true', async () => {
    const h = makeHarness({ cfg: { mode_status: 'ONLY_IN_CLOUD' } });
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    h.infer.calls[0]!.resolve();
    await flush();
    h.r.observe(ev('P1', 2));
    h.r.updateConfig({ ...CFG, mode_status: 'ONLY_IN_CLOUD', kill_switch_cloud: true });
    await h.clock.advance(40000);
    expect(h.infer.calls.length).toBe(1);
    expect(h.infer.calls.some((c, i) => i > 0 && c.req.mode === 'ONLY_IN_CLOUD')).toBe(false);
  });
});

describe('R3 revision 0 on a registered project (B2)', () => {
  it('observe(rev 0) is admitted and starts inference', async () => {
    const h = makeHarness();
    expect(h.r.observe(ev('P1', 0)).kind).toBe('ADMIT');
    await h.clock.advance(0);
    expect(h.infer.calls.length).toBe(1);
    expect(h.infer.calls[0]!.req.key.observedRev).toBe(0);
  });
});

describe('R4 same-revision retry and truthful admission (B2, section 4)', () => {
  it('after a rejected inference, observing the same revision re-admits it, reporting THROTTLE interval then running', async () => {
    const h = makeHarness();
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    h.infer.calls[0]!.reject();
    await flush();
    expect(h.r.snapshot().inFlight.on_device).toBe(0);
    const a = h.r.observe(ev('P1', 1));
    expect(a).toEqual({ kind: 'THROTTLE', reason: 'interval', retryAt: 20000 });
    expect(pend(h).length).toBe(1);
    await h.clock.advance(19999);
    expect(h.infer.calls.length).toBe(1);
    await h.clock.advance(1);
    expect(h.infer.calls.length).toBe(2);
    expect(h.infer.calls[1]!.req.key.observedRev).toBe(1);
    h.infer.calls[1]!.resolve();
    await flush();
    expect(h.store.read('P1')?.source_observed_rev).toBe(1);
  });
  it('repeating a kill-switch-refused ONLY_IN_CLOUD event reports REFUSE again, never ADMIT', () => {
    const h = makeHarness({ cfg: { mode_status: 'ONLY_IN_CLOUD', kill_switch_cloud: true } });
    expect(h.r.observe(ev('P1', 1))).toEqual({ kind: 'REFUSE', reason: 'kill_switch_cloud' });
    expect(h.r.observe(ev('P1', 1))).toEqual({ kind: 'REFUSE', reason: 'kill_switch_cloud' });
    expect(h.r.observe(ev('P1', 1)).kind).not.toBe('ADMIT');
  });
});

describe('R5 FIFO by enqueuedAt after replacement (B9)', () => {
  it('dispatch order follows snapshot enqueuedAt, also when a pending job is replaced by a newer event', async () => {
    const h = makeHarness({ projects: ['P1', 'P2', 'P3'] });
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    h.r.observe(ev('P2', 1));
    await h.clock.advance(1);
    h.r.observe(ev('P3', 1));
    await h.clock.advance(1);
    h.r.observe(ev('P2', 2));
    const snap = pend(h);
    expect(snap.length).toBe(2);
    const expected = [...snap].sort((a, b) => a.enqueuedAt - b.enqueuedAt).map((j) => j.key.projectId);
    expect(expected[0]).toBe(snap.reduce((m, j) => (j.enqueuedAt < m.enqueuedAt ? j : m)).key.projectId);
    h.infer.calls[0]!.resolve();
    await flush(); await h.clock.advance(0);
    expect(h.infer.calls[1]!.req.key.projectId).toBe(expected[0]);
    h.infer.calls[1]!.resolve();
    await flush(); await h.clock.advance(0);
    expect(h.infer.calls[2]!.req.key.projectId).toBe(expected[1]);
  });
  it('equal enqueuedAt dispatches in arrival order (deterministic tie-break)', async () => {
    const h = makeHarness({ projects: ['P1', 'P2', 'P3'] });
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    h.r.observe(ev('P3', 1));
    h.r.observe(ev('P2', 1));
    h.infer.calls[0]!.resolve();
    await flush(); await h.clock.advance(0);
    expect(h.infer.calls[1]!.req.key.projectId).toBe('P3');
    h.infer.calls[1]!.resolve();
    await flush(); await h.clock.advance(0);
    expect(h.infer.calls[2]!.req.key.projectId).toBe('P2');
  });
});

describe('R6 synchronous throw from InferencePort.run (section 4)', () => {
  it('is caught, lane released immediately, capsule stale, next project starts without waiting for timeout', async () => {
    const h = makeHarness({ projects: ['P1', 'P2'] });
    const realRun = h.infer.run.bind(h.infer);
    let threw = 0;
    (h.infer as { run: unknown }).run = () => { threw++; throw new Error('sync boom'); };
    expect(() => h.r.observe(ev('P1', 1))).not.toThrow();
    await expect(h.clock.advance(0)).resolves.toBeUndefined();
    expect(threw).toBe(1);
    expect(h.r.snapshot().inFlight.on_device).toBe(0);
    expect(h.r.freshness('P1')).toBe('stale');
    expect(h.store.casCalls.length).toBe(0);
    (h.infer as { run: unknown }).run = realRun;
    h.r.observe(ev('P2', 1));
    await h.clock.advance(0);
    expect(h.infer.calls.length).toBe(1);
    expect(h.infer.calls[0]!.req.key.projectId).toBe('P2');
  });
});
