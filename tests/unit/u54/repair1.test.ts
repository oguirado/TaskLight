// U54 repair loop 1 (Sol HOLD): stale projectTier after standard -> shared, and queued digests
// written without re-checking current tier authorization.
import { describe, expect, it } from 'vitest';
import type { DigestIn } from '../../../src/sync';
import { drain, makeEnv } from '../u14/harness';
import { ExtLedger, ev, flush, makeH, published } from './harness';

// ---------- 1. reconciler: projectTier follows newer non-private observations ----------

/** rev 1 observed as `first`; while its inference is in flight rev 2 is observed as `second`;
 *  then the rev-1 inference resolves with `source`. */
async function promoteInFlight(first: 'standard' | 'shared' | 'private', second: 'standard' | 'shared' | 'private', source: string) {
  const h = makeH();
  h.r.observe(ev('P1', 1, { tier: first }));
  await h.clock.advance(0);
  expect(h.infer.calls.length).toBe(1);
  h.r.observe(ev('P1', 2, { tier: second }));
  h.infer.calls[0]!.resolve({ inferenceSource: source as never });
  await flush();
  await h.clock.advance(0);
  return h;
}

describe('A-U54r1 reconciler: standard -> shared promotion governs REMOTE_PROVIDER', () => {
  it('control: standard -> standard, REMOTE_PROVIDER rev-1 result is published and counted', async () => {
    const h = await promoteInFlight('standard', 'standard', 'REMOTE_PROVIDER');
    expect(published(h)).toBe(true);
    expect(h.ledger.ext).toEqual(['remote_provider']);
  });
  it('control: standard -> shared, LOCAL_SERVER is still allowed for shared', async () => {
    const h = await promoteInFlight('standard', 'shared', 'LOCAL_SERVER');
    expect(published(h)).toBe(true);
    expect(h.ledger.ext).toEqual(['local_server']);
  });
  it('standard -> shared (newer rev), then REMOTE_PROVIDER: not published, not counted', async () => {
    const h = await promoteInFlight('standard', 'shared', 'REMOTE_PROVIDER');
    expect(published(h)).toBe(false);
    expect(h.ledger.ext).toEqual([]);
    expect(h.ledger.counts.in_cloud).toBe(0);
  });
  it('standard -> shared on another task of the same project also governs', async () => {
    const h = makeH();
    h.r.observe(ev('P1', 1, { tier: 'standard', task: 'status' }));
    await h.clock.advance(0);
    h.r.observe(ev('P1', 1, { tier: 'shared', task: 'summary' as never }));
    h.infer.calls[0]!.resolve({ inferenceSource: 'REMOTE_PROVIDER' as never });
    await flush();
    await h.clock.advance(0);
    expect(h.store.read('P1')?.inference_source).not.toBe('REMOTE_PROVIDER');
    expect(h.ledger.ext).toEqual([]);
  });
  it('shared promoted inside incExternal (reentrant) blocks REMOTE_PROVIDER', async () => {
    const ledger = new ExtLedger();
    const h = makeH({ ledger });
    const orig = ledger.incExternal.bind(ledger);
    ledger.incExternal = (c) => { orig(c); h.r.observe(ev('P1', 2, { tier: 'shared' })); };
    h.r.observe(ev('P1', 1, { tier: 'standard' }));
    await h.clock.advance(0);
    h.infer.calls[0]!.resolve({ inferenceSource: 'REMOTE_PROVIDER' as never });
    await flush();
    await h.clock.advance(0);
    expect(published(h)).toBe(false);
  });
  it('private stays sticky: private -> standard keeps IN_CLOUD blocked', async () => {
    const h = await promoteInFlight('private', 'standard', 'IN_CLOUD');
    expect(published(h)).toBe(false);
    expect(h.ledger.counts.in_cloud).toBe(0);
  });
});

// ---------- 2. sync: queued digests re-check current tiers at write time ----------

const dig = (over: Record<string, unknown> = {}): DigestIn => ({
  revVector: { p1: 4 }, needs_you: [{ projectId: 'p1' }], brief: 'Two things need you.',
  origin: 'ON_DEVICE', prompt_version: 'v1', builtAt: 1_700_000_000_000, ...over,
}) as unknown as DigestIn;

type Tier = 'standard' | 'shared' | 'private';

/** putDigest while p1 is `before`; tier changes to `after` before the flush. */
async function enqueueThenPromote(origin: string, before: Tier, after: Tier, over: Record<string, unknown> = {}) {
  const e = makeEnv({ tiers: { p1: before, p2: 'standard' } });
  const ack = e.sync.putDigest(dig({ origin, ...over }));
  e.tiers.p1 = after;
  await drain(e);
  return { e, ack, docs: e.fs.committedTo('digests') };
}

describe('A-U54r1 sync: digests queued then invalidated are dropped', () => {
  it.each(['ON_DEVICE', 'IN_CLOUD', 'LOCAL_SERVER', 'REMOTE_PROVIDER'])('control: %s with p1 standard throughout is written', async (o) => {
    const { ack, docs } = await enqueueThenPromote(o, 'standard', 'standard');
    expect(ack).toMatchObject({ ok: true });
    expect(docs).toHaveLength(1);
  });
  it.each(['ON_DEVICE', 'IN_CLOUD', 'LOCAL_SERVER', 'REMOTE_PROVIDER'])('%s queued, p1 -> private before flush: no digest written', async (o) => {
    const { e, ack, docs } = await enqueueThenPromote(o, 'standard', 'private');
    expect(ack).toMatchObject({ ok: true });
    expect(docs).toHaveLength(0);
    expect(e.fs.attempted.filter((r) => r.segs[2] === 'digests')).toHaveLength(0);
    expect(e.sync.status().pending).toBe(0);
  });
  it('p1 -> private via needs_you only (not in revVector): not written', async () => {
    const { docs } = await enqueueThenPromote('LOCAL_SERVER', 'standard', 'private', { revVector: { p2: 1 }, needs_you: [{ projectId: 'p1' }] });
    expect(docs).toHaveLength(0);
  });
  it('project meta removed after enqueue: not written', async () => {
    const e = makeEnv({ tiers: { p1: 'standard' } });
    expect(e.sync.putDigest(dig({ origin: 'ON_DEVICE' }))).toMatchObject({ ok: true });
    delete e.tiers.p1;
    await drain(e);
    expect(e.fs.committedTo('digests')).toHaveLength(0);
  });
  it('REMOTE_PROVIDER queued, p1 standard -> shared before flush: not written', async () => {
    const { e, ack, docs } = await enqueueThenPromote('REMOTE_PROVIDER', 'standard', 'shared');
    expect(ack).toMatchObject({ ok: true });
    expect(docs).toHaveLength(0);
    expect(e.sync.status().pending).toBe(0);
  });
  it.each(['ON_DEVICE', 'IN_CLOUD', 'LOCAL_SERVER'])('control: %s queued, p1 -> shared is still written', async (o) => {
    const { docs } = await enqueueThenPromote(o, 'standard', 'shared');
    expect(docs).toHaveLength(1);
  });
  it.each([['LOCAL_SERVER', 'private'], ['ON_DEVICE', 'private'], ['REMOTE_PROVIDER', 'shared']] as const)(
    '%s: p1 -> %s during the transaction (after its reads): not written', async (o, to) => {
      const e = makeEnv({ tiers: { p1: 'standard' } });
      expect(e.sync.putDigest(dig({ origin: o }))).toMatchObject({ ok: true });
      e.fs.onGet = () => { e.tiers.p1 = to; };
      await drain(e);
      expect(e.fs.committedTo('digests')).toHaveLength(0);
    });
});
