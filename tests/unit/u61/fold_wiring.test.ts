import { afterEach, describe, expect, it, vi } from "vitest";
import * as Plan from "../../../src/plan";
import { createAgentStore } from "../../../src/app/agent_store";
import { foldRoomWithStats } from "../../../src/agents";
import { event, id, legacyEvents, opEvent, openOp, order, planStore, projection, vector } from "./helpers";

// The reducer is U60-owned and currently a throwing dependency stub.
// This probe verifies U61 forwarding and result propagation, never reducer semantics.
afterEach(() => vi.restoreAllMocks());
function reducerPort(p = projection()) {
  return vi.spyOn(Plan, "foldPlan").mockReturnValue({ projection: p,
    stats: { applied: 1, replayed: 0, rejected: p.rejected.length, invalid: 0, errors: [] } });
}

describe("O3/O6 U60 folding boundary", () => {
  it.each([true, false])("O4 delegates operation validation to U60 (accepted=%s)", accepted => {
    const validate = vi.spyOn(Plan, "validateOpEvent").mockReturnValue(accepted);
    const s = createAgentStore(); const e = opEvent(1, openOp());
    expect(s.ingest(e)).toBe(accepted);
    expect(validate).toHaveBeenCalledWith(e);
  });
  it("O6 exposes safe empty-room plan/plans queries", () => {
    const s = planStore(); expect(() => s.plan("unknown")).not.toThrow(); expect(s.plan("unknown")).toBeUndefined(); expect(s.plans()).toEqual([]);
  });
  it.each(["task_add", "stale_rev", "cycle_2", "claimed_by_other", "takeover_600000", "takeover_600001", "memory_before_plan", "reopen_preserves_memory"])(
    "O6 forwards %s in deterministic order and returns the canonical reducer result", name => {
      const c = vector(name); const fold = reducerPort(c.expected_projection); const s = planStore();
      [...c.events].reverse().forEach(e => expect(s.ingest(e)).toBe(true));
      expect(s.plan("oracle")).toMatchObject({ room: "oracle", source: "v2", projection: c.expected_projection });
      expect(fold).toHaveBeenCalled(); expect(fold.mock.calls.at(-1)![0]).toEqual([...c.events].sort(order));
      expect(s.plans().find(p => p.room === "oracle")?.projection).toEqual(c.expected_projection);
    });
  it("O6 tie-break uses ordinal event ID rather than arrival order", () => {
    const fold = reducerPort(); const s = planStore();
    const a = opEvent(2, openOp(), { id: id(10) }); const b = opEvent(2, openOp(), { id: id(11) });
    expect(s.ingest(b)).toBe(true); expect(s.ingest(a)).toBe(true); s.plan("oracle");
    expect(fold.mock.calls.at(-1)![0]).toEqual([a, b]);
  });
  it("O3 repeated op_id records reach U60 unchanged; no store-level suppression", () => {
    const fold = reducerPort(); const s = planStore();
    const events = [opEvent(1, { ...openOp(), op_id: "retry_001" }), opEvent(2, { ...openOp(), op_id: "retry_001", title: "Changed" })];
    events.forEach(e => expect(s.ingest(e)).toBe(true)); s.plan("oracle");
    expect(fold.mock.calls.at(-1)![0]).toEqual(events); expect(s.events("oracle")).toHaveLength(2); expect(s.since()["oracle"]).toBe(2);
  });
  it("O6 W0-R passes complete room activity including human and legacy events for takeover", () => {
    const fold = reducerPort(); const s = planStore();
    const events = [...vector("takeover_600001").events,
      event(100, { act: "heartbeat", agent: "alice", ts: 1_700_000_500_000 }),
      event(101, { act: "question", agent: "human", text: "Activity", ts: 1_700_000_500_001 })];
    [...events].reverse().forEach(e => expect(s.ingest(e)).toBe(true)); s.plan("oracle");
    expect(fold.mock.calls.at(-1)![0]).toEqual([...events].sort(order));
    expect(s.events("oracle")).toHaveLength(events.length);
  });
  it("O8 mixed room keeps v2 projection and legacy states independently", () => {
    const p = projection(); reducerPort(p); const s = planStore();
    const legacy = legacyEvents("oracle"); [...legacy, ...vector("task_add").events].forEach(e => expect(s.ingest(e)).toBe(true));
    expect(s.plan("oracle")?.projection).toEqual(p); expect(s.states()).toEqual(foldRoomWithStats(legacy).states);
  });
});
