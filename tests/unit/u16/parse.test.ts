import { describe, expect, test } from "vitest";
import { CONFIG_DEFAULTS, KEY_SPECS } from "../../../src/config/keys";
import { configHash } from "../../../src/config/hash";
import { parseRemote, toAiConfig, toReconcileConfig } from "../../../src/config/parse";
import type { ConfigKey, WallConfig } from "../../../src/config/types";
import { AI_KEYS, ALL_KEYS, RECONCILE_KEYS, REF_DEFAULTS, defaultStrings, refCanon, refFnv } from "./helpers";

const getFrom = (m: Record<string, string>) => (k: ConfigKey): string => (Object.hasOwn(m, k) ? (m[k] as string) : defaultStrings()[k] as string);
const parse = (m: Record<string, string>, prev: WallConfig = { ...REF_DEFAULTS }) => parseRemote(getFrom(m), prev);

describe("constants (green by construction: spec data)", () => {
  test("CONFIG_DEFAULTS equals the independent spec table and is deep-frozen", () => {
    expect(CONFIG_DEFAULTS).toEqual(REF_DEFAULTS);
    expect(Object.isFrozen(CONFIG_DEFAULTS)).toBe(true);
    expect(Object.keys(KEY_SPECS).sort()).toEqual(ALL_KEYS);
  });
  test("no secret-like key exists (B2)", () => {
    for (const k of ALL_KEYS) expect(k).not.toMatch(/secret|debug|recaptcha|api_?key|password|credential/i);
  });
});

describe("O1 defaults_typed / hash", () => {
  test("all-default remote values parse to the defaults with no warnings", () => {
    const r = parse({});
    expect(r.cfg).toEqual(REF_DEFAULTS);
    expect(r.warnings).toEqual([]);
  });
  test("configHash: 8 lowercase hex, FNV-1a over sorted canonical JSON, order independent", () => {
    const h = configHash(REF_DEFAULTS);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(h).toBe(refFnv(refCanon(REF_DEFAULTS)));
    const shuffled = Object.fromEntries(Object.entries(REF_DEFAULTS).reverse()) as unknown as WallConfig;
    expect(configHash(shuffled)).toBe(h);
  });
  test("configHash changes when any single key changes (neg: constant-hash stub fails)", () => {
    const base = configHash(REF_DEFAULTS);
    const seen = new Set<string>([base]);
    for (const [k, v] of Object.entries({ model_name: "gemini-x", max_output_tokens: 201, kill_switch_cloud: true, mode_plan: "ONLY_IN_CLOUD", governor_tier_override: "T2" })) {
      const h = configHash({ ...REF_DEFAULTS, [k]: v } as WallConfig);
      expect(seen.has(h), k).toBe(false);
      seen.add(h);
    }
  });
});

describe("O2 clamp_numeric", () => {
  test("out of range integers clamp to the nearest bound with CLAMPED", () => {
    const r = parse({ max_output_tokens: "5000", ondevice_max_input_tokens: "9216", cloud_concurrency: "0" });
    expect(r.cfg.max_output_tokens).toBe(1024);
    expect(r.cfg.ondevice_max_input_tokens).toBe(7300);
    expect(r.cfg.cloud_concurrency).toBe(1);
    expect(r.warnings.filter((w) => w.code === "CLAMPED").map((w) => w.key).sort())
      .toEqual(["cloud_concurrency", "max_output_tokens", "ondevice_max_input_tokens"]);
  });
  test("every int key clamps at both bounds", () => {
    for (const [k, s] of Object.entries(KEY_SPECS)) {
      if (s.kind !== "int") continue;
      const lo = parse({ [k]: String(s.min - 1) });
      const hi = parse({ [k]: String(s.max + 1) });
      expect((lo.cfg as unknown as Record<string, number>)[k], k + " lo").toBe(s.min);
      expect((hi.cfg as unknown as Record<string, number>)[k], k + " hi").toBe(s.max);
      expect(lo.warnings.some((w) => w.key === k && w.code === "CLAMPED"), k).toBe(true);
    }
  });
  test("in-range boundary values raise no warning", () => {
    const r = parse({ max_output_tokens: "32", frame_js_budget_ms: "11", ondevice_max_input_tokens: "7300" });
    expect(r.warnings).toEqual([]);
    expect(r.cfg.frame_js_budget_ms).toBe(11);
  });
  test("negative and huge base-10 integers clamp (never NaN/Infinity)", () => {
    const r = parse({ max_output_tokens: "-5", min_inference_interval_ms: "99999999999999999999999" });
    expect(r.cfg.max_output_tokens).toBe(32);
    expect(r.cfg.min_inference_interval_ms).toBe(600000);
  });
  test("frame_js_budget_ms ceiling is 11 (VG-GENRE-0142)", () => {
    expect(parse({ frame_js_budget_ms: "12" }).cfg.frame_js_budget_ms).toBe(11);
  });
});

describe("O3 invalid_kept (neg)", () => {
  test("off-enum, bad bool, empty pattern keep the previous values and warn", () => {
    const prev: WallConfig = { ...REF_DEFAULTS, mode_summary: "PREFER_IN_CLOUD", kill_switch_cloud: true, prompt_version: "v7" };
    const r = parseRemote(getFrom({ mode_summary: "prefer_on_device", kill_switch_cloud: "yes", prompt_version: "" }), prev);
    expect(r.cfg.mode_summary).toBe("PREFER_IN_CLOUD");
    expect(r.cfg.kill_switch_cloud).toBe(true);
    expect(r.cfg.prompt_version).toBe("v7");
    expect(r.warnings.filter((w) => w.code === "INVALID_KEPT").map((w) => w.key).sort())
      .toEqual(["kill_switch_cloud", "mode_summary", "prompt_version"]);
  });
  test("unparseable integers are INVALID_KEPT, never coerced", () => {
    const prev: WallConfig = { ...REF_DEFAULTS, max_output_tokens: 300 };
    for (const bad of ["abc", "", "12.5", "1e3", "0x10", "NaN", "Infinity", "-Infinity", " 12", "12 ", "1,000", "٣٠٠"]) {
      const r = parseRemote(getFrom({ max_output_tokens: bad }), prev);
      expect(r.cfg.max_output_tokens, JSON.stringify(bad)).toBe(300);
      expect(r.warnings.some((w) => w.key === "max_output_tokens" && w.code === "INVALID_KEPT"), JSON.stringify(bad)).toBe(true);
    }
  });
  test("bool is exactly 'true' or 'false' (case-sensitive)", () => {
    for (const bad of ["TRUE", "True", "1", "0", "on", " true"]) {
      const r = parse({ kill_switch_cloud: bad });
      expect(r.cfg.kill_switch_cloud, bad).toBe(false);
      expect(r.warnings.some((w) => w.key === "kill_switch_cloud" && w.code === "INVALID_KEPT"), bad).toBe(true);
    }
    expect(parse({ kill_switch_cloud: "true" }).cfg.kill_switch_cloud).toBe(true);
  });
  test("patterns: prompt_version ^v[0-9]{1,3}$, model_name ^gemini-[a-z0-9.-]{1,48}$", () => {
    for (const bad of ["v", "v1000", "V1", "1", "v1a"]) expect(parse({ prompt_version: bad }).cfg.prompt_version, bad).toBe("v1");
    for (const ok of ["v0", "v12", "v999"]) expect(parse({ prompt_version: ok }).cfg.prompt_version, ok).toBe(ok);
    for (const bad of ["gemini-", "Gemini-x", "gpt-4", "gemini-" + "a".repeat(49), "gemini-a b", "gemini-<script>"])
      expect(parse({ model_name: bad }).cfg.model_name, bad).toBe("gemini-3.5-flash-lite");
    for (const ok of ["gemini-3.8-flash", "gemini-" + "a".repeat(48)]) expect(parse({ model_name: ok }).cfg.model_name).toBe(ok);
  });
  test("governor_tier_override accepts none and T0-T3 only", () => {
    for (const ok of ["none", "T0", "T1", "T2", "T3"]) expect(parse({ governor_tier_override: ok }).cfg.governor_tier_override).toBe(ok);
    for (const bad of ["T4", "t1", "None", ""]) {
      const r = parse({ governor_tier_override: bad });
      expect(r.cfg.governor_tier_override, bad).toBe("none");
      expect(r.warnings.some((w) => w.code === "INVALID_KEPT"), bad).toBe(true);
    }
  });
  test("mode_plan and mode_template are validated like other modes (AMEND_C B26)", () => {
    const r = parse({ mode_plan: "CLOUD", mode_template: "ONLY_IN_CLOUD" });
    expect(r.cfg.mode_plan).toBe("PREFER_ON_DEVICE");
    expect(r.cfg.mode_template).toBe("ONLY_IN_CLOUD");
    expect(r.warnings.some((w) => w.key === "mode_plan" && w.code === "INVALID_KEPT")).toBe(true);
  });
  test("one bad key does not block other keys", () => {
    const r = parse({ max_output_tokens: "abc", cloud_concurrency: "4" });
    expect(r.cfg.cloud_concurrency).toBe(4);
  });
  test("a throwing getter port is treated as invalid for that key only", () => {
    const get = (k: ConfigKey): string => { if (k === "model_name") throw new Error("boom"); return defaultStrings()[k] as string; };
    let r: ReturnType<typeof parseRemote> | undefined;
    expect(() => { r = parseRemote(get, { ...REF_DEFAULTS, model_name: "gemini-prev" }); }).not.toThrow();
    expect(r!.cfg.model_name).toBe("gemini-prev");
    expect(r!.warnings.some((w) => w.key === "model_name" && w.code === "INVALID_KEPT")).toBe(true);
  });
});

describe("O4 screenshot_pinned", () => {
  test("any value other than ONLY_ON_DEVICE is pinned back with PINNED", () => {
    const r = parse({ mode_screenshot: "PREFER_IN_CLOUD" });
    expect(r.cfg.mode_screenshot).toBe("ONLY_ON_DEVICE");
    expect(r.warnings.some((w) => w.key === "mode_screenshot" && w.code === "PINNED")).toBe(true);
  });
  test.each(["ONLY_IN_CLOUD", "PREFER_ON_DEVICE", "garbage", ""])("%j never yields a cloud screenshot mode", (v) => {
    expect(parse({ mode_screenshot: v }).cfg.mode_screenshot).toBe("ONLY_ON_DEVICE");
  });
  test("ONLY_ON_DEVICE raises no warning (neg)", () => {
    expect(parse({ mode_screenshot: "ONLY_ON_DEVICE" }).warnings).toEqual([]);
  });
  test("a poisoned prev cannot loosen the pin", () => {
    const r = parseRemote(getFrom({ mode_screenshot: "" }), { ...REF_DEFAULTS, mode_screenshot: "ONLY_IN_CLOUD" });
    expect(r.cfg.mode_screenshot).toBe("ONLY_ON_DEVICE");
  });
});

describe("sink projections", () => {
  test("toAiConfig has exactly the AiConfig keys with the same values", () => {
    const cfg: WallConfig = { ...REF_DEFAULTS, model_name: "gemini-z", kill_switch_cloud: true, mode_digest: "ONLY_IN_CLOUD" };
    const a = toAiConfig(cfg) as unknown as Record<string, unknown>;
    expect(Object.keys(a).sort()).toEqual(AI_KEYS);
    for (const k of AI_KEYS) expect(a[k], k).toBe((cfg as unknown as Record<string, unknown>)[k]);
  });
  test("toReconcileConfig has exactly the ReconcileConfig keys with the same values", () => {
    const cfg: WallConfig = { ...REF_DEFAULTS, min_inference_interval_ms: 40000, inference_timeout_ms: 30000, mode_status: "PREFER_IN_CLOUD" };
    const r = toReconcileConfig(cfg) as unknown as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(RECONCILE_KEYS);
    for (const k of RECONCILE_KEYS) expect(r[k], k).toBe((cfg as unknown as Record<string, unknown>)[k]);
  });
  test("projections never carry governor, frame or plan/template keys", () => {
    const a = Object.keys(toAiConfig(REF_DEFAULTS)).concat(Object.keys(toReconcileConfig(REF_DEFAULTS)));
    for (const k of ["governor_tier_override", "max_patches_per_frame", "frame_js_budget_ms", "mode_plan", "mode_template"]) expect(a).not.toContain(k);
  });
});
