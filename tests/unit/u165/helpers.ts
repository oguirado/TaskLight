import { afterEach, beforeEach, expect, vi } from "vitest";
import { mountWall, type WallMountVM, type WallViewId } from "../../../src/views";
import { NOW, freeze } from "../u136/fixtures";
import { activate, button, commitBeat, detail, one, planFixture, planVM, press } from "../u150/helpers";

export { activate, button, detail, one, press };

const disposers: Array<() => void> = [];
const restorers: Array<() => void> = [];
const network = vi.fn((): never => { throw new Error("Network access is forbidden in this oracle"); });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  localStorage.clear();
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  network.mockClear();
  for (const name of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]) vi.stubGlobal(name, network);
});

afterEach(() => {
  try {
    for (const dispose of disposers.splice(0).reverse()) dispose();
    expect(network, "The scroll oracle must remain local").not.toHaveBeenCalled();
  } finally {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    for (const restore of restorers.splice(0).reverse()) restore();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    document.documentElement.scrollTop = 0;
    localStorage.clear();
    vi.useRealTimers();
  }
});

/** Browser seams only; the renderer, navigation and reducer remain production code. */
export function property(target: object, key: PropertyKey, value: unknown): void {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  restorers.push(() => {
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  });
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
}

export const ROOTS = ["scrollingElement", "null", "undefined"] as const;
export type RootMode = typeof ROOTS[number];

export function scrollingRoot(mode: RootMode): HTMLElement {
  const root = mode === "scrollingElement" ? document.body : document.documentElement;
  property(document, "scrollingElement", mode === "scrollingElement" ? root : mode === "null" ? null : undefined);
  expect(document.scrollingElement ?? document.documentElement).toBe(root);
  return root;
}

export function mountFixture(view: WallViewId = "wall") {
  let projection = planFixture();
  let current: WallMountVM = { ...planVM(projection), view };
  const host = document.createElement("div");
  document.body.append(host);
  const handle = mountWall(host, freeze(current), {
    onView(nextView) {
      current = { ...current, view: nextView };
      handle.update(freeze(current));
    },
  });
  disposers.push(() => handle.destroy());
  let sequence = 0;
  return {
    host,
    navigate(nextView: WallViewId) {
      current = { ...current, view: nextView };
      handle.update(freeze(current));
    },
    refresh() {
      current = { ...current, now: "Refreshed snapshot" };
      handle.update(freeze(current));
    },
    beat() {
      projection = commitBeat(projection, ++sequence);
      current = { ...planVM(projection), view: current.view };
      handle.update(freeze(current));
    },
  };
}

export const INPUTS = ["mouse", "Enter", "Space"] as const;
export type Input = typeof INPUTS[number];

export function open(trigger: HTMLElement, input: Input): void {
  if (input === "mouse") trigger.click();
  else activate(trigger, input === "Space" ? " " : "Enter");
}

export function motionPreference(reduced: boolean): void {
  vi.stubGlobal("matchMedia", vi.fn((query: string): MediaQueryList => ({
    matches: reduced && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  })));
}

export function watchAlignment() {
  const calls: Array<{
    node: Element;
    connected: boolean;
    active: Element | null;
    options: boolean | ScrollIntoViewOptions | undefined;
  }> = [];
  const scroll = vi.fn(function (this: Element, options?: boolean | ScrollIntoViewOptions) {
    calls.push({ node: this, connected: this.isConnected, active: document.activeElement, options });
  });
  property(Element.prototype, "scrollIntoView", scroll);
  return { scroll, calls };
}
