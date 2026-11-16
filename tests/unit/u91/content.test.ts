import { describe, expect, it, vi } from "vitest";
import { activate, card, controlledPanel, disclosure, expectSafe, hostile, mount, selectorHostile,
  setup, source, step, task, text, wall } from "./fixtures";
import type { Task } from "./fixtures";
import { expectStationary } from "./css_probe";

setup();
describe("A8 passive untrusted content", () => {
  it("A8 hostile title, acceptance, outcome, reason and evidence remain literal text", () => {
    const t = task({ title: hostile, status: "blocked", blockedReason: hostile, activity: { state: "blocked" },
      steps: [step({ state: "done", accept: hostile, detail: { outcome: hostile, evidence: [hostile], source }, activity: { state: "done" } })] });
    const before = structuredClone(t); const { host } = mount(wall({ tasks: [t] }));
    const button = disclosure(host); activate(button);
    expect(text(card(host))).toContain(hostile); expect(text(controlledPanel(button))).toContain(hostile);
    expect(card(host).querySelector(".task-title")?.textContent).toBe(hostile);
    expect(card(host).querySelector(".blocked-reason")?.textContent).toBe(hostile);
    expectSafe(host); expect(t).toEqual(before);
  });
  it("A8 hostile acceptance on a pending microtask is visible without creating an image", () => {
    const { host } = mount(wall({ tasks: [task({ steps: [step({ accept: hostile })] })] }));
    const button = disclosure(host); activate(button); expect(text(controlledPanel(button))).toContain(hostile); expectSafe(host);
  });
  it("A8 hostile question text and selector characters in event identity do not execute or throw", () => {
    const t = task({ activity: { state: "needs_you" }, operatorQuestion: { eventId: selectorHostile, text: hostile } });
    const onOpenTask = vi.fn(); const { host, handle } = mount(wall({ tasks: [t] }), { onOpenTask });
    expect(text(card(host))).toContain(hostile); expectSafe(host);
    const button = [...card(host).querySelectorAll<HTMLButtonElement>("button")].find(n => /chat|conversation|answer|respond/i.test(`${text(n)} ${n.getAttribute("aria-label") ?? ""}`));
    expect(button).toBeDefined(); expect(() => activate(button!)).not.toThrow();
    expect(onOpenTask).toHaveBeenCalledTimes(1); expect(() => handle.update(wall({ tasks: [t] }))).not.toThrow();
    expectSafe(host);
  });
  it("A8 hostile dependency identities render literally without selector exceptions", () => {
    const { host, handle } = mount(wall({ tasks: [task({ status: "waiting", waitsFor: [selectorHostile], activity: { state: "waiting" } })] }));
    expect(text(card(host))).toContain(selectorHostile); expectSafe(host);
    expect(() => handle.update(wall({ tasks: [task({ waitsFor: [selectorHostile] })] }))).not.toThrow(); expectSafe(host);
  });
  it("A8 hostile task/micro identities retain safe disclosure relationships across refresh", () => {
    const t = task({ id: `plan:room-a:${selectorHostile}`, taskId: selectorHostile,
      steps: [step({ microId: selectorHostile, state: "done", detail: { outcome: "Recorded", evidence: [selectorHostile], source } })] });
    const { host, handle } = mount(wall({ tasks: [t] })); const button = disclosure(host);
    expect(() => activate(button)).not.toThrow(); expect(text(controlledPanel(button))).toContain(selectorHostile);
    expect(() => handle.update(wall({ tasks: [t] }))).not.toThrow(); expectSafe(host);
    expect(disclosure(host).getAttribute("aria-expanded")).toBe("true");
  });
  it.each([
    { name: "missing", value: undefined }, { name: "null", value: null },
    { name: "HTML string", value: hostile }, { name: "unknown state", value: { state: selectorHostile } },
    { name: "state is an object", value: { state: { toString: () => "working" } } },
    { name: "array", value: [{ state: "working" }] }, { name: "numeric state", value: { state: 1 } },
  ])("A8 malformed activity $name has an inert fallback without HTML or animation", ({ value }) => {
    const t = { ...task({ status: "running" }), activity: value,
      steps: [{ ...step({ state: "active" }), activity: value }] } as unknown as Task;
    let host: HTMLElement | undefined;
    expect(() => { host = mount(wall({ tasks: [t] })).host; }).not.toThrow();
    expect(host).toBeDefined(); expectSafe(host!);
    expect(host!.querySelector('[data-activity="working"]')).toBeNull();
    for (const node of host!.querySelectorAll("[data-activity]")) {
      expect(["idle", "done", "blocked", "waiting", "needs_you", "unknown", "cancelled"]).toContain(node.getAttribute("data-activity"));
    }
    expectStationary(card(host!));
  });
});
