// U52a repair 3 (cross-family HOLD, stalls + lost updates):
// F1 ledger.applyDeltas must settle on dispose / uid switch / TXN_TIMEOUT_MS even when fs.txn
//    never settles, rejecting SYNC_LOCAL_ONLY (caller requeues); late callbacks stage nothing and
//    a late rejection of the abandoned txn is handled.
// F2 a capsule attempt abandoned by the timeout must be invalidated: its paused callback (and any
//    Firestore retry of it) stages nothing, so an older summary cannot overwrite a newer one.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SYNC_LIMITS } from '../../../src/sync';
import { cap, makeEnv, settle, type Env } from '../u14/harness';

const DAY = '2026-11-15';
const T = SYNC_LIMITS.TXN_TIMEOUT_MS;

const unhandled: unknown[] = [];
const onUnhandled = (r: unknown): void => { unhandled.push(r); };
beforeEach(() => { unhandled.length = 0; process.on('unhandledRejection', onUnhandled); });
afterEach(() => { process.off('unhandledRejection', onUnhandled); });

function track(p: Promise<void>) {
  const s: { done: boolean; err?: unknown } = { done: false };
  p.then(() => { s.done = true; }, (err: unknown) => { s.done = true; s.err = err; });
  return s;
}

interface Staged { path: string[]; data: Record<string, unknown> }

/** Ledger txn whose first read pauses until resume(); records staged sets. */
function pausedLedgerTxn(e: Env) {
  const st = { staged: [] as Staged[], invoked: 0, resume: (): void => undefined };
  const gate = new Promise<void>((r) => { st.resume = () => r(); });
  let paused = true;
  (e.fs as unknown as { txn: unknown }).txn = async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    e.fs.txnCalls++;
    st.invoked++;
    return fn({
      get: async (): Promise<null> => { if (paused) { paused = false; await gate; } return null; },
      set: (p: readonly string[], data: Record<string, unknown>): void => { st.staged.push({ path: [...p], data }); },
    });
  };
  return st;
}

describe('U52a r3 F1: applyDeltas never pends forever', () => {
  it.each(['dispose', 'uid-switch', 'timeout'] as const)('never-settling fs.txn + %s -> rejects SYNC_LOCAL_ONLY', async (how) => {
    const e = makeEnv({ user: 'u1' });
    await settle();
    e.fs.mode = 'hang';
    const s = track(e.sync.ledger.applyDeltas(DAY, { p1: { in_cloud: 1 } }));
    await settle(6);
    expect(e.fs.txnCalls).toBe(1);
    expect(s.done).toBe(false);
    if (how === 'dispose') await e.sync.dispose();
    else if (how === 'uid-switch') e.auth.emit({ uid: 'u2' });
    else {
      await e.clock.advance(T - 1);
      expect(s.done).toBe(false);
      await e.clock.advance(1);
    }
    await settle(6);
    expect(s.done).toBe(true);
    expect(String(s.err)).toContain('SYNC_LOCAL_ONLY');
    expect(e.clock.timerCount()).toBe(0);
    expect(e.fs.committedTo('ledger')).toEqual([]);
    if (how !== 'dispose') await e.sync.dispose();
  });

  it('timeout while ledger read is paused, then resume -> nothing staged late', async () => {
    const e = makeEnv({ user: 'u1' });
    await settle();
    const st = pausedLedgerTxn(e);
    const s = track(e.sync.ledger.applyDeltas(DAY, { p1: { in_cloud: 3 } }));
    await settle(6);
    expect(st.invoked).toBe(1);
    await e.clock.advance(T);
    await settle(6);
    expect(s.done).toBe(true);
    expect(String(s.err)).toContain('SYNC_LOCAL_ONLY');
    st.resume();
    await settle(8);
    expect(st.staged).toEqual([]);
    await e.sync.dispose();
  });

  it('abandoned txn rejecting late after timeout -> no unhandled rejection', async () => {
    const e = makeEnv({ user: 'u1' });
    await settle();
    let rejectLate: (err: unknown) => void = () => undefined;
    (e.fs as unknown as { txn: unknown }).txn = (): Promise<unknown> => {
      e.fs.txnCalls++;
      return new Promise<unknown>((_res, rej) => { rejectLate = rej; });
    };
    const s = track(e.sync.ledger.applyDeltas(DAY, { p1: { in_cloud: 1 } }));
    await settle(6);
    await e.clock.advance(T);
    await settle(6);
    expect(s.done).toBe(true);
    expect(String(s.err)).toContain('SYNC_LOCAL_ONLY');
    rejectLate(new Error('late-abandoned-rejection'));
    await settle(10);
    expect(unhandled).toEqual([]);
    await e.sync.dispose();
  });

  it('control: normal applyDeltas resolves and commits the ledger doc', async () => {
    const e = makeEnv({ user: 'u1' });
    await settle();
    const s = track(e.sync.ledger.applyDeltas(DAY, { p1: { in_cloud: 1 } }));
    await settle(8);
    expect(s.done).toBe(true);
    expect(s.err).toBeUndefined();
    const led = e.fs.committedTo('ledger');
    expect(led).toHaveLength(1);
    expect(led[0]!.segs).toEqual(['workspaces', 'u1', 'ledger', DAY]);
    expect(led[0]!.data['in_cloud']).toBe(1);
    expect(e.clock.timerCount()).toBe(0);
    await e.sync.dispose();
  });
});

/** Wraps the real FakeFs.txn; the FIRST txn's first read pauses until resume(). When
 *  `retryOld` is set, the first txn re-runs its callback once more after resume (Firestore
 *  contention retry) and commits whatever the last run staged. */
function pausedFirstCapsuleTxn(e: Env, retryOld: boolean) {
  const st = { invoked: 0, runs: 0, resume: (): void => undefined };
  const gate = new Promise<void>((r) => { st.resume = () => r(); });
  const orig = e.fs.txn.bind(e.fs);
  (e.fs as unknown as { txn: unknown }).txn = <R,>(fn: (tx: unknown) => Promise<R>): Promise<R> => {
    const n = ++st.invoked;
    return orig(async (tx) => {
      if (n !== 1) { st.runs++; return fn(tx); }
      let paused = true;
      const wrap = (inner: typeof tx) => ({
        get: async (p: readonly string[]) => { if (paused) { paused = false; await gate; } return inner.get(p); },
        set: (p: readonly string[], d: Record<string, unknown>) => inner.set(p, d),
      });
      st.runs++;
      const first = await fn(wrap(tx) as never);
      if (!retryOld) return first;
      st.runs++;
      // retry: a second callback run on the same fake tx (sets from both runs are committed,
      // so any OLD doc staged by either run shows up in fs.attempted / fs.store).
      return fn(wrap(tx) as never);
    });
  };
  return st;
}

const summaries = (e: Env): unknown[] =>
  e.fs.attemptedTo('capsules').map((r) => r.data['summary']);

describe('U52a r3 F2: timed-out capsule attempt is invalidated', () => {
  it.each([false, true])('paused OLD txn times out, NEW flushes, OLD resumes (retry=%s) -> NEW survives', async (retryOld) => {
    const e = makeEnv({ user: 'u1', tiers: { p1: 'standard' } });
    await settle();
    const st = pausedFirstCapsuleTxn(e, retryOld);
    expect(e.sync.putCapsule('p1', cap({ observed_rev: 7, summary: 'OLD' }))).toMatchObject({ ok: true });
    const f1 = e.sync.flush();
    await settle(6);
    expect(st.invoked).toBe(1);
    await e.clock.advance(T);
    await f1;
    expect(e.sync.status().pending).toBe(1);
    expect(e.sync.putCapsule('p1', cap({ observed_rev: 7, summary: 'NEW' }))).toMatchObject({ ok: true });
    await e.sync.flush();
    expect(st.invoked).toBe(2);
    const capKey = `workspaces/u1/capsules/${e.ridOf('p1')}`;
    expect(e.fs.store.get(capKey)?.['summary']).toBe('NEW');
    st.resume();
    await settle(12);
    expect(e.fs.store.get(capKey)?.['summary']).toBe('NEW');
    expect(summaries(e)).not.toContain('OLD');
    expect(e.sync.status().pending).toBe(0);
    await e.sync.dispose();
  });

  it('control: no timeout -> paused txn resumes and writes its capsule', async () => {
    const e = makeEnv({ user: 'u1', tiers: { p1: 'standard' } });
    await settle();
    const st = pausedFirstCapsuleTxn(e, false);
    e.sync.putCapsule('p1', cap({ observed_rev: 7, summary: 'ONLY' }));
    const f = e.sync.flush();
    await settle(6);
    st.resume();
    await settle(8);
    await f;
    expect(e.fs.store.get(`workspaces/u1/capsules/${e.ridOf('p1')}`)?.['summary']).toBe('ONLY');
    expect(e.sync.status().counters.written).toBe(1);
    await e.sync.dispose();
  });

  it('A2 preserved: timeout still -> transient + backoff, entry kept', async () => {
    const e = makeEnv({ user: 'u1', tiers: { p1: 'standard' } });
    await settle();
    e.fs.mode = 'hang';
    e.sync.putCapsule('p1', cap({ observed_rev: 7 }));
    const f = e.sync.flush();
    await settle(6);
    await e.clock.advance(T);
    const s = await f;
    expect(s.pending).toBe(1);
    expect(s.detail).toBe('BACKOFF');
    await e.sync.dispose();
  });
});
