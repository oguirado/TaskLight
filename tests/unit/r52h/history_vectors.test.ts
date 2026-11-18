import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

import { foldPlan } from "../../../src/plan/reducer";
import type { PipelineStep, PlanProjection, PlanningTemplate } from "../../../src/plan/types";
import { deterministic } from "../c7/support";

type Event = { lamport: number; op?: { template_hash?: string } };
type Checkpoint = { after: number; expected: ReturnType<typeof observe> };

const { events, arrivalOrder, checkpoints } = JSON.parse(readFileSync(
  "bridge/tests/property/pipeline_histories.json", "utf8",
)) as { events: Event[]; arrivalOrder: number[]; checkpoints: Record<string, Checkpoint> };
const template = JSON.parse(readFileSync(
  "templates/planning/unit-pipeline-v1.json", "utf8",
)) as PlanningTemplate;
template.hash = events[0]!.op!.template_hash!;
const reordered = arrivalOrder.map(lamport => events[lamport - 1]!);

function attempts(step: PipelineStep | undefined) {
  return (step?.attempts ?? []).map(attempt => [
    attempt.lamport, attempt.result_run_id, attempt.state,
    attempt.terminal?.lamport ?? null, attempt.terminal?.verdict ?? null,
    attempt.decision?.lamport ?? null,
  ]);
}

function observe(projection: PlanProjection) {
  const task = projection.tasks.find(entry => entry.id === "T02");
  const steps = task?.pipeline?.steps ?? [];
  return {
    generation: projection.plan?.opened_lamport ?? null,
    tasks: projection.tasks.map(entry => entry.id),
    deps: task?.deps ?? [],
    states: task?.microtasks.map(step => step.state) ?? [],
    bindings: steps.map(step => step.binding),
    acceptedPrefix: steps.slice(0, 3).flatMap(step => step.attempts
      .filter(attempt => attempt.state === "accepted")
      .map(attempt => [attempt.lamport, attempt.decision?.lamport ?? null])),
    author: attempts(steps[3]),
    verify: attempts(steps[4]),
    decisions: (task?.decisions ?? []).map(row => [row.lamport, row.verdict]),
    rejected: projection.rejected.map(row => [row.lamport, row.code]),
  };
}

function through(history: readonly Event[], lamport: number) {
  return history.filter(event => event.lamport <= lamport);
}

function fold(history: readonly Event[]) {
  return foldPlan(history, template).projection;
}

deterministic();

it.each(Object.entries(checkpoints))("matches the hand-derived %s checkpoint", (_name, checkpoint) => {
  const history = through(events, checkpoint.after);
  const original = structuredClone(history);
  expect(observe(fold(history))).toEqual(checkpoint.expected);
  expect(history).toEqual(original);
});

it("replays reordered duplicates at each checkpoint", () => {
  for (const [name, checkpoint] of Object.entries(checkpoints)) {
    const canonical = fold(through(events, checkpoint.after));
    const perturbed = fold(through(reordered, checkpoint.after));
    expect(perturbed, name).toEqual(canonical);
    expect(observe(perturbed), name).toEqual(checkpoint.expected);
  }
});

it("replays the minimized late-ADMIT witness independently", () => {
  const script = [
    "import json",
    "from bridge.tests.property.test_pipeline_histories import shrink_witness",
    "print(json.dumps(shrink_witness()))",
  ].join("\n");
  const child = spawnSync("python3", ["-B", "-c", script], {
    encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const witness = JSON.parse(child.stdout) as Event[];
  const checkpoint = checkpoints.late_old_admit!;
  const observed = observe(fold(through(witness, checkpoint.after)));
  // The unfalsified earlier negative control may be pruned.
  observed.rejected = observed.rejected.filter(([lamport, code]) => lamport !== 23 || code !== "bad_op");
  expect(observed, "minimized history must replay with its generation, parents, bindings and prefix")
    .toEqual({ ...checkpoint.expected, rejected: [[checkpoint.after, "bad_op"]] });
});

