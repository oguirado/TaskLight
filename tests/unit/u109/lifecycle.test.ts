// @vitest-environment node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyOp, foldPlan } from "../../../src/plan/reducer";
import { validateOpShapeCode } from "../../../src/plan/validate";
import type { PlanProjection } from "../../../src/plan/types";

type JsonMap = Record<string, unknown>;
interface Case {
  name: string; acceptance: string; fixture: string; event: JsonMap;
  code: string | null; contains: string[]; paths: JsonMap; preserve: string[]; absent: string[];
}
const data = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")) as {
  fixtures: Record<string, PlanProjection>; cases: Case[];
};
const domain = ["plan", "tasks", "memory", "archived_plans", "rollup", "replayed_ops"] as const;
function at(value: unknown, path: string): unknown {
  for (const key of path.split(".")) value = (value as JsonMap)[key];
  return value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value); for (const item of Object.values(value)) freeze(item);
  }
  return value;
}
function fixture(name: string): PlanProjection { return structuredClone(data.fixtures[name]!); }
function check(c: Case) {
  const before = fixture(c.fixture), original = structuredClone(before);
  const event = structuredClone(c.event), saved = structuredClone(event);
  const r = applyOp(freeze(before), freeze(event));
  expect(before).toEqual(original); expect(event).toEqual(saved);
  expect(r.ok ? null : r.code, "wrong semantic decision; bad_op is not a lifecycle failure").toBe(c.code);
  if (!r.ok) {
    for (const key of domain) expect(r.projection[key], `rejection changed ${key}`).toEqual(original[key]);
    const detail = (r as unknown as JsonMap)["detail"];
    expect(detail, "step rejection requires detail").toBeTypeOf("string");
    expect((detail as string).length).toBeGreaterThan(0);
    for (const token of c.contains) expect((detail as string).toLowerCase()).toContain(token.toLowerCase());
    return;
  }
  for (const [path, expected] of Object.entries(c.paths)) expect(at(r.projection, path), path).toEqual(expected);
  for (const path of c.preserve) expect(at(r.projection, path), path).toEqual(at(original, path));
  for (const path of c.absent) expect(at(r.projection, path) ?? null, path).toBeNull();
}

describe("U109 explicit normalized lifecycle oracle", () => {
  for (const c of data.cases) it(c.name, () => check(c));
  for (const kind of ["micro.set", "task.release"]) {
    const base = kind === "micro.set" ? {kind, micro_id: "T01.M01", state: "pending"} : {kind, task_id: "T01"};
    for (const n of [1, Number.MAX_SAFE_INTEGER])
      it(`a6 validator accepts ${kind} safe boundary ${n}`, () => {
        expect(validateOpShapeCode({...base, claim_lamport: n})).toBeNull();
      });
    for (const value of [null, true, false, "1", 0, -1, 1.25, Number.MAX_SAFE_INTEGER + 1, [], {}])
      it(`a6 validator rejects ${kind} ${JSON.stringify(value)}`, () => {
        expect(validateOpShapeCode({...base, claim_lamport: value})).toBe("bad_op");
      });
  }
});

describe("U109 independent Python/TypeScript step parity", () => {
  it("a8 matches real codes, details and domain projections for every shared case", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const child = spawnSync("python3", ["-B", "-m", "bridge.tests.room.u109.fold_probe"], {
      cwd: root, encoding: "utf8", env: {...process.env, PYTHONDONTWRITEBYTECODE: "1"},
      timeout: 15000, maxBuffer: 8 * 1024 * 1024,
    });
    expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
    const py = JSON.parse(child.stdout) as {name: string; code: string | null; detail: unknown; domain: JsonMap}[];
    expect(py).toHaveLength(data.cases.length);
    for (const [i, c] of data.cases.entries()) {
      const r = applyOp(fixture(c.fixture), c.event);
      const actual = {
        name: c.name, code: r.ok ? null : r.code,
        detail: r.ok ? null : (r as unknown as JsonMap)["detail"] ?? null,
        domain: Object.fromEntries(domain.map(key => [key, r.projection[key]])),
      };
      expect.soft(actual, c.name).toEqual(py[i]);
    }
  });

  it("a8 full event fold rejects an otherwise valid unassigned write", () => {
    const event = (n: number, op: JsonMap) => ({id: `e-${n.toString(16).padStart(16, "0")}`, lamport: n, ts: 1700000000000 + n,
      room: "demo", agent: "alice", act: "op", text: "", op});
    const seed = [event(1, {kind: "plan.open", title: "Plan", template_id: "neutral", template_hash: "a".repeat(64), brief: {}}),
      event(2, {kind: "task.add", title: "Action", type: "action", phase: "start", accept: "", microtasks: [{text: "Check"}]})];
    const before = foldPlan(seed).projection;
    const r = foldPlan([...seed, event(3, {kind: "micro.set", micro_id: "T01.M01", state: "done"})]);
    expect(r.stats.rejected).toBe(1);
    expect(r.projection.rejected[0]).toMatchObject({code: "not_conformant"});
    for (const key of ["plan", "tasks", "rollup", "archived_plans"] as const) expect(r.projection[key]).toEqual(before[key]);
  });
});
