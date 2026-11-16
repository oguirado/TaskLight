import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentStore } from "../../../src/app/agent_store";
import * as Plan from "../../../src/plan";
import { checked, event, fixture, opEvent, pythonRelay, template } from "./helpers";

const options = { templates: () => template };
afterEach(() => vi.restoreAllMocks());

describe("A1 retention and M1 full folding history", () => {
  it("A1 pins every operation and keeps exactly the newest 5000 non-ops after 5001 heartbeats", () => {
    const ops = fixture();
    const history = [...ops, ...Array.from({ length: 5001 }, (_, i) => event(100 + i))];
    const store = createAgentStore(options);
    for (const ev of history) expect(store.ingest(ev)).toBe(true);
    expect(store.plan("demo"), "the plan must survive display retention").toBeDefined();
    expect(store.plan("demo")?.projection).toEqual(Plan.foldPlan(history, template).projection);
    expect(store.plan("demo")?.projection).toEqual(pythonRelay({ events: history }).projection);
    const display = store.events("demo");
    expect(display.filter(e => e.act === "op")).toEqual(ops);
    expect(display.filter(e => e.act !== "op")).toEqual(history.slice(ops.length + 1));
    expect(display.filter(e => e.act !== "op")).toHaveLength(5000);
  }, 60_000); // A-U85a: full fold over 5,009 events takes seconds (PERF-1 debt)

  it("A1 preserves pruned non-op activity and reducer rejection receipts at a small display cap", () => {
    const base = fixture().slice(0, 4);
    const heartbeat = event(10, { ts: 1_700_000_600_000 });
    const takeover = event(20, { act: "op", agent: "bob", ts: 1_700_000_700_000,
      op: { kind: "task.claim", task_id: "T01", takeover: true } });
    const history = [...base, heartbeat, ...[11, 12, 13].map(n => event(n, { agent: "bob" })), takeover];
    const expected = Plan.foldPlan(history, template).projection;
    expect(expected.rejected.at(-1)?.code).toBe("claimed_by_other");
    const store = createAgentStore({ ...options, maxPerRoom: 2 });
    for (const ev of history) expect(store.ingest(ev)).toBe(true);
    expect(store.plan("demo")?.projection).toEqual(expected);
    expect(store.plan("demo")?.projection).toEqual(pythonRelay({ events: history }).projection);
    expect(store.events("demo").some(e => e.id === heartbeat.id)).toBe(false);
    expect(store.events("demo").filter(e => e.act !== "op")).toHaveLength(2);
  });

  it("A1 ordering, deduplication and defensive copies survive retention", () => {
    const store = createAgentStore({ ...options, maxPerRoom: 2 });
    const input = fixture();
    const saved = structuredClone(input);
    for (const ev of [...input].reverse()) expect(store.ingest(ev)).toBe(true);
    input[0]!.text = "changed input";
    const out = store.events("demo");
    out[0]!.text = "changed output";
    (out.at(-1)!.op as unknown as { evidence: { sha256: string }[] }).evidence[0]!.sha256 = "changed";
    expect(store.events("demo")).toEqual(saved);
    expect(store.ingest(saved[0])).toBe(false);
    expect(store.events("demo")).toEqual(saved);
  });

  it("A8 shared-list pruning negative control loses the plan while the public store must retain it", () => {
    const history = [...fixture(), ...[20, 21, 22].map(n => event(n))];
    const expected = Plan.foldPlan(history, template).projection;
    const mutant = Plan.foldPlan(history.slice(-2), template).projection;
    expect(mutant).not.toEqual(expected);
    const store = createAgentStore({ ...options, maxPerRoom: 2 });
    history.forEach(ev => store.ingest(ev));
    expect(store.plan("demo")?.projection).toEqual(expected);
  });
});

describe("A2 checked ingestion compatibility; A5 invalid evidence", () => {
  it("A2 real relay replay equals both unpruned folds and duplicates change nothing", () => {
    const { frames, projection } = pythonRelay();
    const store = createAgentStore(options);
    const events = frames.filter(f => f.t === "room_event").map(f => f["event"]);
    for (const ev of events) expect(checked(store, ev)).toBe("accepted");
    expect(store.plan("demo")?.projection).toEqual(projection);
    expect(projection.tasks[0]?.state).toBe("done");
    expect(projection.rollup.progress_pct).toBe(50);
    expect(Object.keys(projection.memory).sort()).toEqual(["decisions", "goal"]);
    for (const ev of events) expect(checked(store, ev)).toBe("duplicate");
    expect(store.plan("demo")?.projection).toEqual(projection);
    expect(store.events("demo")).toEqual(events);
  });

  it("M2 preserves boolean ingestion and JSONL duplicate malformed and torn compatibility", () => {
    const store = createAgentStore(options);
    const first = fixture()[0]!;
    expect(checked(store, first)).toBe("accepted");
    expect(store.ingest(first)).toBe(false);
    const second = fixture()[1]!;
    expect(store.ingest(second)).toBe(true);
    expect(checked(store, second)).toBe("duplicate");
    expect(store.ingestJsonl(`${JSON.stringify(first)}\ninvalid-json\n{`)).toEqual({
      accepted: 0, duplicate: 1, malformed: 1, torn: true,
    });
  });

  it("A5 redacted sha256 is invalid and cannot complete the microtask or poison a corrected event", () => {
    const store = createAgentStore(options);
    const events = fixture();
    events.slice(0, -1).forEach(ev => expect(store.ingest(ev)).toBe(true));
    const before = structuredClone(store.plan("demo"));
    const corrupted = structuredClone(events.at(-1)!);
    (corrupted.op as unknown as { evidence: { sha256: string }[] }).evidence[0]!.sha256 = "[REDACTED:HIGH_ENTROPY]";
    expect(checked(store, corrupted)).toBe("invalid");
    expect(store.plan("demo")?.projection).toEqual(before?.projection);
    expect(store.events("demo")).toEqual(events.slice(0, -1));
    expect(checked(store, events.at(-1))).toBe("accepted");
  });

  it.each([null, {}, { ...event(50), lamport: Number.MAX_SAFE_INTEGER + 1 },
    opEvent(50, { kind: "unknown.operation" }), JSON.parse('{"__proto__":{},"room":"demo"}')])(
    "M2 hostile checked input %# is invalid without accepted-history mutation", bad => {
      const store = createAgentStore(options);
      fixture().forEach(ev => store.ingest(ev));
      const before = store.events("demo");
      expect(checked(store, bad)).toBe("invalid");
      expect(store.events("demo")).toEqual(before);
    });
});

describe("M7 delegates operation admission across frozen S2", () => {
  it("M7 passes activity.beat unchanged when the integrated validator accepts it", () => {
    const beat = opEvent(10, { kind: "activity.beat", task_id: "T01", micro_id: "T01.M01",
      run_id: "run_1", note: "Working", op_id: "beat_001" });
    const validate = vi.spyOn(Plan, "validateOpEvent").mockReturnValue(true);
    const store = createAgentStore(options);
    expect(store.ingest(beat)).toBe(true);
    expect(validate).toHaveBeenCalledWith(beat);
    expect(store.events("demo")).toEqual([beat]);
  });


  it("M7 preserves the optional S2 live projection from the integrated reducer", () => {
    const store = createAgentStore(options);
    fixture().forEach(ev => expect(store.ingest(ev)).toBe(true));
    const projection = structuredClone(Plan.foldPlan(fixture(), template).projection);
    const live = { agent: "alice", run_id: "run_1", beat_ts: 1_700_000_000_010, beat_lamport: 10 };
    Object.assign(projection.tasks[0]!.microtasks[0]!, { live });
    vi.spyOn(Plan, "foldPlan").mockReturnValue({ projection,
      stats: { applied: 8, replayed: 0, invalid: 0, rejected: 0, errors: [] } });
    expect(store.plan("demo")?.projection).toEqual(projection);
    expect((store.plan("demo")?.projection.tasks[0]?.microtasks[0] as unknown as { live: unknown }).live).toEqual(live);
  });

  it("M7 unknown operations remain rejected by the delegated validator", () => {
    const store = createAgentStore(options);
    const bad = opEvent(10, { kind: "unknown.operation" });
    expect(Plan.validateOpEvent(bad)).toBe(false);
    expect(store.ingest(bad)).toBe(false);
  });
});
