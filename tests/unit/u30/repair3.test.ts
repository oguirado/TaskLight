// Repair r3 (Sol review r2, DISP_03 items 3+4): injected TemplateStore failures must never stall the
// session queue. Spec bounds: load -> {restored:false}; accept/undo -> STORE_FAILED, state unchanged
// (SPEC_U30 persist-before-OK, STORE_FAILED row). The spec gives no number, so the oracle uses a
// generous per-operation bound (BOUND ms of fake time); any finite deadline <= BOUND passes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTemplateSession, type LensId, type Preview, type TemplateStore } from '../../../src/template';
import { FakeStore, renameLabel } from './helpers';

const BOUND = 60_000;
const NEVER = () => new Promise<never>(() => {});

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** Run `p` while advancing fake time by up to `ms`; report whether it settled. */
async function within<T>(p: Promise<T>, ms: number): Promise<{ settled: boolean; value?: T | undefined }> {
  let settled = false; let value: T | undefined;
  p.then((v) => { settled = true; value = v; }, () => { settled = true; });
  for (let t = 0; t < ms && !settled; t += 1000) await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(0);
  return { settled, value };
}

type Mode = 'never' | 'reject' | 'throw' | 'resolve';
function portCall(mode: Mode, ok: () => Promise<unknown>): Promise<unknown> {
  if (mode === 'never') return NEVER();
  if (mode === 'reject') return Promise.reject(new Error('port down'));
  if (mode === 'throw') throw new Error('port threw');
  return ok();
}
class ModeStore implements TemplateStore {
  loadMode: Mode = 'resolve'; saveMode: Mode = 'resolve';
  inner = new FakeStore();
  saveCalls = 0;
  load(lens: LensId) { return portCall(this.loadMode, () => this.inner.load(lens)) as Promise<unknown>; }
  save(lens: LensId, ring: unknown) {
    this.saveCalls++;
    return portCall(this.saveMode, () => this.inner.save(lens, ring)) as Promise<void>;
  }
}

function prop(s: ReturnType<typeof createTemplateSession>, label: string): Preview {
  const p = s.propose({ ops: [renameLabel('s1', label)] });
  if (!p.ok) throw new Error('fixture proposal must be valid');
  return p.value;
}

describe('R3-1 load against a failing store never stalls', () => {
  it.each(['never', 'reject', 'throw'] as Mode[])('load with store.load %s -> {restored:false} within bound', async (m) => {
    const st = new ModeStore(); st.loadMode = m;
    const s = createTemplateSession('dev', st);
    const h0 = s.current().templateHash;
    const r = await within(s.load(), BOUND);
    expect(r.settled).toBe(true);
    expect(r.value).toEqual({ restored: false });
    expect(s.current().templateHash).toBe(h0);
  });
  it('a never-settling load does not block a later accept / undo / load (queue recovers)', async () => {
    const st = new ModeStore(); st.loadMode = 'never';
    const s = createTemplateSession('dev', st);
    const pv = prop(s, 'After');
    const l1 = s.load();
    const a = s.accept(pv);
    const u = s.undo();
    const l2 = s.load();
    await vi.advanceTimersByTimeAsync(0); // l1 is now stuck inside store.load
    st.loadMode = 'resolve';
    const all = await within(Promise.all([l1, a, u, l2]), BOUND * 4);
    expect(all.settled).toBe(true);
    const [r1, ra, ru] = all.value!;
    expect(r1).toEqual({ restored: false });
    expect(ra).toMatchObject({ ok: true });
    expect(ru).toMatchObject({ ok: true }); // undo of the accept
  });
  it('late settlement of a timed-out load does not clobber state installed afterwards', async () => {
    const st = new ModeStore();
    let late!: (v: unknown) => void;
    st.load = () => new Promise<unknown>((r) => { late = r; });
    const s = createTemplateSession('dev', st);
    const l = await within(s.load(), BOUND);
    expect(l.settled).toBe(true);
    st.loadMode = 'resolve'; st.load = ModeStore.prototype.load.bind(st);
    const pv = prop(s, 'Fresh');
    const a = await within(s.accept(pv), BOUND);
    expect(a.value).toMatchObject({ ok: true });
    const h1 = s.current().templateHash;
    late(undefined);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.current().templateHash).toBe(h1);
  });
});

describe('R3-2 accept/undo against a failing store -> STORE_FAILED, state unchanged, queue released', () => {
  it.each(['never', 'reject', 'throw'] as Mode[])('accept with store.save %s', async (m) => {
    const st = new ModeStore();
    const s = createTemplateSession('dev', st);
    await within(s.load(), BOUND);
    const h0 = s.current().templateHash;
    const pv = prop(s, 'X');
    st.saveMode = m;
    const r = await within(s.accept(pv), BOUND);
    expect(r.settled).toBe(true);
    expect(r.value).toEqual({ ok: false, code: 'STORE_FAILED' });
    expect(s.current().templateHash).toBe(h0);
    expect(s.history()).toHaveLength(0);
    // queue released: same preview (same base) is still acceptable on a healthy port
    st.saveMode = 'resolve';
    const r2 = await within(s.accept(pv), BOUND);
    expect(r2.settled).toBe(true);
    expect(r2.value).toMatchObject({ ok: true });
    expect(s.history()).toHaveLength(1);
  });
  it.each(['never', 'reject', 'throw'] as Mode[])('undo with store.save %s keeps history and current', async (m) => {
    const st = new ModeStore();
    const s = createTemplateSession('dev', st);
    await within(s.load(), BOUND);
    const a = await within(s.accept(prop(s, 'One')), BOUND);
    expect(a.value).toMatchObject({ ok: true });
    const h1 = s.current().templateHash; const hist = [...s.history()];
    st.saveMode = m;
    const r = await within(s.undo(), BOUND);
    expect(r.settled).toBe(true);
    expect(r.value).toEqual({ ok: false, code: 'STORE_FAILED' });
    expect(s.current().templateHash).toBe(h1);
    expect([...s.history()]).toEqual(hist);
    st.saveMode = 'resolve';
    const r2 = await within(s.undo(), BOUND);
    expect(r2.value).toMatchObject({ ok: true });
    expect(s.history()).toHaveLength(0);
  });
  it('a stuck save does not block queued operations: each later op completes or refuses within its own bound', async () => {
    const st = new ModeStore();
    const s = createTemplateSession('dev', st);
    await within(s.load(), BOUND);
    const pv1 = prop(s, 'A');
    st.saveMode = 'never';
    const a1 = s.accept(pv1);
    const a2 = s.accept(pv1);       // queued behind a1, same base
    const u = s.undo();             // queued, nothing to undo
    const l = s.load();             // queued
    const all = await within(Promise.all([a1, a2, u, l]), BOUND * 5);
    expect(all.settled).toBe(true);
    const [r1, r2, ru, rl] = all.value!;
    expect(r1).toEqual({ ok: false, code: 'STORE_FAILED' });
    expect(r2).toEqual({ ok: false, code: 'STORE_FAILED' });
    expect(ru).toEqual({ ok: false, code: 'NOTHING_TO_UNDO' });
    expect(rl).toEqual({ restored: false });
  });
  it('late settlement of a timed-out save changes neither current() nor history()', async () => {
    const st = new ModeStore();
    const s = createTemplateSession('dev', st);
    await within(s.load(), BOUND);
    const h0 = s.current().templateHash;
    let late!: () => void;
    st.save = () => new Promise<void>((r) => { late = r; });
    const r = await within(s.accept(prop(s, 'L')), BOUND);
    expect(r.value).toEqual({ ok: false, code: 'STORE_FAILED' });
    late();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.current().templateHash).toBe(h0);
    expect(s.history()).toHaveLength(0);
  });
  it('no timer is left pending after operations settle (no leaked handles)', async () => {
    const st = new ModeStore();
    const s = createTemplateSession('dev', st);
    await within(s.load(), BOUND);
    st.saveMode = 'never';
    const r = await within(s.accept(prop(s, 'T')), BOUND);
    expect(r.settled).toBe(true);
    await vi.advanceTimersByTimeAsync(BOUND * 2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
