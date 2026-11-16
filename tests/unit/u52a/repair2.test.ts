// U52a repair 2 (review HOLD, privacy): a capsule attempt that started while p1 was "standard"
// must not stage capsule/project text after p1 turns "private" (metadata + setTier) mid-txn.
import { describe, expect, it } from 'vitest';
import { cap, makeEnv, settle, type Env } from '../u14/harness';

const CANARY = 'PRIVATE-CANARY';
const NAME = 'SECRET-PROJECT-NAME';

interface Staged { op: 'set' | 'update'; path: string[]; data: Record<string, unknown> }
interface Pausable { staged: Staged[]; invoked: number; resume(): void }

/** fs.txn that invokes the callback; only the very first tx.get pauses until resume(). */
function pausableTxn(e: Env, pauseFirst: boolean): Pausable {
  const st: Pausable = { staged: [], invoked: 0, resume: () => undefined };
  let paused = pauseFirst;
  const gate = new Promise<void>((r) => { st.resume = () => r(); });
  (e.fs as unknown as { txn: unknown }).txn = async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    e.fs.txnCalls++;
    st.invoked++;
    const tx = {
      get: async (): Promise<null> => {
        if (paused) { paused = false; await gate; }
        return null;
      },
      set: (p: readonly string[], data: Record<string, unknown>): void => {
        st.staged.push({ op: 'set', path: [...p], data: JSON.parse(JSON.stringify(data)) });
      },
      update: (p: readonly string[], data: Record<string, unknown>): void => {
        st.staged.push({ op: 'update', path: [...p], data: JSON.parse(JSON.stringify(data)) });
      },
    };
    return fn(tx);
  };
  return st;
}

const leaks = (st: Pausable): Staged[] =>
  st.staged.filter((x) => { const j = JSON.stringify(x.data); return j.includes(CANARY) || j.includes(NAME); });
const setsOf = (st: Pausable, kind: string): Staged[] =>
  st.staged.filter((x) => x.op === 'set' && x.path[1] === 'u1' && x.path[2] === kind);

const latest = () => cap({ observed_rev: 5, summary: CANARY });

function env() {
  const e = makeEnv({ user: 'u1', tiers: { p1: 'standard' }, metaName: NAME });
  return e;
}

describe('U52a r2: capsule tier change during txn reads -> no text staged', () => {
  it('paused first read, p1 -> private + setTier, resume -> no capsule/project doc with canary or name', async () => {
    const e = env();
    await settle();
    const st = pausableTxn(e, true);
    expect(e.sync.putCapsule('p1', latest())).toMatchObject({ ok: true });
    const f = e.sync.flush();
    await settle();
    expect(st.invoked).toBe(1);
    e.tiers.p1 = 'private';
    expect(e.sync.setTier('p1', latest())).toMatchObject({ ok: true });
    st.resume();
    await settle(8);
    await f;
    expect(leaks(st)).toEqual([]);
    expect(setsOf(st, 'capsules').filter((x) => x.data['summary'] !== undefined)).toEqual([]);
    expect(setsOf(st, 'projects').filter((x) => x.data['privacy_tier'] === 'standard')).toEqual([]);
    expect(e.sync.status().pending).toBe(1); // replacement entry preserved
    await e.sync.dispose();
  });

  it('tier change + setTier inside a synchronous fs.timestamp -> no capsule/project doc with canary or name', async () => {
    const e = env();
    await settle();
    const st = pausableTxn(e, false);
    expect(e.sync.putCapsule('p1', latest())).toMatchObject({ ok: true });
    const orig = e.fs.timestamp;
    let fired = 0;
    e.fs.timestamp = (ms: number) => {
      if (fired++ === 0) { e.tiers.p1 = 'private'; e.sync.setTier('p1', latest()); }
      return orig(ms);
    };
    await e.sync.flush();
    expect(fired).toBeGreaterThan(0);
    expect(st.invoked).toBe(1);
    expect(leaks(st)).toEqual([]);
    expect(setsOf(st, 'capsules').filter((x) => x.data['summary'] !== undefined)).toEqual([]);
    expect(e.sync.status().pending).toBe(1);
    await e.sync.dispose();
  });

  it('control: no tier change -> capsule (with canary) and project (with name) written', async () => {
    const e = env();
    await settle();
    const st = pausableTxn(e, true);
    e.sync.putCapsule('p1', latest());
    const f = e.sync.flush();
    await settle();
    st.resume();
    await settle(8);
    await f;
    expect(setsOf(st, 'capsules').some((x) => x.data['summary'] === CANARY)).toBe(true);
    expect(setsOf(st, 'projects').some((x) => x.data['name'] === NAME)).toBe(true);
    expect(e.sync.status().counters.written).toBe(1);
    await e.sync.dispose();
  });

  it('replacement entry is processed afterwards and, being private, writes no text', async () => {
    const e = env();
    await settle();
    const st = pausableTxn(e, true);
    e.sync.putCapsule('p1', latest());
    const f = e.sync.flush();
    await settle();
    e.tiers.p1 = 'private';
    e.sync.setTier('p1', latest());
    st.resume();
    await settle(8);
    await f;
    expect(e.sync.status().pending).toBe(1);
    await e.sync.flush();
    expect(st.invoked).toBe(2);
    expect(e.sync.status().pending).toBe(0);
    expect(e.sync.status().counters.written).toBe(1);
    expect(leaks(st)).toEqual([]);
    const caps = setsOf(st, 'capsules');
    const projs = setsOf(st, 'projects');
    expect(caps).toHaveLength(1);
    expect(caps[0]!.data['summary']).toBeUndefined();
    expect(projs).toHaveLength(1);
    expect(projs[0]!.data['privacy_tier']).toBe('private');
    await e.sync.dispose();
  });
});
