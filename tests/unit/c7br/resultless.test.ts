import { expect, it } from "vitest";
import { applyOp } from "../../../src/plan/reducer";
import { clone, decision, event, fixture, fold, python } from "../c7/support";

const reference = { result_agent: "worker", result_run_id: "r1" };

it.each(["finished", "failed"] as const)("replays %s resultless decisions with Python parity", state => {
  const events = clone(fixture.seed);
  const terminal = events[4]!.op;
  if (terminal.kind !== "agent.lifecycle") throw new Error("Expected a terminal lifecycle event");
  terminal.state = state;
  const result = terminal.result;
  delete terminal.result;
  events.push(
    event(6, { ...terminal, op_id: "repeat-terminal", result }, "worker"),
    event(7, { kind: "agent.lifecycle", op_id: "worker-redeploy", state: "deployed", run_id: "r2" }, "worker"),
    event(8, decision(8, { ...reference, verdict: "HOLD" })),
    event(9, decision(9, { ...reference, verdict: "REJECT" })),
    event(10, decision(9, { ...reference, verdict: "REJECT" })),
  );

  const admit = event(11, decision(11, reference));
  expect(applyOp(fold(events), admit, fixture.template)).toMatchObject({
    ok: false, code: "bad_op", detail: "ADMIT needs a recorded result",
  });
  events.push(admit);

  const projection = fold(events);
  expect(projection.tasks[0]?.decisions?.map(entry => entry.verdict)).toEqual(["HOLD", "REJECT"]);
  expect(projection.tasks[0]?.last_decision).toMatchObject({ ...reference, verdict: "REJECT" });
  expect(projection.rejected).toEqual([{
    id: admit.id, lamport: admit.lamport, op_id: admit.op.op_id, code: "bad_op",
  }]);
  expect(projection).toEqual(python("fold", events));
});

it("rejects a HOLD for an unknown agent or a live run with Python parity", () => {
  const events = clone(fixture.seed).slice(0, 4);
  const invalid = [
    event(5, decision(5, { ...reference, verdict: "HOLD" })),
    event(6, decision(6, { ...reference, result_agent: "missing", verdict: "HOLD" })),
  ];
  for (const item of invalid) {
    expect(applyOp(fold(events), item, fixture.template)).toMatchObject({
      ok: false, code: "bad_op", detail: "unknown result reference",
    });
  }
  const journal = [...events, ...invalid];
  const projection = fold(journal);
  expect(projection.rejected.map(entry => entry.id)).toEqual(invalid.map(item => item.id));
  expect(projection.tasks[0]?.last_decision).toBeUndefined();
  expect(projection).toEqual(python("fold", journal));
});
