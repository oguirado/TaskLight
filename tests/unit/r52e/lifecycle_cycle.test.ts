import { describe, expect, it } from "vitest";
import golden from "../../../bridge/tests/property/lifecycle_cycle.json";
import { foldPlan } from "../../../src/plan/reducer";

function expectHistory(history: (typeof golden)[keyof typeof golden]): void {
  const { projection } = foldPlan(history.events);
  const parents = Object.fromEntries(
    Object.entries(projection.agent_lifecycle ?? {}).map(([agent, record]) => {
      const { lifecycle, run_id, parent_agent, parent_run_id, lamport } = record;
      return [agent, { lifecycle, run_id, parent_agent, parent_run_id, lamport }];
    }),
  );
  expect(parents).toEqual(history.expected.parents);
  expect(projection.rejected).toEqual(history.expected.rejected);
}

describe("R52E lifecycle parent histories", () => {
  it("rejects a parent cycle with the server receipt", () => {
    expectHistory(golden.cycle);
  });

  it("accepts a valid parent chain", () => {
    expectHistory(golden.valid_chain);
  });
});
