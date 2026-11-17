import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewId } from "../../../src/views/types";
import { vm } from "./fixture";
import { cleanup, key, mount, mountSpied, totalCalls } from "./helpers";

afterEach(cleanup);

const KEYS: [string, ViewId][] = [["1", "wall"], ["2", "agenda"], ["3", "diary"], ["4", "archive"]];

describe("B12 keyboard", () => {
  it.each(KEYS)("key %s on the document calls onView(%s) once", (k, view) => {
    const { spies } = mountSpied();
    key(document.body, k);
    expect(spies.onView.mock.calls).toEqual([[view]]);
  });

  // A-U152: complete vertical tabs also retain the legacy Left/Right shortcuts.
  it.each([
    ["ArrowRight", "archive"], ["ArrowDown", "archive"], ["ArrowLeft", "agenda"],
    ["ArrowUp", "agenda"], ["Home", "wall"], ["End", "memory"],
  ] as const)("tab %s selects and focuses %s", (value, view) => {
    const { host, handle, spies } = mountSpied(vm({ view: "diary" }));
    const button = host.querySelector<HTMLButtonElement>('button[data-nav="diary"]')!;
    button.focus();
    expect(key(button, value).defaultPrevented).toBe(true);
    expect(spies.onView).toHaveBeenCalledExactlyOnceWith(view);
    handle.update(vm({ view }));
    const selected = host.querySelector<HTMLButtonElement>(`button[data-nav="${view}"]`)!;
    expect(document.activeElement).toBe(selected);
    expect(selected.tabIndex).toBe(0);
    expect(host.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
    expect(totalCalls(spies)).toBe(1);
  });

  // A-U152: the panel supplies a keyboard route into the view through live refreshes.
  it("keeps focus on the selected panel across a background refresh", () => {
    const { host, handle } = mountSpied();
    const panel = host.querySelector<HTMLElement>('.view[role="tabpanel"]')!;
    expect(panel.tabIndex).toBe(0);
    panel.focus();
    handle.update(vm({ now: "12:34" }));
    expect(document.activeElement).toBe(document.getElementById(panel.id));
    expect((document.activeElement as HTMLElement).hidden).toBe(false);
  });

  // A-U152: the disclosure survives refresh and Escape returns focus to its opener.
  it("preserves an open navigation menu across refresh and closes it with Escape", () => {
    const { host, handle, spies } = mountSpied();
    const toggle = host.querySelector<HTMLButtonElement>(".nav-toggle")!;
    toggle.click();
    host.querySelector<HTMLButtonElement>('button[data-nav="agenda"]')!.focus();
    handle.update(vm({ now: "12:34" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const focused = host.querySelector<HTMLButtonElement>('button[data-nav="agenda"]')!;
    expect(document.activeElement).toBe(focused);
    expect(key(focused, "Escape").defaultPrevented).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".navigation-panel")?.getAttribute("data-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
    expect(totalCalls(spies)).toBe(0);
  });

  // A-U152: number shortcuts retain their order and close an open disclosure.
  it("shortcut 6 closes navigation and selects Swarm once", () => {
    const { host, spies } = mountSpied();
    const toggle = host.querySelector<HTMLButtonElement>(".nav-toggle")!;
    toggle.click();
    key(toggle, "6");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(spies.onView).toHaveBeenCalledExactlyOnceWith("swarm");
    expect(totalCalls(spies)).toBe(1);
  });

  it("works when dispatched straight at the document", () => {
    const { spies } = mountSpied();
    key(document, "3");
    expect(spies.onView.mock.calls).toEqual([["diary"]]);
  });

  it("does not change the view itself (controlled)", () => {
    const { host } = mountSpied();
    key(document.body, "2");
    expect(host.querySelector(".app")?.getAttribute("data-view")).toBe("wall");
  });

  // A-R40: shortcut 5 selects Memory; 6 selects secondary Swarm, U138 M1.
  it.each([["5", "memory"], ["6", "swarm"]])("shortcut %s selects %s", (k, view) => {
    const { spies } = mountSpied();
    key(document.body, k!);
    expect(spies.onView).toHaveBeenCalledExactlyOnceWith(view);
    expect(totalCalls(spies)).toBe(1);
  });

  it.each(["0", "9", "a", "Enter", "Tab", "ArrowRight", " ", "F1", "!", "Escape"])("other key %j does nothing", (k) => {
    const { spies } = mountSpied();
    key(document.body, k);
    expect(totalCalls(spies)).toBe(0);
  });

  it.each([["ctrlKey"], ["metaKey"], ["altKey"], ["shiftKey"]] as const)("a held modifier (%s) suppresses the shortcut", (mod) => {
    const { spies } = mountSpied();
    key(document.body, "1", { [mod]: true });
    key(document.body, "4", { [mod]: true });
    expect(spies.onView).not.toHaveBeenCalled();
  });

  it("a plain key after a modified one still works", () => {
    const { spies } = mountSpied();
    key(document.body, "2", { ctrlKey: true });
    key(document.body, "2");
    expect(spies.onView.mock.calls).toEqual([["agenda"]]);
  });

  describe("ignored while focus is in an editable control", () => {
    const editable: [string, () => HTMLElement][] = [
      ["input", () => document.createElement("input")],
      ["input[type=search]", () => Object.assign(document.createElement("input"), { type: "search" })],
      ["textarea", () => document.createElement("textarea")],
      ["select", () => document.createElement("select")],
      ["contenteditable=true", () => { const d = document.createElement("div"); d.setAttribute("contenteditable", "true"); d.tabIndex = 0; return d; }],
      ["contenteditable (empty value)", () => { const d = document.createElement("div"); d.setAttribute("contenteditable", ""); d.tabIndex = 0; return d; }],
      ["contenteditable=plaintext-only", () => { const d = document.createElement("div"); d.setAttribute("contenteditable", "plaintext-only"); d.tabIndex = 0; return d; }],
    ];

    it.each(editable)("%s", (_n, make) => {
      const { spies } = mountSpied();
      const el = make();
      document.body.appendChild(el);
      el.focus();
      for (const [k] of KEYS) key(el, k);
      expect(spies.onView).not.toHaveBeenCalled();
    });

    it("an input INSIDE the host (e.g. future filter field) is also ignored", () => {
      const { host, spies } = mountSpied();
      const input = document.createElement("input");
      host.appendChild(input);
      input.focus();
      key(input, "2");
      expect(spies.onView).not.toHaveBeenCalled();
    });

    it("contenteditable=false is NOT editable: the shortcut still fires", () => {
      const { spies } = mountSpied();
      const d = document.createElement("div");
      d.setAttribute("contenteditable", "false");
      document.body.appendChild(d);
      key(d, "3");
      expect(spies.onView.mock.calls).toEqual([["diary"]]);
    });

    it("a button, link or plain element keeps the shortcut working", () => {
      const { spies } = mountSpied();
      const b = document.createElement("button");
      document.body.appendChild(b);
      b.focus();
      key(b, "1");
      key(document.body, "4");
      expect(spies.onView.mock.calls).toEqual([["wall"], ["archive"]]);
    });

    it("after the editable loses focus the shortcut works again", () => {
      const { spies } = mountSpied();
      const input = document.createElement("input");
      document.body.appendChild(input);
      input.focus();
      key(input, "2");
      input.blur();
      key(document.body, "2");
      expect(spies.onView.mock.calls).toEqual([["agenda"]]);
    });
  });

  it("is a no-op without handlers (does not throw)", () => {
    mount();
    expect(() => key(document.body, "1")).not.toThrow();
  });

  it("listens on host.ownerDocument: another document's events are ignored, its own are handled", () => {
    const other = document.implementation.createHTMLDocument("other");
    const spies = mountSpied().spies; // main document instance (must not react to `other`)
    const handler = vi.fn<(v: ViewId) => void>();
    mount(vm(), { onView: handler }, other);
    key(other, "2");
    expect(handler.mock.calls).toEqual([["agenda"]]);
    expect(spies.onView).not.toHaveBeenCalled();
    key(document.body, "3");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(spies.onView.mock.calls).toEqual([["diary"]]);
  });

  it("each mounted wall reacts once per key press (two instances = two separate calls, no duplicates per instance)", () => {
    const a = mountSpied();
    const b = mountSpied();
    key(document.body, "1");
    expect(a.spies.onView).toHaveBeenCalledTimes(1);
    expect(b.spies.onView).toHaveBeenCalledTimes(1);
  });
});
