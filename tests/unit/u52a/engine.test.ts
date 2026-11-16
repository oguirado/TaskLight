// U52a ORACLE: sync engine debts D-U54-1 (never-settling fs.txn stalls flush on dispose/auth change)
// and D-U54-2 (reentrant fs.timestamp tier change after the final digest tier check).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DigestIn } from '../../../src/sync';
import { drain, makeEnv, settle, type Env } from '../u14/harness';

const dig = (over: Record<string, unknown> = {}): DigestIn => ({
  revVector: { p1: 4 }, needs_you: [{ projectId: 'p1' }], brief: 'Two things need you.',
  origin: 'ON_DEVICE', prompt_version: 'v1', builtAt: 1_700_000_000_000, ...over,
}) as unknown as DigestIn;

// ---- unhandled rejection tracking ----
let unhandled: unknown[] = [];
const onUnhandled = (r: unknown): void => { unhandled.push(r); };
beforeEach(() => { unhandled = []; process.on('unhandledRejection', onUnhandled); });
afterEach(() => { process.off('unhandledRejection', onUnhandled); });

interface Ctl { resolve(v: unknown): void; reject(e: unknown): void }
/** fs.txn that never settles on its own; the test may complete it late through the returned handles. */
function hangingTxn(e: Env): Ctl[] {
  const ctls: Ctl[] = [];
  (e.fs as unknown as { txn: unknown }).txn = (): Promise<unknown> => {
    e.fs.txnCalls++;
    return new Promise((resolve, reject) => { ctls.push({ resolve, reject }); });
  };
  return ctls;
}
const track = <T,>(p: Promise<T>) => {
  const s: { done: boolean; val?: T; err?: unknown } = { done: false };
  p.then((v) => { s.done = true; s.val = v; }, (e) => { s.done = true; s.err = e; });
  return s;
};
const FAR = 120_000; // far beyond SYNC_LIMITS.TXN_TIMEOUT_MS (10_000) + backoff: only a cancel path may settle p

describe('D-U54-1 dispose() settles a flush stuck on a never-settling fs.txn', () => {
  it('control: txn hangs, flush stays pending before dispose', async () => {
    const e = makeEnv();
    const ctls = hangingTxn(e);
    expect(e.sync.putDigest(dig())).toMatchObject({ ok: true });
    const s = track(e.sync.flush());
    await settle();
    expect(ctls).toHaveLength(1);
    expect(s.done).toBe(false);
    await e.sync.dispose();
  });
  it('flush promise settles after dispose, within fake time', async () => {
    const e = makeEnv();
    hangingTxn(e);
    e.sync.putDigest(dig());
    const p = e.sync.flush();
    const s = track(p);
    await settle();
    expect(s.done).toBe(false);
    await e.sync.dispose();
    await e.clock.advance(FAR);
    expect(s.done).toBe(true);
    expect(s.err).toBeUndefined();
    expect(s.val).toBeDefined();
    expect(unhandled).toEqual([]);
  });
  it('after dispose: nothing written, no backoff timer left, no further txn started', async () => {
    const e = makeEnv();
    const ctls = hangingTxn(e);
    e.sync.putDigest(dig());
    const s = track(e.sync.flush());
    await settle();
    await e.sync.dispose();
    await e.clock.advance(FAR);
    expect(s.done).toBe(true);
    expect(e.sync.status().counters.written).toBe(0);
    expect(e.fs.committedTo('digests')).toHaveLength(0);
    expect(ctls).toHaveLength(1);
    expect(e.clock.timerCount()).toBe(0); // "cancelled" is not transient: no armBackoff
    expect(e.sync.status().pending).toBe(0);
  });
  it('late txn completion (value) after dispose is ignored', async () => {
    const e = makeEnv();
    const ctls = hangingTxn(e);
    e.sync.putDigest(dig());
    const s = track(e.sync.flush());
    await settle();
    await e.sync.dispose();
    await e.clock.advance(FAR);
    expect(s.done).toBe(true);
    ctls[0]!.resolve({ conflict: false, wrote: true });
    await settle();
    expect(e.sync.status().counters).toEqual({ written: 0, denied: 0, conflicts: 0, droppedFields: 0 });
    expect(e.fs.committedTo('digests')).toHaveLength(0);
    expect(unhandled).toEqual([]);
  });
  it('late txn rejection after dispose is ignored, no unhandled rejection', async () => {
    const e = makeEnv();
    const ctls = hangingTxn(e);
    e.sync.putDigest(dig());
    const s = track(e.sync.flush());
    await settle();
    await e.sync.dispose();
    await e.clock.advance(FAR);
    expect(s.done).toBe(true);
    ctls[0]!.reject(new Error('late boom'));
    await settle(6);
    expect(e.sync.status().counters.denied).toBe(0);
    expect(unhandled).toEqual([]);
  });
  it('dispose() itself resolves while the txn is hung, and flush after dispose settles immediately', async () => {
    const e = makeEnv();
    hangingTxn(e);
    e.sync.putDigest(dig());
    void e.sync.flush();
    await settle();
    const d = track(e.sync.dispose());
    await settle();
    expect(d.done).toBe(true);
    const s2 = track(e.sync.flush());
    await settle();
    expect(s2.done).toBe(true);
  });
  it('two concurrent flush callers (joined promise) both settle after dispose', async () => {
    const e = makeEnv();
    hangingTxn(e);
    e.sync.putDigest(dig());
    const a = track(e.sync.flush());
    const b = track(e.sync.flush());
    await settle();
    await e.sync.dispose();
    await e.clock.advance(FAR);
    expect(a.done && b.done).toBe(true);
  });
});

describe('D-U54-1 auth/user change via the engine user callback settles a stuck flush', () => {
  it.each([
    ['sign-out', null],
    ['switch to another uid', { uid: 'u2' }],
  ] as const)('%s: flush promise settles, nothing written, engine usable', async (_n, next) => {
    const e = makeEnv();
    const ctls = hangingTxn(e);
    e.sync.putDigest(dig());
    const s = track(e.sync.flush());
    await settle();
    expect(s.done).toBe(false);
    e.auth.emit(next as { uid: string } | null);
    await e.clock.advance(FAR);
    expect(s.done).toBe(true);
    expect(s.err).toBeUndefined();
    expect(e.sync.status().counters.written).toBe(0);
    expect(e.fs.committedTo('digests')).toHaveLength(0);
    expect(ctls).toHaveLength(1);
    expect(unhandled).toEqual([]);
    await e.sync.dispose();
  });
  it('late txn completion (value and rejection) after auth change is ignored', async () => {
    const e = makeEnv();
    const ctls = hangingTxn(e);
    e.sync.putDigest(dig());
    const s = track(e.sync.flush());
    await settle();
    e.auth.emit({ uid: 'u2' });
    await e.clock.advance(FAR);
    expect(s.done).toBe(true);
    ctls[0]!.resolve({ conflict: false, wrote: true });
    await settle();
    expect(e.sync.status().counters).toEqual({ written: 0, denied: 0, conflicts: 0, droppedFields: 0 });
    expect(e.clock.timerCount()).toBe(0);
    expect(unhandled).toEqual([]);
  });
  it('after an auth change a fresh flush for the new user is not blocked by the stuck one', async () => {
    const e = makeEnv();
    const ctls = hangingTxn(e);
    e.sync.putDigest(dig());
    const s1 = track(e.sync.flush());
    await settle();
    e.auth.emit({ uid: 'u2' });
    await e.clock.advance(FAR);
    expect(s1.done).toBe(true);
    // restore a working fs and enqueue for the new user
    delete (e.fs as unknown as { txn?: unknown }).txn;
    expect(e.sync.putDigest(dig({ brief: 'second' }))).toMatchObject({ ok: true });
    await drain(e);
    const docs = e.fs.committedTo('digests');
    expect(docs).toHaveLength(1);
    expect(docs[0]!.segs[1]).toBe('u2');
    expect(ctls).toHaveLength(1);
    await e.sync.dispose();
  });
});

describe('D-U54-2 reentrant fs.timestamp tier change must block the digest write', () => {
  /** Env whose fs.timestamp synchronously flips p1's tier to `to` (once armed) during doc construction. */
  function envWithFlip(to: 'private' | 'shared' | null) {
    const e = makeEnv({ tiers: { p1: 'standard' } });
    let armed = false;
    const orig = e.fs.timestamp;
    e.fs.timestamp = (ms: number) => { if (armed && to !== null) e.tiers.p1 = to; return orig(ms); };
    return { e, arm: () => { armed = true; } };
  }
  it('control: timestamp called, tier unchanged -> digest written', async () => {
    const { e, arm } = envWithFlip(null);
    arm();
    expect(e.sync.putDigest(dig({ origin: 'LOCAL_SERVER' }))).toMatchObject({ ok: true });
    await drain(e);
    expect(e.fs.timestampCalls).toBeGreaterThan(0);
    expect(e.fs.committedTo('digests')).toHaveLength(1);
    expect(e.fs.attemptedTo('digests')).toHaveLength(1);
  });
  it('LOCAL_SERVER digest, timestamp flips p1 to private -> digest not written (not even attempted)', async () => {
    const { e, arm } = envWithFlip('private');
    expect(e.sync.putDigest(dig({ origin: 'LOCAL_SERVER' }))).toMatchObject({ ok: true });
    arm();
    await drain(e);
    expect(e.fs.timestampCalls).toBeGreaterThan(0); // the doc was built, so the hook ran
    expect(e.fs.attemptedTo('digests')).toHaveLength(0);
    expect(e.fs.committedTo('digests')).toHaveLength(0);
    expect(e.sync.status().counters.written).toBe(0);
  });
  it('REMOTE_PROVIDER digest, timestamp flips p1 to shared -> digest not written (not even attempted)', async () => {
    const { e, arm } = envWithFlip('shared');
    expect(e.sync.putDigest(dig({ origin: 'REMOTE_PROVIDER' }))).toMatchObject({ ok: true });
    arm();
    await drain(e);
    expect(e.fs.timestampCalls).toBeGreaterThan(0);
    expect(e.fs.attemptedTo('digests')).toHaveLength(0);
    expect(e.fs.committedTo('digests')).toHaveLength(0);
    expect(e.sync.status().counters.written).toBe(0);
  });
  it('control: REMOTE_PROVIDER, timestamp flips p1 standard -> standard (no-op) -> written', async () => {
    const { e, arm } = envWithFlip(null);
    arm();
    e.sync.putDigest(dig({ origin: 'REMOTE_PROVIDER' }));
    await drain(e);
    expect(e.fs.committedTo('digests')).toHaveLength(1);
    expect(e.fs.committedTo('digests')[0]!.data.inference_source).toBe('REMOTE_PROVIDER');
  });
});
