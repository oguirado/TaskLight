import { describe, expect, it, vi } from "vitest";
import { ROOTS, mountFixture, one, press, scrollingRoot } from "./helpers";

const ENTRIES = ["mouse", "tab-arrow", "shortcut"] as const;
const VIEWS = ["wall", "agenda", "diary", "archive", "memory", "swarm"] as const;

describe("U165 M1 different-view navigation", () => {
  for (const mode of ROOTS) {
    it.each(ENTRIES)(`M1 ${mode}: %s navigation resets the root after all restored focus`, entry => {
      const root = scrollingRoot(mode), wall = mountFixture();
      const initial = one(wall.host, 'button[data-nav="wall"]');
      const destination = one(wall.host, 'button[data-nav="agenda"]');
      (entry === "mouse" ? destination : initial).focus();
      document.documentElement.scrollTop = 357;
      root.scrollTop = 731;

      // Model the browser scrolling during focus. Resetting before the final
      // restoration (including pending tab focus) must still fail this check.
      const nativeFocus = HTMLElement.prototype.focus;
      const focus = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
        nativeFocus.call(this, options);
        if (this.isConnected && wall.host.contains(this)) root.scrollTop = 911;
      });
      if (entry === "mouse") destination.click();
      else press(initial, entry === "tab-arrow" ? "ArrowDown" : "2");

      expect(one(wall.host, ".app").getAttribute("data-view")).toBe("agenda");
      expect(focus, "The fixture must exercise focus restoration").toHaveBeenCalled();
      expect(root.scrollTop, "Different-view navigation must finish at the root start after focus").toBe(0);
      if (mode === "scrollingElement") {
        expect(document.documentElement.scrollTop, "Only the actual scrolling root is reset").toBe(357);
      }
    });
  }

  it.each([
    ["agenda", "wall"], ["wall", "diary"], ["wall", "archive"],
    ["wall", "memory"], ["wall", "swarm"],
  ] as const)("M1 view update from %s to %s resets without a navigation focus descriptor", (from, to) => {
    const root = scrollingRoot("undefined"), wall = mountFixture(from);
    root.scrollTop = 615;
    wall.navigate(to);
    expect(one(wall.host, ".app").getAttribute("data-view")).toBe(to);
    expect(root.scrollTop, "The reset applies to every different destination, including Swarm").toBe(0);
  });
});

describe("U165 M2 same-view continuity", () => {
  for (const mode of ROOTS) {
    it.each(VIEWS)(`M2 ${mode}: a %s snapshot refresh preserves nonzero root scroll`, view => {
      const root = scrollingRoot(mode), wall = mountFixture(view);
      root.scrollTop = 643;
      wall.refresh();
      expect(one(wall.host, ".app").getAttribute("data-view")).toBe(view);
      expect(root.scrollTop, "Rendering the same view must not reset document scroll").toBe(643);
    });
  }

  it.each(["wall", "swarm"] as const)("M2 a real activity beat preserves root scroll in %s", view => {
    const root = scrollingRoot("scrollingElement"), wall = mountFixture(view);
    for (const offset of [517, 839]) {
      root.scrollTop = offset;
      wall.beat();
      expect(root.scrollTop, "An admitted activity beat is not navigation").toBe(offset);
    }
  });

  it.each(ENTRIES)("M2 selecting the current view through %s preserves root scroll", entry => {
    const root = scrollingRoot("null"), wall = mountFixture();
    const selected = one(wall.host, 'button[data-nav="wall"]');
    selected.focus();
    root.scrollTop = 723;
    if (entry === "mouse") selected.click();
    else press(selected, entry === "tab-arrow" ? "Home" : "1");
    expect(one(wall.host, ".app").getAttribute("data-view")).toBe("wall");
    expect(root.scrollTop, "A navigation callback for the existing view is not a view change").toBe(723);
  });
});
