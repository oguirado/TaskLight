// @vitest-environment node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { foldPlan } from "../../../src/plan/reducer";
import { opEventErrorCode } from "../../../src/plan/validate";
import type { PlanningTemplate, PlanProjection } from "../../../src/plan/types";

interface Case {
  id: string;
  events: Array<Record<string, unknown>>;
  templates: Record<string, PlanningTemplate>;
  expected: PlanProjection;
  code: "bad_op" | null;
  prefixes: PlanProjection[];
}
const child = spawnSync("python3", ["-B", "-m", "bridge.tests.plan.par1.test_event_ids", "--json"], {
  cwd: fileURLToPath(new URL("../../../", import.meta.url)),
  encoding: "utf8", timeout: 30000,
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
});
if (child.error || child.status !== 0) {
  throw new Error(`Python adapter failed: ${child.error?.message ?? child.status} ${child.stderr}`);
}
const cases = JSON.parse(child.stdout) as Case[];

function freeze(value: unknown): void {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) freeze(nested);
  }
}

describe("PAR-1 event IDs: shared histories, explicit oracle and Python parity", () => {
  for (const c of cases) {
    it(c.id, () => {
      const before = JSON.stringify(c);
      freeze(c);
      const template = Object.values(c.templates)[0]!;
      expect(c.prefixes.at(-1)).toEqual(c.expected);
      expect(foldPlan(c.events, template).projection).toEqual(c.expected);
      const opening = c.events.find(e => (e["op"] as Record<string, unknown>)["kind"] === "plan.open")!;
      expect(opEventErrorCode(opening)).toBe(c.code);
      for (let i = 0; i <= c.events.length; i++) {
        expect(foldPlan(c.events.slice(0, i), template).projection, `prefix ${i}`).toEqual(c.prefixes[i]);
      }
      if (c.code === null) {
        const result = foldPlan(c.events, template);
        expect(result.stats).toMatchObject({ applied: 2, replayed: 0, rejected: 0, invalid: 0 });
        expect(result.projection.tasks.map(t => t.id)).toEqual(["T01"]);
      }
      expect(JSON.stringify(c)).toBe(before);
    });
  }

  it("preserves every other envelope and operation validation rule", () => {
    const opening = cases[0]!.events.find(e => (e["op"] as Record<string, unknown>)["kind"] === "plan.open")!;
    for (const patch of [
      { room: "Bad Room" }, { agent: "!" }, { act: "note" },
      { lamport: true }, { lamport: 0 }, { lamport: 1.5 },
      { ts: true }, { text: 123 }, { op: { kind: "unknown" } },
      { op: { ...(opening["op"] as object), op_id: "invalid op id" } },
    ]) expect(opEventErrorCode({ ...opening, ...patch })).toBe("bad_op");
  });
});
