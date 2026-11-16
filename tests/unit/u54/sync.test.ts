// U54 O4: putDigest origin handling (SPEC_U54 section 2).
import { describe, expect, it } from 'vitest';
import type { DigestIn } from '../../../src/sync';
import { drain, makeEnv } from '../u14/harness';

const dig = (over: Record<string, unknown> = {}): DigestIn => ({
  revVector: { p1: 4 }, needs_you: [{ projectId: 'p1' }], brief: 'Two things need you.',
  origin: 'ON_DEVICE', prompt_version: 'v1', builtAt: 1_700_000_000_000, ...over,
}) as unknown as DigestIn;

const written = async (origin: unknown, tiers: Record<string, 'standard' | 'shared' | 'private'> = { p1: 'standard' }) => {
  const e = makeEnv({ tiers });
  const ack = e.sync.putDigest(dig({ origin }));
  await drain(e);
  return { e, ack, docs: e.fs.committedTo('digests') };
};

describe('O4 accepted origins map to themselves', () => {
  it.each(['ON_DEVICE', 'IN_CLOUD', 'LOCAL_SERVER', 'REMOTE_PROVIDER'])('%s is written as inference_source %s', async (o) => {
    const { ack, docs } = await written(o);
    expect(ack).toMatchObject({ ok: true });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.data.inference_source).toBe(o);
  });
  it('LOCAL_SERVER is accepted for a shared project; REMOTE_PROVIDER for a standard one', async () => {
    expect((await written('LOCAL_SERVER', { p1: 'shared' })).docs[0]?.data.inference_source).toBe('LOCAL_SERVER');
    expect((await written('REMOTE_PROVIDER', { p1: 'standard' })).docs[0]?.data.inference_source).toBe('REMOTE_PROVIDER');
  });
  it.each(['ON_DEVICE', 'IN_CLOUD'])('old origin %s stays accepted for shared projects', async (o) => {
    expect((await written(o, { p1: 'shared' })).ack).toMatchObject({ ok: true });
  });
});

describe('O4 any other origin -> DIGEST_BAD_ORIGIN, outbox unchanged', () => {
  it.each(['OTHER', undefined, 'on_device', 'in_cloud', 'local_server', '', null, 5, {}, 'LOCAL_SERVER ', '__proto__'] as unknown[])(
    'origin %j', async (o) => {
      const { e, ack, docs } = await written(o);
      expect(ack).toEqual({ ok: false, code: 'DIGEST_BAD_ORIGIN' });
      expect(docs).toHaveLength(0);
      expect(e.fs.attempted).toHaveLength(0);
      expect(e.sync.status().pending).toBe(0);
    });
  it('is checked before meta reads: unknown / private project ids with a bad origin still give DIGEST_BAD_ORIGIN', () => {
    const e = makeEnv({ tiers: { p1: 'standard', p2: 'private' } });
    expect(e.sync.putDigest(dig({ origin: 'OTHER', revVector: { p2: 1 }, needs_you: [{ projectId: 'ghost' }] })))
      .toEqual({ ok: false, code: 'DIGEST_BAD_ORIGIN' });
  });
});

describe('O4 REMOTE_PROVIDER x shared', () => {
  it.each([
    ['in revVector and needs_you', { revVector: { p1: 1 }, needs_you: [{ projectId: 'p1' }] }],
    ['only in revVector', { revVector: { p1: 1 }, needs_you: [] }],
    ['only in needs_you', { revVector: {}, needs_you: [{ projectId: 'p1' }] }],
  ])('shared project %s -> DIGEST_REMOTE_SHARED, nothing queued', async (_n, over) => {
    const e = makeEnv({ tiers: { p1: 'shared' } });
    expect(e.sync.putDigest(dig({ origin: 'REMOTE_PROVIDER', ...over }))).toEqual({ ok: false, code: 'DIGEST_REMOTE_SHARED' });
    await drain(e);
    expect(e.fs.attempted).toHaveLength(0);
    expect(e.sync.status().pending).toBe(0);
  });
  it('a shared project next to standard ones is enough', () => {
    const e = makeEnv({ tiers: { p1: 'standard', p2: 'shared' } });
    expect(e.sync.putDigest(dig({ origin: 'REMOTE_PROVIDER', revVector: { p1: 1, p2: 2 }, needs_you: [] })))
      .toEqual({ ok: false, code: 'DIGEST_REMOTE_SHARED' });
  });
  it('private still wins its own code for an external origin (DIGEST_HAS_PRIVATE)', () => {
    const e = makeEnv({ tiers: { p1: 'private' } });
    for (const o of ['LOCAL_SERVER', 'REMOTE_PROVIDER'])
      expect(e.sync.putDigest(dig({ origin: o }))).toEqual({ ok: false, code: 'DIGEST_HAS_PRIVATE' });
  });
});

describe('regression: LOCAL_RULES and old paths unchanged', () => {
  it('LOCAL_RULES -> DIGEST_LOCAL_ORIGIN (also with a ghost project)', () => {
    const e = makeEnv();
    expect(e.sync.putDigest(dig({ origin: 'LOCAL_RULES' }))).toEqual({ ok: false, code: 'DIGEST_LOCAL_ORIGIN' });
    expect(e.sync.putDigest(dig({ origin: 'LOCAL_RULES', needs_you: [{ projectId: 'ghost' }] }))).toEqual({ ok: false, code: 'DIGEST_LOCAL_ORIGIN' });
  });
  it('old origins keep DIGEST_HAS_PRIVATE / DIGEST_OVERSIZE', () => {
    const e = makeEnv({ tiers: { p1: 'standard', p2: 'private' } });
    for (const o of ['ON_DEVICE', 'IN_CLOUD']) {
      expect(e.sync.putDigest(dig({ origin: o, revVector: { p2: 1 } }))).toEqual({ ok: false, code: 'DIGEST_HAS_PRIVATE' });
      expect(e.sync.putDigest(dig({ origin: o, brief: 'x'.repeat(601) }))).toEqual({ ok: false, code: 'DIGEST_OVERSIZE' });
    }
  });
});
