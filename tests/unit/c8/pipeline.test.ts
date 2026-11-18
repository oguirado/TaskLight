import { expect, it } from "vitest";
import { foldPlan } from "../../../src/plan/reducer";
import { deterministic } from "../c7/support";
import { attempts, replay, trace } from "./support";

deterministic();

it("m5_python_and_typescript_match_at_each_pipeline_checkpoint", () => {
  const data = trace();
  for (const mark of Object.keys(data.marks) as (keyof typeof data.marks)[]) {
    const { projection } = replay(data, mark);
    expect(projection, mark).toEqual(data.checkpoints[mark]);
  }
  // Both folds silently dropping history must fail as well.
  const repaired = replay(data, "repaired").projection;
  const history = JSON.stringify(attempts(repaired));
  for (const run of ["run-diagnose", "run-failed-spec", "run-held-spec",
    "run-complete-author", "run-complete-verify", "run-complete-review", "run-complete-import"]) {
    expect(history).toContain(JSON.stringify(run));
  }
});

it("m5_replaying_repair_clears_only_the_suffix_and_keeps_prior_attempts", () => {
  const data = trace();
  const repaired = replay(data, "repaired").projection;
  const expected = ["done", "done", "done", "pending", "pending", "pending", "pending"];
  expect(replay(data, "complete").projection.tasks[0]?.microtasks.map(step => step.state))
    .toEqual(Array(7).fill("done"));
  expect(repaired.tasks[0]?.microtasks.map(step => step.state)).toEqual(expected);
  expect(attempts(repaired).length).toBeGreaterThanOrEqual(attempts(data.checkpoints.complete).length);
  const { events, projection } = replay(data, "reworked");
  expect(projection.tasks[0]?.microtasks.map(step => step.state))
    .toEqual(["done", "done", "done", "done", "pending", "pending", "pending"]);
  expect(foldPlan([...events].reverse(), data.template).projection).toEqual(projection);
});
