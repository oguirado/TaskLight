import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  applyOps, canonicalTemplateJson, compileTemplate, createTemplateSession, defaultTemplate,
  templateHash, templatePromptJson, validateProposal, validateTemplate,
  type LensId, type TemplateSession, type UserTemplate,
} from '../../../src/template';
import {
  FakeStore, baseDev, baseStudy, has, errs, moveSlot, removeSlot, renameLabel, setToken, addSlot, sortedJson,
} from './helpers';

// ---- U25 getLens override (Repair loop 1: lens contract must come from getLens) ----
const hoisted = vi.hoisted(() => ({ override: null as null | ((id: string) => unknown) }));
vi.mock('../../../src/lens', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getLens: (id: string) =>
      hoisted.override ? hoisted.override(id) : (actual.getLens as (i: string) => unknown)(id),
  };
});
afterEach(() => { hoisted.override = null; });

const B = (slot: string, field: string, write: string) => ({ slot, field, write });
const DEV_BINDINGS = [
  B('status_chip', 'status', 'class'), B('headline', 'headline', 'textContent'),
  B('summary', 'summary', 'textContent'), B('next_step', 'next_action', 'textContent'),
];
const STEPS_BINDING = B('checklist', 'steps', 'textContent');
const PROGRESS_BINDING = B('progress', 'progress', 'attribute');
function lensObj(id: string, template: unknown[], hash?: unknown) {
  const l: Record<string, unknown> = { lens_id: id, template };
  if (hash !== undefined) l.template_hash = hash;
  return l;
}
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
const noThrow = (f: () => unknown) => { expect(f).not.toThrow(); };

describe('R1-1 B1/B2: accessors never run; inspection failure is NOT_PLAIN, never thrown', () => {
  it('array index getter is not invoked by validate/compile/applyOps/prompt', () => {
    const mk = () => {
      const t = baseDev();
      const orig = t.slots[0]!;
      const ctr = { n: 0 };
      Object.defineProperty(t.slots, 0, { get() { ctr.n++; return orig; }, enumerable: true, configurable: true });
      return { t, ctr };
    };
    const a = mk();
    const r = validateTemplate(a.t);
    expect(a.ctr.n).toBe(0);
    expect(r.ok).toBe(false);
    expect(has(r, 'NOT_PLAIN')).toBe(true);
    const b = mk(); compileTemplate(b.t); expect(b.ctr.n).toBe(0);
    const c = mk(); applyOps(c.t, { ops: [renameLabel('s2', 'X')] }); expect(c.ctr.n).toBe(0);
    const d = mk(); templatePromptJson(d.t); expect(d.ctr.n).toBe(0);
    const e = mk(); noThrow(() => canonicalTemplateJson(e.t));
  });
  it('array getter inside a proposal is rejected without invocation', () => {
    const ctr = { n: 0 };
    const ops = [renameLabel('s1', 'A')];
    Object.defineProperty(ops, 0, { get() { ctr.n++; return renameLabel('s1', 'A'); }, enumerable: true, configurable: true });
    const r = validateProposal({ ops });
    expect(ctr.n).toBe(0);
    expect(r.ok).toBe(false);
    expect(has(r, 'NOT_PLAIN')).toBe(true);
  });
  it('revoked proxies and throwing traps: no throw anywhere, NOT_PLAIN', () => {
    const mkRevoked = (target: object) => { const { proxy, revoke } = Proxy.revocable(target, {}); revoke(); return proxy; };
    const evil = () => new Proxy({}, { getPrototypeOf() { throw new Error('x'); }, ownKeys() { throw new Error('y'); } });
    const bads: Array<[string, () => unknown]> = [
      ['revoked obj root', () => mkRevoked({})],
      ['revoked arr root', () => mkRevoked([])],
      ['throwing traps root', evil],
      ['revoked slot', () => { const t = baseDev() as unknown as { slots: unknown[] }; t.slots[0] = mkRevoked({}); return t; }],
      ['revoked slots array', () => { const t = baseDev() as unknown as { slots: unknown }; t.slots = mkRevoked([]); return t; }],
      ['revoked tokens', () => { const t = baseDev() as unknown as { tokens: unknown }; t.tokens = mkRevoked({}); return t; }],
      ['throwing-trap grid', () => { const t = baseDev() as unknown as { grid: unknown }; t.grid = evil(); return t; }],
    ];
    for (const [name, mk] of bads) {
      const x = mk();
      let r: ReturnType<typeof validateTemplate> | undefined;
      expect(() => { r = validateTemplate(x); }, name).not.toThrow();
      expect(r!.ok, name).toBe(false);
      expect(has(r!, 'NOT_PLAIN'), name).toBe(true);
      expect(() => compileTemplate(x as UserTemplate), name).not.toThrow();
      expect(compileTemplate(x as UserTemplate).ok, name).toBe(false);
      expect(() => applyOps(x as UserTemplate, { ops: [renameLabel('s1', 'Z')] }), name).not.toThrow();
      expect(applyOps(x as UserTemplate, { ops: [renameLabel('s1', 'Z')] }).ok, name).toBe(false);
      expect(() => templatePromptJson(x as UserTemplate), name).not.toThrow();
      expect(() => canonicalTemplateJson(x as UserTemplate), name).not.toThrow();
      expect(() => templateHash(x as UserTemplate), name).not.toThrow();
    }
    const p = { ops: [mkRevoked({})] };
    let pr: ReturnType<typeof validateProposal> | undefined;
    expect(() => { pr = validateProposal(p); }).not.toThrow();
    expect(pr!.ok).toBe(false);
    expect(has(pr!, 'NOT_PLAIN')).toBe(true);
  });
});

describe('R1-2 B1: canonicalTemplateJson / templateHash are total and deterministic', () => {
  it('cyclic, null, primitives, hostile values never throw and are deterministic', () => {
    const cyc: Record<string, unknown> = {}; cyc.self = cyc;
    const cyc2 = baseDev() as unknown as { slots: Array<Record<string, unknown>> }; cyc2.slots[0]!.loop = cyc2;
    const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
    const inputs: unknown[] = [cyc, cyc2, null, undefined, 5, 'x', [], proxy, { v: 1n }, { f() { /* */ } }];
    for (const x of inputs) {
      expect(() => canonicalTemplateJson(x as never)).not.toThrow();
      expect(typeof canonicalTemplateJson(x as never)).toBe('string');
      expect(canonicalTemplateJson(x as never)).toBe(canonicalTemplateJson(x as never));
      expect(() => templateHash(x as never)).not.toThrow();
      expect(typeof templateHash(x as never)).toBe('string');
      expect(templateHash(x as never)).toBe(templateHash(x as never));
      expect(() => templatePromptJson(x as never)).not.toThrow();
      expect(templatePromptJson(x as never).ok).toBe(false);
      expect(() => compileTemplate(x as never)).not.toThrow();
      expect(compileTemplate(x as never).ok).toBe(false);
    }
  });
  it('extremely deep nesting does not overflow any entry point', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 60000; i++) deep = [deep];
    const t = { ...baseDev(), name: deep } as unknown;
    noThrow(() => validateTemplate(t));
    expect(validateTemplate(t).ok).toBe(false);
    noThrow(() => canonicalTemplateJson(t as never));
    noThrow(() => templateHash(t as never));
    noThrow(() => compileTemplate(t as never));
  });
  it('control: valid template still hashes to 8 hex', () => {
    expect(templateHash(baseDev())).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('R1-3 B3/B5/B11: lens contract is whatever getLens returns', () => {
  it('lens template without a checklist binding -> steps is FIELD_NOT_IN_LENS (study without progress too)', () => {
    hoisted.override = (id) => lensObj(id, DEV_BINDINGS, 'aaaaaaaa');
    const r = validateTemplate(baseDev());
    expect(r.ok).toBe(false);
    expect(has(r, 'FIELD_NOT_IN_LENS', 'slots[4]')).toBe(true); // s5 steps
    hoisted.override = (id) => lensObj(id, [...DEV_BINDINGS, STEPS_BINDING], 'aaaaaaaa');
    const s = validateTemplate(baseStudy());
    expect(has(s, 'FIELD_NOT_IN_LENS', 'slots[5]')).toBe(true); // s6 progress not bound
    expect(has(s, 'FIELD_NOT_IN_LENS', 'slots[4]')).toBe(false);
  });
  it('control: bindings present -> valid', () => {
    hoisted.override = (id) => lensObj(id, [...DEV_BINDINGS, STEPS_BINDING, PROGRESS_BINDING], 'aaaaaaaa');
    expect(validateTemplate(baseDev()).ok).toBe(true);
    expect(validateTemplate(baseStudy()).ok).toBe(true);
  });
  it('getLens returning undefined -> BAD_LENS even for dev/study ids', () => {
    hoisted.override = () => undefined;
    const r = validateTemplate(baseDev());
    expect(r.ok).toBe(false);
    expect(has(r, 'BAD_LENS', 'lens_id')).toBe(true);
    expect(compileTemplate(baseDev()).ok).toBe(false);
  });
  it('B11: hash input is canonical + "|" + lens.template_hash', () => {
    const t = baseDev();
    const canon = sortedJson(t);
    const withHash = (h: string) => {
      hoisted.override = (id) => lensObj(id, [...DEV_BINDINGS, STEPS_BINDING], h);
      return templateHash(t);
    };
    const a = withHash('aaaaaaaa'); const b = withHash('bbbbbbbb');
    expect(a).toBe(fnv(`${canon}|aaaaaaaa`));
    expect(b).toBe(fnv(`${canon}|bbbbbbbb`));
    expect(a).not.toBe(b);
    hoisted.override = (id) => lensObj(id, [...DEV_BINDINGS, STEPS_BINDING], 'aaaaaaaa');
    const c = compileTemplate(t);
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.value.templateHash).toBe(fnv(`${canon}|aaaaaaaa`));
  });
  it('lens without a usable template_hash: no silent lens_id fallback; compile refused, no throw', () => {
    for (const h of [undefined, '', 7, null]) {
      hoisted.override = (id) => lensObj(id, [...DEV_BINDINGS, STEPS_BINDING], h);
      noThrow(() => templateHash(baseDev()));
      expect(templateHash(baseDev()), String(h)).not.toBe(fnv(`${sortedJson(baseDev())}|dev`));
      expect(compileTemplate(baseDev()).ok, String(h)).toBe(false);
    }
  });
});

describe('R1-4 B9: errors are attributed to the responsible op', () => {
  it('OUT_OF_GRID caused by ops[1] is not blamed on ops[0]', () => {
    const r = applyOps(baseDev(), { ops: [renameLabel('s2', 'X'), moveSlot('s5', 13, 1)] });
    expect(r.ok).toBe(false);
    expect(has(r, 'OUT_OF_GRID', 'ops[1]')).toBe(true);
    expect(errs(r).some((e) => e.path.startsWith('ops[0]'))).toBe(false);
  });
  it('CELL_TAKEN caused by ops[3] of 4', () => {
    const r = applyOps(baseDev(), {
      ops: [renameLabel('s1', 'A'), renameLabel('s2', 'B'), setToken('accent', 'teal'), moveSlot('s3', 1, 1)],
    });
    expect(r.ok).toBe(false);
    expect(has(r, 'CELL_TAKEN', 'ops[3]')).toBe(true);
    expect(errs(r).some((e) => /^ops\[[012]\]/.test(e.path))).toBe(false);
  });
  it('CODE_LIKE label added by ops[2]', () => {
    const r = applyOps(baseDev(), {
      ops: [renameLabel('s1', 'A'), setToken('scale', 'lg'), addSlot('s6', 'badge', 'inference_source', 4, 1, '<b>')],
    });
    expect(r.ok).toBe(false);
    expect(has(r, 'CODE_LIKE', 'ops[2]')).toBe(true);
    expect(errs(r).some((e) => /^ops\[[01]\]/.test(e.path))).toBe(false);
  });
  it('MISSING_STATUS caused by removing the chip at ops[1]', () => {
    const r = applyOps(baseDev(), { ops: [renameLabel('s2', 'X'), removeSlot('s1'), renameLabel('s3', 'Y')] });
    expect(r.ok).toBe(false);
    expect(has(r, 'MISSING_STATUS', 'ops[1]')).toBe(true);
    expect(errs(r).some((e) => e.path.startsWith('ops[0]'))).toBe(false);
  });
});

describe('R1-5 B10: steps compiles to individually writable pooled rows', () => {
  type N = { tag: string; slot?: string; children?: N[] };
  const walk = (n: N, f: (n: N) => void) => { f(n); (n.children ?? []).forEach((c) => walk(c, f)); };
  it('steps rule does not target the wrapper that holds the rows; 5 rows are addressable by the rule', () => {
    const c = compileTemplate(baseDev());
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const root = c.value.spec.root as unknown as N;
    let wrapper: N | undefined;
    walk(root, (n) => { if (n.slot === 's5') wrapper = n; });
    expect(wrapper).toBeDefined();
    const rows: N[] = [];
    walk(wrapper!, (n) => { if (n.tag === 'span') rows.push(n); });
    expect(rows).toHaveLength(5);
    const rowSlots = rows.map((r) => r.slot);
    expect(rowSlots.every((s) => typeof s === 'string' && s.length > 0)).toBe(true);
    expect(new Set(rowSlots).size).toBe(5);
    const rule = (c.value.allowlist as Record<string, Record<string, unknown> | undefined>).steps;
    expect(rule).toBeDefined();
    let target: N | undefined;
    walk(root, (n) => { if (n.slot === rule!.slot) target = n; });
    if (target !== undefined) expect(target.children ?? []).toHaveLength(0); // a write must not clobber the rows
    const js = JSON.stringify(rule);
    for (const s of rowSlots) expect(js).toContain(JSON.stringify(s));
    expect(js).toContain('"maxChars":80');
  });
});

describe('R1-6 B13/B14: accept cannot persist content that disagrees with the compiled hash', () => {
  it('mutating pv.next after propose never yields stored/compiled disagreement', async () => {
    const store = new FakeStore();
    const s = createTemplateSession('study', store);
    await s.load();
    const pv = s.propose({ ops: [renameLabel('s1', 'L1')] });
    expect(pv.ok).toBe(true);
    if (!pv.ok) return;
    try { (pv.value.next.tokens as { accent: string }).accent = 'rose'; } catch { /* frozen: fine */ }
    try { pv.value.next.slots[1]!.label = 'Hacked'; } catch { /* frozen: fine */ }
    const res = await s.accept(pv.value);
    const reloaded = createTemplateSession('study', store);
    await reloaded.load();
    expect(reloaded.current().templateHash).toBe(s.current().templateHash);
    if (res.ok) expect(res.templateHash).toBe(s.current().templateHash);
  });
  it('forged preview with invalid content is never persisted or installed', async () => {
    const store = new FakeStore();
    const s = createTemplateSession('study', store);
    await s.load();
    const good = s.propose({ ops: [renameLabel('s1', 'L1')] });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    const bad = baseStudy();
    (bad.tokens as { accent: string }).accent = 'bg-red-500';
    const before = s.current().templateHash;
    const res = await s.accept({ baseHash: before, next: bad, compiled: good.value.compiled });
    expect(JSON.stringify(store.saves)).not.toContain('bg-red-500');
    expect(JSON.stringify(s.current())).not.toContain('bg-red-500');
    if (!res.ok) expect(s.current().templateHash).toBe(before);
    expect(s.history().length).toBe(res.ok ? 1 : 0);
    expect(res.ok).toBe(false);
  });
});

class DeferredStore extends FakeStore {
  defer = false;
  pending: Array<() => void> = [];
  override save(lens: LensId, ring: unknown): Promise<void> {
    if (!this.defer) return super.save(lens, ring);
    return new Promise<void>((res, rej) => {
      this.pending.push(() => { super.save(lens, ring).then(res, rej); });
    });
  }
  async flush(): Promise<void> {
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 0));
      while (this.pending.length) this.pending.shift()!();
    }
  }
}
async function openDeferred(lens: LensId = 'study') {
  const store = new DeferredStore();
  const s = createTemplateSession(lens, store);
  await s.load();
  return { s, store };
}
const prop = (s: TemplateSession, label: string) => {
  const p = s.propose({ ops: [renameLabel('s1', label)] });
  if (!p.ok) throw new Error('propose failed');
  return p.value;
};

describe('R1-7 B14/B15: persistence is serialized (no lost updates)', () => {
  it('two concurrent accepts from the same base: one ok, one STALE_PROPOSAL, history 1', async () => {
    const { s, store } = await openDeferred();
    const p1 = prop(s, 'A1'); const p2 = prop(s, 'B2');
    store.defer = true;
    const all = Promise.all([s.accept(p1), s.accept(p2)]);
    await store.flush();
    const [r1, r2] = await all;
    expect(r1.ok).toBe(true);
    expect(r2).toEqual({ ok: false, code: 'STALE_PROPOSAL' });
    expect(s.history()).toHaveLength(1);
    expect(s.current().labels.s1).toBe('A1');
    const reloaded = createTemplateSession('study', store);
    await reloaded.load();
    expect(reloaded.current().templateHash).toBe(s.current().templateHash);
    expect(reloaded.history()).toEqual(s.history());
  });
  it('two concurrent undos each step back once', async () => {
    const { s, store } = await openDeferred();
    const h0 = s.current().templateHash;
    expect((await s.accept(prop(s, 'A1'))).ok).toBe(true);
    expect((await s.accept(prop(s, 'A2'))).ok).toBe(true);
    expect(s.history()).toHaveLength(2);
    store.defer = true;
    const all = Promise.all([s.undo(), s.undo()]);
    await store.flush();
    const [u1, u2] = await all;
    expect(u1.ok).toBe(true);
    expect(u2.ok).toBe(true);
    expect(s.history()).toHaveLength(0);
    expect(s.current().templateHash).toBe(h0);
    const reloaded = createTemplateSession('study', store);
    await reloaded.load();
    expect(reloaded.current().templateHash).toBe(h0);
  });
});

describe('R1-8 B16: invalid history entries are dropped individually', () => {
  async function seeded() {
    const store = new FakeStore();
    const s = createTemplateSession('study', store);
    await s.load();
    for (const l of ['A1', 'A2']) {
      const r = await s.accept(prop(s, l));
      expect(r.ok).toBe(true);
    }
    const ring = structuredClone(store.ring.get('study')) as Record<string, unknown>;
    const key = Object.keys(ring).find((k) => Array.isArray(ring[k]));
    expect(key).toBeDefined();
    return { s, store, ring, key: key! };
  }
  it('invalid entry between/after valid ones keeps the valid ones and restored:true', async () => {
    const { s, ring, key } = await seeded();
    const arr = ring[key] as unknown[];
    expect(arr).toHaveLength(2);
    const variants: unknown[][] = [
      [arr[0], {}, arr[1]], [arr[0], arr[1], null], [{ nope: 1 }, arr[0], arr[1]], [arr[0], 'junk', arr[1], 7],
    ];
    for (const v of variants) {
      const st = new FakeStore();
      st.loadValue = { set: true, v: { ...ring, [key]: v } };
      const b = createTemplateSession('study', st);
      expect(await b.load()).toEqual({ restored: true });
      expect(b.current().templateHash).toBe(s.current().templateHash);
      expect(b.history()).toEqual(s.history());
      expect(st.saves).toHaveLength(0);
    }
  });
  it('invalid current still falls back to defaults (control)', async () => {
    const { ring } = await seeded();
    const st = new FakeStore();
    st.loadValue = { set: true, v: { ...ring, current: {} } };
    const b = createTemplateSession('study', st);
    expect(await b.load()).toEqual({ restored: false });
    const d = compileTemplate(defaultTemplate('study'));
    expect(d.ok && b.current().templateHash === d.value.templateHash).toBe(true);
  });
});
