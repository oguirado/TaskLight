import { describe, it, expect, beforeEach, vi } from "vitest";
import { withReducedMotion } from "../../../src/ui/caps";
import type { FrameCaps } from "../../../src/render/types";
import { FakeMotion } from "./helpers";

const inner = (effects = true) => ({
  maxPatchesThisFrame: vi.fn(() => 8), frameJsBudgetMs: vi.fn(() => 4),
  effectsEnabled: vi.fn(() => effects), beginFrame: vi.fn(), endFrame: vi.fn(),
}) satisfies FrameCaps;
beforeEach(() => document.documentElement.classList.remove("ui-reduced-motion"));

describe("U20 O12 reduced_motion_caps (B16)", () => {
  it("effectsEnabled = inner && !reduced; follows live motion changes; root class toggles", () => {
    const m = new FakeMotion(true); const c = withReducedMotion(inner(true), m);
    expect(c.effectsEnabled()).toBe(false);
    expect(document.documentElement.classList.contains("ui-reduced-motion")).toBe(true);
    m.set(false);
    expect(c.effectsEnabled()).toBe(true);
    expect(document.documentElement.classList.contains("ui-reduced-motion")).toBe(false);
    m.set(true);
    expect(document.documentElement.classList.contains("ui-reduced-motion")).toBe(true);
  });
  it("inner effects off stays off even without reduced motion", () => {
    expect(withReducedMotion(inner(false), new FakeMotion(false)).effectsEnabled()).toBe(false);
  });
  it("delegates the rest of FrameCaps to U12", () => {
    const i = inner(); const c = withReducedMotion(i, new FakeMotion(false));
    expect(c.maxPatchesThisFrame()).toBe(8); expect(c.frameJsBudgetMs()).toBe(4);
    c.beginFrame(); c.endFrame(3, 5);
    expect(i.beginFrame).toHaveBeenCalledTimes(1); expect(i.endFrame).toHaveBeenCalledWith(3, 5);
  });
});
