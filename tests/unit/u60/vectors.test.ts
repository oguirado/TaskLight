// @vitest-environment node
import { describe, expect, it } from "vitest";
import { foldPlan } from "../../../src/plan";
import { clone, event, freeze, vectors } from "./helpers";

// A-U109c: (a) V1/V2 close/reopen vectors must explicitly cancel open work, M6.
// Keep the legacy corpus immutable and adjust only the stated terminal state/revisions.
const lifecycleVectors = vectors.map(original => {
  const c = clone(original);
  if (c.id !== "plan_close" && c.id !== "reopen_preserves_memory") return c;
  const events = c.events as ReturnType<typeof event>[];
  const index = events.findIndex(e => e.op["kind"] === "plan.close");
  for (const e of events.slice(index)) {
    e.lamport += 1; e.ts += 1;
    e.id = event(e.lamport, e.op).id;
  }
  events.splice(index, 0, event(9, { kind: "task.set", task_id: "T01", base_rev: 7, state: "cancelled" }));
  const p = c.expected_projection;
  p.last_lamport += 1;
  p.plan!.rev += 1;
  p.archived_plans[0]!.closed_ts += 1;
  if (c.id === "plan_close") {
    Object.assign(p.tasks[0]!, { rev: 9, explicit_state: "cancelled", state: "cancelled", ready: false });
    Object.assign(p.rollup, { tasks_blocked: 0, tasks_ready: 0 });
  } else {
    p.plan!.opened_lamport += 1;
    p.plan!.opened_ts += 1;
  }
  return c;
});

describe("V1/V2 Stop rule 3: canonical U55 parity (integration blocked on disagreement)", () => {
  for (const c of lifecycleVectors) {
    const template = Object.values(c.templates)[0];
    it(`V1 ${c.id}: exact canonical projection and rejected receipts`, () => {
      const result = foldPlan(freeze(clone(c.events)), template);
      expect(result.projection).toEqual(c.expected_projection);
      expect(result.projection.rejected).toEqual(c.expected_rejected);
      expect(c.expected_rejected).toEqual(c.expected_projection.rejected);
    });
    for (const order of ["reverse", "shuffle"] as const) {
      it(`V2 ${c.id}: ${order} preserves canonical projection`, () => {
        const input = clone(c.events);
        if (order === "reverse") input.reverse();
        else { let seed = 60; for (let i = input.length - 1; i > 0; i--) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const j = seed % (i + 1); [input[i], input[j]] = [input[j], input[i]];
        } }
        const before = clone(input);
        expect(foldPlan(freeze(input), template).projection).toEqual(c.expected_projection);
        expect(input).toEqual(before);
      });
    }
  }
});
