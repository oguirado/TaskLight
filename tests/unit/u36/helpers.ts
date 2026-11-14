import { vi, type Mock } from "vitest";
import { mountWall } from "../../../src/views";
import type { ViewId, WallHandle, WallHandlers, WallVM } from "../../../src/views/types";
import { FIXTURE } from "./fixture";

export interface Spies {
  onView: Mock<(v: ViewId) => void>;
  onWorkspace: Mock<(id: string) => void>;
  onArchiveScope: Mock<(s: "workspace" | "all") => void>;
  onRestore: Mock<(id: string) => void>;
  onNewWorkspace: Mock<() => void>;
  onThemeToggle: Mock<() => void>;
}

export const makeSpies = (): Spies => ({
  onView: vi.fn<(v: ViewId) => void>(),
  onWorkspace: vi.fn<(id: string) => void>(),
  onArchiveScope: vi.fn<(s: "workspace" | "all") => void>(),
  onRestore: vi.fn<(id: string) => void>(),
  onNewWorkspace: vi.fn<() => void>(),
  onThemeToggle: vi.fn<() => void>(),
});

export const totalCalls = (s: Spies): number =>
  s.onView.mock.calls.length + s.onWorkspace.mock.calls.length + s.onArchiveScope.mock.calls.length +
  s.onRestore.mock.calls.length + s.onNewWorkspace.mock.calls.length + s.onThemeToggle.mock.calls.length;

const live: { host: HTMLElement; handle: WallHandle }[] = [];

export function mount(v: WallVM = FIXTURE, handlers?: WallHandlers, doc: Document = document): { host: HTMLElement; handle: WallHandle } {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const handle = mountWall(host, v, handlers);
  live.push({ host, handle });
  return { host, handle };
}

export function mountSpied(v: WallVM = FIXTURE): { host: HTMLElement; handle: WallHandle; spies: Spies } {
  const spies = makeSpies();
  return { ...mount(v, spies), spies };
}

export function cleanup(): void {
  for (const l of live.splice(0)) {
    try { l.handle.destroy(); } catch { /* stub */ }
    l.host.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
}

/* ---- DOM helpers (strict-safe) ---------------------------------------------------------- */

export function q<T extends Element = HTMLElement>(root: ParentNode, sel: string): T {
  const e = root.querySelector<T>(sel);
  if (!e) throw new Error(`missing element: ${sel}`);
  return e;
}
export const qa = <T extends Element = HTMLElement>(root: ParentNode, sel: string): T[] => Array.from(root.querySelectorAll<T>(sel));
export const nth = <T>(a: readonly T[], i: number): T => {
  const x = a[i];
  if (x === undefined) throw new Error(`missing index ${i} of ${a.length}`);
  return x;
};
export const txt = (e: Element | null | undefined): string => (e?.textContent ?? "").trim();
export const txts = (root: ParentNode, sel: string): string[] => qa(root, sel).map(txt);
export const attr = (e: Element, n: string): string | null => e.getAttribute(n);

export const click = (e: Element): void => { e.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); };

export const key = (target: EventTarget, k: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
};

export const cards = (host: ParentNode): HTMLElement[] => qa(host, "article.task");
export const cardIds = (host: ParentNode): string[] => cards(host).map((c) => c.id);

/** Tag.class signature of the whole subtree, used to prove that text never changes structure. */
export const signature = (root: ParentNode): string =>
  qa<Element>(root, "*").map((e) => `${e.tagName.toLowerCase()}.${e.getAttribute("class") ?? ""}`).join("|");

export const htmlAttrs = (): [string, string][] => Array.from(document.documentElement.attributes).map((a) => [a.name, a.value]);

export const ALL_VIEWS: readonly ViewId[] = ["wall", "agenda", "diary", "archive"];
