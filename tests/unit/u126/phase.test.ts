import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderPlanBand } from "../../../src/views/plan";
import { mountWall } from "../../../src/views/index";
import { activate, assertPhaseLabels, HOSTILE, noNetwork, NOW, phaseWall, plan, text } from "./oracle";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); noNetwork(); });
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("U126 visible phase labels", () => {
  it("A5 selecting Build leaves Current phase Discovery and independently labels the Build filter", () => {
    const root = renderPlanBand(document, plan(), { selectedPhase: "build" });
    assertPhaseLabels(root);
    const current = root.querySelector('[data-phase-id="discovery"]');
    const selected = root.querySelector('[data-phase-id="build"]');
    expect(current?.classList.contains("phase-chip")).toBe(true);
    expect(current?.getAttribute("aria-current")).toBe("step"); expect(current?.getAttribute("aria-pressed")).toBe("false");
    expect(selected?.classList.contains("phase-chip")).toBe(true);
    expect(selected?.getAttribute("aria-current")).not.toBe("step"); expect(selected?.getAttribute("aria-pressed")).toBe("true");
  });
  it.each([null, undefined])("M5 null/omitted phase selection %j means All phases", selectedPhase => {
    const root = renderPlanBand(document, plan(), selectedPhase === undefined ? {} : { selectedPhase });
    assertPhaseLabels(root, "Discovery", "All phases");
    expect(root.querySelector('[aria-pressed="true"]')).toBeNull();
  });
  it.each([["missing", "build", "Unknown", "Build"], ["discovery", "missing", "Discovery", "Unknown"],
    ["missing", "missing", "Unknown", "Unknown"]])(
    "M5 unmapped identifiers current=%s selected=%s render Unknown", (phaseId, selectedPhase, currentLabel, filterLabel) => {
      const root = renderPlanBand(document, plan({ phaseId: phaseId! }), { selectedPhase: selectedPhase! });
      assertPhaseLabels(root, currentLabel!, filterLabel!);
    });
  it("M5 resolves the current label from plan.phaseId rather than active flags or the filter", () => {
    const root = renderPlanBand(document, plan({ phases: [
      { id: "discovery", label: "Discovery", active: false }, { id: "build", label: "Build", active: true },
    ] }), { selectedPhase: "build" });
    assertPhaseLabels(root);
  });
  it("A4 Amendment B phase.label is literal in labels and chips", () => {
    const root = renderPlanBand(document, plan({ phases: [
      { id: "discovery", label: HOSTILE, active: true }, { id: "build", label: "Build", active: false },
    ] }), { selectedPhase: "discovery" });
    assertPhaseLabels(root, HOSTILE, HOSTILE);
    expect(root.querySelector('[data-phase-id="discovery"]')?.textContent).toBe(HOSTILE);
    expect(root.querySelector("img, script, svg, iframe")).toBeNull();
    for (const node of root.querySelectorAll("*")) expect([...node.attributes].some(a => /^on/i.test(a.name))).toBe(false);
  });
  it.each([false, true])("A5 mounted Wall select/show-all preserves filtering, plan and revision (keyboard=%s)", keyboard => {
    const vm = { ...phaseWall(), plan: { ...plan(), rev: 7 } };
    const before = JSON.stringify(vm); const onSelectPhase = vi.fn(); const onOpenTask = vi.fn();
    const host = document.createElement("div"); document.body.append(host);
    const handle = mountWall(host, vm, { onSelectPhase, onOpenTask });
    try {
      expect(host.querySelectorAll(".task[data-task-id]")).toHaveLength(2);
      const build = host.querySelector<HTMLButtonElement>('.phase-chip[data-phase-id="build"]');
      expect(build).not.toBeNull(); activate(build!, keyboard);
      expect(onSelectPhase).toHaveBeenCalledExactlyOnceWith("build");
      expect([...host.querySelectorAll(".task[data-task-id]")].map(n => n.getAttribute("data-task-id"))).toEqual(["T02"]);
      const controls = host.querySelectorAll<HTMLButtonElement>(".phase-show-all");
      expect(controls).toHaveLength(1); expect(text(controls[0]!)).toBe("Show all phases");
      // Keep the full journey exercised even while the new labels are absent.
      expect.soft(text(host)).toContain("Current phase: Discovery");
      expect.soft(text(host)).toContain("Phase filter: Build");
      activate(controls[0]!, keyboard);
      expect(host.querySelectorAll(".task[data-task-id]")).toHaveLength(2);
      expect(host.querySelector(".phase-show-all")).toBeNull();
      assertPhaseLabels(host, "Discovery", "All phases");
      expect(host.querySelector('[data-phase-id="discovery"]')?.getAttribute("aria-current")).toBe("step");
      expect(JSON.stringify(vm)).toBe(before); expect(vm.plan.rev).toBe(7); expect(onOpenTask).not.toHaveBeenCalled();
    } finally { handle.destroy(); }
  });
  it("M5 preserves the existing delegated Show all phases owner without rendering a duplicate", () => {
    const root = renderPlanBand(document, plan(), { selectedPhase: "build" });
    expect(root.querySelector(".phase-show-all")).toBeNull();
    const selection = vi.fn();
    const withHandler = renderPlanBand(document, plan(), { onSelectPhase: selection });
    withHandler.querySelector<HTMLButtonElement>('[data-phase-id="build"]')!.click();
    expect(selection).toHaveBeenCalledExactlyOnceWith("build");
  });
});
