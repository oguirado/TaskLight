import { vi } from 'vitest';
import {
  createRenderer,
  type CapsuleRenderer, type FieldAllowlist, type FrameCaps, type RendererOptions, type TemplateSpec,
} from '../../../src/render';

export const TEMPLATE: TemplateSpec = {
  templateHash: 'h-test',
  root: {
    tag: 'div', slot: 'root', staticClass: ['capsule'],
    children: [
      { tag: 'h3', slot: 'headline' },
      { tag: 'p', slot: 'summary' },
      { tag: 'span', slot: 'status' },
      { tag: 'span', slot: 'attention' },
      { tag: 'span', slot: 'next_action' },
      { tag: 'span', slot: 'source' },
      { tag: 'time', slot: 'updated_at' },
    ],
  },
};

export const ALLOWLIST: FieldAllowlist = {
  status: { kind: 'class', slot: 'status', classMap: { ok: 's-ok', warn: 's-warn' } },
  attention: { kind: 'class', slot: 'attention', classMap: { low: 'a-low', high: 'a-high' } },
  headline: { kind: 'text', slot: 'headline', maxChars: 120 },
  summary: { kind: 'text', slot: 'summary', maxChars: 600 },
  next_action: { kind: 'text', slot: 'next_action', maxChars: 200 },
  inference_source: { kind: 'attr', slot: 'source', attr: 'data-source' },
  stale: { kind: 'class', slot: 'root', classMap: { true: 'is-stale' } },
  updated_at: { kind: 'text', slot: 'updated_at', maxChars: 40 },
};

export class FakeClock {
  t = 0;
  step = 0; // auto-advance per nowUs() call (µs)
  nowUs(): number { const v = this.t; this.t += this.step; return v; }
}

export class FakeScheduler {
  queue: Array<() => void> = [];
  request = vi.fn((cb: () => void) => { this.queue.push(cb); });
  /** runs callbacks queued so far; callbacks that re-request land in the next flush */
  flush(): number {
    const q = this.queue; this.queue = [];
    q.forEach((cb) => cb());
    return q.length;
  }
  get waiting(): number { return this.queue.length; }
}

export function makeCaps(o: { max?: number; budgetMs?: number; effects?: boolean } = {}) {
  const caps = {
    maxPatchesThisFrame: vi.fn(() => o.max ?? 8),
    frameJsBudgetMs: vi.fn(() => o.budgetMs ?? 4),
    effectsEnabled: vi.fn(() => o.effects ?? true),
    beginFrame: vi.fn(),
    endFrame: vi.fn(),
  };
  return caps satisfies FrameCaps;
}

export function setup(o: Partial<RendererOptions> & { max?: number; budgetMs?: number; step?: number } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const clock = new FakeClock();
  clock.step = o.step ?? 0;
  const scheduler = new FakeScheduler();
  const caps = makeCaps({ max: o.max ?? 8, budgetMs: o.budgetMs ?? 4 });
  const r: CapsuleRenderer = createRenderer({
    container, template: TEMPLATE, allowlist: ALLOWLIST, poolCapacity: 16,
    caps, scheduler, clock, ...o,
  });
  return { container, clock, scheduler, caps, r };
}

/** i-th mounted capsule's slot node (mount order == DOM order) */
export function slot(container: HTMLElement, i: number, name: string): Element {
  const el = container.querySelectorAll(`[data-slot="${name}"]`)[i];
  if (!el) throw new Error(`slot ${name}[${i}] not found`);
  return el;
}
export function slotText(container: HTMLElement, i: number, name: string): string {
  return slot(container, i, name).textContent ?? '';
}
export function mountN(r: CapsuleRenderer, n: number): string[] {
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  ids.forEach((id) => r.mount(id));
  return ids;
}
