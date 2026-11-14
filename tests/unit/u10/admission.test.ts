import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeHarness, ev, flush } from './harness';

afterEach(() => vi.unstubAllGlobals());

describe('O5 interval_throttle (B6)', () => {
  it('event at t=5000 after a start at t=0 is THROTTLE interval retryAt=20000; fires at 20000 only', async () => {
    const h = makeHarness();
    expect(h.r.observe(ev('P1', 1)).kind).toBe('ADMIT');
    await h.clock.advance(0);
    h.infer.calls[0]!.resolve();
    await flush();
    await h.clock.advance(5000);
    expect(h.r.observe(ev('P1', 2))).toEqual({ kind: 'THROTTLE', reason: 'interval', retryAt: 20000 });
    await h.clock.advance(19999 - 5000);
    expect(h.clock.now()).toBe(19999);
    expect(h.infer.calls.length).toBe(1);
    await h.clock.advance(1);
    expect(h.infer.calls.length).toBe(2);
    expect(h.infer.calls[1]!.req.key.observedRev).toBe(2);
    expect(h.raf).not.toHaveBeenCalled();
  });
  it('interval is per project: another project starts immediately', async () => {
    const h = makeHarness({ projects: ['P1', 'P2'], cfg: { mode_status: 'PREFER_IN_CLOUD' } });
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    expect(h.r.observe(ev('P2', 1)).kind).toBe('ADMIT');
    await h.clock.advance(0);
    expect(h.infer.calls.length).toBe(2);
  });
});

describe('O6 lane_caps (B5, B7)', () => {
  it('cloud lane: 2 in flight, third THROTTLE lane_full', async () => {
    const h = makeHarness({ projects: ['P1', 'P2', 'P3'], cfg: { mode_status: 'PREFER_IN_CLOUD' } });
    expect(h.r.observe(ev('P1', 1))).toEqual({ kind: 'ADMIT', lane: 'cloud' });
    expect(h.r.observe(ev('P2', 1))).toEqual({ kind: 'ADMIT', lane: 'cloud' });
    const third = h.r.observe(ev('P3', 1));
    expect(third.kind).toBe('THROTTLE');
    if (third.kind === 'THROTTLE') expect(third.reason).toBe('lane_full');
    await h.clock.advance(0);
    expect(h.r.snapshot().inFlight.cloud).toBe(2);
    expect(h.infer.calls.length).toBe(2);
  });
  it('on-device lane: concurrency 1', async () => {
    const h = makeHarness({ projects: ['P1', 'P2'] });
    expect(h.r.observe(ev('P1', 1))).toEqual({ kind: 'ADMIT', lane: 'on_device' });
    const second = h.r.observe(ev('P2', 1));
    expect(second.kind).toBe('THROTTLE');
    if (second.kind === 'THROTTLE') expect(second.reason).toBe('lane_full');
    await h.clock.advance(0);
    expect(h.r.snapshot().inFlight.on_device).toBe(1);
    expect(h.infer.calls.length).toBe(1);
    // slot released -> queued job dispatches
    h.infer.calls[0]!.resolve();
    await flush(); await h.clock.advance(0);
    expect(h.infer.calls.length).toBe(2);
  });
  it('config hot swap: new caps apply at next admission', async () => {
    const h = makeHarness({ projects: ['P1', 'P2'], cfg: { mode_status: 'PREFER_IN_CLOUD' } });
    h.r.updateConfig({ ...(await import('./harness')).CFG, mode_status: 'PREFER_IN_CLOUD', cloud_concurrency: 1 });
    h.r.observe(ev('P1', 1));
    const b = h.r.observe(ev('P2', 1));
    expect(b.kind).toBe('THROTTLE');
  });
});

describe('O7 device_routing (B7, B8)', () => {
  it('downloading: PREFER_ON_DEVICE routes to cloud concurrently; ONLY_ON_DEVICE+unavailable throttles', async () => {
    const h = makeHarness({ projects: ['P1', 'P2', 'P3'] });
    h.r.setDeviceState('downloading');
    expect(h.r.observe(ev('P1', 1))).toEqual({ kind: 'ADMIT', lane: 'cloud' });
    expect(h.r.observe(ev('P2', 1))).toEqual({ kind: 'ADMIT', lane: 'cloud' });
    await h.clock.advance(0);
    expect(h.r.snapshot().inFlight.cloud).toBe(2);
    expect(h.infer.calls.length).toBe(2);
    h.r.setDeviceState('unavailable');
    const third = h.r.observe(ev('P3', 1, { task: 'screenshot' }));
    expect(third.kind).toBe('THROTTLE');
    if (third.kind === 'THROTTLE') expect(third.reason).toBe('device_not_ready');
    await h.clock.advance(0);
    expect(h.infer.calls.length).toBe(2);
  });
  it('B8: later setDeviceState(available) re-admits the waiting ONLY_ON_DEVICE job', async () => {
    const h = makeHarness();
    h.r.setDeviceState('unavailable');
    const a = h.r.observe(ev('P1', 1, { task: 'screenshot' }));
    expect(a.kind).toBe('THROTTLE');
    await h.clock.advance(0);
    expect(h.infer.calls.length).toBe(0);
    h.r.setDeviceState('available');
    await h.clock.advance(0);
    expect(h.infer.calls.length).toBe(1);
    expect(h.infer.calls[0]!.req.mode).toBe('ONLY_ON_DEVICE');
  });
  it('device available: PREFER_ON_DEVICE goes on_device', async () => {
    const h = makeHarness();
    expect(h.r.observe(ev('P1', 1))).toEqual({ kind: 'ADMIT', lane: 'on_device' });
    await h.clock.advance(0);
    expect(h.r.snapshot().inFlight).toEqual({ on_device: 1, cloud: 0 });
    expect(h.infer.calls[0]!.req.mode).toBe('PREFER_ON_DEVICE');
  });
});

describe('O12 kill_switch (B10)', () => {
  it('ONLY_IN_CLOUD refused; PREFER_ON_DEVICE dispatched as ONLY_ON_DEVICE', async () => {
    const h = makeHarness({ projects: ['P1', 'P2'], cfg: { kill_switch_cloud: true, mode_summary: 'ONLY_IN_CLOUD', mode_status: 'PREFER_ON_DEVICE' } });
    expect(h.r.observe(ev('P1', 1, { task: 'summary' }))).toEqual({ kind: 'REFUSE', reason: 'kill_switch_cloud' });
    expect(h.ledger.counts.refusals).toBe(1);
    expect(h.r.observe(ev('P2', 1, { task: 'status' })).kind).toBe('ADMIT');
    await h.clock.advance(0);
    expect(h.infer.calls.length).toBe(1);
    expect(h.infer.calls[0]!.req.mode).toBe('ONLY_ON_DEVICE');
  });
  it('PREFER_IN_CLOUD under kill switch is dispatched as ONLY_ON_DEVICE', async () => {
    const h = makeHarness({ cfg: { kill_switch_cloud: true, mode_status: 'PREFER_IN_CLOUD' } });
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    expect(h.infer.calls[0]!.req.mode).toBe('ONLY_ON_DEVICE');
  });
  it('control: without kill switch the requested mode is preserved', async () => {
    const h = makeHarness({ cfg: { mode_status: 'PREFER_IN_CLOUD' } });
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    expect(h.infer.calls[0]!.req.mode).toBe('PREFER_IN_CLOUD');
  });
});

describe('O13 private_tier_no_cloud (B11)', () => {
  it('private dispatches ONLY_ON_DEVICE; IN_CLOUD outcome is never published', async () => {
    const h = makeHarness({ cfg: { mode_status: 'PREFER_IN_CLOUD' } });
    h.r.observe(ev('P1', 1, { tier: 'private' }));
    await h.clock.advance(0);
    expect(h.infer.calls[0]!.req.mode).toBe('ONLY_ON_DEVICE');
    h.infer.calls[0]!.resolve({ inferenceSource: 'IN_CLOUD' });
    await flush();
    expect(h.store.casCalls.length).toBe(0);
    expect(h.store.read('P1')).toBeUndefined();
  });
  it('control: private with ON_DEVICE outcome does publish', async () => {
    const h = makeHarness();
    h.r.observe(ev('P1', 1, { tier: 'private' }));
    await h.clock.advance(0);
    h.infer.calls[0]!.resolve({ inferenceSource: 'ON_DEVICE' });
    await flush();
    expect(h.store.read('P1')?.rev).toBe(1);
  });
});
