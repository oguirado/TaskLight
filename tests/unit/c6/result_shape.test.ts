import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateOpShapeCode } from "../../../src/plan/validate";

type Vector = { name: string; state: string; result: unknown; valid: boolean };
const vectors = JSON.parse(readFileSync(join(process.cwd(), "bridge/tests/room/c6/result_cases.json"), "utf8")) as {
  base: unknown; cases: Vector[];
};
const operation = (state: string, result: unknown) => ({
  kind: "agent.lifecycle", state, run_id: "run-c6", op_id: "c6-shape-0001", result,
});

describe("C6 M1 Python/browser shared result shape vectors", () => {
  for (const vector of vectors.cases) {
    it(`m1_shape_${vector.name}`, () => {
      const op = operation(vector.state, structuredClone(vector.result));
      const before = JSON.stringify(op);
      const code = validateOpShapeCode(op);
      if (vector.valid) expect(code, "M1 valid optional result must be accepted").toBeNull();
      else expect(code, "M1 browser rejects invalid result shapes").not.toBeNull();
      expect(JSON.stringify(op), "shape validation cannot mutate data").toBe(before);
    });
  }

  it("m1_unknown_key_negative_control_has_valid_positive_twin", () => {
    expect(validateOpShapeCode(operation("finished", vectors.base)), "M1 result support must exist").toBeNull();
    const valid = vectors.base as Record<string, unknown>;
    expect(validateOpShapeCode(operation("finished", { ...valid, unknown: true }))).not.toBeNull();
  });

  for (const state of ["deployed", "alive", "finished", "failed"]) {
    it(`m1_legacy_${state}_without_result_still_valid`, () => {
      const op = { kind: "agent.lifecycle", state, run_id: "run-c6", op_id: "c6-legacy-0001",
        parent_agent: "leader", parent_run_id: "lead-c6" };
      const before = JSON.stringify(op);
      expect(validateOpShapeCode(op)).toBeNull();
      expect(JSON.stringify(op)).toBe(before);
      expect(op).not.toHaveProperty("result");
    });
  }

  it("m1_existing_AgentLifecycleOp_type_accepts_optional_results", () => {
    // The installed compiler exposes a CLI; the temporary consumer stays here.
    const temporary = mkdtempSync(join(process.cwd(), "tests/unit/c6/runtime-"));
    const file = join(temporary, "consumer.ts");
    const source = 'import type { AgentLifecycleOp } from "../../../../src/plan/types";\n'
      + 'const terminal: AgentLifecycleOp = '
      + JSON.stringify(operation("finished", vectors.base)) + ';\n'
      + 'const legacy: AgentLifecycleOp = {kind:"agent.lifecycle", state:"finished",run_id:"r1",op_id:"c6-type-01"};\n';
    try {
      writeFileSync(file, source);
      const result = spawnSync(join(process.cwd(), "node_modules/.bin/tsc"), [
        "--noEmit", "--ignoreConfig", "--strict", "--skipLibCheck", "--target", "ES2022",
        "--module", "ESNext", "--moduleResolution", "bundler", "--types", "node", file,
      ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000, maxBuffer: 128 * 1024 });
      expect(result.error, "bounded local compiler must run").toBeUndefined();
      expect(result.status, "M1 existing public type must accept optional results: " + result.stdout + result.stderr).toBe(0);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
