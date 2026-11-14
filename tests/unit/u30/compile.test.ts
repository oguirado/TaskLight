import { describe, it, expect } from 'vitest';
import {
  compileTemplate, canonicalTemplateJson, templateHash, templatePromptJson, defaultTemplate, STYLE_CLASSES,
  type CompiledTemplate, type UserTemplate,
} from '../../../src/template';
import { createRenderer } from '../../../src/render';
import type { FieldAllowlist, TemplateNode } from '../../../src/render/types';
import { baseDev, baseStudy, clone, deepFrozen, anyFrozen, sortedJson, has, errs } from './helpers';

const TAGS = new Set(['div', 'span', 'p', 'h3', 'time']);
const ATTRS = new Set(['data-status', 'data-attention', 'data-source', 'data-stale', 'aria-label']);
const PATCH_FIELDS = ['status', 'attention', 'headline', 'summary', 'next_action', 'inference_source', 'stale', 'updated_at'];

function must(t: UserTemplate): CompiledTemplate {
  const r = compileTemplate(t);
  if (!r.ok) throw new Error(`compile failed: ${JSON.stringify(r.errors)}`);
  return r.value;
}
function walk(n: TemplateNode, f: (n: TemplateNode) => void): void {
  f(n);
  for (const c of n.children ?? []) walk(c, f);
}
/** largest valid templates available: both defaults, and a full study template */
function bigStudy(): UserTemplate {
  const t = baseStudy();
  t.grid.cols = 3;
  t.slots.push({ id: 's7', component: 'badge', field: 'inference_source', label: 'ZZQQLABEL', row: 4, col: 1 });
  t.slots.push({ id: 's8', component: 'badge', field: 'stale', label: 'Stale', row: 4, col: 2 });
  t.name = 'ZZQQNAME';
  t.slots[0]!.label = 'ZZQQLABEL0';
  return t;
}

describe('T5 compiled_output_safe', () => {
  const inputs: Array<[string, UserTemplate]> = [
    ['dev default', defaultTemplate('dev')], ['study default', defaultTemplate('study')],
    ['base dev', baseDev()], ['big study', bigStudy()],
  ];
  it('STYLE_CLASSES mirrors the documented class families', () => {
    for (const c of ['t-accent-blue', 'g-cols-2', 'g-r3-c2']) expect(STYLE_CLASSES.has(c)).toBe(true);
    for (const c of STYLE_CLASSES) expect(/^\S+$/.test(c)).toBe(true);
  });
  for (const [name, t] of inputs) {
    it(`${name}: tags, classes, keys, attrs`, () => {
      const c = must(t);
      let nodes = 0; const slotSet = new Set<string>(); let classCount = 0;
      walk(c.spec.root, (n) => {
        nodes++; if (n.slot) slotSet.add(n.slot); classCount += (n.staticClass ?? []).length;
        expect(TAGS.has(n.tag)).toBe(true);
        for (const k of Object.keys(n)) expect(['tag', 'slot', 'staticClass', 'children']).toContain(k);
        for (const cl of n.staticClass ?? []) expect(STYLE_CLASSES.has(cl)).toBe(true);
      });
      expect(nodes).toBeGreaterThan(t.slots.length);          // non-vacuous: real subtree per slot
      for (const sl of t.slots) expect(slotSet.has(sl.id)).toBe(true);
      expect(classCount).toBeGreaterThan(0);
      expect(Object.keys(c.allowlist).length).toBeGreaterThan(0);
      const all = JSON.stringify(c);
      expect(all).not.toMatch(/"(style|on[a-z]+|src|href|innerHTML|className|html)"\s*:/i);
      for (const rule of Object.values(c.allowlist)) {
        for (const cl of Object.values(rule?.classMap ?? {})) expect(STYLE_CLASSES.has(cl)).toBe(true);
        if (rule?.kind === 'attr') expect(ATTRS.has(rule.attr as string)).toBe(true);
      }
    });
  }
  it('no input string appears as a class, attr or tag', () => {
    const c = must(bigStudy());
    const classes: string[] = [];
    walk(c.spec.root, (n) => { classes.push(...(n.staticClass ?? [])); });
    for (const rule of Object.values(c.allowlist)) classes.push(...Object.values(rule?.classMap ?? {}));
    expect(classes.length).toBeGreaterThan(0);
    expect(Object.values(c.labels)).toContain('ZZQQLABEL');
    expect(classes.join(' ')).not.toMatch(/zzqq/i);
    expect(JSON.stringify(c.spec)).not.toMatch(/zzqq/i); // names/labels live only in `labels`
  });
  it('tokens and grid map to classes; different tokens give different classes', () => {
    const a = must(baseDev());
    const b2 = baseDev(); b2.tokens.accent = 'rose'; b2.grid.cols = 3;
    const b = must(b2);
    const cls = (c: CompiledTemplate) => { const o: string[] = []; walk(c.spec.root, (n) => { o.push(...(n.staticClass ?? [])); }); return o.sort().join(' '); };
    expect(cls(a)).toContain('t-accent-blue');
    expect(cls(a)).toContain('g-cols-2');
    expect(cls(b)).toContain('t-accent-rose');
    expect(cls(b)).toContain('g-cols-3');
    expect(cls(b)).not.toContain('t-accent-blue');
  });
});

describe('B10 compile structure', () => {
  it('every slot id is a node slot; labels painted; allowlist slots exist', () => {
    const t = baseStudy();
    const c = must(t);
    const slots = new Set<string>();
    walk(c.spec.root, (n) => { if (n.slot !== undefined) slots.add(n.slot); });
    for (const s of t.slots) {
      expect(slots.has(s.id)).toBe(true);
      expect(c.labels[s.id]).toBe(s.label);
    }
    for (const rule of Object.values(c.allowlist)) expect(slots.has(rule!.slot)).toBe(true);
  });
  it('allowlist has exactly the bound fields with documented caps', () => {
    const c = must(baseStudy());
    expect(Object.keys(c.allowlist).sort()).toEqual(['headline', 'next_action', 'progress', 'status', 'steps', 'summary']);
    expect(c.allowlist.headline).toMatchObject({ kind: 'text', maxChars: 120 });
    expect(c.allowlist.summary).toMatchObject({ kind: 'text', maxChars: 600 });
    expect(c.allowlist.next_action).toMatchObject({ kind: 'text', maxChars: 160 });
    expect(c.allowlist.status).toMatchObject({ kind: 'class' });
    expect(Object.keys(c.allowlist.status!.classMap ?? {})).toContain('running');
    expect(c.allowlist.progress).toMatchObject({ kind: 'attr' });
    const dev = must(baseDev());
    expect(dev.allowlist.progress).toBeUndefined();
  });
  it('unbound fields are absent from the allowlist (removing a slot removes its rule)', () => {
    const t = baseDev();
    t.slots = t.slots.filter((s) => s.field !== 'summary');
    expect(must(t).allowlist.headline).toBeDefined();
    expect(must(t).allowlist.summary).toBeUndefined();
  });
  it('output is deep-frozen; input is not frozen or mutated', () => {
    const t = baseStudy();
    const before = clone(t);
    const c = must(t);
    expect(deepFrozen(c)).toBe(true);
    expect(() => { (c.labels as Record<string, string>).s1 = 'x'; }).toThrow();
    expect(t).toEqual(before);
    expect(anyFrozen(t)).toBe(false);
  });
  it('invalid input is not compiled and never throws', () => {
    const t = clone(baseDev()) as unknown as Record<string, unknown>;
    t.className = 'x';
    const r = compileTemplate(t as unknown as UserTemplate);
    expect(r.ok).toBe(false);
    expect(has(r, 'UNKNOWN_FIELD')).toBe(true);
    expect(compileTemplate(null as never).ok).toBe(false);
    const raw = clone(baseDev()); raw.tokens.accent = 'bg-red-500 x' as never;
    expect(has(compileTemplate(raw), 'BAD_TOKEN_VALUE')).toBe(true);
    const c2 = clone(baseDev()); c2.slots[0]!.component = 'iframe' as never;
    expect(has(compileTemplate(c2), 'BAD_COMPONENT')).toBe(true);
    expect(errs(compileTemplate(raw)).length).toBeGreaterThan(0);
  });
});

describe('B11 hash and canonical json', () => {
  it('canonical: sorted keys, no whitespace, key-order independent', () => {
    const t = baseStudy();
    expect(canonicalTemplateJson(t)).toBe(sortedJson(t));
    expect(canonicalTemplateJson(t)).not.toMatch(/\s(?=(?:[^"]*"[^"]*")*[^"]*$)/); // no whitespace outside strings
    const shuffled = { slots: t.slots.map((s) => ({ label: s.label, col: s.col, row: s.row, id: s.id, field: s.field, component: s.component })),
      tokens: { scale: t.tokens.scale, radius: t.tokens.radius, density: t.tokens.density, accent: t.tokens.accent },
      grid: { cols: t.grid.cols }, name: t.name, lens_id: t.lens_id, v: t.v } as unknown as UserTemplate;
    expect(canonicalTemplateJson(shuffled)).toBe(canonicalTemplateJson(t));
    expect(templateHash(shuffled)).toBe(templateHash(t));
  });
  it('hash: 8 hex, stable, equals compiled hash', () => {
    const t = baseStudy();
    expect(templateHash(t)).toMatch(/^[0-9a-f]{8}$/);
    expect(templateHash(t)).toBe(templateHash(clone(t)));
    expect(templateHash(t)).not.toBe(templateHash(baseDev()));
    expect(must(t).templateHash).toBe(templateHash(t));
    expect(must(t).spec.templateHash).toBe(templateHash(t));
  });
  it('hash changes on every kind of edit, including a label rename and a move', () => {
    const base = baseStudy();
    const h = new Set<string>([templateHash(base)]);
    const variants: Array<(t: UserTemplate) => void> = [
      (t) => { t.slots[0]!.label = 'Other'; },
      (t) => { t.slots[0]!.label = 'Status '; },
      (t) => { t.slots[4]!.row = 5; },
      (t) => { t.tokens.accent = 'rose'; },
      (t) => { t.tokens.density = 'compact'; },
      (t) => { t.tokens.radius = 'none'; },
      (t) => { t.tokens.scale = 'lg'; },
      (t) => { t.name = 'Renamed'; },
      (t) => { t.grid.cols = 3; },
      (t) => { t.slots.pop(); },
      (t) => { t.slots.push({ id: 's7', component: 'badge', field: 'stale', label: 'S', row: 4, col: 1 }); },
    ];
    for (const m of variants) { const t = clone(base); m(t); h.add(templateHash(t)); }
    expect(h.size).toBe(variants.length + 1);
  });
  it('hash depends on lens: same shape, different lens_id', () => {
    const a = baseDev();
    const b = baseDev(); b.lens_id = 'study';
    expect(templateHash(a)).not.toBe(templateHash(b));
  });
  it('different defaults per lens', () => {
    expect(templateHash(defaultTemplate('dev'))).not.toBe(templateHash(defaultTemplate('study')));
  });
});

describe('B12 prompt json / T15 budget', () => {
  it('canonical, deterministic, <= 1500 for the largest valid templates', () => {
    for (const t of [defaultTemplate('dev'), defaultTemplate('study'), bigStudy()]) {
      const a = templatePromptJson(t);
      const b = templatePromptJson(clone(t));
      expect(a.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.value).toBe(b.value);
      expect(a.value.length).toBeLessThanOrEqual(1500);
      expect(a.value).toBe(canonicalTemplateJson(t));
      expect(a.value).toBe(sortedJson(t));
    }
  });
  it('negative control: 12 slots with 24-char labels is not returned as ok', () => {
    // 12 distinct-field slots cannot be valid (B5), so this must be refused (PROMPT_TOO_LARGE or validation error)
    const t = baseStudy();
    t.name = 'n'.repeat(40);
    t.slots = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i + 1}`, component: 'text', field: 'summary', label: 'L'.repeat(24), row: Math.floor(i / 2) + 1, col: (i % 2) + 1,
    })) as never;
    const r = templatePromptJson(t);
    expect(r.ok).toBe(false);
  });
});

describe('compiled template accepted by the real U11 createRenderer', () => {
  type Mk = { container: HTMLElement; frames: Array<() => void>; r: ReturnType<typeof createRenderer> };
  function build(c: CompiledTemplate): Mk {
    // U11 delta AUSENTE: FieldAllowlist is total over PatchField and rejects non-PatchField keys (steps, progress).
    // Filter to PatchField keys for the unmodified renderer; ORACLE.md documents this.
    const allow = Object.fromEntries(Object.entries(c.allowlist).filter(([k]) => PATCH_FIELDS.includes(k))) as unknown as FieldAllowlist;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const frames: Array<() => void> = [];
    const r = createRenderer({
      container, template: c.spec, allowlist: allow, poolCapacity: 4,
      caps: { maxPatchesThisFrame: () => 8, frameJsBudgetMs: () => 4, effectsEnabled: () => true, beginFrame() {}, endFrame() {} },
      scheduler: { request: (cb) => { frames.push(cb); } }, clock: { nowUs: () => 0 },
    });
    return { container, frames, r };
  }
  for (const [name, t] of [['dev default', defaultTemplate('dev')], ['study default', defaultTemplate('study')],
    ['base dev', baseDev()], ['base study', baseStudy()], ['big study', bigStudy()]] as Array<[string, UserTemplate]>) {
    it(`${name}: createRenderer accepts, mounts, paints a patch`, () => {
      const c = must(t);
      const { container, frames, r } = build(c);
      expect(r.mount('p1')).toEqual({ ok: true });
      const root = container.firstElementChild as HTMLElement;
      for (const s of t.slots) expect(root.querySelector(`[data-slot="${s.id}"]`) ?? root.matches(`[data-slot="${s.id}"]`)).toBeTruthy();
      const h = c.allowlist.headline;
      if (h) {
        expect(r.enqueue({ projectId: 'p1', rev: 1, field: 'headline', value: 'Hello' })).toEqual({ ok: true });
        frames.splice(0).forEach((f) => f());
        const el = root.querySelector(`[data-slot="${h.slot}"]`) ?? root;
        expect(el.textContent).toBe('Hello');
      }
      const st = c.allowlist.status!;
      const key = Object.keys(st.classMap ?? {})[0]!;
      expect(r.enqueue({ projectId: 'p1', rev: 2, field: 'status', value: key })).toEqual({ ok: true });
      frames.splice(0).forEach((f) => f());
      const sel = root.matches(`[data-slot="${st.slot}"]`) ? root : root.querySelector(`[data-slot="${st.slot}"]`);
      expect(sel!.classList.contains(st.classMap![key]!)).toBe(true);
      expect(r.enqueue({ projectId: 'p1', rev: 3, field: 'status', value: 'bg-red-500 x' })).toMatchObject({ ok: false });
    });
  }
});
