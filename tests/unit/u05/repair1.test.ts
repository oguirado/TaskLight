import { afterEach, describe, expect, it } from "vitest";
import {
  ATTENTION, CAPSULE_STATUS, INFERENCE_SOURCE, LIMITS, PRIVACY_TIER,
  validateCapsuleState, validatePatch, validateTaskOutput,
} from "../../../src/schema/index";
import type { PrivacyTier, TaskId, Validated } from "../../../src/schema/index";

const has = <T>(r: Validated<T>, code: string, path?: string): boolean =>
  !r.ok && r.errors.some((e) => e.code === code && (path === undefined || e.path === path));
const state = (extra: Record<string, unknown> = {}) => ({
  rev: 1, observed_rev: 1, status: "running", attention: "none",
  inference_source: "ON_DEVICE", updated_at: 1700000000000, writer_uid: "u1", ...extra,
});
const patch = (extra: Record<string, unknown> = {}) => ({
  projectId: "p1", base_rev: 1, observed_rev: 1, prompt_version: "v1", template_hash: "h",
  inference_source: "IN_CLOUD", fields: { status: "done" }, ...extra,
});

const savedLimit: number = LIMITS.HEADLINE_MAX;
afterEach(() => {
  try { (LIMITS as Record<string, number>).HEADLINE_MAX = savedLimit; } catch { /* frozen */ }
  for (const a of [CAPSULE_STATUS, ATTENTION, PRIVACY_TIER, INFERENCE_SOURCE] as unknown as string[][]) {
    const i = a.indexOf("bogus");
    if (i >= 0) a.splice(i, 1);
  }
});

describe("repair loop 1: B3 runtime freeze", () => {
  it("R1 LIMITS is frozen and mutation has no effect", () => {
    expect(Object.isFrozen(LIMITS)).toBe(true);
    try { (LIMITS as Record<string, number>).HEADLINE_MAX = 9999; } catch { /* strict-mode throw ok */ }
    expect(LIMITS.HEADLINE_MAX).toBe(120);
    const r = validateTaskOutput("summary", JSON.stringify({ headline: "a".repeat(200), summary: "s" }));
    expect(r.ok).toBe(false);
  });
  it("R2 enum arrays are frozen and push has no effect", () => {
    for (const a of [CAPSULE_STATUS, ATTENTION, PRIVACY_TIER, INFERENCE_SOURCE]) {
      expect(Object.isFrozen(a)).toBe(true);
      const n = a.length;
      try { (a as unknown as string[]).push("bogus"); } catch { /* frozen throws */ }
      expect(a.length).toBe(n);
    }
    expect(validateTaskOutput("status", "bogus").ok).toBe(false);
  });
});

describe("repair loop 1: B4 never throws", () => {
  it("R3 non-string raw returns WRONG_TYPE without throwing", () => {
    for (const bad of [null, undefined, 42, {}, ["x"], true]) {
      let r: Validated<unknown> | undefined;
      expect(() => { r = validateTaskOutput("summary", bad as unknown as string); }).not.toThrow();
      expect(r && has(r, "WRONG_TYPE")).toBe(true);
    }
  });
  it("R4 unknown task id is rejected (no digest fallthrough)", () => {
    for (const t of ["typo", "", "toString", "__proto__", 7, null]) {
      let r: Validated<unknown> | undefined;
      expect(() => { r = validateTaskOutput(t as unknown as TaskId, '{"needs_you":[],"brief":"ok"}'); }).not.toThrow();
      expect(r?.ok).toBe(false);
    }
  });
});

describe("repair loop 1: B7 plain object only", () => {
  class Foo { rev = 1; }
  const nonPlain = () => [new Date(), new Map(), new Set(), /x/, new Foo(), [state()], () => 1];
  it("R5 validateCapsuleState rejects non-plain objects with NOT_OBJECT", () => {
    for (const v of nonPlain()) expect(has(validateCapsuleState(v, "standard"), "NOT_OBJECT")).toBe(true);
  });
  it("R6 validatePatch rejects non-plain objects with NOT_OBJECT", () => {
    for (const v of nonPlain()) expect(has(validatePatch(v, "standard"), "NOT_OBJECT")).toBe(true);
  });
});

describe("repair loop 1: B13 unknown tier fails closed", () => {
  it("R8 validateCapsuleState with unknown tier does not leak text", () => {
    for (const t of ["PRIVATE", "secret", "", undefined, null, 3]) {
      const r = validateCapsuleState(state({ summary: "secret" }), t as unknown as PrivacyTier);
      expect(r.ok).toBe(false);
    }
  });
  it("R9 validatePatch with unknown tier does not leak text", () => {
    for (const t of ["PRIVATE", "secret", "", undefined, null, 3]) {
      const r = validatePatch(patch({ fields: { summary: "secret" } }), t as unknown as PrivacyTier);
      expect(r.ok).toBe(false);
    }
  });
  it("R10 known tiers still behave (controls)", () => {
    expect(validateCapsuleState(state({ summary: "s" }), "standard").ok).toBe(true);
    expect(validateCapsuleState(state({ summary: "s" }), "shared").ok).toBe(true);
    expect(has(validateCapsuleState(state({ summary: "s" }), "private"), "PRIVATE_TEXT")).toBe(true);
  });
});

describe("repair loop 1: B10 control chars in ids", () => {
  it("R11 writer_uid with control char / DEL -> CONTROL_CHAR", () => {
    for (const u of ["u1\u0000", "u\u00071", "u1\u007f"]) {
      expect(has(validateCapsuleState(state({ writer_uid: u }), "standard"), "CONTROL_CHAR")).toBe(true);
    }
  });
  it("R12 patch projectId with control char / DEL -> CONTROL_CHAR", () => {
    for (const p of ["p1\u0000", "p\u00071", "p1\u007f"]) {
      expect(has(validatePatch(patch({ projectId: p }), "standard"), "CONTROL_CHAR")).toBe(true);
    }
  });
});
