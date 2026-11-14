import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, RenderError, type CapsulePatch, type PatchField, type TemplateSpec } from '../../../src/render';
import { ALLOWLIST, TEMPLATE, makeCaps, mountN, setup, slot, slotText, FakeClock, FakeScheduler } from './helpers';

const P = (projectId: string, field: PatchField, value: string | boolean, rev = 1): CapsulePatch =>
  ({ projectId, field, value, rev });

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('U11 B2 template validation', () => {
  function expectRenderError(fn: () => unknown, code: string) {
    let err: unknown;
    try { fn(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RenderError);
    expect((err as RenderError).code).toBe(code);
  }
  const build = (template: TemplateSpec, allowlist = ALLOWLIST) => () =>
    createRenderer({ container: document.createElement('div'), template, allowlist, poolCapacity: 2,
      caps: makeCaps(), scheduler: new FakeScheduler(), clock: new FakeClock() });

  it('tag outside whitelist -> template_invalid', () => {
    const bad = { templateHash: 'x', root: { tag: 'script', slot: 'root', children: TEMPLATE.root.children } } as unknown as TemplateSpec;
    expectRenderError(build(bad), 'template_invalid');
  });
  it('duplicate slots -> template_invalid', () => {
    const bad: TemplateSpec = { templateHash: 'x', root: { ...TEMPLATE.root, children: [...TEMPLATE.root.children!, { tag: 'span', slot: 'headline' }] } };
    expectRenderError(build(bad), 'template_invalid');
  });
  it('allowlist slot missing from template -> allowlist_invalid', () => {
    const bad = { ...ALLOWLIST, headline: { kind: 'text', slot: 'nope', maxChars: 120 } } as typeof ALLOWLIST;
    expectRenderError(build(TEMPLATE, bad), 'allowlist_invalid');
  });
  it('valid template does not throw', () => {
    expect(build(TEMPLATE)).not.toThrow();
  });
});

describe('U11 B1/O7 pool', () => {
  it('construction pre-creates poolCapacity nodes, none attached', () => {
    const spy = vi.spyOn(document, 'createElement');
    const { container } = setup({ poolCapacity: 16 });
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(16);
    expect(container.childElementCount).toBe(0);
  });

  it('O7 pool_preallocated_and_bounded: 16 ok, 17th pool_exhausted, zero createElement after warm-up', () => {
    const { r } = setup({ poolCapacity: 16 });
    const spy = vi.spyOn(document, 'createElement');
    const spyNS = vi.spyOn(document, 'createElementNS');
    const clone = vi.spyOn(Node.prototype, 'cloneNode');
    const res = Array.from({ length: 17 }, (_, i) => r.mount(`p${i}`));
    expect(res.slice(0, 16).every((x) => x.ok)).toBe(true);
    expect(res[16]).toEqual({ ok: false, reason: 'pool_exhausted' });
    expect(r.counters().poolExhausted).toBe(1);
    expect(spy).toHaveBeenCalledTimes(0);
    expect(spyNS).toHaveBeenCalledTimes(0);
    expect(clone).toHaveBeenCalledTimes(0);
  });

  it('no allocation during patch/tick/unmount/remount cycles', () => {
    const { r, scheduler } = setup({ poolCapacity: 4 });
    const spy = vi.spyOn(document, 'createElement');
    const clone = vi.spyOn(Node.prototype, 'cloneNode');
    expect(r.mount('a').ok).toBe(true);
    r.enqueue(P('a', 'headline', 'hi'));
    scheduler.flush();
    r.unmount('a');
    expect(r.mount('b').ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(0);
    expect(clone).toHaveBeenCalledTimes(0);
    expect(r.counters().writes).toBe(1);
  });

  it('duplicate mount refused', () => {
    const { r } = setup();
    expect(r.mount('a')).toEqual({ ok: true });
    expect(r.mount('a')).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('mounted capsule is attached to container with data-slot nodes; template static class applied', () => {
    const { r, container } = setup();
    r.mount('a');
    expect(container.querySelectorAll('[data-slot="headline"]').length).toBe(1);
    expect(container.querySelector('.capsule')).not.toBeNull();
  });
});

describe('U11 B11 unmount', () => {
  it('detaches, clears slots, returns node to pool, drops pending', () => {
    const { r, container, scheduler } = setup({ poolCapacity: 1 });
    r.mount('a');
    r.enqueue(P('a', 'headline', 'hello'));
    scheduler.flush();
    expect(slotText(container, 0, 'headline')).toBe('hello');
    r.enqueue(P('a', 'summary', 'pending-one', 2));
    r.unmount('a');
    expect(container.querySelectorAll('[data-slot="headline"]').length).toBe(0);
    expect(r.pendingCount()).toBe(0);
    expect(r.mount('b')).toEqual({ ok: true }); // node came back to pool (capacity 1)
    expect(slotText(container, 0, 'headline')).toBe('');
    expect(slotText(container, 0, 'summary')).toBe('');
    const w = r.counters().writes;
    scheduler.flush();
    expect(r.counters().writes).toBe(w); // dropped patch never written
    expect(r.enqueue(P('a', 'headline', 'x')).ok).toBe(false);
  });
});

describe('U11 O1 html_string_renders_literal', () => {
  const evil = '<img src=x onerror=alert(1)>';
  it.each(['headline', 'summary', 'next_action'] as const)('%s: markup string stays literal text', (field) => {
    const { r, container, scheduler } = setup();
    r.mount('p1');
    expect(r.enqueue(P('p1', field, evil))).toEqual({ ok: true });
    scheduler.flush();
    const name = field;
    expect(slotText(container, 0, name)).toBe(evil);
    expect(container.querySelectorAll('img').length).toBe(0);
    expect(slot(container, 0, name).childElementCount).toBe(0);
  });
  it('boolean value on a text field is not painted', () => {
    const { r, scheduler, container } = setup();
    r.mount('p1');
    const res = r.enqueue(P('p1', 'headline', true));
    expect(res).toEqual({ ok: false, reason: 'value_not_allowed' });
    scheduler.flush();
    expect(slotText(container, 0, 'headline')).toBe('');
  });
});

describe('U11 O2 off_allowlist_field_rejected', () => {
  it('innerHTML field cast past types: rejected, DOM byte-identical, counted', () => {
    const { r, container, scheduler } = setup();
    r.mount('p1');
    const before = container.innerHTML;
    const res = r.enqueue({ projectId: 'p1', rev: 1, field: 'innerHTML', value: '<b>x</b>' } as unknown as CapsulePatch);
    expect(res).toEqual({ ok: false, reason: 'field_not_allowed' });
    scheduler.flush();
    expect(container.innerHTML).toBe(before);
    expect(r.counters().rejects.field_not_allowed).toBe(1);
    expect(r.pendingCount()).toBe(0);
    expect(scheduler.request).not.toHaveBeenCalled();
  });
  it.each(['outerHTML', 'style', 'onclick', 'href', '__proto__', 'constructor'])('field %s rejected', (f) => {
    const { r } = setup();
    r.mount('p1');
    const res = r.enqueue({ projectId: 'p1', rev: 1, field: f, value: 'x' } as unknown as CapsulePatch);
    expect(res).toEqual({ ok: false, reason: 'field_not_allowed' });
  });
});

describe('U11 B4 validation order and reasons', () => {
  it('field checked before project', () => {
    const { r } = setup();
    const res = r.enqueue({ projectId: 'nope', rev: 1, field: 'bogus', value: 'x' } as unknown as CapsulePatch);
    expect(res).toEqual({ ok: false, reason: 'field_not_allowed' });
  });
  it('keyed patch to unknown capsule rejected, DOM and queue untouched', () => {
    const { r, container, scheduler } = setup();
    r.mount('p1');
    const before = container.innerHTML;
    expect(r.enqueue(P('ghost', 'headline', 'x'))).toEqual({ ok: false, reason: 'unknown_project' });
    scheduler.flush();
    expect(container.innerHTML).toBe(before);
    expect(r.pendingCount()).toBe(0);
    expect(r.counters().rejects.unknown_project).toBe(1);
  });
  it('project checked before rev', () => {
    const { r } = setup();
    expect(r.enqueue(P('ghost', 'headline', 'x', -1))).toEqual({ ok: false, reason: 'unknown_project' });
  });
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rev %s -> bad_rev', (rev) => {
    const { r } = setup();
    r.mount('p1');
    expect(r.enqueue(P('p1', 'headline', 'x', rev))).toEqual({ ok: false, reason: 'bad_rev' });
    expect(r.counters().rejects.bad_rev).toBe(1);
  });
  it('O6 stale_rev_rejected: applied 7 then 6 -> text unchanged', () => {
    const { r, container, scheduler } = setup();
    r.mount('p1');
    r.enqueue(P('p1', 'headline', 'seven', 7));
    scheduler.flush();
    expect(r.enqueue(P('p1', 'headline', 'six', 6))).toEqual({ ok: false, reason: 'stale_rev' });
    scheduler.flush();
    expect(slotText(container, 0, 'headline')).toBe('seven');
    expect(r.counters().rejects.stale_rev).toBe(1);
  });
  it('equal rev is accepted (rev >= last applied)', () => {
    const { r, container, scheduler } = setup();
    r.mount('p1');
    r.enqueue(P('p1', 'headline', 'a', 7)); scheduler.flush();
    expect(r.enqueue(P('p1', 'headline', 'b', 7))).toEqual({ ok: true });
    scheduler.flush();
    expect(slotText(container, 0, 'headline')).toBe('b');
  });
  it('stale check precedes too_long', () => {
    const { r, scheduler } = setup();
    r.mount('p1');
    r.enqueue(P('p1', 'headline', 'a', 7)); scheduler.flush();
    expect(r.enqueue(P('p1', 'headline', 'x'.repeat(500), 3))).toEqual({ ok: false, reason: 'stale_rev' });
  });
  it('headline 120 ok, 121 too_long; summary 600 ok, 601 too_long', () => {
    const { r, container, scheduler } = setup();
    r.mount('p1');
    expect(r.enqueue(P('p1', 'headline', 'h'.repeat(120)))).toEqual({ ok: true });
    expect(r.enqueue(P('p1', 'headline', 'h'.repeat(121), 2))).toEqual({ ok: false, reason: 'too_long' });
    expect(r.enqueue(P('p1', 'summary', 's'.repeat(600)))).toEqual({ ok: true });
    expect(r.enqueue(P('p1', 'summary', 's'.repeat(601), 2))).toEqual({ ok: false, reason: 'too_long' });
    scheduler.flush();
    expect(slotText(container, 0, 'headline').length).toBe(120);
    expect(r.counters().rejects.too_long).toBe(2);
  });
  it('rejection keeps previously painted value', () => {
    const { r, container, scheduler } = setup();
    r.mount('p1');
    r.enqueue(P('p1', 'headline', 'keep', 1)); scheduler.flush();
    r.enqueue(P('p1', 'headline', 'x'.repeat(121), 2));
    scheduler.flush();
    expect(slotText(container, 0, 'headline')).toBe('keep');
  });
});

describe('U11 B3/B9 write paths, O3 class value not in map', () => {
  it('O3: injection-shaped status rejected; no onmouseover anywhere', () => {
    const { r, container, scheduler } = setup();
    r.mount('p1');
    expect(r.enqueue(P('p1', 'status', 'x" onmouseover="a'))).toEqual({ ok: false, reason: 'value_not_allowed' });
    scheduler.flush();
    expect(container.innerHTML).not.toContain('onmouseover');
    expect(r.counters().rejects.value_not_allowed).toBe(1);
    expect(r.pendingCount()).toBe(0);
  });
  it('class write uses the classMap token and swaps tokens on change', () => {
    const { r, container, scheduler } = setup();
    r.mount('p1');
    r.enqueue(P('p1', 'status', 'ok', 1)); scheduler.flush();
    expect(slot(container, 0, 'status').classList.contains('s-ok')).toBe(true);
    expect(slot(container, 0, 'status').classList.contains('ok')).toBe(false);
    r.enqueue(P('p1', 'status', 'warn', 2)); scheduler.flush();
    expect(slot(container, 0, 'status').classList.contains('s-warn')).toBe(true);
    expect(slot(container, 0, 'status').classList.contains('s-ok')).toBe(false);
  });
  it('attr write uses only the allowed attribute; no style/href/src/on* ever appear', () => {
    const { r, container, scheduler } = setup();
    r.mount('p1');
    r.enqueue(P('p1', 'inference_source', 'ON_DEVICE'));
    r.enqueue(P('p1', 'headline', 'h'));
    r.enqueue(P('p1', 'status', 'ok'));
    scheduler.flush();
    expect(slot(container, 0, 'source').getAttribute('data-source')).toBe('ON_DEVICE');
    const forbidden = /^(style|href|src|on.*)$/i;
    for (const el of Array.from(container.querySelectorAll('*'))) {
      for (const a of Array.from(el.attributes)) expect(a.name).not.toMatch(forbidden);
    }
  });
  it('never touches innerHTML/outerHTML/insertAdjacentHTML while painting', () => {
    const { r, container, scheduler } = setup();
    const inner = vi.fn(); const outer = vi.fn(); const adj = vi.spyOn(Element.prototype, 'insertAdjacentHTML');
    const di = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!;
    const dout = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML')!;
    Object.defineProperty(Element.prototype, 'innerHTML', { ...di, set(v: string) { inner(); di.set!.call(this, v); } });
    Object.defineProperty(Element.prototype, 'outerHTML', { ...dout, set(v: string) { outer(); dout.set!.call(this, v); } });
    try {
      r.mount('p1');
      r.enqueue(P('p1', 'headline', '<b>x</b>'));
      r.enqueue(P('p1', 'status', 'ok'));
      scheduler.flush();
      r.unmount('p1');
      expect(slotText(container, 0 as never, 'headline' as never)).toBe('');
    } catch { /* slot lookup after unmount throws: expected */ } finally {
      Object.defineProperty(Element.prototype, 'innerHTML', di);
      Object.defineProperty(Element.prototype, 'outerHTML', dout);
    }
    expect(r.counters().writes).toBe(2);
    expect(inner).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
    expect(adj).not.toHaveBeenCalled();
  });
  it('B9 stale=true -> class is-stale + data-stale="true"; false clears', () => {
    const { r, container, scheduler } = setup();
    r.mount('p1');
    r.enqueue(P('p1', 'stale', true, 1)); scheduler.flush();
    expect(container.querySelector('.is-stale')).not.toBeNull();
    expect(container.querySelector('[data-stale="true"]')).not.toBeNull();
    r.enqueue(P('p1', 'stale', false, 2)); scheduler.flush();
    expect(container.querySelector('.is-stale')).toBeNull();
    expect(container.querySelector('[data-stale="true"]')).toBeNull();
  });
});

describe('U11 B5-B8 batching', () => {
  it('O9 no_sync_write: DOM unchanged until flush; request called exactly once', () => {
    const { r, container, scheduler } = setup();
    r.mount('p1');
    const before = container.innerHTML;
    expect(r.enqueue(P('p1', 'headline', 'a'))).toEqual({ ok: true });
    expect(r.enqueue(P('p1', 'summary', 'b'))).toEqual({ ok: true });
    expect(container.innerHTML).toBe(before);
    expect(scheduler.request).toHaveBeenCalledTimes(1);
    expect(r.pendingCount()).toBe(2);
    scheduler.flush();
    expect(slotText(container, 0, 'headline')).toBe('a');
    expect(slotText(container, 0, 'summary')).toBe('b');
    expect(r.pendingCount()).toBe(0);
  });
  it('after a drained frame, the next enqueue requests a new frame', () => {
    const { r, scheduler } = setup();
    r.mount('p1');
    r.enqueue(P('p1', 'headline', 'a', 1)); scheduler.flush();
    r.enqueue(P('p1', 'headline', 'b', 2));
    expect(scheduler.request).toHaveBeenCalledTimes(2);
  });
  it('O5 coalesce_latest_rev: 3 revs -> 1 write, rev 7 text', () => {
    const { r, container, scheduler } = setup();
    r.mount('p1');
    r.enqueue(P('p1', 'headline', 'r5', 5));
    r.enqueue(P('p1', 'headline', 'r6', 6));
    r.enqueue(P('p1', 'headline', 'r7', 7));
    expect(r.pendingCount()).toBe(1);
    scheduler.flush();
    expect(r.counters().writes).toBe(1);
    expect(slotText(container, 0, 'headline')).toBe('r7');
  });
  it('O4 max_patches_per_frame_8: 8 / 16 / 20 writes, remainder carried, FIFO', () => {
    const { r, container, scheduler, caps } = setup({ max: 8 });
    mountN(r, 12);
    for (let i = 0; i < 12; i++) r.enqueue(P(`p${i}`, 'headline', `h${i}`));
    for (let i = 0; i < 8; i++) r.enqueue(P(`p${i}`, 'summary', `s${i}`));
    expect(r.pendingCount()).toBe(20);
    expect(scheduler.request).toHaveBeenCalledTimes(1);

    scheduler.flush();
    expect(r.counters().writes).toBe(8);
    expect(r.pendingCount()).toBe(12);
    expect(slotText(container, 7, 'headline')).toBe('h7');   // FIFO: first 8 enqueued applied
    expect(slotText(container, 8, 'headline')).toBe('');
    expect(caps.endFrame).toHaveBeenLastCalledWith(8, 12);
    expect(scheduler.waiting).toBe(1);                        // carry requested automatically

    scheduler.flush();
    expect(r.counters().writes).toBe(16);
    expect(r.pendingCount()).toBe(4);
    expect(caps.endFrame).toHaveBeenLastCalledWith(8, 4);

    scheduler.flush();
    expect(r.counters().writes).toBe(20);
    expect(r.pendingCount()).toBe(0);
    expect(caps.endFrame).toHaveBeenLastCalledWith(4, 0);
    expect(scheduler.waiting).toBe(0);
    expect(caps.beginFrame).toHaveBeenCalledTimes(3);
  });
  it('tick reads the cap per frame (T3 = 1 write per frame)', () => {
    const { r, scheduler, caps } = setup();
    caps.maxPatchesThisFrame.mockReturnValue(1);
    mountN(r, 3);
    for (let i = 0; i < 3; i++) r.enqueue(P(`p${i}`, 'headline', 'x'));
    scheduler.flush(); expect(r.counters().writes).toBe(1);
    scheduler.flush(); expect(r.counters().writes).toBe(2);
    scheduler.flush(); expect(r.counters().writes).toBe(3);
  });
  it('O8 budget_stops_tick: +1000us per clock read, budget 4ms -> 1..4 applied, rest deferred', () => {
    const { r, scheduler, caps } = setup({ max: 8, budgetMs: 4, step: 1000 });
    mountN(r, 10);
    for (let i = 0; i < 10; i++) r.enqueue(P(`p${i}`, 'headline', 'x'));
    scheduler.flush();
    const applied = r.counters().writes;
    expect(applied).toBeGreaterThanOrEqual(1);
    expect(applied).toBeLessThanOrEqual(4);
    expect(r.pendingCount()).toBe(10 - applied);
    expect(caps.endFrame).toHaveBeenLastCalledWith(applied, 10 - applied);
    expect(scheduler.waiting).toBe(1);
  });
  it('at least one write per tick even when budget is 0', () => {
    const { r, scheduler } = setup({ max: 8, budgetMs: 0, step: 1000 });
    mountN(r, 3);
    for (let i = 0; i < 3; i++) r.enqueue(P(`p${i}`, 'headline', 'x'));
    scheduler.flush();
    expect(r.counters().writes).toBe(1);
    expect(r.pendingCount()).toBe(2);
  });
  it('queue bounded by mounted x 8 fields under re-enqueue storms', () => {
    const { r } = setup();
    mountN(r, 2);
    const fields: PatchField[] = ['status', 'attention', 'headline', 'summary', 'next_action', 'inference_source', 'stale', 'updated_at'];
    for (let rev = 1; rev <= 50; rev++) for (const f of fields) for (const id of ['p0', 'p1']) {
      r.enqueue(P(id, f, f === 'stale' ? true : f === 'status' ? 'ok' : f === 'attention' ? 'low' : 'v', rev));
    }
    expect(r.pendingCount()).toBeLessThanOrEqual(16);
    expect(r.pendingCount()).toBe(16);
  });
});
