// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyOp, checkConformance, foldPlan } from "../../../src/plan";
import type { PlanningTemplate, PlanProjection } from "../../../src/plan";

type Case = {
  name: string; task_state: string; task_type: string;
  micro_states: string[]; evidence: unknown[]; missing: string[];
};
const corpus = JSON.parse(readFileSync(new URL("./evidence_cases.json", import.meta.url), "utf8")) as {
  template: PlanningTemplate; history: unknown[]; cases: Case[];
};
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function projection(row: Case): PlanProjection {
  const p = structuredClone(foldPlan(corpus.history, corpus.template).projection);
  const task = p.tasks[0]!;
  return {...p, tasks: [{...task, state: row.task_state, type: row.task_type,
    microtasks: row.micro_states.map((state, index) => ({...task.microtasks[0]!,
      id: `T01.M${String(index + 1).padStart(2, "0")}`, state, evidence: row.evidence[index]}))}]} as PlanProjection;
}

describe("U164 M8 diagnostic parity with Python conformance", () => {
  for (const row of corpus.cases) it(`M8 ${row.name}`, () => {
    const p = freeze(projection(row));
    const template = freeze(structuredClone(corpus.template));
    const before = structuredClone({p, template});
    const report = checkConformance(p, template);
    expect(report.findings.filter(f => f.code === "missing_evidence").map(f => f.path)).toEqual(row.missing);
    expect({p, template}).toEqual(before);
  });
});

describe("U164 M6/M8 historical events stay admissible in the browser", () => {
  it("M6 historical evidence-free completion preserves fold, progress and receipts", () => {
    const history = freeze(structuredClone(corpus.history));
    const result = foldPlan(history, corpus.template);
    expect(result.projection.rejected).toEqual([]);
    expect(result.projection.tasks[0]!.state).toBe("done");
    expect(result.projection.tasks[0]!.microtasks.map(m => m.state)).toEqual(["done", "done"]);
    expect(result.projection.rollup).toMatchObject({tasks_done: 1, micro_done: 2, progress: 1, progress_pct: 100});
    expect(Object.keys(result.projection.replayed_ops)).toHaveLength(2);
    expect(foldPlan(structuredClone(corpus.history), corpus.template)).toEqual(result);
    expect(checkConformance(result.projection, corpus.template).findings.filter(f => f.code === "missing_evidence").map(f => f.path))
      .toEqual(["tasks.T01.microtasks.T01.M01.evidence", "tasks.T01.microtasks.T01.M02.evidence"]);
  });
  it("M8 incremental applyOp accepts every historical event", () => {
    let state = foldPlan([], corpus.template).projection;
    for (const event of corpus.history) {
      const result = applyOp(state, event, corpus.template);
      expect(result.ok).toBe(true);
      if (result.ok) state = result.projection;
    }
    expect(state).toEqual(foldPlan(corpus.history, corpus.template).projection);
  });
});
