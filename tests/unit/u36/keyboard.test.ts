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

  it.each(["0", "5", "9", "a", "Enter", "Tab", "ArrowRight", " ", "F1", "!", "Escape"])("other key %j does nothing", (k) => {
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
