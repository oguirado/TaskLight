import { describe, it, expect, beforeEach, vi } from "vitest";
import { createOnboarding } from "../../../src/ui/onboarding";
import type { WallView } from "../../../src/ui/types";
import { click, isHidden, trustPredicate } from "./helpers";

const V = (o: Partial<WallView> = {}): WallView => ({ mode: "needs_gesture", progressPct: null, showEnableCta: true, privateAvailable: false, ...o });
let panel: HTMLElement; let activate: ReturnType<typeof vi.fn<(t: boolean) => Promise<void>>>;
const mk = (opt: { isTrusted?: (ev: Event) => boolean } = { isTrusted: trustPredicate }) => {
  document.body.replaceChildren(); panel = document.createElement("div"); document.body.appendChild(panel);
  activate = vi.fn<(t: boolean) => Promise<void>>(() => new Promise<void>(() => {}));
  return createOnboarding(panel, { activate }, opt);
};
const cta = () => panel.querySelector('[data-role="enable-cta"]') as HTMLElement | null;

describe("U20 onboarding (B5-B7)", () => {
  it("never activates on construction, render, focus or timers", () => {
    vi.useFakeTimers();
    const o = mk(); o.render(V(), false);
    cta()?.focus(); cta()?.dispatchEvent(new FocusEvent("focus")); vi.advanceTimersByTime(60000);
    expect(activate).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it("CTA is a native button", () => {
    mk().render(V(), false);
    expect(cta()).not.toBeNull();
    expect(cta()!.tagName).toBe("BUTTON");
    expect(cta()!.getAttribute("type")).toBe("button");
    expect(cta()!.textContent!.trim().length).toBeGreaterThan(0);
  });
  it("O2 gesture_required: untrusted click -> 0 calls; trusted twice -> exactly 1 call with trusted=true", () => {
    mk().render(V(), false);
    click(cta()!, false); expect(activate).toHaveBeenCalledTimes(0);
    click(cta()!, true); click(cta()!, true);
    expect(activate).toHaveBeenCalledTimes(1); expect(activate).toHaveBeenCalledWith(true);
  });
  it("A3 default predicate is ev.isTrusted: a synthetic click is untrusted -> 0 activations", () => {
    mk({}).render(V(), false);
    click(cta()!, true); cta()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(activate).toHaveBeenCalledTimes(0);
  });
  it("O4 CTA hidden when showEnableCta=false", () => {
    const o = mk(); o.render(V({ showEnableCta: false, mode: "on_device" }), false);
    expect(isHidden(cta())).toBe(true);
    o.render(V(), false); expect(isHidden(cta())).toBe(false);
  });
  it("B6 copy: hardware minimum, minutes, cloud continues", () => {
    mk().render(V({ mode: "no_model" }), false);
    const t = panel.textContent!;
    expect(t).toMatch(/4\s*GB/); expect(t).toMatch(/16\s*GB/); expect(t).toMatch(/22\s*GB/); expect(t).toMatch(/4 cores|4\s*cores/i);
    expect(t).toMatch(/minutes/i); expect(t).toMatch(/cloud/i);
  });
  it("B6 'Continue with cloud' dismisses the panel without activating", () => {
    const o = mk(); o.render(V(), false);
    const b = panel.querySelector('[data-action="continue-cloud"]') as HTMLElement;
    expect(b.tagName).toBe("BUTTON");
    click(b, true);
    expect(activate).not.toHaveBeenCalled();
    expect(isHidden(panel.querySelector('[data-role="onboarding-panel"]') ?? panel) || isHidden(cta())).toBe(true);
  });
  it("O3/B7 progressbar ARIA: role, min 0, max 100, now = progressPct; removed/hidden after ready", () => {
    const o = mk(); o.render(V({ mode: "downloading", progressPct: 12, showEnableCta: false }), false);
    const pb = panel.querySelector('[role="progressbar"]') as HTMLElement;
    expect(pb.getAttribute("aria-valuemin")).toBe("0"); expect(pb.getAttribute("aria-valuemax")).toBe("100");
    expect(pb.getAttribute("aria-valuenow")).toBe("12");
    o.render(V({ mode: "downloading", progressPct: 100, showEnableCta: false }), false);
    expect(panel.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("100");
    o.render(V({ mode: "on_device", progressPct: null, showEnableCta: false, privateAvailable: true }), false);
    expect(isHidden(panel.querySelector('[role="progressbar"]'))).toBe(true);
  });
  it("progress has visible text (not colour only)", () => {
    mk().render(V({ mode: "downloading", progressPct: 42, showEnableCta: false }), false);
    expect(panel.textContent).toContain("42");
  });
  it("dispose detaches the CTA handler", () => {
    const o = mk(); o.render(V(), false); const c = cta()!; o.dispose();
    click(c, true); expect(activate).not.toHaveBeenCalled();
  });
});
