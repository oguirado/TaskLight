import { vi } from "vitest";
import type { CapsulePatch, CapsuleRenderer } from "../../../src/render/types";
import type {
  CapsuleCardView, Clock, DevicePort, MotionPort, ThemePort, WallInputs, UiOptions,
} from "../../../src/ui/types";

export const D = (o: Partial<WallInputs> = {}): WallInputs => ({
  host: { kind: "ready" }, device: { state: "ready" }, availability: "available",
  online: true, killSwitchCloud: false, ...o,
});
export const card = (id: string, o: Partial<CapsuleCardView> = {}): CapsuleCardView => ({
  projectId: id, lens_id: "dev", status: "running", attention: "none", tier: "standard", stale: false, ...o,
});
export const ids = (n: number, p = "p") => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);

export class FakeClock implements Clock {
  t = 0;
  private seq = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  nowMs(): number { return this.t; }
  setTimer(ms: number, fn: () => void): () => void {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + ms, fn });
    return () => { this.timers = this.timers.filter((x) => x.id !== id); };
  }
  get pending(): number { return this.timers.length; }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x.id !== due.id);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = end;
  }
}

class Flag {
  private cbs = new Set<(v: boolean) => void>();
  constructor(public value: boolean) {}
  get listeners(): number { return this.cbs.size; }
  sub(cb: (v: boolean) => void): () => void { this.cbs.add(cb); return () => { this.cbs.delete(cb); }; }
  set(v: boolean): void { this.value = v; [...this.cbs].forEach((c) => c(v)); }
}
export class FakeMotion extends Flag implements MotionPort {
  reduced(): boolean { return this.value; }
  onChange(cb: (r: boolean) => void): () => void { return this.sub(cb); }
}
export class FakeTheme extends Flag implements ThemePort {
  dark(): boolean { return this.value; }
  onChange(cb: (d: boolean) => void): () => void { return this.sub(cb); }
}

/** Card node as the U11 pool would hand it out (capsuleTemplate() slot names). */
export function makeCard(id: string): HTMLElement {
  const n = document.createElement("div");
  n.className = "capsule"; n.setAttribute("data-slot", "root"); n.setAttribute("data-id", id);
  for (const s of ["headline", "summary", "status", "attention", "next_action", "source", "badge", "stale_badge"]) {
    const c = document.createElement("span"); c.setAttribute("data-slot", s); n.appendChild(c);
  }
  for (let i = 1; i <= 5; i++) {
    const r = document.createElement("div"); r.setAttribute("data-slot", `step_${i}`); n.appendChild(r);
  }
  return n;
}
export const slot = (n: Element, s: string): HTMLElement => n.querySelector(`[data-slot="${s}"]`) as HTMLElement;
export const isHidden = (el: Element | null): boolean =>
  el === null || el.closest("[hidden], .is-hidden") !== null;

/** A3-U20: jsdom's Event.isTrusted is non-configurable, so trust is injected via UiOptions.isTrusted. */
const trusted_events = new WeakSet<Event>();
export const trustPredicate = (ev: Event): boolean => trusted_events.has(ev);

export function click(el: Element, trusted: boolean): void {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  if (trusted) trusted_events.add(ev);
  el.dispatchEvent(ev);
}
export function key(el: Element, k: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
}

export function makeHarness(init: { dark?: boolean; reduced?: boolean } = {}) {
  document.body.replaceChildren();
  const root = document.createElement("div");
  const container = document.createElement("div");
  container.setAttribute("data-wall-container", "");
  root.appendChild(container);
  document.body.appendChild(root);
  const clock = new FakeClock();
  const motion = new FakeMotion(init.reduced ?? false);
  const theme = new FakeTheme(init.dark ?? false);
  const nodes = new Map<string, HTMLElement>();
  const patches: CapsulePatch[] = [];
  const renderer = {
    mount: vi.fn((id: string) => { const n = makeCard(id); container.appendChild(n); nodes.set(id, n); return { ok: true as const }; }),
    unmount: vi.fn((id: string) => { nodes.get(id)?.remove(); nodes.delete(id); }),
    enqueue: vi.fn((p: CapsulePatch) => { patches.push(p); return { ok: true as const }; }),
    pendingCount: vi.fn(() => 0),
    counters: vi.fn(() => ({ writes: 0, deferred: 0, poolExhausted: 0, rejects: { unknown_project: 0, field_not_allowed: 0, value_not_allowed: 0, too_long: 0, stale_rev: 0, bad_rev: 0 } })),
  } as unknown as CapsuleRenderer & { mount: ReturnType<typeof vi.fn>; unmount: ReturnType<typeof vi.fn>; enqueue: ReturnType<typeof vi.fn> };
  let release: () => void = () => {};
  const device = { activate: vi.fn((_t: boolean) => new Promise<void>((r) => { release = r; })) } satisfies DevicePort;
  const onOpen = vi.fn();
  const onOpenTemplateEditor = vi.fn();
  const opts: UiOptions = {
    root, renderer, locator: { nodeOf: (id) => nodes.get(id) ?? null },
    device, motion, theme, clock, onOpen, onOpenTemplateEditor,
    isTrusted: trustPredicate,
  };
  return { root, container, clock, motion, theme, nodes, patches, renderer, device, onOpen, onOpenTemplateEditor, opts,
    resolveActivation: () => release(),
    banner: () => root.querySelector('[data-role="wall-banner"]') as HTMLElement | null,
    badge: () => root.querySelector('[data-role="wall-badge"]') as HTMLElement | null,
    live: () => root.querySelector('[aria-live]') as HTMLElement | null,
    cta: () => root.querySelector('[data-role="enable-cta"]') as HTMLElement | null,
  };
}
export type Harness = ReturnType<typeof makeHarness>;
