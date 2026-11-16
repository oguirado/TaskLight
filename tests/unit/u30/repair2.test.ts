// Repair r2 (cross-family review, DISP_03 threat model). Two BLOCKING items only:
//  R2-1 B14/B16: accept must refuse a template of another lens; a stored ring must never be
//       one the same session would silently discard on reload.
//  R2-2 B3/B5/B11: lens descriptor prerequisites (array `template`) missing/invalid -> fail closed,
//       never hardcoded permissions or a lens_id hash substitute.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyOps, compileTemplate, createTemplateSession, defaultTemplate, templateHash, validateProposal,
  validateTemplate, type LensId, type Preview,
} from '../../../src/template';
import { FakeStore, baseDev, baseStudy, has, renameLabel, sortedJson } from './helpers';

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

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

async function previewOf(next: ReturnType<typeof baseDev>, base: string): Promise<Preview> {
  const c = compileTemplate(next);
  if (!c.ok) throw new Error('fixture must compile');
  return { baseHash: base, next, compiled: c.value };
}

describe('R2-1 accept refuses a template of another lens (B14/B16)', () => {
  const cases: Array<[LensId, () => ReturnType<typeof baseDev>]> = [
    ['dev', () => baseStudy()],
    ['dev', () => defaultTemplate('study')],
    ['study', () => baseDev()],
    ['study', () => defaultTemplate('dev')],
  ];
  it.each(cases)('session %s accepting a foreign-lens template: refused, nothing saved, state unchanged', async (lens, mk) => {
    const store = new FakeStore();
    const s = createTemplateSession(lens, store);
    await s.load();
    const h0 = s.current().templateHash;
    const r = await s.accept(await previewOf(mk(), h0));
    expect(r.ok).toBe(false);
    expect(store.saves).toHaveLength(0);
    expect(s.current().templateHash).toBe(h0);
    expect(s.history()).toHaveLength(0);
    // a fresh session sees the untouched defaults
    const s2 = createTemplateSession(lens, store);
    expect((await s2.load()).restored).toBe(false);
    expect(s2.current().templateHash).toBe(h0);
  });
  it('a foreign-lens accept never poisons an existing good ring (second session restores the good template)', async () => {
    const store = new FakeStore();
    const s = createTemplateSession('dev', store);
    await s.load();
    const p = s.propose({ ops: [renameLabel('s1', 'Mine')] });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const good = await s.accept(p.value);
    expect(good.ok).toBe(true);
    const h1 = s.current().templateHash;
    const bad = await s.accept(await previewOf(baseStudy(), h1));
    expect(bad.ok).toBe(false);
    expect(s.current().templateHash).toBe(h1);
    const s2 = createTemplateSession('dev', store);
    expect((await s2.load()).restored).toBe(true);
    expect(s2.current().templateHash).toBe(h1);
  });
  it('invariant: whatever accept reports ok is restored identically on reload (no silent discard)', async () => {
    for (const lens of ['dev', 'study'] as LensId[]) {
      for (const next of [baseDev(), baseStudy(), defaultTemplate('dev'), defaultTemplate('study')]) {
        const store = new FakeStore();
        const s = createTemplateSession(lens, store);
        await s.load();
        const r = await s.accept(await previewOf(next, s.current().templateHash));
        if (r.ok) {
          const s2 = createTemplateSession(lens, store);
          const l = await s2.load();
          expect(l.restored, `${lens} accepted ${next.lens_id}`).toBe(true);
          expect(s2.current().templateHash).toBe(r.templateHash);
        }
      }
    }
  });
  it('control: same-lens accept saves, installs and survives reload', async () => {
    const store = new FakeStore();
    const s = createTemplateSession('study', store);
    await s.load();
    const next = baseStudy();
    next.name = 'Changed';
    const r = await s.accept(await previewOf(next, s.current().templateHash));
    expect(r.ok).toBe(true);
    expect(store.saves).toHaveLength(1);
    const s2 = createTemplateSession('study', store);
    expect((await s2.load()).restored).toBe(true);
    expect(s2.current().templateHash).toBe(s.current().templateHash);
  });
});

describe('R2-2 lens descriptor prerequisites fail closed (B3/B5/B11)', () => {
  const B = (slot: string, field: string, write: string) => ({ slot, field, write });
  const goodTpl = [B('status_chip', 'status', 'class'), B('headline', 'headline', 'textContent'),
    B('summary', 'summary', 'textContent'), B('next_step', 'next_action', 'textContent'), B('checklist', 'steps', 'textContent'),
    B('progress', 'progress', 'attribute')];
  const BAD: Array<[string, (id: string) => unknown]> = [
    ['no template, no hash', (id) => ({ lens_id: id })],
    ['no template, with hash', (id) => ({ lens_id: id, template_hash: 'aaaaaaaa' })],
    ['template undefined', (id) => ({ lens_id: id, template: undefined, template_hash: 'aaaaaaaa' })],
    ['template null', (id) => ({ lens_id: id, template: null, template_hash: 'aaaaaaaa' })],
    ['template string', (id) => ({ lens_id: id, template: 'status', template_hash: 'aaaaaaaa' })],
    ['template number', (id) => ({ lens_id: id, template: 7, template_hash: 'aaaaaaaa' })],
    ['template plain object', (id) => ({ lens_id: id, template: { status: 'x' }, template_hash: 'aaaaaaaa' })],
    ['template object with length', (id) => ({ lens_id: id, template: { length: 5 }, template_hash: 'aaaaaaaa' })],
    ['descriptor without lens_id and template', () => ({})],
  ];
  it.each(BAD)('%s: validate, compile and applyOps refuse; hash is not the lens_id substitute', (_n, mk) => {
    hoisted.override = mk;
    for (const t of [baseDev(), baseStudy()]) {
      const v = validateTemplate(t);
      expect(v.ok).toBe(false);
      expect(has(v, 'BAD_LENS', 'lens_id')).toBe(true);
      expect(compileTemplate(t).ok).toBe(false);
      expect(applyOps(t, { ops: [renameLabel('s1', 'X')] }).ok).toBe(false);
      expect(templateHash(t)).not.toBe(fnv(`${sortedJson(t)}|${t.lens_id}`));
    }
    expect(validateProposal({ ops: [renameLabel('s1', 'X')] }).ok).toBe(true); // control: proposal shape itself unaffected
  });
  it('control: a valid descriptor (array template + hash) still validates and compiles', () => {
    hoisted.override = (id) => ({ lens_id: id, template: goodTpl, template_hash: 'aaaaaaaa' });
    expect(validateTemplate(baseDev()).ok).toBe(true);
    expect(validateTemplate(baseStudy()).ok).toBe(true);
    expect(compileTemplate(baseStudy()).ok).toBe(true);
  });
  it('hardcoded permissions are not a fallback: a lens-less descriptor cannot authorise any field', () => {
    hoisted.override = (id) => ({ lens_id: id, template_hash: 'aaaaaaaa' });
    const t = baseDev();
    expect(validateTemplate(t).ok).toBe(false);
    expect(has(validateTemplate(t), 'FIELD_NOT_IN_LENS')).toBe(false); // refused as BAD_LENS, not field-by-field from a hardcoded table
  });
});
