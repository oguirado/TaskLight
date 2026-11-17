// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyOp, checkConformance, validateOpEvent, validateTemplate } from "../../../src/plan";
import type { PlanningTemplate, PlanProjection, TemplateRejectCode } from "../../../src/plan";
import { add, clone, event, freeze, open, projection, template, templates } from "./helpers";

function rawTemplate(): Record<string, unknown> {
  const raw = clone(template) as unknown as Record<string, unknown>; delete raw["hash"]; return raw;
}
function templateFailure(raw: unknown, code: TemplateRejectCode) {
  const r = validateTemplate(raw); expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.map(e => e.code)).toContain(code);
}

describe("T1 planning template validation", () => {
  for (const starter of templates)
    it(`T1 starter ${starter.id} accepts normalized hash`, () => {
      const r = validateTemplate(freeze(clone(starter))); expect(r.ok).toBe(true);
      if (r.ok) expect(r.template.id).toBe(starter.id);
    });
  it("T1 raw starter without computed hash accepted", () => expect(validateTemplate(rawTemplate()).ok).toBe(true));
  const bad: [string, Record<string, unknown>, TemplateRejectCode][] = [
    ["version", {v: 2}, "BAD_VERSION"], ["name cap", {name: "x".repeat(41)}, "BAD_NAME"],
    ["unknown field", {surprise: true}, "UNKNOWN_FIELD"],
    ["wrong type", {name: 42}, "WRONG_TYPE"],
    ["phases cap", {phases: Array.from({length: 9}, (_, i) => ({id: `phase${i}`, label: "Phase", exit: "Ready"}))}, "LIMIT_EXCEEDED"],
    ["brief cap", {brief_fields: Array.from({length: 9}, (_, i) => ({id: `field${i}`, label: "Field", required: false}))}, "LIMIT_EXCEEDED"],
    ["task types cap", {task_types: Array.from({length: 13}, (_, i) => ({id: `type${i}`, label: "Type", accept_required: false, evidence_required: false, micro_hints: []}))}, "LIMIT_EXCEEDED"],
    ["memory sections cap", {memory_sections: Array.from({length: 13}, (_, i) => ({id: `memory${i}`, label: "Memory", required: false, max_chars: 100, hint: "Keep"}))}, "LIMIT_EXCEEDED"],
    ["memory chars cap", {memory_sections: [{...template.memory_sections[0]!, max_chars: 2001}]}, "LIMIT_EXCEEDED"],
    ["duplicate id", {phases: [template.phases[0], template.phases[0]]}, "DUPLICATE_ID"],
    ["granularity reversed", {granularity: {...template.granularity, micro_min: 12, micro_max: 1}}, "BAD_GRANULARITY"],
  ];
  for (const [name, patch, code] of bad)
    it(`T1 ${name}: ${code}`, () => templateFailure({...rawTemplate(), ...patch}, code));
  it("T1 missing required field", () => {
    const raw = rawTemplate(); delete raw["phases"]; templateFailure(raw, "MISSING_FIELD");
  });
  for (const value of ["x\u0000", "x\n", "x\t", "x\u001f", "x\u007f"])
    it(`T1 control ${JSON.stringify(value)}`, () => templateFailure({...rawTemplate(), summary: value}, "CONTROL_CHAR"));
  for (const value of ["<script>", "://", "javascript:alert(1)"])
    it(`T1 code-like ${JSON.stringify(value)}`, () => templateFailure({...rawTemplate(), summary: value}, "CODE_LIKE"));
  it("T1 nested text safety", () => templateFailure({...rawTemplate(), memory_sections: [{...template.memory_sections[0]!, hint: "<script>"}]}, "CODE_LIKE"));

  const positions = ["id", "name", "summary", "lens_id", "brief_fields.0.id", "brief_fields.0.label",
    "phases.0.id", "phases.0.label", "phases.0.exit", "task_types.0.id", "task_types.0.label",
    "task_types.0.micro_hints.0", "granularity.rule", "memory_sections.0.id", "memory_sections.0.label", "memory_sections.0.hint"];
  for (const path of positions) for (const [payload, code] of [["bad\u0000", "CONTROL_CHAR"], ["<code>", "CODE_LIKE"]] as const)
    it(`T1 unsafe text ${path}: ${code}`, () => {
      const raw = rawTemplate(); const parts = path.split(".");
      let parent: Record<string, unknown> = raw;
      for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
      parent[parts.at(-1)!] = payload; templateFailure(raw, code);
    });
  it("T1 Unicode code-point name length", () => {
    const raw = rawTemplate(); raw["name"] = "😀".repeat(40);
    expect(validateTemplate(raw).ok).toBe(true);
  });
});

function conforming(): PlanProjection {
  const p = projection();
  return {...p, plan: {...p.plan!, brief: {goal: "Deliver"}},
    tasks: p.tasks.map(t => ({...t, accept: "Verified", microtasks: t.microtasks.map(m => ({...m, accept: "Verified", evidence: [{path: "proof", sha256: "a".repeat(64)}]}))})),
    memory: {notes: {id: "notes", text: "Decision", by: "alice", ts: 1, rev: 1}}};
}

describe("T2 conformance diagnostics outside projection", () => {
  it("T2 conforming projection has canonical ok/findings and is immutable", () => {
    const p = freeze(conforming()); const before = clone(p);
    expect(checkConformance(p, template)).toEqual({ok: true, findings: []}); expect(p).toEqual(before);
  });
  const variants: [string, (p: PlanProjection) => PlanProjection][] = [
    ["required brief", p => ({...p, plan: {...p.plan!, brief: {}}})],
    ["required memory", p => ({...p, memory: {}})],
    ["micro count below minimum", p => ({...p, tasks: p.tasks.map(t => ({...t, microtasks: []}))})],
    ["micro count above template maximum", p => p],
    ["required accept", p => ({...p, tasks: p.tasks.map(t => ({...t, accept: ""}))})],
    // A-U164: missing evidence diagnoses completed tasks' completed microtasks.
    ["required evidence", p => ({...p, tasks: p.tasks.map(t => ({...t, state: "done", microtasks: t.microtasks.map(m => ({...m, state: "done", evidence: []}))}))})],
    ["unknown plan phase", p => ({...p, plan: {...p.plan!, phase: "unknown"}})],
    ["unknown task phase", p => ({...p, tasks: p.tasks.map(t => ({...t, phase: "unknown"}))})],
    ["unknown type", p => ({...p, tasks: p.tasks.map(t => ({...t, type: "unknown"}))})],
  ];
  for (const [name, mutate] of variants)
    it(`T2 ${name}`, () => {
      let p = mutate(conforming()); let tpl: PlanningTemplate = clone(template);
      if (name === "micro count above template maximum") {
        tpl = {...tpl, granularity: {...tpl.granularity, micro_max: 1}};
        p = {...p, tasks: p.tasks.map(t => ({...t, microtasks: [...t.microtasks, {...t.microtasks[0]!, id: "T01.M02"}]}))};
      }
      const before = clone(p); const result = checkConformance(freeze(p), freeze(tpl));
      expect(result.ok).toBe(false); expect(result.findings.length).toBeGreaterThan(0);
      for (const f of result.findings) {
        expect(f.severity).toBe("error"); expect(typeof f.path).toBe("string"); expect(typeof f.code).toBe("string");
        expect(f.code.length).toBeGreaterThan(0); expect(typeof f.message).toBe("string");
      }
      expect(checkConformance(p, tpl)).toEqual(result); expect(p).toEqual(before);
    });
  it("T2 reducer has no implicit strict-conformance mode", () => {
    expect(validateOpEvent(event(1, {...open(), brief: {}}))).toBe(true);
    expect(applyOp(projection("empty"), event(1, {...open(), brief: {}}), template).ok).toBe(true);
  });
});

describe("Envelope and amended operation validation", () => {
  it("optional op_id omitted or valid accepted; ordinary operation newline accepted", () => {
    expect(validateOpEvent(event(1, open()))).toBe(true);
    expect(validateOpEvent(event(1, add({op_id: "valid_01", title: "Line\nnext\tpart"})))).toBe(true);
  });
  for (const op_id of [null, "short", "!invalid!", "x".repeat(65), 42])
    it(`invalid op_id ${JSON.stringify(op_id)}`, () => expect(validateOpEvent(event(1, add({op_id})))).toBe(false));
  for (const op_id of ["x".repeat(8), "x".repeat(64)])
    it(`op_id boundary ${op_id.length}`, () => expect(validateOpEvent(event(1, add({op_id})))).toBe(true));
});
