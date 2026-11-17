import { describe, expect, it } from "vitest";
import { deriveActivity } from "../../../src/app/activity";
import { applyOp, foldPlan } from "../../../src/plan/reducer";
import { validateOpShapeCode } from "../../../src/plan/validate";
import { apply, beat, copy, event, fixture, incremental, initial, live, micro, projectedMicro, python, task } from "./support";

describe("U90 repair: task retirement and projection parity", () => {
  function parity(events: Record<string, unknown>[]): ReturnType<typeof initial> {
    const state = incremental(events);
    expect(foldPlan(events).projection).toEqual(state);
    expect(python({ events })).toEqual(state);
    expect(python({ events: fixture.seed, continuation: events.slice(fixture.seed.length) })).toEqual(state);
    return state;
  }

  it("a superseded run cannot poison a newly active sibling after JSON continuation", () => {
    const current = beat(13, "run_B");
    const late = beat(14);
    delete (current["op"] as Record<string, unknown>)["micro_id"];
    delete (late["op"] as Record<string, unknown>)["micro_id"];
    const state = parity([...fixture.seed, beat(10), beat(11, "run_B"),
      event(12, { kind: "micro.set", micro_id: "T01.M02", state: "active" }), current, late]);
    expect(state.tasks[0]!.microtasks.slice(0, 2).map((m) => m.live?.run_id)).toEqual(["run_B", "run_B"]);
  });

  it("supersession clears the retired run from untargeted active siblings", () => {
    const state = parity([...fixture.seed, beat(10),
      event(11, { kind: "micro.set", micro_id: "T01.M02", state: "active" }),
      beat(12, "run_B", { micro_id: "T01.M02" }), beat(13)]);
    expect(projectedMicro(state).live).toBeUndefined();
    expect(projectedMicro(state, 1).live?.run_id).toBe("run_B");
  });

  it.each(["blocked", "cancelled", "release", "reassign"])("%s retires runs on future siblings", (transition) => {
    const events = [...fixture.seed, beat(10)];
    let owner = "alice";
    if (transition === "blocked" || transition === "cancelled") {
      events.push(event(11, { kind: "task.set", task_id: "T01", base_rev: 5, state: transition }),
        event(12, { kind: "task.set", task_id: "T01", base_rev: 11, state: null }));
    } else if (transition === "release") {
      events.push(event(11, { kind: "task.release", task_id: "T01" }), event(12, { kind: "task.claim", task_id: "T01" }));
    } else {
      owner = "mallory";
      events.push(event(11, { kind: "task.claim", task_id: "T01", takeover: true }, owner, 700001));
    }
    const late = beat(14, "run_A", { micro_id: "T01.M02" });
    late["agent"] = owner;
    events.push(event(13, { kind: "micro.set", micro_id: "T01.M02", state: "active" }, owner), late);
    expect(projectedMicro(parity(events), 1).live).toBeUndefined();
  });

  it("plan close records task retirement", () => {
    // A-U109c: (a) close requires terminal tasks; cancellation preserves historical retirement, M6.
    const state = parity([...fixture.seed, beat(10),
      event(11, { kind: "task.set", task_id: "T01", base_rev: 5, state: "cancelled" }),
      event(12, { kind: "task.set", task_id: "T02", base_rev: 3, state: "cancelled" }),
      event(13, { kind: "plan.close", base_rev: 1 })]);
    expect((state.replayed_ops["activity.retired"] as Record<string, string[]>)["T01"]).toContain("run_A");
    expect(projectedMicro(state).live).toBeUndefined();
  });

  it("release retires historical runs even when no microtask is live", () => {
    const state = parity([...fixture.seed, beat(10),
      event(11, { kind: "micro.set", micro_id: "T01.M01", state: "pending" }),
      event(12, { kind: "task.release", task_id: "T01" }), event(13, { kind: "task.claim", task_id: "T01" }),
      event(14, { kind: "micro.set", micro_id: "T01.M02", state: "active" }),
      beat(15, "run_A", { micro_id: "T01.M02" })]);
    expect(projectedMicro(state, 1).live).toBeUndefined();
  });

  it("caps retirement at 256 IDs per scope without readmitting old runs", () => {
    let state = initial();
    for (let n = 10; n < 280; n++) state = apply(copy(state), beat(n, `run_${n}`));
    const retired = state.replayed_ops["activity.retired"] as Record<string, string[]>;
    expect(Object.values(retired).every((runs) => runs.length <= 256)).toBe(true);
    state = apply(copy(state), event(280, { kind: "micro.set", micro_id: "T01.M02", state: "active" }));
    state = apply(copy(state), beat(281, "run_10", { micro_id: "T01.M02" }));
    expect(projectedMicro(state, 1).live).toBeUndefined();
  });

  it("ownership rejection precedes the microtask lookup", () => {
    const ev = beat(10, "run_A", { micro_id: "T01.M12" });
    ev["agent"] = "mallory";
    const result = applyOp(initial(), ev);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("claimed_by_other");
  });

  it.each(["\x00", "\t", "\n", "\x1b", "\x7f", "\x85", "\x9f"])("rejects control character %j in notes", (control) => {
    expect(validateOpShapeCode({ ...fixture.beat.op, note: `passive${control}text` })).toBe("bad_op");
  });
});

describe("U90 repair: activity display guards", () => {
  it("an empty done parent outranks waiting and attention", () => {
    expect(deriveActivity(task([], { state: "done", ready: false }), undefined, 1000, { needsYou: true })).toBe("done");
  });

  it.each([undefined, null, NaN, Infinity, 1.5, 2 ** 53, "10"])("invalid beat Lamport %j is unknown", (value) => {
    const m = micro({ live: { ...live, beat_lamport: value } as unknown as typeof live });
    expect(deriveActivity(task([m]), m, 1000)).toBe("unknown");
  });

  it("negative timestamps cannot imply working", () => {
    const m = micro({ live: { ...live, beat_ts: -100 } });
    expect(deriveActivity(task([m]), m, 1000)).toBe("unknown");
  });
});
