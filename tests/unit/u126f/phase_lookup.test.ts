import { afterEach, describe, expect, it } from "vitest";
import { renderPlanBand } from "../../../src/views/plan";

// U126f (U126 split review, plan.ts): phase lookup uses the same string normalization as the chips.
afterEach(() => { document.body.replaceChildren(); });
const band = (plan: unknown, selectedPhase?: string | null) =>
  renderPlanBand(document, JSON.parse(JSON.stringify(plan)), selectedPhase === undefined ? undefined : { selectedPhase });
const textOf = (root: HTMLElement, cls: string) => root.querySelector(`.${cls}`)?.textContent ?? null;

describe("U126f phase lookup normalization", () => {
  it("an id-less phase never matches an absent phaseId", () => {
    const root = band({ id: "p1", title: "T", phases: [{ label: "Discovery" }] });
    expect(textOf(root, "plan-current-phase")).toBe("Current phase: Unknown");
  });
  it("an empty selection never presses an id-less chip", () => {
    const root = band({ id: "p1", title: "T", phases: [{ label: "Discovery" }] }, "");
    for (const chip of root.querySelectorAll(".phase-chip")) expect(chip.getAttribute("aria-pressed")).toBe("false");
  });
  it("numeric phase ids resolve like their chip ids", () => {
    const root = band({ id: "p1", title: "T", phaseId: "1", phases: [{ id: 1, label: "Build" }] }, "1");
    expect(root.querySelector('[data-phase-id="1"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(textOf(root, "plan-current-phase")).toBe("Current phase: Build");
    expect(textOf(root, "plan-phase-filter")).toBe("Phase filter: Build");
    expect(root.querySelector(".plan-phase-filter-note")).toBeNull();
  });
  it("a known string id still resolves and an unknown one still shows the note", () => {
    const ok = band({ id: "p1", title: "T", phaseId: "a", phases: [{ id: "a", label: "Alpha" }] }, "a");
    expect(textOf(ok, "plan-current-phase")).toBe("Current phase: Alpha");
    expect(ok.querySelector(".plan-phase-filter-note")).toBeNull();
    const bad = band({ id: "p1", title: "T", phaseId: "a", phases: [{ id: "a", label: "Alpha" }] }, "zz");
    expect(textOf(bad, "plan-phase-filter")).toBe("Phase filter: Unknown");
    expect(bad.querySelector(".plan-phase-filter-note")).not.toBeNull();
  });
});
