import { describe, expect, it } from "vitest";
import { DEV_LENS, validateLensVocab } from "../../../src/schema/index";
import { A, STUDY, has, j, pairs, patch, state, step, steps, studyPatch, studyState, vPatch, vState, vTask } from "./helpers";
import type { V } from "./helpers";

const plan = (stepsV: unknown, progress: unknown = 10) => j({ steps: stepsV, progress });
const P = (raw: string, lens = STUDY) => vTask("plan", raw, { lens });

describe("V1 study_status_ok / V2 dev_status_under_study (B6, B8, B17)", () => {
  it("V1 review_due accepted under STUDY (bare and JSON-quoted)", () => {
    for (const raw of ["review_due", '"review_due"', "review_due\n"]) {
      const r = vTask("status", raw, { lens: STUDY });
      expect(r.ok, raw).toBe(true);
      expect(r.ok && r.value.status).toBe("review_due");
    }
    expect(vTask("screenshot", j({ status: "stuck", note: "n" }), { lens: STUDY }).ok).toBe(true);
  });
  it("V2 STRATEGY oracle: dev status rejected under study, accepted by default; shared 'done' is not the negative", () => {
    expect(has(vTask("status", "blocked", { lens: STUDY }), "ENUM_VIOLATION")).toBe(true);
    expect(has(vTask("status", '"blocked"', { lens: STUDY }), "ENUM_VIOLATION")).toBe(true);
    expect(has(vTask("screenshot", j({ status: "blocked", note: "n" }), { lens: STUDY }), "ENUM_VIOLATION", "status")).toBe(true);
    const dflt = vTask("status", "blocked");
    expect(dflt.ok && dflt.value.status).toBe("blocked");
    expect(vTask("status", "blocked", { lens: DEV_LENS }).ok).toBe(true);
    expect(vTask("status", "done", { lens: STUDY }).ok).toBe(true);
  });
  it("study vocabulary is rejected under dev (default and explicit)", () => {
    for (const s of ["reading", "review_due", "not_started", "stuck"]) {
      expect(has(vTask("status", s), "ENUM_VIOLATION"), s).toBe(true);
      expect(has(vTask("status", s, { lens: DEV_LENS }), "ENUM_VIOLATION"), s).toBe(true);
      expect(has(vTask("status", s, { lens: STUDY }), "ENUM_VIOLATION"), s).toBe(false);
    }
  });
  it("study vocabulary accepted ONLY under study: state and patch", () => {
    expect(vState(studyState({ status: "practising" }), "standard", STUDY).ok).toBe(true);
    expect(has(vState(state({ status: "practising" }), "standard"), "ENUM_VIOLATION", "status")).toBe(true);
    expect(has(vState(state({ lens_id: "dev", status: "practising" }), "standard", DEV_LENS), "ENUM_VIOLATION", "status")).toBe(true);
    expect(vPatch(studyPatch({ status: "review_due" }), "standard", STUDY).ok).toBe(true);
    expect(has(vPatch(patch({ fields: { status: "review_due" } }), "standard"), "ENUM_VIOLATION", "fields.status")).toBe(true);
    expect(has(vPatch(studyPatch({ status: "blocked" }), "standard", STUDY), "ENUM_VIOLATION", "fields.status")).toBe(true);
    expect(has(vState(studyState({ status: "running" }), "standard", STUDY), "ENUM_VIOLATION", "status")).toBe(true);
  });
  it("a lens's statuses decide membership (custom lens, never cross-checked)", () => {
    const L = { lens_id: "triage", statuses: ["open", "closed"] };
    expect(validateLensVocab(L).ok).toBe(true);
    expect(vTask("status", "open", { lens: L }).ok).toBe(true);
    expect(has(vTask("status", "done", { lens: L }), "ENUM_VIOLATION")).toBe(true);
    expect(has(vTask("status", "reading", { lens: L }), "ENUM_VIOLATION")).toBe(true);
  });
});

describe("plan task output (B18)", () => {
  it("V3 plan_boundary_ok: 5 x 80 chars mixed states / empty plan; values copied, not truncated", () => {
    const five = ["todo", "doing", "done", "todo", "doing"].map((s) => step(s, A(80)));
    const r = P(plan(five, 100));
    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toEqual({ steps: five, progress: 100 });
    const e = P(plan([], 0));
    expect(e.ok && e.value).toEqual({ steps: [], progress: 0 });
    expect(vTask("plan", plan(five, 100)).ok).toBe(true); // lens optional (dev default); plan is lens-independent
  });
  it("V4 plan_six_steps (STRATEGY oracle): TOO_MANY_ITEMS at steps", () => {
    const r = P(plan(steps(6)));
    expect(r.ok).toBe(false);
    expect(has(r, "TOO_MANY_ITEMS", "steps")).toBe(true);
    expect(P(plan(steps(5))).ok).toBe(true);
    expect(P(plan(steps(100))).ok).toBe(false);
  });
  it("V5 step_fields: exact errors, sorted, no truncation", () => {
    const bad = [
      { text: A(81), state: "todo" },
      { text: "ok", state: "in_progress" },
      { text: "ok", state: "todo", url: "http://x" },
      { text: "go\u0007", state: "done" },
    ];
    const r = P(plan(bad));
    expect(pairs(r)).toEqual([
      "steps[0].text:TOO_LONG", "steps[1].state:ENUM_VIOLATION", "steps[2].url:UNKNOWN_FIELD", "steps[3].text:CONTROL_CHAR",
    ]);
    expect(P(plan([step("todo", A(80)), step("todo", "a\nb\tc")])).ok).toBe(true); // \n \t allowed (B10)
    expect(has(P(plan([step("todo", "a\u007fb")])), "CONTROL_CHAR", "steps[0].text")).toBe(true);
  });
  it("step shape: missing keys, wrong types, non-object step, prototype keys", () => {
    expect(has(P(plan([{ text: "x" }])), "MISSING_FIELD", "steps[0].state")).toBe(true);
    expect(has(P(plan([{ state: "todo" }])), "MISSING_FIELD", "steps[0].text")).toBe(true);
    expect(has(P(plan([{ text: 5, state: "todo" }])), "WRONG_TYPE", "steps[0].text")).toBe(true);
    expect(has(P(plan([{ text: "x", state: 1 }])), "WRONG_TYPE", "steps[0].state")).toBe(true);
    expect(has(P(plan(["read"])), "WRONG_TYPE", "steps[0]")).toBe(true);
    expect(has(P(plan([null])), "WRONG_TYPE", "steps[0]")).toBe(true);
    expect(has(P(plan([step()])), "ENUM_VIOLATION")).toBe(false);
    expect(has(P(plan([step("Done")])), "ENUM_VIOLATION", "steps[0].state")).toBe(true);
    const evil = '{"steps":[{"text":"x","state":"todo","__proto__":{"p":1}}],"progress":1}';
    expect(has(P(evil), "UNKNOWN_FIELD", "steps[0].__proto__")).toBe(true);
    expect(({} as Record<string, unknown>)["p"]).toBeUndefined();
  });
  it("top level: both keys required, unknown keys rejected, steps must be array, parse/size errors", () => {
    expect(has(P(j({ progress: 1 })), "MISSING_FIELD", "steps")).toBe(true);
    expect(has(P(j({ steps: [] })), "MISSING_FIELD", "progress")).toBe(true);
    expect(has(P(j({ steps: [], progress: 1, note: "x" })), "UNKNOWN_FIELD", "note")).toBe(true);
    expect(has(P(j({ steps: "todo", progress: 1 })), "WRONG_TYPE", "steps")).toBe(true);
    expect(has(P(j({ steps: {}, progress: 1 })), "WRONG_TYPE", "steps")).toBe(true);
    expect(has(P(j({ steps: null, progress: 1 })), "WRONG_TYPE", "steps")).toBe(true);
    let r: V | undefined;
    expect(() => { r = P('{"steps":[{"text":"re'); }).not.toThrow();
    expect(has(r!, "PARSE_ERROR")).toBe(true);
    for (const raw of ["[]", "null", "5", '"x"']) expect(has(P(raw), "NOT_OBJECT"), raw).toBe(true);
    expect(has(P(" ".repeat(9000)), "TOO_LARGE_RAW")).toBe(true);
    expect(has(P(""), "EMPTY")).toBe(true);
  });
  it("B20: no derived consistency between progress and step states", () => {
    expect(P(plan([step("done"), step("done")], 0)).ok).toBe(true);
    expect(P(plan([step("todo")], 100)).ok).toBe(true);
    expect(P(plan([], 100)).ok).toBe(true);
  });
  it("determinism: input untouched, same result twice", () => {
    const raw = plan(steps(6), 101.5);
    expect(P(raw)).toEqual(P(raw));
    expect(pairs(P(raw))).toEqual(["progress:BAD_INT", "steps:TOO_MANY_ITEMS"]);
    expect(raw).toBe(plan(steps(6), 101.5));
  });
});

describe("V6 progress_bounds (B19)", () => {
  const table: Array<[string, string, string]> = [
    ["101", "101", "OUT_OF_RANGE"], ["-1", "-1", "OUT_OF_RANGE"], ["42.5", "42.5", "BAD_INT"],
    ['"50"', '"50"', "WRONG_TYPE"], ["null", "null", "WRONG_TYPE"], ["true", "true", "WRONG_TYPE"],
    ["[]", "[]", "WRONG_TYPE"], ["0.1", "0.1", "BAD_INT"], ["99.999", "99.999", "BAD_INT"],
  ];
  it.each(table)("plan task: progress %s -> %s at progress", (_n, lit, code) => {
    const r = P(`{"steps":[],"progress":${lit}}`);
    expect(pairs(r)).toEqual([`progress:${code}`]);
  });
  it("plan task: missing progress -> MISSING_FIELD; 0 and 100 and 1 accepted", () => {
    expect(pairs(P(j({ steps: [] })))).toEqual(["progress:MISSING_FIELD"]);
    for (const n of [0, 1, 50, 99, 100]) expect(P(plan([], n)).ok, String(n)).toBe(true);
    for (const n of [-0.0, 100.0]) expect(P(plan([], n)).ok).toBe(true);
  });
  it("same rule in CapsuleState (path progress) and patches (path fields.progress)", () => {
    const cases: Array<[unknown, string]> = [[101, "OUT_OF_RANGE"], [-1, "OUT_OF_RANGE"], [42.5, "BAD_INT"], ["50", "WRONG_TYPE"], [Number.NaN, "BAD_INT"]];
    for (const [v, code] of cases) {
      expect(has(vState(studyState({ progress: v }), "standard", STUDY), code, "progress"), `state ${String(v)}`).toBe(true);
      expect(has(vPatch(studyPatch({ progress: v }), "standard", STUDY), code, "fields.progress"), `patch ${String(v)}`).toBe(true);
    }
    for (const n of [0, 100]) {
      expect(vState(studyState({ progress: n }), "standard", STUDY).ok).toBe(true);
      expect(vPatch(studyPatch({ progress: n }), "standard", STUDY).ok).toBe(true);
    }
  });
  it("progress bounds hold in the private tier too", () => {
    expect(has(vState(studyState({ progress: 101 }), "private", STUDY), "OUT_OF_RANGE")).toBe(true);
    expect(has(vPatch(studyPatch({ progress: -5 }), "private", STUDY), "OUT_OF_RANGE")).toBe(true);
    expect(vState(studyState({ progress: 100 }), "private", STUDY).ok).toBe(true);
  });
});

describe("CapsuleState lens_id / steps / progress (B9-B11, B17, B21)", () => {
  it("valid study state keeps lens_id, steps, progress verbatim", () => {
    const input = studyState({ headline: "h", steps: steps(5), progress: 40 });
    const r = vState(input, "standard", STUDY);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toEqual(input);
    expect(vState(studyState({ steps: [] }), "shared", STUDY).ok).toBe(true);
  });
  it("step errors in state carry steps[i].field paths", () => {
    const bad = [step(), { text: A(81), state: "bogus", extra: 1 }];
    expect(pairs(vState(studyState({ steps: bad }), "standard", STUDY))).toEqual([
      "steps[1].extra:UNKNOWN_FIELD", "steps[1].state:ENUM_VIOLATION", "steps[1].text:TOO_LONG",
    ]);
    expect(has(vState(studyState({ steps: steps(6) }), "standard", STUDY), "TOO_MANY_ITEMS", "steps")).toBe(true);
    expect(has(vState(studyState({ steps: "x" }), "standard", STUDY), "WRONG_TYPE", "steps")).toBe(true);
    expect(has(vState(studyState({ steps: [step("todo", "a\u0000")] }), "standard", STUDY), "CONTROL_CHAR", "steps[0].text")).toBe(true);
  });
  it("V9 private_steps: step text is private text; progress and lens_id are not", () => {
    const withSteps = studyState({ steps: [step("todo", "read ch2")], progress: 40 });
    const r = vState(withSteps, "private", STUDY);
    expect(r.ok).toBe(false);
    expect(has(r, "PRIVATE_TEXT", "steps")).toBe(true);
    const bare = studyState({ progress: 40 });
    const ok = vState(bare, "private", STUDY);
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.value.progress).toBe(40);
    expect(ok.ok && ok.value.lens_id).toBe("study");
    expect(ok.ok && ok.value.status).toBe("reading");
  });
  it("private tier: steps:[] still PRIVATE_TEXT; standard/shared allow steps; text fields still blocked", () => {
    expect(has(vState(studyState({ steps: [] }), "private", STUDY), "PRIVATE_TEXT", "steps")).toBe(true);
    for (const t of ["standard", "shared"] as const) expect(vState(studyState({ steps: steps(2) }), t, STUDY).ok).toBe(true);
    for (const f of ["headline", "summary", "next_action"]) expect(has(vState(studyState({ [f]: "x" }), "private", STUDY), "PRIVATE_TEXT", f)).toBe(true);
  });
  it("private tier rejects step text before/alongside length checks, and unknown tiers fail closed", () => {
    const r = vState(studyState({ steps: [step("todo", A(81))] }), "private", STUDY);
    expect(has(r, "PRIVATE_TEXT", "steps")).toBe(true);
    expect(has(vState(studyState({ steps: steps(1) }), "weird" as never, STUDY), "PRIVATE_TEXT", "steps")).toBe(true);
  });
  it("V10 lens_mismatch (state): explicit lens_id differing from the lens", () => {
    expect(has(vState(state({ lens_id: "dev", status: "done" }), "standard", STUDY), "LENS_MISMATCH")).toBe(true);
    expect(has(vState(studyState({ status: "done" }), "standard", DEV_LENS), "LENS_MISMATCH")).toBe(true);
    expect(has(vState(studyState({ status: "done" }), "standard"), "LENS_MISMATCH")).toBe(true);
    expect(vState(studyState(), "standard", STUDY).ok).toBe(true);
    expect(vState(state({ lens_id: "dev" }), "standard", DEV_LENS).ok).toBe(true);
    expect(has(vState(studyState({ lens_id: 5 }), "standard", STUDY), "WRONG_TYPE", "lens_id")).toBe(true);
  });
  it("V11 legacy_dev_default (state): absent lens_id reads as dev, input not mutated", () => {
    const input = state();
    const snap = j(input);
    const r = vState(input, "standard");
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.lens_id).toBe("dev");
    expect(r.ok && r.value).toEqual({ ...input, lens_id: "dev" });
    expect(j(input)).toBe(snap);
    expect(Object.hasOwn(input, "lens_id")).toBe(false);
    expect(vState(input, "standard", DEV_LENS).ok).toBe(true);
    expect(has(vState(input, "standard", STUDY), "LENS_MISMATCH")).toBe(true);
  });
  it("BAD_LENS precedes everything else (path lens, sole error), for state and patch", () => {
    const badLens = { lens_id: "Study 1", statuses: ["done"] };
    const s = vState({ nonsense: 1 }, "standard", badLens);
    expect(pairs(s)).toEqual(["lens:BAD_LENS"]);
    expect(pairs(vPatch({ nonsense: 1 }, "standard", badLens))).toEqual(["lens:BAD_LENS"]);
    expect(pairs(vState(null, "standard", badLens))).toEqual(["lens:BAD_LENS"]);
    expect(pairs(vState(state(), "standard", { lens_id: "dev", statuses: [] }))).toEqual(["lens:BAD_LENS"]);
  });
});

describe("CapsulePatch (B13, B14, B17)", () => {
  it("V12a steps + progress accepted; steps replace the whole array; value copied", () => {
    const f = { steps: steps(3), progress: 30 };
    const r = vPatch(studyPatch(f), "standard", STUDY);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.fields).toEqual(f);
    expect(r.ok && r.value.lens_id).toBe("study");
    expect(vPatch(studyPatch({ steps: [] }), "standard", STUDY).ok).toBe(true); // clear all steps
    expect(vPatch(studyPatch({ steps: steps(5), status: "stuck", attention: "high", headline: "h" }), "shared", STUDY).ok).toBe(true);
  });
  it("V12b lens_id inside fields is UNKNOWN_FIELD", () => {
    expect(has(vPatch(patch({ fields: { lens_id: "dev" } }), "standard"), "UNKNOWN_FIELD", "fields.lens_id")).toBe(true);
    expect(pairs(vPatch(studyPatch({ lens_id: "study", status: "done" }), "standard", STUDY))).toEqual(["fields.lens_id:UNKNOWN_FIELD"]);
  });
  it("V12c private patch with progress only is ok; V12d with steps is PRIVATE_TEXT", () => {
    expect(vPatch(studyPatch({ progress: 30 }), "private", STUDY).ok).toBe(true);
    expect(vPatch(studyPatch({ progress: 30, status: "reading", attention: "low" }), "private", STUDY).ok).toBe(true);
    expect(has(vPatch(studyPatch({ steps: steps(2) }), "private", STUDY), "PRIVATE_TEXT", "fields.steps")).toBe(true);
    expect(has(vPatch(studyPatch({ steps: [] }), "private", STUDY), "PRIVATE_TEXT", "fields.steps")).toBe(true);
    expect(has(vPatch(studyPatch({ steps: steps(1), progress: 5 }), "private", STUDY), "PRIVATE_TEXT")).toBe(true);
  });
  it("patch step errors use fields.steps[i].x paths; per-index patch is impossible", () => {
    const bad = [step(), { text: A(81), state: "todo" }, { text: "x", state: "nope" }];
    expect(pairs(vPatch(studyPatch({ steps: bad }), "standard", STUDY))).toEqual([
      "fields.steps[1].text:TOO_LONG", "fields.steps[2].state:ENUM_VIOLATION",
    ]);
    expect(has(vPatch(studyPatch({ steps: steps(6) }), "standard", STUDY), "TOO_MANY_ITEMS", "fields.steps")).toBe(true);
    expect(has(vPatch(studyPatch({ steps: { 0: step() } }), "standard", STUDY), "WRONG_TYPE", "fields.steps")).toBe(true);
    expect(has(vPatch(studyPatch({ "steps[0]": step() }), "standard", STUDY), "UNKNOWN_FIELD")).toBe(true);
    expect(has(vPatch(studyPatch({ "steps.0.text": "x" }), "standard", STUDY), "UNKNOWN_FIELD")).toBe(true);
  });
  it("V10 lens_mismatch (patch): study lens_id validated with no lens", () => {
    expect(has(vPatch(patch({ lens_id: "study" }), "standard"), "LENS_MISMATCH")).toBe(true);
    expect(has(vPatch(patch({ lens_id: "dev" }), "standard", STUDY), "LENS_MISMATCH")).toBe(true);
    expect(has(vPatch(patch({ lens_id: 7 }), "standard", STUDY), "WRONG_TYPE", "lens_id")).toBe(true);
  });
  it("V11 legacy_dev_default (patch): absent lens_id -> dev, not mutated; study lens mismatches", () => {
    const input = patch({ fields: { status: "done" } });
    const snap = j(input);
    const r = vPatch(input, "standard");
    expect(r.ok && r.value.lens_id).toBe("dev");
    expect(j(input)).toBe(snap);
    expect(Object.hasOwn(input, "lens_id")).toBe(false);
    expect(has(vPatch(input, "standard", STUDY), "LENS_MISMATCH")).toBe(true);
  });
  it("patch statuses are lens-checked; empty fields still EMPTY_PATCH", () => {
    expect(has(vPatch(studyPatch({}), "standard", STUDY), "EMPTY_PATCH")).toBe(true);
    expect(has(vPatch(studyPatch({ status: "waiting_input" }), "standard", STUDY), "ENUM_VIOLATION", "fields.status")).toBe(true);
  });
});
