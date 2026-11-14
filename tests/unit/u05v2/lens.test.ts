import { describe, expect, it } from "vitest";
import {
  CAPSULE_STATUS, DEV_LENS, LENS_ID_RE, LIMITS, STATUS_RE, STEP_STATE, TASK_SCHEMAS,
  taskSchemasFor, validateLensVocab,
} from "../../../src/schema/index";
import { getLens } from "../../../src/lens/index";
import { A, B2_KEYWORDS, STUDY, deepFrozen, has, j, pairs, sample, vTask, walk } from "./helpers";
import type { V } from "./helpers";

const lensOf = (id: string, statuses: unknown): unknown => ({ lens_id: id, statuses });
const noThrow = <T>(f: () => T): T => { let r!: T; expect(() => { r = f(); }).not.toThrow(); return r; };

describe("constants (spec 2)", () => {
  it("new limits and enums; v1 vocabulary untouched", () => {
    expect(LIMITS).toMatchObject({
      STEPS_MAX: 5, STEP_TEXT_MAX: 80, PROGRESS_MIN: 0, PROGRESS_MAX: 100, LENS_STATUSES_MAX: 8,
      HEADLINE_MAX: 120, SUMMARY_MAX: 600, NEXT_ACTION_MAX: 160, NOTE_MAX: 140, BRIEF_MAX: 600,
      REASON_MAX: 160, NEEDS_YOU_MAX: 12, RAW_MAX: 8192,
    });
    expect([...STEP_STATE]).toEqual(["todo", "doing", "done"]);
    expect([...CAPSULE_STATUS]).toEqual(["running", "waiting_input", "blocked", "failed", "done", "idle"]);
  });
  it("LENS_ID_RE and STATUS_RE (TARGET patterns)", () => {
    for (const ok of ["dev", "study", "a", "a" + "b".repeat(15), "a-1", "x9-y"]) expect(LENS_ID_RE.test(ok)).toBe(true);
    for (const bad of ["", "Study", "1a", "-a", "a b", "a_b", "a" + "b".repeat(16), "Study 1", "étude"]) expect(LENS_ID_RE.test(bad)).toBe(false);
    for (const ok of ["done", "not_started", "a", "a" + "b".repeat(23)]) expect(STATUS_RE.test(ok)).toBe(true);
    for (const bad of ["", "Done!", "Done", "1x", "_x", "a-b", "a b", "a" + "b".repeat(24)]) expect(STATUS_RE.test(bad)).toBe(false);
  });
  it("DEV_LENS is the deep-frozen dev vocabulary", () => {
    expect(DEV_LENS.lens_id).toBe("dev");
    expect([...DEV_LENS.statuses]).toEqual([...CAPSULE_STATUS]);
    expect(deepFrozen(DEV_LENS)).toBe(true);
    expect(noThrow(() => validateLensVocab(DEV_LENS)).ok).toBe(true);
  });
});

describe("V8 bad_lens (B16)", () => {
  const nine = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
  const bad: Array<[string, unknown]> = [
    ["9 statuses", lensOf("study", nine)],
    ["duplicate status", lensOf("study", ["done", "reading", "done"])],
    ["status Done!", lensOf("study", ["reading", "Done!"])],
    ["lens_id 'Study 1'", lensOf("Study 1", ["reading", "done"])],
    ["lens_id 17 chars", lensOf("a" + "b".repeat(16), ["done"])],
    ["status 25 chars", lensOf("study", ["a" + "b".repeat(24)])],
    ["status leading digit", lensOf("study", ["1x"])],
    ["empty statuses", lensOf("study", [])],
    ["statuses not array", lensOf("study", "done")],
    ["non-string status", lensOf("study", [1])],
    ["extra key", { lens_id: "study", statuses: ["done"], label: "Study" }],
    ["missing statuses", { lens_id: "study" }],
    ["missing lens_id", { statuses: ["done"] }],
    ["null", null], ["array", []], ["string", "study"], ["undefined", undefined],
  ];
  it.each(bad)("validateLensVocab rejects %s with BAD_LENS, no throw", (_n, input) => {
    const r = noThrow(() => validateLensVocab(input));
    expect(r.ok).toBe(false);
    expect(has(r as V, "BAD_LENS")).toBe(true);
  });
  it("boundaries accepted: 8 statuses, 16-char id, 24-char status", () => {
    expect(validateLensVocab(lensOf("a" + "b".repeat(15), nine.slice(0, 8))).ok).toBe(true);
    expect(validateLensVocab(lensOf("study", ["a" + "b".repeat(23)])).ok).toBe(true);
    const r = validateLensVocab(STUDY);
    expect(r.ok && r.value).toEqual(STUDY);
  });
  it("U25 registry lenses project to a valid LensVocab (structural subset)", () => {
    for (const id of ["dev", "study"]) {
      const l = getLens(id);
      expect(l).toBeDefined();
      const proj = { lens_id: l!.lens_id, statuses: l!.statuses };
      expect(validateLensVocab(proj).ok).toBe(true);
    }
  });
  it("taskSchemasFor rejects each bad lens with BAD_LENS, no throw", () => {
    for (const [, input] of bad) {
      const r = noThrow(() => taskSchemasFor(input as never));
      expect(r.ok).toBe(false);
      expect(has(r as V, "BAD_LENS")).toBe(true);
    }
  });
  it("same lens_id re-registered with 5 statuses -> BAD_LENS (memo conflict)", () => {
    expect(taskSchemasFor(STUDY).ok).toBe(true);
    const five = lensOf("study", STUDY.statuses.slice(0, 5));
    const r = noThrow(() => taskSchemasFor(five as never));
    expect(r.ok).toBe(false);
    expect(has(r as V, "BAD_LENS")).toBe(true);
    expect(taskSchemasFor(STUDY).ok).toBe(true); // original unharmed
  });
  it("validateTaskOutput with an invalid ctx.lens -> BAD_LENS at path lens, nothing else", () => {
    const r = vTask("status", "done", { lens: lensOf("Study 1", ["done"]) as never });
    expect(r.ok).toBe(false);
    expect(pairs(r)).toEqual(["lens:BAD_LENS"]);
  });
});

describe("V7 schemas_for_lens (B1-B3)", () => {
  it("six keys, status enum = lens statuses, plan shape, frozen, memoised", () => {
    const r1 = taskSchemasFor(STUDY);
    const r2 = taskSchemasFor(STUDY);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    const t = r1.value;
    expect(Object.keys(t).sort()).toEqual(["digest", "next_action", "plan", "screenshot", "status", "summary"]);
    expect(t.status.mimeType).toBe("text/x.enum");
    expect(t.status.schema).toEqual({ type: "string", enum: [...STUDY.statuses], nullable: false });
    expect(t.screenshot.schema.properties?.["status"]?.enum).toEqual([...STUDY.statuses]);
    expect(t.plan.mimeType).toBe("application/json");
    const p = t.plan.schema;
    expect(p.type).toBe("object");
    expect(Object.keys(p.properties ?? {}).sort()).toEqual(["progress", "steps"]);
    expect(p.properties?.["progress"]).toEqual({ type: "number", nullable: false });
    const st = p.properties?.["steps"];
    expect(st?.type).toBe("array");
    expect(st?.items?.type).toBe("object");
    expect(Object.keys(st?.items?.properties ?? {}).sort()).toEqual(["state", "text"]);
    expect(st?.items?.properties?.["text"]).toEqual({ type: "string", nullable: false });
    expect(st?.items?.properties?.["state"]?.enum).toEqual([...STEP_STATE]);
    for (const x of Object.values(t)) {
      walk(x.schema, (n) => {
        for (const k of Object.keys(n)) expect(B2_KEYWORDS.has(k)).toBe(true);
        expect(n.nullable).toBe(false);
        if (n.type === "object") expect(Object.keys(n.properties ?? {}).sort()).toEqual([...(n.required ?? [])].sort());
      });
      expect(deepFrozen(x)).toBe(true);
    }
    expect(deepFrozen(t)).toBe(true);
    expect(r1.value).toBe(r2.value);
    const copy = taskSchemasFor({ lens_id: "study", statuses: [...STUDY.statuses] });
    expect(copy.ok && copy.value).toBe(r1.value); // memoised by lens_id, equal input
    expect(() => { (t.plan.schema as { type: string }).type = "string"; }).toThrow();
  });
  it("TASK_SCHEMAS stays the 5-key dev export = taskSchemasFor(DEV_LENS) minus plan", () => {
    expect(Object.keys(TASK_SCHEMAS).sort()).toEqual(["digest", "next_action", "screenshot", "status", "summary"]);
    const d = taskSchemasFor(DEV_LENS);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const { plan, ...rest } = d.value;
    expect(plan.mimeType).toBe("application/json");
    expect(rest).toEqual(TASK_SCHEMAS);
    expect(d.value.status.schema.enum).toEqual([...CAPSULE_STATUS]);
  });
  it("dev result differs from study only in the status enums", () => {
    const d = taskSchemasFor(DEV_LENS);
    const s = taskSchemasFor(STUDY);
    if (!d.ok || !s.ok) throw new Error("schemas");
    for (const k of ["summary", "next_action", "digest", "plan"] as const) expect(s.value[k]).toEqual(d.value[k]);
    expect(s.value.status).not.toEqual(d.value.status);
  });
  it("study plan/status schemas deep-equal the admitted U25 study descriptor", () => {
    const desc = getLens("study");
    const s = taskSchemasFor(STUDY);
    if (!s.ok || !desc) throw new Error("setup");
    expect(s.value.plan).toEqual(desc.task_schemas.plan);
    expect(s.value.status).toEqual(desc.task_schemas.status);
    expect(s.value.summary).toEqual(desc.task_schemas.summary);
    expect(s.value.digest).toEqual(desc.task_schemas.digest);
  });
});

describe("plan schema as on-device responseConstraint and cloud responseSchema (B2/B3)", () => {
  const T = () => { const r = taskSchemasFor(STUDY); if (!r.ok) throw new Error("schemas"); return r.value; };
  it("is pure JSON data restricted to the portable keyword subset (identical object serves both SDKs)", () => {
    const plan = T().plan;
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
    const types = new Set<string>();
    walk(plan.schema, (n) => {
      types.add(n.type);
      for (const forbidden of ["additionalProperties", "minimum", "maximum", "maxItems", "minItems", "maxLength", "$schema", "format", "pattern", "oneOf", "anyOf", "$ref"])
        expect(Object.hasOwn(n, forbidden)).toBe(false);
    });
    expect([...types].sort()).toEqual(["array", "number", "object", "string"]); // no "integer": range/int live in the validator
    expect(plan.mimeType).toBe("application/json"); // responseMimeType for the cloud; JSON constraint on device
  });
  it("every task's minimal schema instance is accepted by the validator (schema/validator parity)", () => {
    for (const [task, ts] of Object.entries(T())) {
      const inst = sample(ts.schema);
      const raw = typeof inst === "string" ? inst : j(inst);
      const r = vTask(task, raw, { lens: STUDY });
      expect(r.ok, `${task}: ${j(r)}`).toBe(true);
    }
  });
  it("a schema-conformant plan with maximal steps is accepted; the validator is stricter than the schema where documented", () => {
    const max = { steps: Array.from({ length: 5 }, () => ({ text: A(80), state: "doing" })), progress: 55 };
    expect(vTask("plan", j(max), { lens: STUDY }).ok).toBe(true);
    // schema (B2) cannot express these; validator must (B18/B19)
    expect(has(vTask("plan", j({ steps: [], progress: 12.5 }), { lens: STUDY }), "BAD_INT", "progress")).toBe(true);
    expect(has(vTask("plan", j({ steps: [], progress: 1000 }), { lens: STUDY }), "OUT_OF_RANGE", "progress")).toBe(true);
  });
});
