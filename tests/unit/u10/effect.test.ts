import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeHarness, ev, flush, rejectValidator, okValidator } from './harness';

afterEach(() => vi.unstubAllGlobals());

async function runOne(h: ReturnType<typeof makeHarness>, rev = 1, over = {}) {
  h.r.observe(ev('P1', rev, over));
  await h.clock.advance(0);
  const c = h.infer.calls[h.infer.calls.length - 1]!;
  return c;
}

describe('O11 schema_reject_negative_control (B12.4)', () => {
  it('reject: no publish, schema_rejects=1', async () => {
    const h = makeHarness({ validator: rejectValidator });
    (await runOne(h)).resolve();
    await flush();
    expect(h.store.casCalls.length).toBe(0);
    expect(h.ledger.counts.schema_rejects).toBe(1);
    expect(h.r.freshness('P1')).toBe('stale');
  });
  it('ok: publishes rev 1 with expectedRev 0 and expected fields', async () => {
    const h = makeHarness({ validator: okValidator });
    h.clock.t = 1234;
    (await runOne(h, 3)).resolve({ raw: 'R', inferenceSource: 'ON_DEVICE' });
    await flush();
    expect(h.store.casCalls.length).toBe(1);
    const c = h.store.casCalls[0]!;
    expect(c.expectedRev).toBe(0);
    expect(c.next.rev).toBe(1);
    expect(c.next.source_observed_rev).toBe(3);
    expect(c.next.incarnation).toBe('A');
    expect(c.next.inference_source).toBe('ON_DEVICE');
    expect(c.next.updated_at).toBe(1234);
    expect(c.next.patch).toEqual({ raw: 'R' });
    expect(h.ledger.counts.schema_rejects).toBe(0);
    expect(h.r.freshness('P1')).toBe('fresh');
  });
});

describe('O8 incarnation_effect_time (B12.1)', () => {
  it('incarnation switched before resolve: no CAS, capsule unchanged', async () => {
    const h = makeHarness();
    const c = await runOne(h);
    h.store.inc.set('P1', 'B');
    c.resolve();
    await flush();
    expect(h.store.casCalls.length).toBe(0);
    expect(h.store.read('P1')).toBeUndefined();
  });
  it('control: unchanged incarnation publishes', async () => {
    const h = makeHarness();
    (await runOne(h)).resolve();
    await flush();
    expect(h.store.casCalls.length).toBe(1);
  });
  it('capsule removed (incarnation undefined) drops result', async () => {
    const h = makeHarness();
    const c = await runOne(h);
    h.store.inc.delete('P1');
    c.resolve();
    await flush();
    expect(h.store.casCalls.length).toBe(0);
  });
});

describe('O9 stale_result_not_published (B12.3)', () => {
  it('source_observed_rev=7, job for rev 5 resolves: no publish, freshness unchanged', async () => {
    const h = makeHarness();
    h.store.seed('P1', { rev: 3, observed_rev: 0, source_observed_rev: 7 });
    const c = await runOne(h, 5);
    const before = h.r.freshness('P1');
    c.resolve();
    await flush();
    expect(h.store.casCalls.length).toBe(0);
    expect(h.store.read('P1')?.rev).toBe(3);
    expect(h.r.freshness('P1')).toBe(before);
  });
  it('control: job for rev 8 against source 7 publishes rev 4', async () => {
    const h = makeHarness();
    h.store.seed('P1', { rev: 3, observed_rev: 0, source_observed_rev: 7 });
    (await runOne(h, 8)).resolve();
    await flush();
    expect(h.store.casCalls.map((x) => [x.expectedRev, x.next.rev])).toEqual([[3, 4]]);
  });
  it('equal revision (5 vs source 5) is not published (must be strictly greater)', async () => {
    const h = makeHarness();
    h.store.seed('P1', { rev: 3, observed_rev: 0, source_observed_rev: 5 });
    (await runOne(h, 5)).resolve();
    await flush();
    expect(h.store.casCalls.length).toBe(0);
  });
});

describe('O10 guarded_publish_cas (B13)', () => {
  it('concurrent writer bumps rev 3 -> 4: calls (3,rev4)=false then (4,rev5)=true', async () => {
    const h = makeHarness();
    h.store.seed('P1', { rev: 3 });
    const c = await runOne(h, 1);
    h.store.beforeCas = () => h.store.seed('P1', { rev: 4 });
    c.resolve();
    await flush();
    expect(h.store.casCalls.map((x) => [x.expectedRev, x.next.rev, x.result])).toEqual([[3, 4, false], [4, 5, true]]);
    for (const x of h.store.casCalls) expect(x.next.rev).toBe(x.expectedRev + 1);
    expect(h.store.read('P1')?.rev).toBe(5);
  });
  it('second CAS false drops the result: exactly two attempts, never a third', async () => {
    const h = makeHarness();
    h.store.seed('P1', { rev: 3 });
    const c = await runOne(h, 1);
    h.store.forceFalse = true;
    c.resolve();
    await flush();
    await h.clock.advance(100000);
    expect(h.store.casCalls.length).toBe(2);
    for (const x of h.store.casCalls) expect(x.next.rev).toBe(x.expectedRev + 1);
    expect(h.store.read('P1')?.rev).toBe(3);
  });
  it('retry re-applies incarnation check: writer changes incarnation, no second CAS', async () => {
    const h = makeHarness();
    h.store.seed('P1', { rev: 3 });
    const c = await runOne(h, 1);
    h.store.beforeCas = () => h.store.seed('P1', { rev: 4 }, 'B');
    c.resolve();
    await flush();
    expect(h.store.casCalls.length).toBe(1);
    expect(h.store.casCalls[0]!.result).toBe(false);
  });
  it('retry re-applies rev check: writer publishes newer source rev, no second CAS', async () => {
    const h = makeHarness();
    h.store.seed('P1', { rev: 3 });
    const c = await runOne(h, 2);
    h.store.beforeCas = () => h.store.seed('P1', { rev: 4, source_observed_rev: 9 });
    c.resolve();
    await flush();
    expect(h.store.casCalls.length).toBe(1);
  });
});

describe('O14 ledger_and_fallback (B14)', () => {
  it('PREFER_ON_DEVICE resolving IN_CLOUD then ON_DEVICE: in_cloud=1 fallbacks=1 on_device=1', async () => {
    const h = makeHarness({ projects: ['P1', 'P2'] });
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    h.infer.calls[0]!.resolve({ inferenceSource: 'IN_CLOUD' });
    await flush();
    expect(h.ledger.counts).toMatchObject({ in_cloud: 1, fallbacks: 1, on_device: 0 });
    h.r.observe(ev('P2', 1));
    await h.clock.advance(0);
    h.infer.calls[1]!.resolve({ inferenceSource: 'ON_DEVICE' });
    await flush();
    expect(h.ledger.counts).toMatchObject({ in_cloud: 1, fallbacks: 1, on_device: 1 });
  });
  it('PREFER_IN_CLOUD resolving IN_CLOUD does not count a fallback', async () => {
    const h = makeHarness({ cfg: { mode_status: 'PREFER_IN_CLOUD' } });
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    h.infer.calls[0]!.resolve({ inferenceSource: 'IN_CLOUD' });
    await flush();
    expect(h.ledger.counts).toMatchObject({ in_cloud: 1, fallbacks: 0, on_device: 0 });
  });
});

describe('O15 stale_badge_and_prompt_swap (B12.2, B15)', () => {
  it('no publication => stale; observe above published source => stale; republish => fresh', async () => {
    const h = makeHarness();
    expect(h.r.freshness('P1')).toBe('stale');
    h.store.seed('P1', { rev: 1, observed_rev: 5, source_observed_rev: 5 });
    h.r.observe(ev('P1', 6));
    expect(h.r.freshness('P1')).toBe('stale');
    await h.clock.advance(0);
    h.infer.calls[0]!.resolve();
    await flush();
    expect(h.r.freshness('P1')).toBe('fresh');
  });
  it('prompt_version swap while v1 job in flight: v1 dropped, v2 job enqueued then published', async () => {
    const h = makeHarness();
    const { CFG } = await import('./harness');
    h.store.seed('P1', { rev: 1, observed_rev: 5, source_observed_rev: 5 });
    h.r.observe(ev('P1', 6));
    await h.clock.advance(0);
    expect(h.infer.calls[0]!.req.key.promptVersion).toBe('v1');
    expect(h.r.freshness('P1')).toBe('stale');
    h.r.updateConfig({ ...CFG, prompt_version: 'v2' });
    h.infer.calls[0]!.resolve();
    await flush();
    expect(h.store.casCalls.length).toBe(0);
    expect(h.r.freshness('P1')).toBe('stale');
    await h.clock.advance(20000);
    expect(h.infer.calls.length).toBe(2);
    expect(h.infer.calls[1]!.req.key.promptVersion).toBe('v2');
    expect(h.infer.calls[1]!.req.key.observedRev).toBe(6);
    h.infer.calls[1]!.resolve();
    await flush();
    expect(h.store.casCalls.length).toBe(1);
    expect(h.store.read('P1')?.rev).toBe(2);
    expect(h.r.freshness('P1')).toBe('fresh');
  });
  it('templateHash change while in flight: old result dropped (B12.2)', async () => {
    const h = makeHarness();
    h.r.observe(ev('P1', 1, { templateHash: 'h1' }));
    await h.clock.advance(0);
    h.r.observe(ev('P1', 2, { templateHash: 'h2' }));
    h.infer.calls[0]!.resolve();
    await flush();
    expect(h.store.casCalls.length).toBe(0);
  });
});

describe('B16 timeout and stale badge', () => {
  it('in-flight job exceeding inference_timeout_ms is aborted, slot released, capsule stale, late resolve ignored', async () => {
    const h = makeHarness();
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    const c = h.infer.calls[0]!;
    await h.clock.advance(59999);
    expect(c.signal.aborted).toBe(false);
    expect(h.r.snapshot().inFlight.on_device).toBe(1);
    await h.clock.advance(1);
    expect(c.signal.aborted).toBe(true);
    expect(h.r.snapshot().inFlight.on_device).toBe(0);
    expect(h.r.freshness('P1')).toBe('stale');
    c.resolve();
    await flush();
    expect(h.store.casCalls.length).toBe(0);
    expect(h.r.freshness('P1')).toBe('stale');
  });
  it('control: resolving before timeout publishes and timeout later does not abort', async () => {
    const h = makeHarness();
    h.r.observe(ev('P1', 1));
    await h.clock.advance(0);
    const c = h.infer.calls[0]!;
    c.resolve();
    await flush();
    await h.clock.advance(60000);
    expect(c.signal.aborted).toBe(false);
    expect(h.store.casCalls.length).toBe(1);
    expect(h.r.freshness('P1')).toBe('fresh');
  });
});
