import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderPlanBand } from "../../../src/views/plan";
import { activate, announcements, controlledPanel, disclosure, expectActivity as legacyExpectActivity, mount, plan, q, setup,
  step, task, wall, workingWall } from "./fixtures";


import { computedMotion, contrast, declaration, expectStationary, hasAnimation, rules, token } from "./css_probe";

// A-Q1: U148 keeps task and microtask state distinct; exclude children from task text checks.
function expectActivity(scope: HTMLElement, state: Parameters<typeof legacyExpectActivity>[1]): void {
  const own = scope.cloneNode(true) as HTMLElement;
  if (scope.matches(".task[data-task-id]")) own.querySelectorAll(".steps").forEach(n => n.remove());
  legacyExpectActivity(own, state);
}

// A-Q1: U148 non-article task roots retain .task/data-task-id; keep identity checks.
function card(root: ParentNode, id = "T01"): HTMLElement {
  const matches = [...root.querySelectorAll<HTMLElement>(".task[data-task-id]")].filter(n => n.dataset.taskId === id);
  expect(matches, `Required unique task card: ${id}`).toHaveLength(1);
  return matches[0]!;
}

setup();
describe("A4 phase visual distinction", () => {
  it("A4 authored CSS distinguishes aria-current from aria-pressed", () => {
    const css = readFileSync(resolve(__dirname, "../../../styles/plan.css"), "utf8");
    const declarations = rules(css);
    expect(declarations.some(r => /\[aria-current\s*=\s*["']?step["']?\]/.test(r.selector))).toBe(true);
    expect(declarations.some(r => /\[aria-pressed\s*=\s*["']?true["']?\]/.test(r.selector))).toBe(true);
    const band = renderPlanBand(document, plan(), { selectedPhase: "build" }); document.body.append(band);
    const current = q(band, '[aria-current="step"]'), selected = q(band, '[aria-pressed="true"]');
    const properties = ["background", "background-color", "color", "border-color", "border-width", "font-weight", "box-shadow", "outline", "text-decoration"];
    expect(properties.map(p => declaration(current, p, "", false, css)))
      .not.toEqual(properties.map(p => declaration(selected, p, "", false, css)));
  });
});

describe("A9 motion and announcements", () => {
  it("A9 CSSOM probe distinguishes reduced pseudo rules from normal rotation", () => {
    const { host } = mount(workingWall()); const ring = q(host, ".step-indicator");
    const control = '.step-indicator::before { animation: probe-spin 1s linear infinite; } @media (prefers-reduced-motion: reduce) { .step-indicator::before { animation: none; } }';
    expect(declaration(ring, "animation", "before", false, control)).toContain("probe-spin");
    expect(declaration(ring, "animation", "before", false, control)).toContain("1s");
    expect(declaration(ring, "animation", "before", true, control)).toBe("none");
    expect(hasAnimation(ring, "before", false, control)).toBe(true); expect(hasAnimation(ring, "before", true, control)).toBe(false);
  });
  it("A9 reduced motion leaves Working text with stationary rings and pseudo-elements", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("prefers-reduced-motion"), media: query,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(), onchange: null }));
    const { host } = mount(workingWall()); expectActivity(card(host), "working"); expectStationary(card(host), true);
    const indicators = [...host.querySelectorAll<HTMLElement>(".step-indicator, .status-icon, .agent-dot")];
    expect(indicators.length).toBeGreaterThan(0);
    for (const indicator of indicators) for (const pseudo of ["", "before", "after"] as const) {
      const computed = computedMotion(indicator, pseudo, true);
      expect(computed.animationName || computed.animation || "none").toMatch(/^(none|initial|unset)$/);
      expect(hasAnimation(indicator, pseudo, true)).toBe(false);
    }
  });
  it("A9 reduced-motion authored declarations disable pseudo-element rotation", () => {
    const { host } = mount(workingWall()); const ring = q(host, ".step-indicator");
    expect(hasAnimation(ring, "before", false)).toBe(true);
    const computed = computedMotion(ring, "before", true);
    expect(computed.animationName || computed.animation).toBe("none"); expect(hasAnimation(ring, "before", true)).toBe(false);
  });
  it("A9 repeated beats do not announce unchanged semantic activity", async () => {
    const { host, handle } = mount(workingWall()); const observed = announcements(host);
    for (const deadline of [190010, 190020, 190030]) handle.update(workingWall(deadline));
    await Promise.resolve(); observed.stop(); expect(observed.messages).toEqual([]);
  });
  it("A9 working-to-unknown expiry announces once; repeated expired renders remain silent", async () => {
    const { host, handle } = mount(workingWall()); const observed = announcements(host);
    vi.advanceTimersByTime(2); await Promise.resolve();
    expect(observed.messages).toHaveLength(1); expect(observed.messages[0]).toMatch(/liveness unknown/i);
    handle.update(workingWall()); handle.update(workingWall()); await Promise.resolve(); observed.stop();
    expect(observed.messages).toHaveLength(1);
  });
  it("A9 explicit semantic transition announces once without requiring a new phase selection", async () => {
    const { host, handle } = mount(workingWall()); const observed = announcements(host);
    handle.update(wall({ tasks: [task({ status: "running", activity: { state: "unknown" },
      steps: [step({ state: "active", activity: { state: "unknown" } })] })] }));
    await Promise.resolve(); observed.stop(); expect(observed.messages).toHaveLength(1);
    expect(observed.messages[0]).toMatch(/liveness unknown/i);
  });
  it("A9 acceptance focus stays on its native trigger after keyboard activation", () => {
    const { host } = mount(wall()); const button = disclosure(host); activate(button);
    expect(document.activeElement).toBe(button); expect(controlledPanel(button).hidden).toBe(false);
  });
});

describe.each(["light", "dark"] as const)("A9 defined contrast pairs in %s theme", theme => {
  it.each(["--c-text-1", "--c-text-2", "--c-text-3"])("A9 %s on task surface meets text contrast", foreground => {
    expect(contrast(token(foreground, theme), token("--c-surface-1", theme))).toBeGreaterThanOrEqual(4.5);
  });
  it.each(["--c-st-running", "--c-st-done", "--c-st-blocked", "--c-st-waiting", "--c-st-idle", "--c-st-pending", "--c-focus"])(
    "A9 %s on task surface meets icon/focus contrast", foreground => {
      expect(contrast(token(foreground, theme), token("--c-surface-1", theme))).toBeGreaterThanOrEqual(3);
    });
  it("A9 keyboard trigger has a visible focus outline from defined tokens", () => {
    const { host } = mount(wall({ theme })); const chip = q(host, 'button.phase-chip[data-phase-id="build"]');
    chip.dataset.u91Focus = "true";
    expect(declaration(chip, "outline")).toMatch(/\bsolid\b.*var\(--c-focus\)/);
    expect(contrast(token("--c-focus", theme), token("--c-surface-1", theme))).toBeGreaterThanOrEqual(3);
  });
});
