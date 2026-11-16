import { describe, expect, it } from "vitest";
import {
  ATTENTION, CAPSULE_STATUS, INFERENCE_SOURCE, LIMITS, PRIVACY_TIER, TASK_SCHEMAS,
  validateCapsuleState, validateInferenceSource, validatePatch, validateTaskOutput,
} from "../../../src/schema/index";
import type { JsonSchema, Validated } from "../../../src/schema/index";

const codes = <T>(r: Validated<T>): string[] => (r.ok ? [] : r.errors.map((e) => e.code));
const has = <T>(r: Validated<T>, code: string, path?: string): boolean =>
  !r.ok && r.errors.some((e) => e.code === code && (path === undefined || e.path === path));
const j = (o: unknown): string => JSON.stringify(o);
const A = (n: number): string => "a".repeat(n);
const item = (id: string) => ({ projectId: id, reason: "r", attention: "low" });
const state = (extra: Record<string, unknown> = {}) => ({
  rev: 1, observed_rev: 1, status: "running", attention: "none",
  inference_source: "ON_DEVICE", updated_at: 1700000000000, writer_uid: "u1", ...extra,
});
const patch = (extra: Record<string, unknown> = {}) => ({
  projectId: "p1", base_rev: 1, observed_rev: 1, prompt_version: "v1", template_hash: "h",
  inference_source: "IN_CLOUD", fields: { status: "done" }, ...extra,
});

describe("constants (B1/spec 2)", () => {
  it("LIMITS and enums carry the spec values", () => {
    expect(LIMITS).toMatchObject({ HEADLINE_MAX: 120, SUMMARY_MAX: 600, NEXT_ACTION_MAX: 160, NOTE_MAX: 140,
      BRIEF_MAX: 600, REASON_MAX: 160, NEEDS_YOU_MAX: 12, RAW_MAX: 8192 });
    expect([...CAPSULE_STATUS]).toEqual(["running", "waiting_input", "blocked", "failed", "done", "idle"]);
    expect([...ATTENTION]).toEqual(["none", "low", "high", "now"]);
    expect([...PRIVACY_TIER]).toEqual(["private", "standard", "shared"]);
    expect([...INFERENCE_SOURCE]).toEqual(["ON_DEVICE", "IN_CLOUD", "LOCAL_SERVER", "REMOTE_PROVIDER"]);
  });
});

describe("validateTaskOutput", () => {
  it("O1 status_valid_bare (B6)", () => {
    const r = validateTaskOutput("status", "blocked");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.status).toBe("blocked");
  });
  it("O2 status_off_enum (B8)", () => {
    expect(has(validateTaskOutput("status", "waiting"), "ENUM_VIOLATION")).toBe(true);
    expect(has(validateTaskOutput("status", "Blocked"), "ENUM_VIOLATION")).toBe(true);
  });
  it("O3 summary_boundary_ok (B9)", () => {
    const r = validateTaskOutput("summary", j({ headline: A(120), summary: "b".repeat(600) }));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.value.headline).toHaveLength(120); expect(r.value.summary).toHaveLength(600); }
  });
  it("O4 headline_121 (B9) rejected, not truncated; summary 601 also", () => {
    const r = validateTaskOutput("summary", j({ headline: A(121), summary: "ok" }));
    expect(r.ok).toBe(false);
    expect(has(r, "TOO_LONG", "headline")).toBe(true);
    expect(has(validateTaskOutput("summary", j({ headline: "h", summary: A(601) })), "TOO_LONG", "summary")).toBe(true);
  });
  it("O5 summary_extra_key (B8)", () => {
    const r = validateTaskOutput("summary", j({ headline: "h", summary: "s", html: "<b>x</b>" }));
    expect(has(r, "UNKNOWN_FIELD", "html")).toBe(true);
  });
  it("O6 truncated_json (B7) does not throw", () => {
    let r: Validated<unknown> | undefined;
    expect(() => { r = validateTaskOutput("summary", '{"headline":"Build fa'); }).not.toThrow();
    expect(has(r!, "PARSE_ERROR")).toBe(true);
  });
  it("O7 missing_and_wrongtype sorted by path (B4/B8)", () => {
    const r = validateTaskOutput("summary", '{"headline":42}');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const pairs = r.errors.map((e) => `${e.path}:${e.code}`);
      expect(pairs).toContain("headline:WRONG_TYPE");
      expect(pairs).toContain("summary:MISSING_FIELD");
      expect(pairs.indexOf("headline:WRONG_TYPE")).toBeLessThan(pairs.indexOf("summary:MISSING_FIELD"));
      const sorted = [...r.errors].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
      expect(r.errors).toEqual(sorted);
    }
  });
  it("O8 control_char (B10); \\n and \\t allowed; DEL rejected", () => {
    expect(has(validateTaskOutput("next_action", j({ next_action: "retry\u0007", attention: "high" })), "CONTROL_CHAR")).toBe(true);
    expect(has(validateTaskOutput("next_action", j({ next_action: "a\u007fb", attention: "high" })), "CONTROL_CHAR")).toBe(true);
    expect(validateTaskOutput("next_action", j({ next_action: "a\nb\tc", attention: "high" })).ok).toBe(true);
  });
  it("O10 digest_hallucinated_project (B11)", () => {
    const raw = j({ needs_you: [item("p9")], brief: "b" });
    expect(has(validateTaskOutput("digest", raw, { knownProjectIds: new Set(["p1", "p2"]) }), "UNKNOWN_PROJECT")).toBe(true);
    expect(validateTaskOutput("digest", j({ needs_you: [item("p1")], brief: "b" }), { knownProjectIds: new Set(["p1", "p2"]) }).ok).toBe(true);
    expect(validateTaskOutput("digest", raw).ok).toBe(true); // no ctx => no project check
  });
  it("O11 digest_dup_and_overflow (B11)", () => {
    const items = [item("p1"), ...Array.from({ length: 11 }, (_, i) => item(`q${i}`)), item("p1")];
    expect(items).toHaveLength(13);
    const r = validateTaskOutput("digest", j({ needs_you: items, brief: "b" }));
    expect(codes(r)).toEqual(expect.arrayContaining(["TOO_MANY_ITEMS", "DUPLICATE_PROJECT"]));
    const twelve = Array.from({ length: 12 }, (_, i) => item(`q${i}`));
    expect(validateTaskOutput("digest", j({ needs_you: twelve, brief: "b" })).ok).toBe(true);
  });
  it("O13 enum_parity (B6)", () => {
    for (const raw of ['"blocked"', "blocked\n", '  "blocked" \n']) {
      const r = validateTaskOutput("status", raw);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.status).toBe("blocked");
    }
  });
  it("O15a raw_too_large and empty (B5)", () => {
    expect(has(validateTaskOutput("summary", " ".repeat(8193)), "TOO_LARGE_RAW")).toBe(true);
    expect(has(validateTaskOutput("status", "a".repeat(8193)), "TOO_LARGE_RAW")).toBe(true);
    expect(has(validateTaskOutput("summary", ""), "EMPTY")).toBe(true);
    expect(has(validateTaskOutput("status", " \n\t"), "EMPTY")).toBe(true);
  });
  it("N1 non-JSON / non-object (B7)", () => {
    expect(has(validateTaskOutput("summary", "Sure! here is your summary"), "PARSE_ERROR")).toBe(true);
    for (const raw of ["[]", "null", "42", '"str"', '[{"headline":"h","summary":"s"}]'])
      expect(has(validateTaskOutput("summary", raw), "NOT_OBJECT")).toBe(true);
  });
  it("N2 wrong types, enum and short fields on other tasks (B8)", () => {
    expect(has(validateTaskOutput("next_action", j({ next_action: "x", attention: "urgent" })), "ENUM_VIOLATION")).toBe(true);
    expect(has(validateTaskOutput("screenshot", j({ status: "idle", note: A(141) })), "TOO_LONG", "note")).toBe(true);
    expect(validateTaskOutput("screenshot", j({ status: "idle", note: A(140) })).ok).toBe(true);
    expect(has(validateTaskOutput("screenshot", j({ status: "nope", note: "n" })), "ENUM_VIOLATION", "status")).toBe(true);
    expect(has(validateTaskOutput("digest", j({ needs_you: "p1", brief: "b" })), "WRONG_TYPE")).toBe(true);
    expect(has(validateTaskOutput("digest", j({ needs_you: [], brief: A(601) })), "TOO_LONG")).toBe(true);
    expect(has(validateTaskOutput("next_action", j({ next_action: A(161), attention: "low" })), "TOO_LONG")).toBe(true);
  });
  it("N3 prototype-pollution keys are rejected, never merged (B8)", () => {
    const raw = '{"headline":"h","summary":"s","__proto__":{"polluted":true},"constructor":{"x":1}}';
    const r = validateTaskOutput("summary", raw);
    expect(r.ok).toBe(false);
    expect(has(r, "UNKNOWN_FIELD", "__proto__")).toBe(true);
    expect(has(r, "UNKNOWN_FIELD", "constructor")).toBe(true);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(has(validateTaskOutput("summary", '{"headline":"h","summary":"s","prototype":1}'), "UNKNOWN_FIELD", "prototype")).toBe(true);
  });
  it("N4 deterministic, input not mutated, ok value is a plain copy (B4)", () => {
    const raw = '{"headline":42,"x":1}';
    const a = validateTaskOutput("summary", raw);
    expect(validateTaskOutput("summary", raw)).toEqual(a);
    expect(codes(a)).toEqual(expect.arrayContaining(["WRONG_TYPE", "UNKNOWN_FIELD", "MISSING_FIELD"]));
    expect(raw).toBe('{"headline":42,"x":1}');
    const ok = validateTaskOutput("summary", j({ headline: "h", summary: "s" }));
    expect(ok.ok && Object.keys(ok.value).sort()).toEqual(["headline", "summary"]);
  });
});

describe("validateInferenceSource (B12)", () => {
  it("O12 source_casing", () => {
    expect(has(validateInferenceSource("on_device"), "BAD_SOURCE")).toBe(true);
    for (const v of [undefined, null, 1, {}, "", "ON_DEVICE "]) expect(has(validateInferenceSource(v), "BAD_SOURCE")).toBe(true);
    const r = validateInferenceSource("IN_CLOUD");
    expect(r.ok && r.value).toBe("IN_CLOUD");
    expect(validateInferenceSource("ON_DEVICE").ok).toBe(true);
  });
});

describe("validateCapsuleState (B13)", () => {
  it("O9 private_tier_text", () => {
    expect(has(validateCapsuleState(state({ summary: "secret" }), "private"), "PRIVATE_TEXT")).toBe(true);
    expect(has(validateCapsuleState(state({ headline: "h" }), "private"), "PRIVATE_TEXT")).toBe(true);
    expect(has(validateCapsuleState(state({ next_action: "n" }), "private"), "PRIVATE_TEXT")).toBe(true);
    expect(validateCapsuleState(state(), "private").ok).toBe(true);
    expect(validateCapsuleState(state({ summary: "fine" }), "standard").ok).toBe(true);
    expect(validateCapsuleState(state({ summary: "fine" }), "shared").ok).toBe(true);
  });
  it("N5 bad ints", () => {
    for (const bad of [-1, 1.5, Number.NaN, Infinity, 2 ** 53, "1"]) {
      expect(has(validateCapsuleState(state({ rev: bad }), "standard"), "BAD_INT")).toBe(true);
    }
    expect(has(validateCapsuleState(state({ observed_rev: -1 }), "standard"), "BAD_INT")).toBe(true);
    expect(has(validateCapsuleState(state({ updated_at: 0.5 }), "standard"), "BAD_INT")).toBe(true);
    expect(validateCapsuleState(state({ rev: 0, observed_rev: 0, updated_at: 0 }), "standard").ok).toBe(true);
  });
  it("N6 non-object state, bad enums, bad source never throw", () => {
    for (const s of [null, undefined, 5, "x", []]) {
      let r: Validated<unknown> | undefined;
      expect(() => { r = validateCapsuleState(s, "standard"); }).not.toThrow();
      expect(r!.ok).toBe(false);
    }
    expect(has(validateCapsuleState(state({ status: "paused" }), "standard"), "ENUM_VIOLATION")).toBe(true);
    expect(has(validateCapsuleState(state({ inference_source: "on_device" }), "standard"), "BAD_SOURCE")).toBe(true);
  });
});

describe("validatePatch (B14)", () => {
  it("positive control", () => {
    const r = validatePatch(patch(), "standard");
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.value.fields).toEqual({ status: "done" }); expect(r.value.projectId).toBe("p1"); }
  });
  it("O15b empty_patch and O15c unknown field key", () => {
    expect(has(validatePatch(patch({ fields: {} }), "standard"), "EMPTY_PATCH")).toBe(true);
    expect(has(validatePatch(patch({ fields: { rev: 3 } }), "standard"), "UNKNOWN_FIELD")).toBe(true);
    expect(has(validatePatch(patch({ fields: { status: "done", writer_uid: "x" } }), "standard"), "UNKNOWN_FIELD")).toBe(true);
  });
  it("N7 field value checks (B8-B10) and ints", () => {
    expect(has(validatePatch(patch({ fields: { headline: A(121) } }), "standard"), "TOO_LONG")).toBe(true);
    expect(has(validatePatch(patch({ fields: { status: "nope" } }), "standard"), "ENUM_VIOLATION")).toBe(true);
    expect(has(validatePatch(patch({ fields: { attention: "NOW" } }), "standard"), "ENUM_VIOLATION")).toBe(true);
    expect(has(validatePatch(patch({ fields: { summary: "x\u0000" } }), "standard"), "CONTROL_CHAR")).toBe(true);
    expect(has(validatePatch(patch({ fields: { summary: 5 } }), "standard"), "WRONG_TYPE")).toBe(true);
    expect(has(validatePatch(patch({ base_rev: -1 }), "standard"), "BAD_INT")).toBe(true);
    expect(has(validatePatch(patch({ observed_rev: 1.2 }), "standard"), "BAD_INT")).toBe(true);
    expect(has(validatePatch(patch({ inference_source: "cloud" }), "standard"), "BAD_SOURCE")).toBe(true);
  });
  it("N8 prompt_version / template_hash must be non-empty strings", () => {
    expect(validatePatch(patch({ prompt_version: "" }), "standard").ok).toBe(false);
    expect(validatePatch(patch({ template_hash: "" }), "standard").ok).toBe(false);
    expect(validatePatch(patch({ prompt_version: 1 }), "standard").ok).toBe(false);
  });
  it("N9 private tier blocks text in patch fields, allows status/attention", () => {
    expect(has(validatePatch(patch({ fields: { summary: "s" } }), "private"), "PRIVATE_TEXT")).toBe(true);
    expect(validatePatch(patch({ fields: { status: "done", attention: "now" } }), "private").ok).toBe(true);
  });
  it("N10 non-object patch / prototype keys never throw", () => {
    for (const p of [null, 1, "x", []]) {
      let r: Validated<unknown> | undefined;
      expect(() => { r = validatePatch(p, "standard"); }).not.toThrow();
      expect(r!.ok).toBe(false);
    }
    const evil = JSON.parse('{"projectId":"p1","base_rev":1,"observed_rev":1,"prompt_version":"v","template_hash":"h","inference_source":"ON_DEVICE","fields":{"status":"done","__proto__":{"x":1}}}');
    expect(has(validatePatch(evil, "standard"), "UNKNOWN_FIELD")).toBe(true);
  });
});

describe("TASK_SCHEMAS (B1-B3)", () => {
  const ALLOWED = new Set(["type", "properties", "required", "items", "enum", "nullable"]);
  const walk = (s: JsonSchema, visit: (s: JsonSchema) => void): void => {
    visit(s);
    for (const p of Object.values(s.properties ?? {})) walk(p, visit);
    if (s.items) walk(s.items, visit);
  };
  const deepFrozen = (o: unknown): boolean =>
    typeof o !== "object" || o === null || (Object.isFrozen(o) && Object.values(o).every(deepFrozen));

  it("O14 schema_shape", () => {
    expect(Object.keys(TASK_SCHEMAS).sort()).toEqual(["digest", "next_action", "screenshot", "status", "summary"]);
    expect(TASK_SCHEMAS.status.mimeType).toBe("text/x.enum");
    expect(TASK_SCHEMAS.status.schema).toEqual({ type: "string", enum: [...CAPSULE_STATUS], nullable: false });
    for (const k of ["summary", "next_action", "screenshot", "digest"] as const) {
      expect(TASK_SCHEMAS[k].mimeType).toBe("application/json");
      expect(TASK_SCHEMAS[k].schema.type).toBe("object");
    }
    for (const t of Object.values(TASK_SCHEMAS)) {
      walk(t.schema, (n) => {
        for (const key of Object.keys(n)) expect(ALLOWED.has(key)).toBe(true);
        expect(n.nullable).toBe(false);
        if (n.type === "object") {
          expect(Object.keys(n.properties ?? {}).sort()).toEqual([...(n.required ?? [])].sort());
          expect((n.required ?? []).length).toBeGreaterThan(0);
        }
      });
      expect(deepFrozen(t)).toBe(true);
    }
    expect(Object.isFrozen(TASK_SCHEMAS)).toBe(true);
  });
  it("B1 property names match the output types", () => {
    const props = (k: "summary" | "next_action" | "screenshot" | "digest") => Object.keys(TASK_SCHEMAS[k].schema.properties ?? {}).sort();
    expect(props("summary")).toEqual(["headline", "summary"]);
    expect(props("next_action")).toEqual(["attention", "next_action"]);
    expect(props("screenshot")).toEqual(["note", "status"]);
    expect(props("digest")).toEqual(["brief", "needs_you"]);
    const nu = TASK_SCHEMAS.digest.schema.properties?.["needs_you"];
    expect(nu?.type).toBe("array");
    expect(nu?.items?.type).toBe("object");
    expect(Object.keys(nu?.items?.properties ?? {}).sort()).toEqual(["attention", "projectId", "reason"]);
    expect(TASK_SCHEMAS.next_action.schema.properties?.["attention"]?.enum).toEqual([...ATTENTION]);
  });
  it("B3 exports are tamper-proof", () => {
    expect(() => { (TASK_SCHEMAS.summary.schema as { type: string }).type = "string"; }).toThrow();
    expect(TASK_SCHEMAS.summary.schema.type).toBe("object");
  });
});
