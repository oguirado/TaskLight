// U52a repair 1b: the ledger txn (applyDeltas) must not stage writes once dispose / uid switch
// happened while its callback was paused on a read; the stale call rejects (caller requeues).
import { describe, expect, it } from 'vitest';
import { makeEnv, settle, type Env } from '../u14/harness';

const DAY = '2026-11-14';
interface Staged { op: 'set' | 'update'; path: string[] }

function pausableTxn(e: Env) {
  const st = { staged: [] as Staged[], invoked: 0, resume: (): void => undefined };
  let paused = true;
  const gate = new Promise<void>((r) => { st.resume = () => r(); });
  (e.fs as unknown as { txn: unknown }).txn = async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    e.fs.txnCalls++;
    st.invoked++;
    return fn({
      get: async (): Promise<null> => { if (paused) { paused = false; await gate; } return null; },
      set: (p: readonly string[]): void => { st.staged.push({ op: 'set', path: [...p] }); },
      update: (p: readonly string[]): void => { st.staged.push({ op: 'update', path: [...p] }); },
    });
  };
  return st;
}

async function scenario(cancel: 'dispose' | 'uid-switch' | 'none') {
  const e = makeEnv({ user: 'u1', tiers: { p1: 'standard' } });
  await settle();
  const st = pausableTxn(e);
  const s: { done: boolean; err?: unknown } = { done: false };
  e.sync.ledger.applyDeltas(DAY, { p1: { in_cloud: 2 } })
    .then(() => { s.done = true; }, (err: unknown) => { s.done = true; s.err = err; });
  await settle();
  expect(st.invoked).toBe(1);
  if (cancel === 'dispose') await e.sync.dispose();
  else if (cancel === 'uid-switch') e.auth.emit({ uid: 'u2' });
  st.resume();
  await settle(6);
  return { e, st, s };
}

describe('U52a r1b ledger txn: no write staged after cancellation', () => {
  it.each(['dispose', 'uid-switch'] as const)('%s while ledger read is paused -> nothing staged, call rejects', async (cancel) => {
    const { e, st, s } = await scenario(cancel);
    expect(st.staged).toEqual([]);
    expect(s.done).toBe(true);
    expect(String(s.err)).toContain('SYNC_LOCAL_ONLY');
    if (cancel !== 'dispose') await e.sync.dispose();
  });
  it('control: no cancellation -> ledger set staged under u1, call resolves', async () => {
    const { e, st, s } = await scenario('none');
    expect(st.staged.some((x) => x.op === 'set' && x.path[1] === 'u1' && x.path[2] === 'ledger')).toBe(true);
    expect(s.done).toBe(true);
    expect(s.err).toBeUndefined();
    await e.sync.dispose();
  });
});
