// U52a repair 1 (review HOLD): after cancellation (dispose / uid switch) settles flush(),
// a still-running fs.txn callback must not stage any write (tx.set / tx.update).
import { describe, expect, it } from 'vitest';
import type { DigestIn } from '../../../src/sync';
import { cap, makeEnv, settle, type Env } from '../u14/harness';

const dig = (over: Record<string, unknown> = {}): DigestIn => ({
  revVector: { p1: 4 }, needs_you: [{ projectId: 'p1' }], brief: 'Two things need you.',
  origin: 'ON_DEVICE', prompt_version: 'v1', builtAt: 1_700_000_000_000, ...over,
}) as unknown as DigestIn;

const FAR = 120_000;

interface Staged { op: 'set' | 'update'; path: string[] }
interface Pausable {
  staged: Staged[];
  invoked: number;
  /** resolves the first tx.get (null); later gets return null immediately */
  resume(): void;
  txnResults: unknown[];
}

/** fs.txn that really invokes the callback; the first tx.get pauses until resume(). */
function pausableTxn(e: Env): Pausable {
  const st: Pausable = { staged: [], invoked: 0, resume: () => undefined, txnResults: [] };
  let paused = true;
  const gate = new Promise<void>((r) => { st.resume = () => r(); });
  (e.fs as unknown as { txn: unknown }).txn = async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    e.fs.txnCalls++;
    st.invoked++;
    const tx = {
      get: async (): Promise<null> => {
        if (paused) { paused = false; await gate; }
        return null;
      },
      set: (p: readonly string[]): void => { st.staged.push({ op: 'set', path: [...p] }); },
      update: (p: readonly string[]): void => { st.staged.push({ op: 'update', path: [...p] }); },
    };
    const r = await fn(tx);
    st.txnResults.push(r);
    return r;
  };
  return st;
}

const track = <T,>(p: Promise<T>) => {
  const s: { done: boolean; err?: unknown } = { done: false };
  p.then(() => { s.done = true; }, (err) => { s.done = true; s.err = err; });
  return s;
};

type Path = 'digest' | 'capsule';
type Cancel = 'dispose' | 'uid-switch' | 'none';

const enqueue = (e: Env, path: Path): void => {
  if (path === 'digest') expect(e.sync.putDigest(dig())).toMatchObject({ ok: true });
  else e.sync.putCapsule('p1', cap({ observed_rev: 5 }));
};

async function scenario(path: Path, cancel: Cancel) {
  const e = makeEnv({ user: 'u1', tiers: { p1: 'standard' } });
  await settle();
  const st = pausableTxn(e);
  enqueue(e, path);
  const s = track(e.sync.flush());
  await settle();
  expect(st.invoked).toBe(1); // callback is running, paused on first tx.get
  if (cancel === 'dispose') await e.sync.dispose();
  else if (cancel === 'uid-switch') e.auth.emit({ uid: 'u2' });
  if (cancel !== 'none') {
    await e.clock.advance(FAR);
    expect(s.done).toBe(true); // flush settled by cancellation, before resume
  }
  st.resume();
  await settle(6);
  if (cancel === 'none') await e.clock.advance(1);
  await settle(6);
  return { e, st, s };
}

describe.each(['digest', 'capsule'] as const)('U52a r1 %s path: no write staged after cancellation', (path) => {
  it.each(['dispose', 'uid-switch'] as const)('%s while txn read is paused -> callback stages nothing', async (cancel) => {
    const { e, st, s } = await scenario(path, cancel);
    expect(s.done).toBe(true);
    expect(s.err).toBeUndefined();
    expect(st.staged).toEqual([]);
    expect(st.staged.filter((x) => x.path[1] === 'u1')).toHaveLength(0);
    expect(st.txnResults).toHaveLength(1); // callback ran to completion after resume
    expect(e.sync.status().counters.written).toBe(0);
    if (cancel !== 'dispose') await e.sync.dispose();
  });
  it('control: no cancellation -> callback stages writes under u1', async () => {
    const { e, st, s } = await scenario(path, 'none');
    expect(s.done).toBe(true);
    const kind = path === 'digest' ? 'digests' : 'capsules';
    expect(st.staged.some((x) => x.op === 'set' && x.path[1] === 'u1' && x.path[2] === kind)).toBe(true);
    expect(e.sync.status().counters.written).toBe(1);
    await e.sync.dispose();
  });
});
