import { describe, expect, it, vi } from "vitest";
import { TASK_IDS, assertWalk, domStops, enter, key, mountFixture, one, tab, tabTo, title } from "./helpers";

describe("U159 Wall keyboard order", () => {
  it("AC1 Tab traverses every control and all thirty tasks in exact DOM order", () => {
    const wall = mountFixture();
    assertWalk(wall, domStops(wall.host).map(key));
  });

  it("AC2 Shift+Tab traverses the complete thirty-task fixture in exact reverse order", () => {
    const wall = mountFixture();
    assertWalk(wall, domStops(wall.host).map(key).reverse(), true);
  });

  it("AC2 every control returns to its actual predecessor and round-trips with Tab", () => {
    const wall = mountFixture();
    const stops = domStops(wall.host);
    for (const [index, control] of stops.entries()) {
      control.focus();
      tab(true);
      expect(key(document.activeElement), `U159 predecessor of ${key(control)}`).toBe(key(stops[index - 1] ?? wall.before));
      tab();
      expect(key(document.activeElement), "forward/backward adjacency must be reversible").toBe(key(control));
    }
  });

  it("AC3 Tab to Brief then Shift+Tab and Enter cannot accidentally expand T30", () => {
    const wall = mountFixture();
    const expected = domStops(wall.host);
    const brief = one(wall.host, 'button[data-phase-id="brief"]');
    const previous = expected[expected.indexOf(brief) - 1] ?? wall.before;
    const tail = one(wall.host, '.task[data-task-id="T30"]');
    const unchangedTail = tail.outerHTML;
    const activateTail = vi.fn();
    title(wall.host, "T30").addEventListener("click", activateTail);
    one(wall.host, 'button[data-micro-id="T30.M01"]').addEventListener("click", activateTail);
    tabTo(wall, "phase:brief");
    tab(true);
    expect(key(document.activeElement), "Brief must return to its DOM predecessor, never the tail").toBe(key(previous));
    enter();
    expect(tail.outerHTML, "Enter on Brief's predecessor must leave T30 unchanged").toBe(unchangedTail);
    expect(activateTail).not.toHaveBeenCalled();
    expect(wall.onOpenTask).not.toHaveBeenCalled();
  });

  it("AC3 an offscreen T30 is allowed only when it really is the previous control", () => {
    const wall = mountFixture();
    const tail = one(wall.host, '.task[data-task-id="T30"]');
    vi.spyOn(tail, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 1800, 400, 100));
    expect(tail.getBoundingClientRect().top).toBeGreaterThan(900);
    const expected = domStops(wall.host).at(-1)!;
    expect(tail.contains(expected), "the fixture's genuine final control belongs to T30").toBe(true);
    wall.after.focus();
    tab(true);
    expect(document.activeElement).toBe(expected);
    tabTo(wall, "phase:brief");
    tab(true);
    expect(tail.contains(document.activeElement)).toBe(false);
  });

  it("AC3 closed legacy Messages and inactive panels never enter sequential navigation", () => {
    const wall = mountFixture();
    expect(wall.host.querySelectorAll('.messages-body[hidden] button').length).toBeGreaterThan(0);
    const stops = domStops(wall.host);
    expect(stops.some(node => node.closest("[hidden], [inert]"))).toBe(false);
    expect(stops.some(node => node.closest(".messages-body"))).toBe(false);
    assertWalk(wall, stops.map(key));
  });

  it.each(["phase:brief", "micro:T15.M01"])("AC4 preserved %s focus and adjacent order survive a beat refresh", identity => {
    const wall = mountFixture();
    const expected = domStops(wall.host).map(key);
    tabTo(wall, identity);
    wall.refreshBeat();
    expect(key(document.activeElement), "refresh must retain the focused control's identity").toBe(identity);
    tab(true);
    expect(key(document.activeElement)).toBe(expected[expected.indexOf(identity) - 1]);
    tab();
    expect(key(document.activeElement)).toBe(identity);
  });

  it("AC4 every task-title control retains focus by identity after a beat refresh", () => {
    const wall = mountFixture();
    const lost: string[] = [];
    for (const id of TASK_IDS) {
      title(wall.host, id).focus();
      expect(key(document.activeElement)).toBe(`title:${id}`);
      wall.refreshBeat();
      if (key(document.activeElement) !== `title:${id}`) lost.push(`${id} -> ${key(document.activeElement)}`);
    }
    expect(lost, "task-title refresh must not reset the keyboard origin to the document body").toEqual([]);
  });

  it("AC4 Shift+Tab after a focused title refresh returns to the true predecessor", () => {
    const wall = mountFixture();
    const expected = domStops(wall.host).map(key);
    tabTo(wall, "title:T15");
    wall.refreshBeat();
    expect(key(document.activeElement), "refresh must restore the keyboard origin before Shift+Tab").toBe("title:T15");
    tab(true);
    expect(key(document.activeElement), "refresh must not send reverse navigation to the document tail")
      .toBe(expected[expected.indexOf("title:T15") - 1]);
  });

  it("AC4 Tab after a focused title refresh advances to the true successor", () => {
    const wall = mountFixture();
    const expected = domStops(wall.host).map(key);
    tabTo(wall, "title:T15");
    wall.refreshBeat();
    expect(key(document.activeElement), "refresh must restore the keyboard origin before Tab").toBe("title:T15");
    tab();
    expect(key(document.activeElement), "refresh must not restart forward navigation at the document head")
      .toBe(expected[expected.indexOf("title:T15") + 1]);
  });

  it("AC4 fifty beat-only refreshes preserve title focus and the complete keyboard sequence", () => {
    const wall = mountFixture();
    const expected = domStops(wall.host).map(key);
    tabTo(wall, "title:T15");
    const lostAt: number[] = [];
    for (let i = 1; i <= 50; i += 1) {
      wall.refreshBeat();
      if (key(document.activeElement) !== "title:T15") lostAt.push(i);
    }
    expect(lostAt, "beat-only updates must never steal or discard keyboard focus").toEqual([]);
    assertWalk(wall, expected);
    assertWalk(wall, [...expected].reverse(), true);
  });

  it("AC4 a selected navigation control restores predictably under either navigation pattern", () => {
    const wall = mountFixture();
    const agenda = one(wall.host, 'button[data-nav="agenda"]');
    if (agenda.getAttribute("role") === "tab") {
      const selected = one(wall.host, '[role="tab"][aria-selected="true"]');
      selected.focus();
      selected.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    } else {
      agenda.focus();
      enter();
    }
    expect(key(document.activeElement)).toBe("nav:agenda");
    wall.refreshBeat();
    const restored = one(wall.host, 'button[data-nav="agenda"]');
    expect(document.activeElement).toBe(restored);
    expect(domStops(wall.host)).toContain(restored);
    if (restored.getAttribute("role") === "tab") {
      expect(wall.host.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
    }
    assertWalk(wall, domStops(wall.host).map(key));
  });

  it.each(["extra zero tab stop", "positive tabindex priority"])("AC5 negative control catches a T30 %s leak", mutation => {
    const wall = mountFixture();
    const expected = domStops(wall.host).map(key);
    const target = mutation === "extra zero tab stop" ? one(wall.host, '.task[data-task-id="T30"]') : title(wall.host, "T30");
    target.tabIndex = mutation === "extra zero tab stop" ? 0 : 1;
    expect(() => assertWalk(wall, expected)).toThrow(/U159 focus order/);
    expect(() => assertWalk(wall, [...expected].reverse(), true)).toThrow(/U159 focus order/);
  });

  it("AC5 negative control catches an intercepted Shift+Tab from Brief to T30", () => {
    const wall = mountFixture();
    const brief = one(wall.host, 'button[data-phase-id="brief"]');
    const expected = domStops(wall.host);
    const previous = key(expected[expected.indexOf(brief) - 1] ?? wall.before);
    brief.addEventListener("keydown", event => {
      if (event.key === "Tab" && event.shiftKey) { event.preventDefault(); title(wall.host, "T30").focus(); }
    });
    tabTo(wall, "phase:brief");
    expect(() => {
      tab(true);
      expect(key(document.activeElement), "U159 focus order rejects application focus jumps").toBe(previous);
    }).toThrow(/U159 focus order/);
  });
});
