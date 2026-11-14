import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeHarness, ev, flush } from './harness';

afterEach(() => vi.unstubAllGlobals());
const pend = (h: ReturnType<typeof makeHarness>) => h.r.snapshot().pending;

describe('O2 coalesce_latest (B3)', () => {
  it('10x burst coalesces to latest; infer called exactly twice (1 then 11); no rAF', async () => {
    const h = makeHarness();
    expect(h.r.observe(ev('P1', 1)).kind).toBe('ADMIT');
    await h.clock.advance(0);
    expect(h.infer.calls.map((c) => c.req.key.observedRev)).toEqual([1]);
    for (let rev = 2; rev <= 11; rev++) {
      h.r.observe(ev('P1', rev));
      expect(pend(h).filter((j) => j.task === 'status').length).toBeLessThanOrEqual(1);
    }
    expect(pend(h).length).toBe(1);
    expect(pend(h)[0]!.key.observedRev).toBe(11);
    expect(h.r.snapshot().inFlight.on_device).toBe(1); // in-flight not cancelled
    h.infer.calls[0]!.resolve();
    await flush();
    await h.clock.advance(19999);
    expect(h.infer.calls.length).toBe(1);
    await h.clock.advance(1);
    expect(h.infer.calls.map((c) => c.req.key.observedRev)).toEqual([1, 11]);
    expect(h.raf).not.toHaveBeenCalled();
  });
  it('B2: equal revision with different templateHash is a no-op (slot metadata unchanged, result still publishable)', async () => {
    const h = makeHarness();
    h.r.observe(ev('P1', 1, { templateHash: 'h1' }));
    await h.clock.advance(0);
    h.r.observe(ev('P1', 1, { templateHash: 'h2' }));
    expect(pend(h).length).toBe(0);
    h.infer.calls[0]!.resolve();
    await flush();
    expect(h.store.casCalls.length).toBe(1);
    expect(h.store.casCalls[0]!.result).toBe(true);
  });
  it('B2: lower or equal revision is a no-op; invalid revisions throw TypeError', async () => {
    const h = makeHarness();
    h.r.observe(ev('P1', 5));
    await h.clock.advance(0);
    h.r.observe(ev('P1', 7));
    const before = pend(h).length;
    h.r.observe(ev('P1', 6));
    h.r.observe(ev('P1', 7));
    expect(pend(h).length).toBe(before);
    expect(pend(h)[0]!.key.observedRev).toBe(7);
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => h.r.observe(ev('P1', bad))).toThrow(TypeError);
    }
  });
});

describe('O3 g5_burst_bounded (B4, B5)', () => {
  it('10 events x 5 projects while lane busy: pending <= 10, on-device in-flight <= 1', async () => {
    const ps = ['P1', 'P2', 'P3', 'P4', 'P5'];
    const h = makeHarness({ projects: ps });
    for (let rev = 1; rev <= 10; rev++) {
      for (const p of ps) {
        h.r.observe(ev(p, rev));
        const s = h.r.snapshot();
        expect(s.pending.length).toBeLessThanOrEqual(10);
        expect(s.inFlight.on_device).toBeLessThanOrEqual(1);
      }
    }
    await h.clock.advance(0);
    const s = h.r.snapshot();
    expect(s.bound).toBe(10);
    expect(s.inFlight.on_device).toBe(1);
    expect(h.infer.calls.length).toBe(1);
    expect(s.pending.length).toBeGreaterThanOrEqual(4);
    expect(new Set(s.pending.map((j) => j.key.projectId + j.task)).size).toBe(s.pending.length);
    for (const j of s.pending) expect(j.key.observedRev).toBe(10);
  });
});

describe('O4 queue_full_refuse (B4)', () => {
  it('N=1, bound 2 counts PENDING only: 1 in flight + 2 pending admitted, third pending slot is REFUSE queue_full, refusals=1', async () => {
    const h = makeHarness();
    expect(h.r.snapshot().bound).toBe(2);
    expect(h.r.observe(ev('P1', 1, { task: 'status' })).kind).toBe('ADMIT');
    await h.clock.advance(0);
    expect(h.r.snapshot().inFlight.on_device).toBe(1);
    expect(h.r.observe(ev('P1', 1, { task: 'summary' })).kind).not.toBe('REFUSE');
    expect(h.r.observe(ev('P1', 1, { task: 'next_action' })).kind).not.toBe('REFUSE');
    expect(h.r.snapshot().pending.length).toBe(2);
    expect(h.ledger.counts.refusals).toBe(0);
    const a4 = h.r.observe(ev('P1', 1, { task: 'screenshot' }));
    expect(a4).toEqual({ kind: 'REFUSE', reason: 'queue_full' });
    expect(h.ledger.counts.refusals).toBe(1);
    expect(h.r.snapshot().pending.length).toBe(2);
  });
  it('coalescing replacement never refuses even at the bound', async () => {
    const h = makeHarness();
    h.r.observe(ev('P1', 1, { task: 'status' }));
    await h.clock.advance(0);
    h.r.observe(ev('P1', 1, { task: 'summary' }));
    for (let rev = 2; rev < 6; rev++) {
      expect(h.r.observe(ev('P1', rev, { task: 'summary' })).kind).not.toBe('REFUSE');
      expect(h.r.observe(ev('P1', rev, { task: 'status' })).kind).not.toBe('REFUSE');
    }
    expect(h.ledger.counts.refusals).toBe(0);
    expect(h.r.snapshot().pending.length).toBeLessThanOrEqual(2);
    expect(h.r.snapshot().pending.find((j) => j.task === 'summary')?.key.observedRev).toBe(5);
  });
  it('bound scales with queue_max_depth_factor x N', () => {
    const h = makeHarness({ projects: ['P1', 'P2', 'P3'], cfg: { queue_max_depth_factor: 3 } });
    expect(h.r.snapshot().bound).toBe(9);
  });
});

describe('B9 FIFO dispatch', () => {
  it('pending jobs start in enqueue order as the lane frees', async () => {
    const h = makeHarness({ projects: ['P1', 'P2', 'P3'] });
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    h.r.observe(ev('P3', 1));
    await h.clock.advance(1);
    h.r.observe(ev('P2', 1));
    h.infer.calls[0]!.resolve();
    await flush(); await h.clock.advance(0);
    expect(h.infer.calls.length).toBe(2);
    expect(h.infer.calls[1]!.req.key.projectId).toBe('P3');
    h.infer.calls[1]!.resolve();
    await flush(); await h.clock.advance(0);
    expect(h.infer.calls[2]!.req.key.projectId).toBe('P2');
  });
});

describe('errors and lifecycle', () => {
  it('unknown project is refused', () => {
    const h = makeHarness();
    expect(h.r.observe(ev('NOPE', 1))).toEqual({ kind: 'REFUSE', reason: 'unknown_project' });
  });
  it('B17 dispose aborts in-flight, later observe is REFUSE disposed', async () => {
    const h = makeHarness();
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    expect(h.infer.calls.length).toBe(1);
    h.r.dispose();
    expect(h.infer.calls[0]!.signal.aborted).toBe(true);
    expect(h.r.observe(ev('P1', 2))).toEqual({ kind: 'REFUSE', reason: 'disposed' });
    h.infer.calls[0]!.resolve();
    await flush();
    expect(h.store.casCalls.length).toBe(0);
  });
  it('inference error releases the slot and leaves capsule stale', async () => {
    const h = makeHarness();
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    h.infer.calls[0]!.reject();
    await flush();
    expect(h.r.snapshot().inFlight.on_device).toBe(0);
    expect(h.r.freshness('P1')).toBe('stale');
    expect(h.store.casCalls.length).toBe(0);
  });
});
