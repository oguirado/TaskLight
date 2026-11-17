import { afterEach, beforeEach, expect, vi } from "vitest";
import { mountWall, type WallMountHandle, type WallMountHandlers, type WallMountVM, type WallViewId } from "../../../src/views";
import { deriveSwarmViewModel } from "../../../src/app/swarm_vm";

// A-V1: Agents comes first; numeric shortcuts keep their original destinations.
export const DESTINATIONS = [
  ["swarm", "Agents", "6"],
  ["wall", "Wall", "1"], ["agenda", "Agenda", "2"], ["diary", "Diary", "3"],
  ["archive", "Archive", "4"], ["memory", "Memory", "5"],
] as const;

const handles: WallMountHandle[] = [];
const network = vi.fn(() => { throw new Error("U152 must not use the network"); });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-02T12:00:00Z"));
  network.mockClear();
  vi.stubGlobal("fetch", network);
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.destroy();
  document.body.replaceChildren();
  document.querySelectorAll("style[data-u152]").forEach(style => style.remove());
  try {
    expect(network, "navigation and status rendering must be local").not.toHaveBeenCalled();
  } finally {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

export function fixture(overrides: Partial<WallMountVM> = {}): WallMountVM {
  return {
    now: "12:00", model: { state: "ready", label: "Gemini Nano ready" }, network: "online",
    workspaces: [{ id: "private-room", name: "Private room", lens: "dev", accent: "sky" }],
    workspace: "private-room", view: "wall", archiveScope: "workspace", tasks: [], agenda: [], archive: [],
    swarm: deriveSwarmViewModel({ room: "private-room", projection: null, events: [], nowMs: Date.now(), connected: true }),
    availability: "Private room · cloud disabled", ...overrides,
  };
}

/** Exercise the real renderer with its existing controlled-update contract. */
export function mount(overrides: Partial<WallMountVM> = {}, handlers: WallMountHandlers = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  let current = fixture(overrides);
  let handle: WallMountHandle | undefined;
  const onView = vi.fn((view: WallViewId) => {
    current = { ...current, view };
    handle?.update(current);
    handlers.onView?.(view);
  });
  handle = mountWall(host, current, { ...handlers, onView });
  handles.push(handle);
  const mounted = handle;
  return { host, onView, update(patch: Partial<WallMountVM>) {
    current = { ...current, ...patch };
    mounted.update(current);
  } };
}

export function visible(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (node.hidden || node.getAttribute("aria-hidden") === "true" || style.display === "none"
      || style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (node instanceof HTMLDetailsElement && !node.open) {
      const summary = node.querySelector("summary");
      if (element !== node && !summary?.contains(element)) return false;
    }
  }
  return true;
}

export function text(element: Element): string {
  const visit = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node instanceof HTMLElement && !visible(node)) return "";
    return [...node.childNodes].map(visit).join("");
  };
  return visit(element).replace(/\s+/g, " ").trim();
}

/** Sufficient for these native controls: labelledby, aria-label, visible content. */
export function name(element: HTMLElement): string {
  const ids = element.getAttribute("aria-labelledby")?.trim().split(/\s+/).filter(Boolean);
  if (ids?.length) return ids.map(id => element.ownerDocument.getElementById(id)?.textContent ?? "").join(" ").trim();
  return element.getAttribute("aria-label")?.trim() || text(element);
}

// Exclude content actions such as "Show all in Swarm" from the sidebar order.
export const navButtons = (root: ParentNode): HTMLButtonElement[] => [...root.querySelectorAll<HTMLButtonElement>("button[data-nav]")]
  .filter(button => button.hasAttribute("aria-keyshortcuts") || button.closest('nav,[role="navigation"],[role="tablist"]'));

export function nav(root: ParentNode, view: WallViewId): HTMLButtonElement {
  const button = navButtons(root).find(item => item.dataset.nav === view);
  expect(button, `navigation must expose ${view}`).toBeDefined();
  return button!;
}

export function key(target: EventTarget, value: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
}

export function assertFocusContract(root: HTMLElement, view: WallViewId): void {
  const selected = nav(root, view);
  expect(navButtons(root).filter(button => button.getAttribute("aria-current") === "page")).toEqual([selected]);
  expect(selected.disabled).toBe(false);
  expect(visible(selected)).toBe(true);
  selected.focus();
  expect(document.activeElement).toBe(selected);
  if (selected.getAttribute("role") === "tab") {
    const group = selected.closest('[role="tablist"]');
    expect(group, "a tab must belong to a tablist").not.toBeNull();
    const tabs = [...group!.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(selected.getAttribute("aria-selected")).toBe("true");
    expect(selected.tabIndex, "the selected tab must be the tab stop").toBe(0);
    expect(tabs.filter(tab => tab.tabIndex >= 0).map(tab => tab.dataset.nav), "roving focus must leave only the selected tab in the Tab sequence").toEqual([view]);
    for (const tab of tabs.filter(tab => tab !== selected)) {
      expect(tab.tabIndex).toBe(-1);
      expect(tab.getAttribute("aria-selected")).toBe("false");
    }
  } else {
    expect(selected.tabIndex).toBeGreaterThanOrEqual(0);
    for (const button of navButtons(root).filter(button => button.getAttribute("role") !== "tab")) {
      expect(button.getAttribute("aria-selected"), "plain navigation must not retain partial tab semantics").toBeNull();
      expect(button.closest('[role="tablist"]')).toBeNull();
    }
  }
}

export function assertPanelContract(root: HTMLElement): void {
  const buttons = navButtons(root);
  const tabs = buttons.filter(button => button.getAttribute("role") === "tab");
  if (!tabs.length) {
    expect(root.querySelector('[role="tablist"]'), "plain buttons must remove the abandoned tablist role").toBeNull();
    for (const button of buttons) expect(button.getAttribute("aria-selected")).toBeNull();
    return;
  }
  for (const tab of tabs) {
    expect(tab.id, "every tab needs an id for its panel's label").not.toBe("");
    expect([...document.querySelectorAll("[id]")].filter(node => node.id === tab.id)).toHaveLength(1);
    const ids = tab.getAttribute("aria-controls")?.trim().split(/\s+/).filter(Boolean) ?? [];
    expect(ids, "every tab must control a real panel").toHaveLength(1);
    const panel = document.getElementById(ids[0]!);
    expect(panel, "aria-controls must resolve inside this wall").not.toBeNull();
    expect(root.contains(panel)).toBe(true);
    expect([...document.querySelectorAll("[id]")].filter(node => node.id === panel!.id)).toHaveLength(1);
    expect(panel!.getAttribute("role")).toBe("tabpanel");
    if (tab.getAttribute("aria-selected") === "true") {
      expect(visible(panel!)).toBe(true);
      expect(panel!.getAttribute("aria-labelledby")?.split(/\s+/)).toContain(tab.id);
    }
  }
}

export function assertSingleModels(root: HTMLElement): HTMLButtonElement {
  const openers = [...root.querySelectorAll<HTMLButtonElement>("button")].filter(button =>
    button.getAttribute("aria-controls")?.split(/\s+/).includes("model-sheet") || /^Models(?:\b|:)/i.test(name(button)));
  expect(openers, "there must be exactly one Models opener, including hidden copies").toHaveLength(1);
  expect(openers[0]!.disabled).toBe(false);
  expect(name(openers[0]!)).toMatch(/^Models\b/i);
  return openers[0]!;
}
