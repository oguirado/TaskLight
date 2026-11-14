import { describe, expect, it, vi } from "vitest";
import { parseConfig, resolveMode } from "../../../src/ai/config";
import { AI_DEFAULTS, type AiConfig, type ModeName } from "../../../src/ai/types";
import { MODES, TASKS } from "./harness";

vi.mock("../../../src/schema", () => import("./schemaMock"));

const cfg = (o: Partial<AiConfig> = {}): AiConfig => ({
  ...AI_DEFAULTS, mode_status: "PREFER_ON_DEVICE", mode_summary: "PREFER_ON_DEVICE", mode_next_action: "PREFER_ON_DEVICE",
  mode_screenshot: "ONLY_ON_DEVICE", mode_digest: "PREFER_IN_CLOUD", max_output_tokens: 200,
  ondevice_max_input_tokens: 7300, prompt_version: "v1", model_name: "gemini-3.5-flash-lite", kill_switch_cloud: false, ...o,
});

describe("resolveMode (B5-B8, pure)", () => {
  it("B5 takes the task key as configured (standard tier, no kill switch)", () => {
    for (const m of MODES) {
      expect(resolveMode("status", "standard", cfg({ mode_status: m }))).toBe(m);
      expect(resolveMode("digest", "shared", cfg({ mode_digest: m }))).toBe(m);
      expect(resolveMode("summary", "standard", cfg({ mode_summary: m }))).toBe(m);
      expect(resolveMode("next_action", "standard", cfg({ mode_next_action: m }))).toBe(m);
    }
  });
  it("B5 invalid value falls back to the task default (resolveMode level)", () => {
    expect(resolveMode("digest", "standard", cfg({ mode_digest: "nope" as ModeName }))).toBe("PREFER_IN_CLOUD");
    expect(resolveMode("status", "standard", cfg({ mode_status: "prefer_on_device" as ModeName }))).toBe("PREFER_ON_DEVICE");
  });
  it("B6 screenshot is ONLY_ON_DEVICE whatever the config says", () => {
    for (const m of MODES) expect(resolveMode("screenshot", "standard", cfg({ mode_screenshot: m }))).toBe("ONLY_ON_DEVICE");
  });
  it("B7 private tier forces ONLY_ON_DEVICE for every task", () => {
    for (const t of TASKS) for (const m of MODES) {
      expect(resolveMode(t, "private", cfg({ [`mode_${t}`]: m } as Partial<AiConfig>))).toBe("ONLY_ON_DEVICE");
    }
  });
  it("O9 B8 kill switch forces ONLY_ON_DEVICE for every task (digest default is PREFER_IN_CLOUD)", () => {
    expect(resolveMode("digest", "standard", cfg())).toBe("PREFER_IN_CLOUD");
    for (const t of TASKS) for (const tier of ["standard", "shared"] as const) {
      expect(resolveMode(t, tier, cfg({ kill_switch_cloud: true, mode_digest: "ONLY_IN_CLOUD", mode_status: "PREFER_IN_CLOUD" }))).toBe("ONLY_ON_DEVICE");
    }
  });
  it("is pure and deterministic (no mutation of cfg)", () => {
    const c = Object.freeze(cfg());
    expect(resolveMode("digest", "standard", c)).toBe(resolveMode("digest", "standard", c));
  });
});

describe("parseConfig (B5)", () => {
  it("empty raw gives defaults and no warnings", () => {
    const r = parseConfig({});
    expect(r.cfg).toEqual(AI_DEFAULTS);
    expect(r.cfg).toMatchObject({ mode_status: "PREFER_ON_DEVICE", mode_screenshot: "ONLY_ON_DEVICE", mode_digest: "PREFER_IN_CLOUD", max_output_tokens: 200, ondevice_max_input_tokens: 7300, prompt_version: "v1", model_name: "gemini-3.5-flash-lite", kill_switch_cloud: false });
    expect(r.warnings).toEqual([]);
  });
  it("valid values pass through", () => {
    const r = parseConfig({ mode_digest: "ONLY_IN_CLOUD", max_output_tokens: 120, kill_switch_cloud: true, model_name: "m", prompt_version: "v2" });
    expect(r.cfg.mode_digest).toBe("ONLY_IN_CLOUD");
    expect(r.cfg.max_output_tokens).toBe(120);
    expect(r.cfg.kill_switch_cloud).toBe(true);
    expect(r.cfg.model_name).toBe("m");
    expect(r.cfg.prompt_version).toBe("v2");
    expect(r.warnings).toEqual([]);
  });
  it("invalid mode falls back to that key's default and warns naming the key", () => {
    for (const bad of ["bogus", "prefer_on_device", "", 3, null, undefined]) {
      const r = parseConfig({ mode_digest: bad, mode_summary: "ONLY_IN_CLOUD" });
      expect(r.cfg.mode_digest).toBe("PREFER_IN_CLOUD");
      expect(r.cfg.mode_summary).toBe("ONLY_IN_CLOUD");
      if (bad !== undefined) expect(r.warnings.join("|")).toContain("mode_digest");
    }
  });
  it("invalid default per key: status -> PREFER_ON_DEVICE, screenshot -> ONLY_ON_DEVICE", () => {
    const r = parseConfig({ mode_status: "x", mode_screenshot: "x" });
    expect(r.cfg.mode_status).toBe("PREFER_ON_DEVICE");
    expect(r.cfg.mode_screenshot).toBe("ONLY_ON_DEVICE");
    expect(r.warnings.join("|")).toContain("mode_status");
    expect(r.warnings.join("|")).toContain("mode_screenshot");
  });
  it("wrong-typed numeric / boolean values fall back to defaults with a warning", () => {
    const r = parseConfig({ max_output_tokens: "200", ondevice_max_input_tokens: -5, kill_switch_cloud: "true" });
    expect(r.cfg.max_output_tokens).toBe(200);
    expect(r.cfg.ondevice_max_input_tokens).toBe(7300);
    expect(r.cfg.kill_switch_cloud).toBe(false);
    const w = r.warnings.join("|");
    expect(w).toContain("max_output_tokens");
    expect(w).toContain("ondevice_max_input_tokens");
    expect(w).toContain("kill_switch_cloud");
  });
  it("does not mutate raw", () => {
    const raw = Object.freeze({ mode_status: "x" });
    expect(() => parseConfig(raw)).not.toThrow();
  });
});
