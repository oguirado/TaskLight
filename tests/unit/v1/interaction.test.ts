import { describe, expect, it, vi } from "vitest";
import { activate, agent, board, bubble, deterministic, escape, lane, microNode, mounted, name, render, task } from "./helpers";

deterministic();

describe("V1 M8 keyboard", () => {
  it("M8 Tab order contains each lane including taskless agents and every task disclosure", () => {
    const vm = board([agent(), agent("taskless", { state: "idle", activity: "idle" })]), root = render(vm);
    for (const a of vm.agents) {
      const row = lane(root, a.agent);
      expect(row.tabIndex, `M8 lane ${a.agent} participates in sequential focus`).toBeGreaterThanOrEqual(0);
      row.focus(); expect(document.activeElement).toBe(row);
      for (const t of a.tasks) {
        const button = bubble(row, t.title);
        expect(button.tabIndex).toBeGreaterThanOrEqual(0); expect(button.disabled).toBe(false);
        button.focus(); expect(document.activeElement).toBe(button);
      }
    }
  });

  it.each(["Enter", " "] as const)("M8 %j opens and closes each task once, with Escape returning focus to its bubble", key => {
    const root = render(), button = bubble(root, "Task T09"); button.focus();
    activate(button, key); expect(button.getAttribute("aria-expanded")).toBe("true");
    const child = microNode(root, "Micro T09.M04"); escape(child);
    expect(button.getAttribute("aria-expanded")).toBe("false"); expect(document.activeElement).toBe(button);
    activate(button, key); expect(button.getAttribute("aria-expanded")).toBe("true");
    activate(button, key); expect(button.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("V1 M7 stable refresh and viewport", () => {
  it("M7 each task independently retains expansion and semantic identity across state refreshes", () => {
    const vm = board(), wall = mounted(vm), first = bubble(wall.host, "Task T09"), second = bubble(wall.host, "Task T01");
    first.click(); second.click();
    const ids = [first, second].map(n => [n.id, n.getAttribute("aria-controls")]);
    const changed = task("T09", { microtasks: task().microtasks.map(m => ({ ...m, state: "done" as const })) });
    wall.update(board([agent("z-lead", { tasks: [changed, task("T01", { state: "pending", microtasks: [] })] })]));
    const after = [bubble(wall.host, "Task T09"), bubble(wall.host, "Task T01")];
    expect(after.map(n => n.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
    expect(after.map(n => [n.id, n.getAttribute("aria-controls")])).toEqual(ids);
    expect(name(after[0]!)).toContain("4/4");
    expect(after[0]!.compareDocumentPosition(after[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each(["task", "lane", "navigation"] as const)("M7/U166 a %s focus restoration preserves identity and both scroll roots", target => {
    const wall = mounted();
    const before = target === "task" ? bubble(wall.host, "Task T09") : target === "lane" ? lane(wall.host, "z-lead") :
      wall.host.querySelector<HTMLElement>('[data-nav="swarm"]');
    expect(before, "Focus target must exist").not.toBeNull();
    expect(before!.tabIndex, "M7 target must be keyboard focusable").toBeGreaterThanOrEqual(0);
    before!.focus(); expect(document.activeElement).toBe(before);
    document.documentElement.scrollTop = 643; document.body.scrollTop = 517;
    const native = HTMLElement.prototype.focus;
    const focus = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      native.call(this, options);
      if (!options?.preventScroll) { document.documentElement.scrollTop = 999; document.body.scrollTop = 999; }
    });
    wall.update();
    const after = document.activeElement as HTMLElement;
    expect(after.isConnected).toBe(true); expect(wall.host.contains(after)).toBe(true);
    if (target === "task") expect(name(after)).toContain("Task T09");
    if (target === "lane") expect(after).toBe(lane(wall.host, "z-lead"));
    if (target === "navigation") expect(after.getAttribute("data-nav")).toBe("swarm");
    for (const [index, node] of focus.mock.contexts.entries()) if (node === after) {
      expect(focus.mock.calls[index]?.[0]).toEqual(expect.objectContaining({ preventScroll: true }));
    }
    expect(document.documentElement.scrollTop).toBe(643); expect(document.body.scrollTop).toBe(517);
  });

  it("M7/U165 changing view resets the scrolling root after focus restoration", () => {
    const wall = mounted(); document.documentElement.scrollTop = 731;
    wall.navigate("agenda");
    expect(wall.host.querySelector(".app")?.getAttribute("data-view")).toBe("agenda");
    expect((document.scrollingElement ?? document.documentElement).scrollTop).toBe(0);
  });

  it("M7 a same-view refresh preserves scroll and does not align reopened disclosure content", () => {
    const wall = mounted(); bubble(wall.host, "Task T09").click();
    const scroll = vi.fn(); const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
    try {
      document.documentElement.scrollTop = 837; wall.update();
      expect(document.documentElement.scrollTop).toBe(837); expect(scroll).not.toHaveBeenCalled();
      expect(bubble(wall.host, "Task T09").getAttribute("aria-expanded")).toBe("true");
    } finally {
      if (original) Object.defineProperty(Element.prototype, "scrollIntoView", original);
      else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("M7 collapsing a task and refreshing cannot reopen it or move expansion to a sibling", () => {
    const wall = mounted(), button = bubble(wall.host, "Task T09"); button.click(); button.click(); wall.update();
    expect(bubble(wall.host, "Task T09").getAttribute("aria-expanded")).toBe("false");
    expect(bubble(wall.host, "Task T01").getAttribute("aria-expanded")).toBe("false");
  });
});
