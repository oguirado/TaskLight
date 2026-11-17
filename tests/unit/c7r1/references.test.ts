import { describe, expect, it } from "vitest";
import { applyOp } from "../../../src/plan/reducer";
import { validateOpShapeCode } from "../../../src/plan/validate";
import { renderSwarmView } from "../../../src/views/swarm";
import { clone, decision, deterministic, event, fixture, fold, python, view } from "../c7/support";

function seed() {
  const events = clone(fixture.seed);
  for (const item of events) {
    if (item.agent === "worker") item.agent = "worker-1";
    if (item.op.kind === "task.add" && item.op.assignee === "worker") item.op.assignee = "worker-1";
  }
  return events;
}
const reference = (fields: Record<string, unknown> = {}) => decision(6, {
  result_agent: "worker-1", result_run_id: "r1", ...fields,
});

deterministic();

describe("C7r1 independent decision result references", () => {
  it("accepts orchestrator decisions with exact Python parity and immutable inputs", () => {
    const events = seed(), before = fold(events), untouched = clone(before);
    const item = event(6, reference(), "orchestrator");
    const applied = applyOp(before, item, fixture.template);
    expect(applied.ok).toBe(true);
    expect(before).toEqual(untouched);
    const projection = fold([...events, item]);
    expect(projection.rejected).toEqual([]);
    expect(projection.tasks[0]?.last_decision).toMatchObject({
      result_agent: "worker-1", result_run_id: "r1", verdict: "ADMIT",
    });
    expect(projection).toEqual(python("fold", [...events, item]));
  });

  for (const fields of [{ result_agent: "absent" }, { result_run_id: "missing" }]) {
    it(`rejects unknown reference ${JSON.stringify(fields)} with Python parity`, () => {
      const events = seed(), before = fold(events), untouched = clone(before);
      const item = event(6, reference(fields), "orchestrator");
      const applied = applyOp(before, item, fixture.template);
      expect(applied.ok).toBe(false);
      if (!applied.ok) expect(applied.code).toBe("bad_op");
      expect(before).toEqual(untouched);
      const projection = fold([...events, item]);
      expect(projection.tasks[0]?.last_decision).toBeUndefined();
      expect(projection.rejected).toHaveLength(1);
      expect(projection).toEqual(python("fold", [...events, item]));
    });
  }

  for (const terminal of [false, true]) {
    it(`rejects ${terminal ? "terminal without result" : "live run"} with Python parity`, () => {
      const events = seed();
      if (terminal) {
        const op = events.at(-1)!.op;
        if (op.kind === "agent.lifecycle") delete op.result;
      } else events.pop();
      const item = event(6, reference(), "orchestrator");
      const projection = fold([...events, item]);
      expect(projection.rejected).toHaveLength(1);
      expect(projection.rejected[0]?.code).toBe("bad_op");
      expect(projection.tasks[0]?.last_decision).toBeUndefined();
      expect(projection).toEqual(python("fold", [...events, item]));
    });
  }

  it("retries are idempotent and changed references conflict with Python parity", () => {
    const events = [...seed(), event(6, reference(), "orchestrator"),
      event(7, reference(), "orchestrator"),
      event(8, reference({ result_run_id: "missing" }), "orchestrator")];
    const projection = fold(events);
    expect(projection.tasks[0]?.decisions).toHaveLength(1);
    expect(projection.rejected).toHaveLength(1);
    expect(projection.rejected[0]?.code).toBe("bad_op");
    expect(projection).toEqual(python("fold", events));
  });

  it("retains historical failed result references after redeployment", () => {
    const events = seed(), terminal = events.at(-1)!.op;
    if (terminal.kind === "agent.lifecycle") terminal.state = "failed";
    events.push(event(6, { kind: "agent.lifecycle", op_id: "c7r1-redeploy", state: "deployed", run_id: "r2" }, "worker-1"));
    events.push(event(7, { ...reference(), op_id: "c7r1-review-old-run" }, "orchestrator"));
    const projection = fold(events);
    expect(projection.rejected).toEqual([]);
    expect(projection.tasks[0]?.last_decision).toMatchObject({ result_run_id: "r1" });
    expect(projection).toEqual(python("fold", events));
  });

  it("validates the new reference pair and rejects partial, mixed and invalid forms", () => {
    expect(validateOpShapeCode(reference())).toBeNull();
    const partialAgent = reference(); delete partialAgent.result_run_id;
    const partialRun = reference(); delete partialRun.result_agent;
    const invalid = [partialAgent, partialRun, reference({ agent: "worker-1", run_id: "r1" }),
      reference({ agent: "worker-1" }), reference({ run_id: "r1" })];
    for (const field of ["result_agent", "result_run_id"]) {
      for (const value of [null, false, 1, "", "bad/slug", "x".repeat(field === "result_agent" ? 49 : 65)]) {
        invalid.push(reference({ [field]: value }));
      }
    }
    for (const op of invalid) expect(validateOpShapeCode(op), JSON.stringify(op)).toBe("bad_op");
  });

  it("shows the referenced worker in the task bubble and its accessible name", () => {
    const events = [...seed(), event(6, reference(), "orchestrator")];
    const element = renderSwarmView(document, view(events));
    document.body.append(element);
    const bubble = [...element.querySelectorAll<HTMLButtonElement>(".swarm-task-bubble")]
      .find(button => button.getAttribute("aria-label")?.includes("First task"));
    expect(bubble).toBeDefined();
    expect(bubble?.textContent).toContain("Result: worker-1 (r1)");
    expect(bubble?.getAttribute("aria-label")).toContain("worker-1");
    expect(element.querySelector("img,script,[onerror]")).toBeNull();
  });

  it("keeps legacy raw references readable on the board", () => {
    const events = [...seed(), event(6, decision(6, { agent: "worker-1", run_id: "r1" }), "orchestrator")];
    const projection = fold(events);
    expect(projection.rejected).toEqual([]);
    expect(projection).toEqual(python("fold", events));
    const element = renderSwarmView(document, view(events, projection));
    expect(element.querySelector(".swarm-task-bubble")?.textContent).toContain("Result: worker-1 (r1)");
  });
});
