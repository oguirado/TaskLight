import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeHarness, ev, flush, CFG } from './harness';
import type { Harness } from './harness';

afterEach(() => vi.unstubAllGlobals());
const pend = (h: Harness) => h.r.snapshot().pending;
const timerCount = (h: Harness): number => ((h.clock as unknown as { timers: unknown[] }).timers).length;

describe('RP1 pending job whose effective mode/lane changes is dispatched exactly once (B3, B9, B10)', () => {
  // Cloud lane (cap 2) is full with P1, P2; P3 waits with lane_full. The flip makes P3 eligible
  // on the free on_device lane in the same scheduler pass that rewrites its effective mode/lane.
  async function setup(cfg: Parameters<typeof makeHarness>[0], dev?: 'unavailable') {
    const h = makeHarness({ ...cfg, projects: ['P1', 'P2', 'P3'] });
    if (dev) h.r.setDeviceState(dev);
    h.r.observe(ev('P1', 1));
    h.r.observe(ev('P2', 1));
    await h.clock.advance(0);
    expect(h.infer.calls.length).toBe(2);
    h.r.observe(ev('P3', 1));
    await h.clock.advance(0);
    expect(h.infer.calls.length).toBe(2);
    expect(pend(h).length).toBe(1);
    return h;
  }
  async function finish(h: Harness) {
    await h.clock.advance(0);
    expect(h.infer.calls.length).toBe(3);
    expect(h.infer.calls[2]!.req.key.projectId).toBe('P3');
    expect(pend(h).length).toBe(0);
    for (const c of h.infer.calls) c.resolve();
    await flush();
    await h.clock.advance(120000);
    expect(h.infer.calls.length).toBe(3);
    expect(pend(h).length).toBe(0);
  }
  it('kill switch flip: rerouted job leaves pending and never runs twice', async () => {
    const h = await setup({ cfg: { mode_status: 'PREFER_IN_CLOUD' } });
    h.r.updateConfig({ ...CFG, mode_status: 'PREFER_IN_CLOUD', kill_switch_cloud: true });
    await finish(h);
    expect(h.infer.calls[2]!.req.mode).toBe('ONLY_ON_DEVICE');
  });
  it('device state flip changes lane: job dispatched once and removed from pending', async () => {
    const h = await setup({}, 'unavailable');
    h.r.setDeviceState('available');
    await finish(h);
  });
});

describe('RP2 refresh insertion respects the pending bound (B4)', () => {
  it('prompt_version change while pending is full never pushes pending above bound', async () => {
    const h = makeHarness();
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    h.r.observe(ev('P1', 1, { task: 'summary' }));
    h.r.observe(ev('P1', 1, { task: 'next_action' }));
    expect(h.r.snapshot().bound).toBe(2);
    expect(pend(h).length).toBe(2);
    h.r.updateConfig({ ...CFG, prompt_version: 'v2' });
    h.infer.calls[0]!.resolve();
    await flush();
    expect(pend(h).length).toBeLessThanOrEqual(h.r.snapshot().bound);
    for (let i = 0; i < 6; i++) {
      await h.clock.advance(20000);
      for (const c of h.infer.calls) c.resolve();
      await flush();
      expect(pend(h).length).toBeLessThanOrEqual(h.r.snapshot().bound);
    }
  });
});

describe('RP3 shrinking bound never leaves pending above the reported bound (B4, hot swap)', () => {
  async function fill() {
    const h = makeHarness({ projects: ['A', 'B'] });
    h.r.observe(ev('A', 1));
    await h.clock.advance(0);
    h.r.observe(ev('A', 1, { task: 'summary' }));
    h.r.observe(ev('A', 1, { task: 'next_action' }));
    h.r.observe(ev('A', 1, { task: 'screenshot' }));
    expect(h.r.snapshot().bound).toBe(4);
    expect(pend(h).length).toBe(3);
    return h;
  }
  it('unregisterProject shrinking N', async () => {
    const h = await fill();
    h.r.unregisterProject('B');
    const s = h.r.snapshot();
    expect(s.bound).toBe(2);
    expect(s.pending.length).toBeLessThanOrEqual(s.bound);
  });
  it('updateConfig lowering queue_max_depth_factor', async () => {
    const h = await fill();
    h.r.updateConfig({ ...CFG, queue_max_depth_factor: 1 });
    const s = h.r.snapshot();
    expect(s.bound).toBe(2);
    expect(s.pending.length).toBeLessThanOrEqual(s.bound);
  });
});

describe('RP4 expired timeout handles are released (B16)', () => {
  it('dispose does not cancel handles of timers that already fired', async () => {
    const h = makeHarness();
    const live = new Set<number>();
    let id = 0, staleCancels = 0;
    const orig = h.clock.setTimer.bind(h.clock);
    h.clock.setTimer = (ms, fn) => {
      const n = id++;
      live.add(n);
      const cancel = orig(ms, () => { live.delete(n); fn(); });
      return () => { if (!live.has(n)) staleCancels++; live.delete(n); cancel(); };
    };
    for (let rev = 1; rev <= 5; rev++) {
      h.r.observe(ev('P1', rev));
      await h.clock.advance(0);
      await h.clock.advance(60000);
      await h.clock.advance(20000);
    }
    expect(h.infer.calls.length).toBe(5);
    expect(h.r.snapshot().inFlight.on_device).toBe(0);
    h.r.dispose();
    expect(staleCancels).toBe(0);
  });
});

describe('RP5 coalesced replacements do not accumulate dispatch timers (B3, B9)', () => {
  it('many newer revisions while in flight keep outstanding timers and timer allocations bounded', async () => {
    const h = makeHarness();
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    const calls0 = h.clock.setTimerCalls;
    for (let rev = 2; rev <= 60; rev++) h.r.observe(ev('P1', rev));
    expect(pend(h).length).toBe(1);
    expect(pend(h)[0]!.key.observedRev).toBe(60);
    expect(timerCount(h)).toBeLessThanOrEqual(3);
    expect(h.clock.setTimerCalls - calls0).toBeLessThanOrEqual(5);
  });
});
