import { afterEach, describe, expect, it } from 'vitest';
import { createRenderer, RenderError, type CapsulePatch, type FieldAllowlist, type PatchField, type TemplateSpec } from '../../../src/render';
import { ALLOWLIST, TEMPLATE, makeCaps, setup, slot, FakeClock, FakeScheduler } from './helpers';

// Repair loop 2 regression tests (reviewer r1 HOLD items; see ORACLE.md "Repair loop 2").
const P = (projectId: string, field: PatchField, value: string | boolean, rev = 1): CapsulePatch =>
  ({ projectId, field, value, rev });
afterEach(() => { document.body.innerHTML = ''; });

const build = (template: TemplateSpec, allowlist: FieldAllowlist = ALLOWLIST) => () =>
  createRenderer({ container: document.createElement('div'), template, allowlist,
    poolCapacity: 2, caps: makeCaps(), scheduler: new FakeScheduler(), clock: new FakeClock() });
function codeOf(fn: () => unknown): { err: unknown; code?: string } {
  try { fn(); } catch (e) { return { err: e, code: (e as RenderError).code }; }
  return { err: undefined };
}

describe('U11 repair2 B4.4 lastAppliedRev is monotonic', () => {
  it('applying rev 7 then pending rev 5 (other field) keeps rev 7 as the stale floor', () => {
    const { r, scheduler } = setup();
    r.mount('p1');
    expect(r.enqueue(P('p1', 'headline', 'a', 7)).ok).toBe(true);
    expect(r.enqueue(P('p1', 'summary', 'b', 5)).ok).toBe(true); // 5 >= -1 (nothing applied yet)
    scheduler.flush();
    const res = r.enqueue(P('p1', 'headline', 'c', 6));
    expect(res).toEqual({ ok: false, reason: 'stale_rev' });
  });
});

describe('U11 repair2 B3 class tokens tracked per field', () => {
  const SHARED: FieldAllowlist = {
    ...ALLOWLIST,
    status: { kind: 'class', slot: 'root', classMap: { ok: 's-ok', warn: 's-warn' } },
    stale: { kind: 'class', slot: 'root', classMap: { true: 'is-stale', false: 'not-stale' } },
  };
  it('status and stale on one slot do not evict each other', () => {
    const { r, scheduler, container } = setup({ allowlist: SHARED });
    r.mount('p1');
    r.enqueue(P('p1', 'status', 'ok', 1));
    r.enqueue(P('p1', 'stale', true, 2));
    scheduler.flush();
    const root = slot(container, 0, 'root');
    expect(root.classList.contains('s-ok')).toBe(true);
    expect(root.classList.contains('is-stale')).toBe(true);
  });
  it('changing one field replaces only its own token', () => {
    const { r, scheduler, container } = setup({ allowlist: SHARED });
    r.mount('p1');
    r.enqueue(P('p1', 'status', 'ok', 1));
    r.enqueue(P('p1', 'stale', true, 2));
    scheduler.flush();
    r.enqueue(P('p1', 'status', 'warn', 3));
    scheduler.flush();
    const root = slot(container, 0, 'root');
    expect([...root.classList].sort()).toEqual(['capsule', 'is-stale', 's-warn']);
  });
});

describe('U11 repair2 B9 stale value must be boolean', () => {
  const MAP: FieldAllowlist = { ...ALLOWLIST, stale: { kind: 'class', slot: 'root', classMap: { true: 'is-stale', false: 'fresh' } } };
  it("string 'true' is value_not_allowed", () => {
    const { r } = setup({ allowlist: MAP });
    r.mount('p1');
    expect(r.enqueue(P('p1', 'stale', 'true', 1))).toEqual({ ok: false, reason: 'value_not_allowed' });
    expect(r.pendingCount()).toBe(0);
  });
  it('applying stale=false after true removes is-stale and data-stale and applies classMap.false', () => {
    const { r, scheduler, container } = setup({ allowlist: MAP });
    r.mount('p1');
    r.enqueue(P('p1', 'stale', true, 1)); scheduler.flush();
    const root = slot(container, 0, 'root');
    expect(root.getAttribute('data-stale')).toBe('true');
    r.enqueue(P('p1', 'stale', false, 2)); scheduler.flush();
    expect(root.classList.contains('is-stale')).toBe(false);
    expect(root.hasAttribute('data-stale')).toBe(false);
    expect(root.classList.contains('fresh')).toBe(true);
  });
});

describe('U11 repair2 B10 effects disabled is observable', () => {
  // ASSUMPTION: the spec does not name "transition classes"; the test uses the literal token 'transition'.
  const T: TemplateSpec = { templateHash: 'h-fx', root: { tag: 'div', slot: 'root', staticClass: ['capsule', 'transition'],
    children: TEMPLATE.root.children } };
  const run = (effects: boolean) => {
    const container = document.createElement('div');
    const scheduler = new FakeScheduler();
    const caps = makeCaps({ effects });
    const r = createRenderer({ container, template: T, allowlist: ALLOWLIST, poolCapacity: 2, caps, scheduler, clock: new FakeClock() });
    r.mount('p1'); r.enqueue(P('p1', 'headline', 'x', 1)); scheduler.flush();
    return container.querySelector('[data-slot="root"]') as Element;
  };
  it('effects false: transition class removed from mounted capsule', () => {
    expect(run(false).classList.contains('transition')).toBe(false);
  });
  it('effects true (negative control): transition class kept', () => {
    expect(run(true).classList.contains('transition')).toBe(true);
  });
});

describe('U11 repair2 B2 class token validation at construction', () => {
  const tpl = (staticClass: string[]): TemplateSpec => ({ templateHash: 'h', root: { ...TEMPLATE.root, staticClass } });
  it.each([['a b'], [''], [' '], ['a\tb']])('staticClass token %j -> RenderError template_invalid', (tok) => {
    const { err, code } = codeOf(build(tpl([tok])));
    expect(err).toBeInstanceOf(RenderError);
    expect(code).toBe('template_invalid');
  });
  it.each([['a b'], ['']])('classMap token %j -> RenderError at construction (not a later DOMException)', (tok) => {
    const al: FieldAllowlist = { ...ALLOWLIST, status: { kind: 'class', slot: 'status', classMap: { ok: tok } } };
    const { err } = codeOf(build(TEMPLATE, al));
    expect(err).toBeInstanceOf(RenderError);
  });
  it('valid tokens still construct (negative control)', () => {
    expect(build(tpl(['a', 'b-c']))).not.toThrow();
  });
});

describe('U11 repair2 counters() returns a copy', () => {
  it('mutating the returned object (and rejects) does not change internal counters', () => {
    const { r } = setup();
    r.mount('p1');
    r.enqueue(P('p1', 'headline', 'x', -1));
    const c = r.counters() as unknown as { writes: number; rejects: Record<string, number> };
    expect(c.rejects.bad_rev).toBe(1);
    try { c.writes = 99; c.rejects.bad_rev = 99; } catch { /* frozen copy also acceptable */ }
    const again = r.counters();
    expect(again.writes).toBe(0);
    expect(again.rejects.bad_rev).toBe(1);
  });
});
