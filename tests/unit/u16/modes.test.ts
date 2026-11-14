// SPEC_AMEND_C U16: B26 (defaults/parsing), B27 (floors never loosened), B28 (kill switch). Oracle A10.
import { describe, expect, test } from "vitest";
import { MODE_KEYS, MODE_SNAPSHOT_DEFAULTS, parseConfig, resolveMode } from "../../../src/config/modes";
import type { ModeKey, ModeSnapshot } from "../../../src/config/modes";

const snap = (over: Partial<Record<ModeKey, string>> = {}, kill = false): ModeSnapshot => {
  const p = parseConfig({ ...over, kill_switch_cloud: kill });
  return p;
};

describe("parseConfig (B26)", () => {
  test("constants: seven mode keys, defaults per spec", () => {
    expect([...MODE_KEYS].sort()).toEqual(["mode_digest", "mode_next_action", "mode_plan", "mode_screenshot", "mode_status", "mode_summary", "mode_template"]);
    expect(MODE_SNAPSHOT_DEFAULTS.modes.mode_digest).toBe("PREFER_IN_CLOUD");
    expect(MODE_SNAPSHOT_DEFAULTS.modes.mode_screenshot).toBe("ONLY_ON_DEVICE");
  });
  test("empty raw yields defaults and nothing invalid; missing mode_plan is PREFER_ON_DEVICE", () => {
    const s = parseConfig({});
    expect(s.modes.mode_plan).toBe("PREFER_ON_DEVICE");
    expect(s.modes.mode_template).toBe("PREFER_ON_DEVICE");
    expect(s.invalid).toEqual([]);
    expect(s.prompt_version).toBe("v1");
    expect(s.min_inference_interval_ms).toBe(20000);
  });
  test("value outside LensMode keeps the default and is listed in invalid", () => {
    const s = parseConfig({ mode_digest: "CLOUD" });
    expect(s.modes.mode_digest).toBe("PREFER_IN_CLOUD");
    expect(s.invalid).toContain("mode_digest");
  });
  test("non-string and lowercase values are invalid (case-sensitive, JSON-producible types)", () => {
    const s = parseConfig({ mode_status: 3, mode_summary: "prefer_on_device", mode_plan: null, mode_template: { a: 1 }, mode_next_action: true });
    expect([...s.invalid].sort()).toEqual(["mode_next_action", "mode_plan", "mode_status", "mode_summary", "mode_template"]);
    expect(s.modes.mode_status).toBe("PREFER_ON_DEVICE");
  });
  test("valid values are applied (neg: reject-all stub fails)", () => {
    const s = parseConfig({ mode_plan: "ONLY_IN_CLOUD", mode_template: "ONLY_ON_DEVICE", mode_digest: "ONLY_ON_DEVICE" });
    expect(s.modes.mode_plan).toBe("ONLY_IN_CLOUD");
    expect(s.modes.mode_template).toBe("ONLY_ON_DEVICE");
    expect(s.modes.mode_digest).toBe("ONLY_ON_DEVICE");
    expect(s.invalid).toEqual([]);
  });
  test("mode_screenshot cannot be loosened by raw config", () => {
    expect(parseConfig({ mode_screenshot: "PREFER_IN_CLOUD" }).modes.mode_screenshot).toBe("ONLY_ON_DEVICE");
  });
  test("kill_switch_cloud boolean is read; non-boolean keeps false", () => {
    expect(parseConfig({ kill_switch_cloud: true }).kill_switch_cloud).toBe(true);
    expect(parseConfig({ kill_switch_cloud: "true" }).kill_switch_cloud).toBe(false);
  });
  test("returned snapshot is not aliased to the frozen defaults and never throws on junk", () => {
    expect(() => parseConfig({ mode_status: undefined, max_output_tokens: "x", prompt_version: 5 })).not.toThrow();
    const a = parseConfig({}); const b = parseConfig({});
    expect(a).not.toBe(b);
  });
});

describe("A10 rc_cannot_loosen (resolveMode, B27)", () => {
  test("page/standard with mode_summary ONLY_IN_CLOUD is tightened to ONLY_ON_DEVICE", () => {
    const r = resolveMode("mode_summary", "page", "standard", snap({ mode_summary: "ONLY_IN_CLOUD" }));
    expect(r).toEqual({ mode: "ONLY_ON_DEVICE", floor: "ONLY_ON_DEVICE", tightened: true });
  });
  test("tab/standard with requested ONLY_ON_DEVICE stays ONLY_ON_DEVICE, floor PREFER, not tightened (neg)", () => {
    const r = resolveMode("mode_summary", "tab", "standard", snap({ mode_summary: "ONLY_ON_DEVICE" }));
    expect(r).toEqual({ mode: "ONLY_ON_DEVICE", floor: "PREFER_ON_DEVICE", tightened: false });
  });
  test("tab/standard with PREFER_IN_CLOUD is lifted to the PREFER_ON_DEVICE floor", () => {
    const r = resolveMode("mode_summary", "tab", "standard", snap({ mode_summary: "PREFER_IN_CLOUD" }));
    expect(r).toEqual({ mode: "PREFER_ON_DEVICE", floor: "PREFER_ON_DEVICE", tightened: true });
  });
  test("shared is treated as standard", () => {
    const a = resolveMode("mode_summary", "tab", "shared", snap({ mode_summary: "ONLY_IN_CLOUD" }));
    const b = resolveMode("mode_summary", "tab", "standard", snap({ mode_summary: "ONLY_IN_CLOUD" }));
    expect(a).toEqual(b);
    expect(a.mode).toBe("PREFER_ON_DEVICE");
  });
  test("null floor (agent/ci/git standard) returns the requested mode unchanged (positive control)", () => {
    for (const src of ["agent", "ci", "git"] as const) {
      const r = resolveMode("mode_summary", src, "standard", snap({ mode_summary: "ONLY_IN_CLOUD" }));
      expect(r).toEqual({ mode: "ONLY_IN_CLOUD", floor: null, tightened: false });
    }
  });
  test("every source with private tier resolves ONLY_ON_DEVICE whatever Remote Config says", () => {
    for (const src of ["agent", "ci", "git", "tab", "selection", "page", "doc"] as const)
      for (const req of ["PREFER_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD", "ONLY_ON_DEVICE"])
        expect(resolveMode("mode_digest", src, "private", snap({ mode_digest: req })).mode, `${src}/${req}`).toBe("ONLY_ON_DEVICE");
  });
  test("private with unknown source (null) is still ONLY_ON_DEVICE (privacy, mirrors U06 B7)", () => {
    expect(resolveMode("mode_digest", null, "private", snap({ mode_digest: "ONLY_IN_CLOUD" })).mode).toBe("ONLY_ON_DEVICE");
  });
  test("page and doc sources are device-only for standard and shared", () => {
    for (const src of ["page", "doc"] as const)
      for (const tier of ["standard", "shared"] as const)
        expect(resolveMode("mode_plan", src, tier, snap({ mode_plan: "PREFER_IN_CLOUD" })).mode, `${src}/${tier}`).toBe("ONLY_ON_DEVICE");
  });
  test("mode_plan missing resolves to PREFER_ON_DEVICE", () => {
    expect(resolveMode("mode_plan", null, "standard", snap()).mode).toBe("PREFER_ON_DEVICE");
  });
  test("mode_digest invalid string 'CLOUD' resolves to the default PREFER_IN_CLOUD (null source, standard)", () => {
    const s = parseConfig({ mode_digest: "CLOUD" });
    expect(resolveMode("mode_digest", null, "standard", s).mode).toBe("PREFER_IN_CLOUD");
  });
  test("mode_screenshot always resolves ONLY_ON_DEVICE, even for agent/standard (B7)", () => {
    expect(resolveMode("mode_screenshot", "agent", "standard", snap({ mode_screenshot: "ONLY_IN_CLOUD" })).mode).toBe("ONLY_ON_DEVICE");
  });
  test("tightening is monotone: result is never looser than the requested mode", () => {
    const rank: Record<string, number> = { ONLY_IN_CLOUD: 0, PREFER_IN_CLOUD: 1, PREFER_ON_DEVICE: 2, ONLY_ON_DEVICE: 3 };
    for (const src of [null, "agent", "tab", "selection", "page", "doc"] as const)
      for (const tier of ["private", "standard", "shared"] as const)
        for (const req of ["PREFER_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD", "ONLY_ON_DEVICE"]) {
          const r = resolveMode("mode_summary", src, tier, snap({ mode_summary: req }));
          expect(rank[r.mode]!, `${src}/${tier}/${req}`).toBeGreaterThanOrEqual(rank[req]!);
        }
  });
});

describe("B28 kill switch", () => {
  test("kill_switch_cloud forces ONLY_ON_DEVICE for every requested mode and key", () => {
    for (const key of MODE_KEYS)
      for (const req of ["PREFER_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD", "ONLY_ON_DEVICE"])
        expect(resolveMode(key, "agent", "standard", snap({ [key]: req }, true)).mode, `${key}/${req}`).toBe("ONLY_ON_DEVICE");
  });
  test("without the switch the same input is not forced (neg: always-ON_DEVICE stub fails)", () => {
    expect(resolveMode("mode_digest", "agent", "standard", snap({ mode_digest: "ONLY_IN_CLOUD" }, false)).mode).toBe("ONLY_IN_CLOUD");
  });
});
