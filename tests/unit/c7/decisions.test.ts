import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { applyOp, emptyProjection } from "../../../src/plan/reducer";
import { validateOpShapeCode } from "../../../src/plan/validate";
import { clone, decision, decisionTask, deterministic, event, fixture, fold, python, root } from "./support";

deterministic();

describe("C7 M2 shared decision shape vectors", () => {
  for (const vector of fixture.cases) it(`m2_shape_${vector.name}`, () => {
    const op = clone(vector.op), before = clone(op);
    expect(validateOpShapeCode(op)).toBe(vector.valid ? null : "bad_op");
    expect(op).toEqual(before);
  });
  it("m2_negative_control_has_valid_positive_twin", () => {
    expect(validateOpShapeCode(clone(fixture.base)), "decision support must exist").toBeNull();
    expect(validateOpShapeCode(decision(6, { reason: "x".repeat(241) }))).toBe("bad_op");
    expect(validateOpShapeCode(decision(6, { unknown: true }))).toBe("bad_op");
  });
  it("m2_no_open_plan_stops_reducer_without_mutating_input", () => {
    const initial = emptyProjection(), before = clone(initial);
    const result = applyOp(initial, event(1, decision()), fixture.template);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("no_plan");
    expect(initial).toEqual(before);
  });

  for (const [name, patch] of Object.entries({
    unknown_task: { task_id: "T40" }, unknown_micro: { micro_id: "T01.M12" },
    foreign_micro: { micro_id: "T02.M01" }, unknown_agent: { agent: "absent", run_id: "r1" },
    unknown_run: { agent: "worker", run_id: "absent-run" },
  })) it(`m2_context_${name}_is_bad_op_and_leaves_input_unchanged`, () => {
    const initial = fold(fixture.seed), before = clone(initial);
    expect(initial.rejected).toEqual([]);
    const positive = applyOp(initial, event(6, decision()), fixture.template);
    expect(positive.ok, "positive twin must admit a valid current-plan task").toBe(true);
    const result = applyOp(initial, event(6, decision(6, patch)), fixture.template);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("bad_op");
    expect(initial).toEqual(before);
  });
});

describe("C7 M3 fold history and Python/browser parity", () => {
  for (const history of fixture.histories) {
    it(`m3_history_${history.name}`, () => {
      const input = clone(history.events), before = clone(input), projection = fold(input);
      expect(projection.rejected.map(row => row.id)).toEqual(history.rejected_ids);
      const task = decisionTask(projection);
      expect(task.decisions, "history must exist even when both implementations formerly ignored decisions").toBeInstanceOf(Array);
      expect(task.decisions!.map(row => row.reason)).toEqual(history.reasons);
      expect(task.decisions!.length).toBeLessThanOrEqual(16);
      expect(task.last_decision).toEqual(task.decisions!.at(-1));
      for (const row of task.decisions!) expect(["ADMIT", "HOLD", "REJECT"]).toContain(row.verdict);
      expect(fold([...input].reverse().concat(input))).toEqual(projection);
      expect(input).toEqual(before);
    });
    it(`m3_python_parity_${history.name}`, () => {
      const browser = fold(history.events);
      const backend = python("fold", history.events) as typeof browser;
      // Independent expected history prevents a vacuous match of two rejecting implementations.
      for (const projection of [backend, browser]) {
        expect(projection.rejected.map(row => row.id)).toEqual(history.rejected_ids);
        expect(decisionTask(projection).decisions?.map(row => row.reason)).toEqual(history.reasons);
      }
      expect(browser).toEqual(backend);
    });
  }
  it("m3_accepting_a_decision_does_not_mutate_prior_projection", () => {
    const initial = fold(fixture.seed), before = clone(initial);
    const result = applyOp(initial, event(6, decision()), fixture.template);
    expect(result.ok).toBe(true);
    expect(initial).toEqual(before);
    if (result.ok) expect(decisionTask(result.projection).last_decision?.reason).toBe("Checks passed");
  });
});

describe("C7 public TypeScript contract", () => {
  it("m2_m3_public_types_accept_decision_ops_and_history_without_test_type_errors", () => {
    const temporary = mkdtempSync(join(root, "tests/unit/c7/runtime-"));
    const file = join(temporary, "consumer.ts");
    try {
      writeFileSync(file, 'import type { PlanOpBody, PlanTask } from "../../../../src/plan/types";\n'
        + `const op: PlanOpBody = ${JSON.stringify(decision())};\n`
        + 'declare const task: PlanTask;\n'
        + 'const verdict: string | undefined = task.last_decision?.verdict;\n'
        + 'const reasons = task.decisions?.map(d => d.reason);\n');
      const child = spawnSync(join(root, "node_modules/.bin/tsc"), ["--noEmit", "--ignoreConfig", "--strict",
        "--skipLibCheck", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "bundler", "--types", "node", file],
      { cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 128 * 1024 });
      expect(child.error).toBeUndefined();
      expect(child.status, "public C7 type contract: " + child.stdout + child.stderr).toBe(0);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
