import { describe, it, expect } from 'vitest';
import {
  createTemplateSession, defaultTemplate, compileTemplate, TPL_LIMITS, type TemplateSession, type LensId,
} from '../../../src/template';
import { FakeStore, renameLabel, setToken, removeSlot, has, clone } from './helpers';

async function open(lens: LensId = 'study', store = new FakeStore()) {
  const s = createTemplateSession(lens, store);
  const l = await s.load();
  return { s, store, l };
}
const firstSlot = (lens: LensId) => defaultTemplate(lens).slots[0]!.id;
const ren = (s: TemplateSession, n: number) => ({ ops: [renameLabel(firstSlot('study'), `L${n}`)] });
async function acceptRename(s: TemplateSession, n: number) {
  const pv = s.propose(ren(s, n));
  expect(pv.ok).toBe(true);
  if (!pv.ok) throw new Error('unreachable');
  return s.accept(pv.value);
}
const defaultHash = (lens: LensId) => { const c = compileTemplate(defaultTemplate(lens)); if (!c.ok) throw new Error('x'); return c.value.templateHash; };

describe('B16 load', () => {
  it('empty store -> default, restored:false', async () => {
    const { s, l } = await open('study');
    expect(l).toEqual({ restored: false });
    expect(s.current().templateHash).toBe(defaultHash('study'));
    expect(s.history()).toEqual([]);
  });
  it('T15 garbage store -> default, restored:false', async () => {
    for (const g of [{ garbage: 1 }, null, 7, 'x', [], [{ nope: 1 }], { v: 1, ring: 'x' }]) {
      const st = new FakeStore();
      st.loadValue = { set: true, v: g };
      const { s, l } = await open('dev', st);
      expect(l).toEqual({ restored: false });
      expect(s.current().templateHash).toBe(defaultHash('dev'));
      expect(s.history()).toEqual([]);
      expect(st.saves).toHaveLength(0); // loading never writes
    }
  });
  it('a valid saved ring restores current + history in a new session', async () => {
    const a = await open('study');
    await acceptRename(a.s, 1);
    await acceptRename(a.s, 2);
    const b = await open('study', a.store);
    expect(a.s.history()).toHaveLength(2);
    expect(a.store.saves).toHaveLength(2);
    expect(b.l.restored).toBe(true);
    expect(b.s.current().templateHash).toBe(a.s.current().templateHash);
    expect(b.s.history()).toEqual(a.s.history());
    const u = await b.s.undo();
    expect(u.ok).toBe(true);
  });
  it('stores are per lens', async () => {
    const st = new FakeStore();
    const a = await open('study', st);
    await acceptRename(a.s, 1);
    expect(st.saves.every((x) => x.lens === 'study')).toBe(true);
    const d = await open('dev', st);
    expect(d.l.restored).toBe(false);
    expect(d.s.current().templateHash).toBe(defaultHash('dev'));
  });
});

describe('T11 no_change_without_accept', () => {
  it('propose is pure; accept persists once and changes hash', async () => {
    const { s, store } = await open('study');
    const h0 = s.current().templateHash;
    const pv = s.propose(ren(s, 1));
    expect(pv.ok).toBe(true);
    if (!pv.ok) return;
    expect(s.current().templateHash).toBe(h0);
    expect(store.saves).toHaveLength(0);
    expect(s.history()).toHaveLength(0);
    expect(pv.value.baseHash).toBe(h0);
    expect(pv.value.compiled.templateHash).not.toBe(h0);
    expect(pv.value.compiled.spec.templateHash).toBe(pv.value.compiled.templateHash);
    expect(pv.value.next.slots[0]!.label).toBe('L1');
    const r = await s.accept(pv.value);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.templateHash).toBe(pv.value.compiled.templateHash);
    expect(s.current().templateHash).toBe(r.templateHash);
    expect(r.templateHash).not.toBe(h0);
    expect(store.saves).toHaveLength(1);
    expect(s.history()).toEqual([h0]);
  });
  it('invalid proposals are refused and touch nothing', async () => {
    const { s, store } = await open('study');
    const h0 = s.current().templateHash;
    const bads: unknown[] = [
      { ops: [] }, { ops: [1, 2, 3, 4, 5].map((n) => renameLabel(firstSlot('study'), `A${n}`)) },
      { ops: [setToken('accent', 'fuchsia')] }, { ops: [removeSlot('s11')] }, { ops: [renameLabel(firstSlot('study'), '<b>x</b>')] },
      null, 'x', { ops: [{ ...renameLabel(firstSlot('study'), 'x'), className: 'x' }] },
    ];
    for (const b of bads) {
      const r = s.propose(b);
      expect(r.ok).toBe(false);
    }
    expect(has(s.propose({ ops: [] }), 'EMPTY_PROPOSAL')).toBe(true);
    expect(has(s.propose({ ops: [removeSlot('s11')] }), 'SLOT_NOT_FOUND', 'ops[0]')).toBe(true);
    expect(s.current().templateHash).toBe(h0);
    expect(store.saves).toHaveLength(0);
  });
  it('NO_CHANGE when the proposal yields an identical template', async () => {
    const { s, store } = await open('study');
    const cur = defaultTemplate('study');
    const pv = s.propose({ ops: [setToken('accent', cur.tokens.accent)] });
    expect(pv.ok).toBe(true);
    if (!pv.ok) return;
    expect(await s.accept(pv.value)).toEqual({ ok: false, code: 'NO_CHANGE' });
    expect(store.saves).toHaveLength(0);
    expect(s.history()).toHaveLength(0);
  });
});

describe('T12 stale_and_store_fail', () => {
  it('second proposal from the same base is STALE_PROPOSAL', async () => {
    const { s, store } = await open('study');
    const p1 = s.propose(ren(s, 1));
    const p2 = s.propose(ren(s, 2));
    expect(p1.ok && p2.ok).toBe(true);
    if (!p1.ok || !p2.ok) return;
    expect((await s.accept(p1.value)).ok).toBe(true);
    const h1 = s.current().templateHash;
    expect(await s.accept(p2.value)).toEqual({ ok: false, code: 'STALE_PROPOSAL' });
    expect(s.current().templateHash).toBe(h1);
    expect(store.saves).toHaveLength(1);
  });
  it('rejected save -> STORE_FAILED, state unchanged, retry works', async () => {
    const { s, store } = await open('study');
    const h0 = s.current().templateHash;
    const pv = s.propose(ren(s, 1));
    if (!pv.ok) throw new Error('unreachable');
    store.failNext = true;
    expect(await s.accept(pv.value)).toEqual({ ok: false, code: 'STORE_FAILED' });
    expect(s.current().templateHash).toBe(h0);
    expect(s.history()).toHaveLength(0);
    expect((await s.accept(pv.value)).ok).toBe(true);
    expect(s.current().templateHash).toBe(pv.value.compiled.templateHash);
  });
  it('persist-before-OK: current() is still the old template while save is in flight', async () => {
    const { s, store } = await open('study');
    const h0 = s.current().templateHash;
    let seen = '';
    store.onSave = () => { seen = s.current().templateHash; };
    const pv = s.propose(ren(s, 1));
    if (!pv.ok) throw new Error('unreachable');
    await s.accept(pv.value);
    expect(seen).toBe(h0);
  });
  it('undo with failing store -> STORE_FAILED, state unchanged', async () => {
    const { s, store } = await open('study');
    await acceptRename(s, 1);
    const h1 = s.current().templateHash;
    const hist = [...s.history()];
    store.failNext = true;
    expect(await s.undo()).toEqual({ ok: false, code: 'STORE_FAILED' });
    expect(s.current().templateHash).toBe(h1);
    expect(s.history()).toEqual(hist);
    expect((await s.undo()).ok).toBe(true);
  });
});

describe('T13 undo_ring', () => {
  it('11 accepts keep a ring of 10; undos restore exact prior hashes in reverse; 11th undo is NOTHING_TO_UNDO', async () => {
    const { s, store } = await open('study');
    const hashes: string[] = [s.current().templateHash];
    for (let n = 1; n <= 11; n++) {
      const r = await acceptRename(s, n);
      expect(r.ok).toBe(true);
      hashes.push(s.current().templateHash);
      expect(s.history().length).toBeLessThanOrEqual(TPL_LIMITS.UNDO_DEPTH);
    }
    expect(new Set(hashes).size).toBe(12); // every accepted edit changed the hash
    expect(s.history()).toHaveLength(10);
    expect(s.history()).toEqual(hashes.slice(1, 11)); // newest last, oldest (base) evicted
    const savesBefore = store.saves.length;
    for (let k = 10; k >= 1; k--) {
      const u = await s.undo();
      expect(u).toEqual({ ok: true, templateHash: hashes[k] });
      expect(s.current().templateHash).toBe(hashes[k]);
    }
    expect(store.saves.length).toBe(savesBefore + 10); // undo persists
    expect(s.history()).toHaveLength(0);
    expect(await s.undo()).toEqual({ ok: false, code: 'NOTHING_TO_UNDO' });
    expect(s.current().templateHash).toBe(hashes[1]);
  });
  it('undo restores the exact previous template (spec and labels), not a repaired one', async () => {
    const { s } = await open('study');
    const before = clone(s.current());
    const pv = s.propose({ ops: [renameLabel(firstSlot('study'), 'Changed'), setToken('accent', 'rose')] });
    if (!pv.ok) throw new Error('unreachable');
    await s.accept(pv.value);
    expect(s.current().labels).not.toEqual(before.labels);
    await s.undo();
    expect(JSON.stringify(s.current())).toBe(JSON.stringify(before));
  });
  it('undo on a fresh session is NOTHING_TO_UNDO and writes nothing', async () => {
    const { s, store } = await open('study');
    expect(await s.undo()).toEqual({ ok: false, code: 'NOTHING_TO_UNDO' });
    expect(store.saves).toHaveLength(0);
  });
  it('accept after undo: new edit, history grows; hash differs from the undone one unless identical content', async () => {
    const { s } = await open('study');
    const h0 = s.current().templateHash;
    await acceptRename(s, 1);
    await s.undo();
    expect(s.current().templateHash).toBe(h0);
    await acceptRename(s, 2);
    expect(s.current().templateHash).not.toBe(h0);
    expect(s.history()).toEqual([h0]);
  });
});
