// Repair loop 1: regression tests for reviewer review r0 (B3/B4 prototype-key version lookup).
import { describe, expect, it } from "vitest";
import { cap, ev, ok } from "./helpers";
import { buildPrompt, templateHash } from "../../../src/prompts/index";

const PROTO_KEYS = ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"];
const TASKS = ["status", "summary", "next_action", "screenshot", "digest"] as const;

describe("repair1: inherited Object.prototype keys are not versions (B3)", () => {
  for (const version of PROTO_KEYS) {
    it(`buildPrompt version "${version}" falls back to v1 with UNKNOWN_VERSION_FALLBACK`, () => {
      const v = ok(buildPrompt(cap("status", [ev(1, 50)]), { version }));
      expect(v.prompt_version).toBe("v1");
      expect(v.degraded).toContain("UNKNOWN_VERSION_FALLBACK");
    });
    it(`output for "${version}" equals the v1 output plus the fallback flag`, () => {
      const base = ok(buildPrompt(cap("summary", [ev(1, 50)]), { version: "v1" }));
      const v = ok(buildPrompt(cap("summary", [ev(1, 50)]), { version }));
      expect(v.text).toBe(base.text);
      expect(v.template_hash).toBe(base.template_hash);
    });
  }
});

describe("repair1: templateHash ignores inherited keys (B4/B3)", () => {
  for (const version of PROTO_KEYS) {
    it(`templateHash(task, "${version}") equals the v1 hash`, () => {
      for (const t of TASKS) expect(templateHash(t, version)).toBe(templateHash(t, "v1"));
    });
  }
});
