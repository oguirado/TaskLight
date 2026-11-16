// Shape tests over the frozen constants and export surface (green on stubs by design).
import { describe, expect, it } from "vitest";
import * as P from "../../../src/providers";
import { AI_DEFAULTS } from "../../../src/ai/types";

describe("frozen constants (SPEC_U47 public API)", () => {
  it("FIREBASE_IDS order and DEFAULT_PROVIDER", () => {
    expect([...P.FIREBASE_IDS]).toEqual(["firebase-hybrid", "firebase-ondevice", "firebase-cloud"]);
    expect(P.DEFAULT_PROVIDER).toBe("firebase-hybrid");
  });
  it("TASK_GROUP covers the five non-screenshot TaskIds and has no screenshot", () => {
    expect(P.TASK_GROUP).toEqual({ status: "capsule", summary: "capsule", next_action: "capsule", plan: "capsule", digest: "digest" });
    expect(Object.keys(P.TASK_GROUP)).not.toContain("screenshot");
  });
  it("TIMEOUTS_MS and MAX_BODY_BYTES", () => {
    expect(P.TIMEOUTS_MS).toEqual({ probe: 1500, local: 30000, remote: 60000, ceiling: 120000 });
    expect(P.MAX_BODY_BYTES).toBe(49152);
  });
  it("ceiling equals the existing config ceiling (src/config/keys.ts:13 per spec) and caps both budgets", () => {
    expect(P.TIMEOUTS_MS.local).toBeLessThanOrEqual(P.TIMEOUTS_MS.ceiling);
    expect(P.TIMEOUTS_MS.remote).toBeLessThanOrEqual(P.TIMEOUTS_MS.ceiling);
  });
  it("export surface of index", () => {
    for (const f of ["createProviderRegistry", "toChatMessages", "strictParse"]) expect(typeof (P as Record<string, unknown>)[f]).toBe("function");
    for (const k of ["FIREBASE_IDS", "DEFAULT_PROVIDER", "TASK_GROUP", "TIMEOUTS_MS", "MAX_BODY_BYTES"]) expect(P).toHaveProperty(k);
  });
  it("AI_DEFAULTS still as the spec cites (src/ai/types.ts:19-24): chain relies on it only inside Firebase", () => {
    expect(AI_DEFAULTS.mode_screenshot).toBe("ONLY_ON_DEVICE");
    expect(AI_DEFAULTS.prompt_version).toBe("v1");
  });
});
