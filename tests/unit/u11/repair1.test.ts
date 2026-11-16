import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, RenderError, type CapsulePatch, type PatchField } from '../../../src/render';
import { ALLOWLIST, TEMPLATE, makeCaps, setup, slotText, FakeClock, FakeScheduler } from './helpers';

// Repair loop 1 regression tests (reviewer HOLD items; see ORACLE.md "Repair loop 1").
const P = (projectId: string, field: PatchField, value: string | boolean, rev = 1): CapsulePatch =>
  ({ projectId, field, value, rev });
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

const build = (allowlist: unknown) => () =>
  createRenderer({ container: document.createElement('div'), template: TEMPLATE, allowlist: allowlist as typeof ALLOWLIST,
    poolCapacity: 2, caps: makeCaps(), scheduler: new FakeScheduler(), clock: new FakeClock() });
function codeOf(fn: () => unknown): { err: unknown; code?: string } {
  try { fn(); } catch (e) { return { err: e, code: (e as RenderError).code }; }
  return { err: undefined };
}

describe('U11 repair1 B5 pending coalescing vs rev', () => {
  it('older rev enqueued after newer pending rev must not replace it', () => {
    const { r, scheduler, container } = setup();
    r.mount('p1');
    r.enqueue(P('p1', 'headline', 'new', 7));
    r.enqueue(P('p1', 'headline', 'old', 5));
    scheduler.flush();
    expect(slotText(container, 0, 'headline')).toBe('new');
  });
  it('stale pending rev is rejected as stale_rev or ignored; never lowers pending', () => {
    const { r, scheduler, container } = setup();
    r.mount('p1');
    r.enqueue(P('p1', 'headline', 'rev7', 7));
    const res = r.enqueue(P('p1', 'headline', 'rev6', 6));
    expect(res.ok === false ? res.reason : 'stale_rev').toBe('stale_rev');
    expect(r.pendingCount()).toBe(1);
    scheduler.flush();
    expect(slotText(container, 0, 'headline')).toBe('rev7');
  });
});

describe('U11 repair1 B2/B3 allowlist validation', () => {
  it('unknown allowlist key (innerHTML) -> RenderError allowlist_invalid', () => {
    const { err, code } = codeOf(build({ ...ALLOWLIST, innerHTML: { kind: 'text', slot: 'headline' } }));
    expect(err).toBeInstanceOf(RenderError);
    expect(code).toBe('allowlist_invalid');
  });
  it('invalid rule kind -> RenderError allowlist_invalid', () => {
    const { err, code } = codeOf(build({ ...ALLOWLIST, headline: { kind: 'bogus', slot: 'headline' } }));
    expect(err).toBeInstanceOf(RenderError);
    expect(code).toBe('allowlist_invalid');
  });
  it.each(['onclick', 'href', 'src', 'style'])('attr %s outside AllowedAttr -> RenderError allowlist_invalid', (attr) => {
    const { err, code } = codeOf(build({ ...ALLOWLIST, inference_source: { kind: 'attr', slot: 'source', attr } }));
    expect(err).toBeInstanceOf(RenderError);
    expect(code).toBe('allowlist_invalid');
  });
  it('disallowed attr never reaches the DOM even if construction did not throw', () => {
    let ctx: ReturnType<typeof setup> | undefined;
    try {
      ctx = setup({ allowlist: { ...ALLOWLIST, inference_source: { kind: 'attr', slot: 'source', attr: 'onclick' } } as typeof ALLOWLIST });
    } catch { return; }
    ctx.r.mount('p1');
    ctx.r.enqueue(P('p1', 'inference_source', 'alert(1)'));
    ctx.scheduler.flush();
    expect(ctx.container.querySelector('[onclick]')).toBeNull();
  });
});

describe('U11 repair1 B7 progress guarantee', () => {
  it('maxPatchesThisFrame() = 0 still applies >= 1 write per tick and drains', () => {
    const { r, scheduler, caps } = setup({ max: 0 });
    r.mount('p1');
    ['headline', 'summary', 'next_action'].forEach((f) => r.enqueue(P('p1', f as PatchField, 'x')));
    let before = r.pendingCount();
    for (let i = 0; i < 5 && r.pendingCount() > 0; i++) {
      scheduler.flush();
      expect(r.pendingCount()).toBeLessThan(before);
      before = r.pendingCount();
    }
    expect(r.pendingCount()).toBe(0);
    expect(r.counters().writes).toBe(3);
    expect(caps.endFrame).toHaveBeenCalled();
  });
  it('slow clock (every read exceeds budget) still applies exactly >= 1 write per tick', () => {
    const { r, scheduler } = setup({ step: 50_000 });
    r.mount('p1');
    ['headline', 'summary', 'next_action'].forEach((f) => r.enqueue(P('p1', f as PatchField, 'x')));
    let before = r.pendingCount();
    for (let i = 0; i < 5 && r.pendingCount() > 0; i++) {
      scheduler.flush();
      expect(r.pendingCount()).toBeLessThan(before);
      before = r.pendingCount();
    }
    expect(r.pendingCount()).toBe(0);
  });
  it('frameJsBudgetMs() = 0 still progresses', () => {
    const { r, scheduler } = setup({ budgetMs: 0, step: 1000 });
    r.mount('p1');
    r.enqueue(P('p1', 'headline', 'a'));
    r.enqueue(P('p1', 'summary', 'b'));
    scheduler.flush();
    expect(r.counters().writes).toBeGreaterThanOrEqual(1);
  });
});

describe('U11 repair1 B10 effects via public capability API', () => {
  it('tick consults caps.effectsEnabled() (true and false) and still writes', () => {
    const { r, scheduler, caps, container } = setup();
    r.mount('p1');
    r.enqueue(P('p1', 'headline', 'a'));
    scheduler.flush();
    expect(caps.effectsEnabled).toHaveBeenCalled();
    caps.effectsEnabled.mockReturnValue(false);
    caps.effectsEnabled.mockClear();
    r.enqueue(P('p1', 'headline', 'b', 2));
    scheduler.flush();
    expect(caps.effectsEnabled).toHaveBeenCalled();
    expect(slotText(container, 0, 'headline')).toBe('b');
  });
});
