import { describe, expect, it, vi } from "vitest";
import { mountFixture, scrollingRoot } from "../u165/helpers";

// U166 (U165 review debt): focus restored after a same-view refresh never scrolls the page, for every control kind.
describe("U166 restored focus keeps the viewport", () => {
  for (const selector of ["button.step-row", "button.phase-chip"]) {
    it(`${selector} focus survives a beat with preventScroll`, () => {
      const root = scrollingRoot("null"), wall = mountFixture();
      const before = wall.host.querySelector<HTMLElement>(selector);
      expect(before, `fixture has ${selector}`).not.toBeNull();
      before!.focus();

      root.scrollTop = 640;
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      wall.beat();
      const restored = document.activeElement as HTMLElement;
      expect(restored.matches(selector)).toBe(true);
      const index = focus.mock.contexts.findLastIndex(node => node === restored);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(focus.mock.calls[index]?.[0]).toEqual(expect.objectContaining({ preventScroll: true }));
      expect(root.scrollTop).toBe(640);
    });
  }
});
