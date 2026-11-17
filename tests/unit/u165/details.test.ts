import { describe, expect, it, vi } from "vitest";
import {
  INPUTS, button, detail, motionPreference, mountFixture, one, open,
  press, property, scrollingRoot, watchAlignment,
} from "./helpers";

describe("U165 M3 connected task detail opening", () => {
  for (const reduced of [false, true]) {
    it.each(INPUTS)(`M3 reduced-motion=${reduced}: %s focuses without scrolling, then aligns the selected section start`, input => {
      motionPreference(reduced);
      const wall = mountFixture("swarm"), alignment = watchAlignment();
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      open(button(wall.host, "View task T05"), input);
      const opened = detail(wall.host);
      expect(opened, "The selected task must actually open").toBeDefined();
      expect(opened!.isConnected).toBe(true);
      expect(document.activeElement).toBe(opened);
      const focused = focus.mock.contexts.findLastIndex(node => node === opened);
      expect(focused, "The details section itself must receive focus").toBeGreaterThanOrEqual(0);
      expect.soft(focus.mock.calls[focused]?.[0], "Detail focus must suppress its implicit scrolling")
        .toEqual(expect.objectContaining({ preventScroll: true }));

      expect(alignment.scroll, "Opening connected details must explicitly reveal their heading").toHaveBeenCalled();
      const index = alignment.calls.findIndex(call => call.node === opened);
      expect(index, "Align the details section, rather than its trigger or a child").toBeGreaterThanOrEqual(0);
      const call = alignment.calls[index]!;
      expect(call.connected).toBe(true);
      expect(call.active, "Focus must already belong to the section when alignment occurs").toBe(opened);
      expect(alignment.scroll.mock.invocationCallOrder[index]!).toBeGreaterThan(focus.mock.invocationCallOrder[focused]!);
      expect(call.options).toEqual(expect.objectContaining({ block: "start" }));
      if (reduced) {
        expect((call.options as ScrollIntoViewOptions).behavior, "Reduced motion must never request smooth scrolling").not.toBe("smooth");
      }
    });
  }
});

describe("U165 M4 detached refresh guard", () => {
  it.each(["region", "close", "trigger"] as const)("M4 beat reopening with %s focus never aligns a detached section", target => {
    const root = scrollingRoot("undefined"), wall = mountFixture("swarm"), alignment = watchAlignment();
    open(button(wall.host, "View task T05"), "mouse");
    const before = detail(wall.host);
    expect(before).toBeDefined();
    if (target === "close") button(before!, "Close task details").focus();
    if (target === "trigger") button(wall.host, "View task T05").focus();
    alignment.calls.splice(0);
    alignment.scroll.mockClear();
    root.scrollTop = 887;
    wall.beat();

    const reopened = detail(wall.host);
    expect(reopened, "The refresh must exercise reopening, rather than dropping the detail").toBeDefined();
    expect(reopened).not.toBe(before);
    expect(reopened!.isConnected).toBe(true);
    expect(button(wall.host, "View task T05").getAttribute("aria-expanded")).toBe("true");
    expect(alignment.calls.filter(call => !call.connected), "A detached section cannot be aligned").toEqual([]);
    expect(root.scrollTop, "Reopening on a beat must preserve the current view's root offset").toBe(887);
    const restored = target === "region" ? reopened : target === "close"
      ? button(reopened!, "Close task details") : button(wall.host, "View task T05");
    expect(document.activeElement).toBe(restored);
  });
});

describe("U165 M5 preserved focus behavior", () => {
  it.each(INPUTS)("M5 Escape after %s opening closes details and returns to the selected trigger", input => {
    const wall = mountFixture("swarm");
    watchAlignment();
    const trigger = button(wall.host, "View task T05");
    open(trigger, input);
    expect(detail(wall.host)).toBeDefined();
    expect(document.activeElement).toBe(detail(wall.host));
    press(document.activeElement!, "Escape");
    expect(detail(wall.host)).toBeUndefined();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("M5 Escape after beat reopening restores the fresh trigger", () => {
    const wall = mountFixture("swarm");
    watchAlignment();
    open(button(wall.host, "View task T05"), "Enter");
    wall.beat();
    expect(detail(wall.host)).toBeDefined();
    const trigger = button(wall.host, "View task T05");
    press(document.activeElement!, "Escape");
    expect(detail(wall.host)).toBeUndefined();
    expect(document.activeElement).toBe(trigger);
  });

  it("M5 task-title identity and preventScroll focus survive a same-view beat", () => {
    const root = scrollingRoot("null"), wall = mountFixture();
    const selector = '.task[data-task-id="T05"] .task-detail-toggle';
    const before = one(wall.host, selector);
    before.focus();
    root.scrollTop = 697;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    wall.beat();
    const restored = one(wall.host, selector);
    expect(restored).not.toBe(before);
    expect(document.activeElement).toBe(restored);
    const index = focus.mock.contexts.findLastIndex(node => node === restored);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(focus.mock.calls[index]?.[0]).toEqual(expect.objectContaining({ preventScroll: true }));
    expect(root.scrollTop).toBe(697);
  });
});

describe("U165 M6 missing browser alignment API", () => {
  for (const absent of ["deleted", "undefined"] as const) {
    it.each(INPUTS)(`M6 scrollIntoView ${absent}: %s opening still works without an exception`, input => {
      property(Element.prototype, "scrollIntoView", undefined);
      if (absent === "deleted") Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      expect(typeof Element.prototype.scrollIntoView).toBe("undefined");
      const wall = mountFixture("swarm"), errors: unknown[] = [];
      const onError = (event: ErrorEvent) => { errors.push(event.error ?? event.message); event.preventDefault(); };
      window.addEventListener("error", onError);
      try {
        const trigger = button(wall.host, "View task T05");
        expect(() => open(trigger, input)).not.toThrow();
        expect(errors, "DOM event-listener exceptions must not be swallowed by the test").toEqual([]);
        const opened = detail(wall.host);
        expect(opened).toBeDefined();
        expect(document.activeElement).toBe(opened);
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
      } finally {
        window.removeEventListener("error", onError);
      }
    });
  }
});
