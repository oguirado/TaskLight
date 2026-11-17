import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Plan from "../../../src/plan";
import type { RoomEvent } from "../../../src/agents/types";
import { renderMemoryView } from "../../../src/views/memory";
import { createAgentStore, toWallVM } from "../../../src/app/agent_store";
import { assertHistory, assertScoped, event, EXPECTED, fixture, id, makeStore, memoryOp, noNetwork,
  NOW, op, opening, planEvents, projection, python, template, wall } from "./oracle";
import type { Memory, Projection, Version } from "./oracle";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); noNetwork(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("U126 retained history seam", () => {
  it("A1 shared fixture matches the actual Python memory_history tool", () => {
    expect(python(fixture())).toEqual({ section: "goal", versions: EXPECTED });
  });
  it("A1 plan exposes both accepted versions in Lamport order despite reversed timestamps", () => {
    const p = projection(makeStore());
    expect(p.projection.memory["goal"]).toMatchObject({ rev: 9, text: "new" });
    assertHistory(p.memoryHistory?.["goal"]);
  });
  it("A1 M1 toWallVM carries selected room and history without an active plan", () => {
    const store = makeStore(); expect(projection(store).projection.plan).toBeNull();
    assertScoped(wall(store).memory as Memory | undefined, "demo", EXPECTED);
    expect(wall(store).memory?.sections[0]?.text).toBe("new");
  });
  it("A2 repeated event, repeated operation, stale revision and invalid operation stay excluded", () => {
    const events = fixture();
    events.push(structuredClone(events[0]!),
      op(10, { kind: "memory.set", section: "goal", text: "replayed", base_rev: 9, op_id: "mem-0009" }, { agent: "bob" }),
      op(11, { kind: "memory.set", section: "goal", text: "stale", base_rev: 0, op_id: "mem-0011" }),
      op(12, { kind: "memory.set", section: "goal", text: 42, base_rev: 9, op_id: "mem-0012" }));
    expect(python(events)["versions"]).toEqual(EXPECTED);
    const store = makeStore(events.filter(e => e.lamport !== 12));
    expect(store.ingestChecked(events.at(-1))).toBe("invalid");
    const p = projection(store);
    expect(p.projection.rejected).toContainEqual(expect.objectContaining({ id: id(11), code: "stale_rev" }));
    assertHistory(p.memoryHistory?.["goal"]);
  });
  it("A2 accepted op_id deduplication spans non-memory operation kinds", () => {
    const events = [opening(1, { op_id: "shared-op-identity" }), ...fixture(),
      op(12, { kind: "memory.set", section: "goal", text: "must not appear", base_rev: 9, op_id: "shared-op-identity" })];
    expect(python(events)["versions"]).toEqual(EXPECTED);
    assertHistory(projection(makeStore(events)).memoryHistory?.["goal"]);
  });
  it("A2 rejected operations do not consume accepted operation identities", () => {
    const events = [fixture()[0]!,
      op(6, { kind: "memory.set", section: "goal", text: "rejected", base_rev: 0, op_id: "mem-0009" }, { agent: "bob" }),
      fixture()[1]!];
    expect(python(events)["versions"]).toEqual(EXPECTED);
    assertHistory(projection(makeStore(events)).memoryHistory?.["goal"]);
  });
  it("A2 same operation identity from different agents remains independently accepted", () => {
    const first = fixture()[0]!;
    const second = op(9, { kind: "memory.set", section: "goal", text: "new", base_rev: 5, op_id: "mem-0005" }, { agent: "bob", ts: 1000 });
    expect(python([first, second])["versions"]).toEqual(EXPECTED);
    assertHistory(projection(makeStore([first, second])).memoryHistory?.["goal"]);
  });
  it("A2 first event-id occurrence wins over a changed duplicate payload", () => {
    const events = fixture(); events.push({ ...events[0]!, op: { ...events[0]!.op!, text: "forged duplicate" } });
    expect(python(events)["versions"]).toEqual(EXPECTED);
    assertHistory(projection(makeStore(events)).memoryHistory?.["goal"]);
  });
  it("A2 equal Lamports use event id before reversing accepted versions", () => {
    const first = memoryOp(5, 0, "low-id", { ts: 9000 });
    const second = memoryOp(6, 5, "high-id", { lamport: 5, ts: 1000 });
    const expected = [{ rev: 5, by: "alice", ts: 1000, text: "high-id" },
      { rev: 5, by: "alice", ts: 9000, text: "low-id" }];
    expect(python([second, first])["versions"]).toEqual(expected);
    assertHistory(projection(makeStore([second, first])).memoryHistory?.["goal"], expected);
  });
  it.each([5000, 1])("A3 reverse arrivals and valid close/reopen preserve history at maxPerRoom=%i", maxPerRoom => {
    const store = createAgentStore({ maxPerRoom });
    const [first, second] = fixture();
    expect(store.ingest(second)).toBe(true);
    // Prime the history cache while the newest event is still stale.
    store.plan("demo");
    expect(store.ingest(first)).toBe(true);
    expect(projection(store).projection.memory["goal"]?.text).toBe("new");
    const lifecycle = [opening(20), op(21, { kind: "plan.close", base_rev: 20, outcome: "complete" }), opening(22)];
    for (const e of lifecycle) expect(store.ingest(e)).toBe(true);
    const p = projection(store);
    expect(p.projection.rejected).toEqual([]);
    expect(p.projection.archived_plans).toHaveLength(1);
    expect(p.projection.plan?.opened_lamport).toBe(22);
    expect(python([...fixture(), ...lifecycle])["versions"]).toEqual(EXPECTED);
    assertHistory(p.memoryHistory?.["goal"]);
  });
  it("A3 U123 compaction retains non-beat memory operations with maxPerRoom=1", () => {
    const store = makeStore([...planEvents(),
      op(4, { kind: "task.claim", task_id: "T01" }), ...fixture(),
      op(6, { kind: "micro.set", micro_id: "T01.M01", state: "active" }),
    ], { maxPerRoom: 1 });
    for (let n = 100; n < 140; n++) expect(store.ingest(op(n, { kind: "activity.beat",
      task_id: "T01", micro_id: "T01.M01", run_id: "run_1", op_id: `beat-${n.toString().padStart(4, "0")}` }))).toBe(true);
    expect(store.events("demo").filter(e => e.op?.["kind"] === "memory.set")).toHaveLength(2);
    expect(store.events("demo").filter(e => e.op?.["kind"] === "activity.beat")).toHaveLength(1);
    assertHistory(projection(store).memoryHistory?.["goal"]);
  });
  it("A3 keeps exactly the newest 100 versions in server order per section", () => {
    const events: RoomEvent[] = [], expected: Version[] = [];
    for (let n = 1; n <= 105; n++) {
      const e = memoryOp(n, n - 1, `version-${n}`, { ts: 10_000 - n }); events.push(e);
      expected.unshift({ rev: n, by: "alice", ts: e.ts, text: `version-${n}` });
    }
    const capped = expected.slice(0, 100);
    expect(python(events)["versions"]).toEqual(capped);
    assertHistory(projection(makeStore([...events].reverse(), { maxPerRoom: 1 })).memoryHistory?.["goal"], capped);
  });
  it("A3 M1 each section keeps its own history and final value", () => {
    const events = [...fixture(), op(12, { kind: "memory.set", section: "notes", text: "separate", base_rev: 0 })];
    const p = projection(makeStore(events));
    expect(python(events, { section: "notes" })["versions"]).toEqual([{ rev: 12, by: "alice", ts: NOW + 12, text: "separate" }]);
    assertHistory(p.memoryHistory?.["goal"]);
    expect(p.memoryHistory?.["notes"]).toEqual([{ rev: 12, by: "alice", ts: NOW + 12, text: "separate" }]);
  });
  it("A3 A6 selected-room history is scoped before rendering and updates on room switch", () => {
    const secret = memoryOp(30, 0, "secret", { room: "other" });
    const store = makeStore([...fixture(), secret]);
    const demo = wall(store, "demo").memory as Memory | undefined;
    assertScoped(demo, "demo", EXPECTED);
    const other = wall(store, "other").memory as Memory | undefined;
    expect(other?.room).toBe("other");
    expect(other?.history?.["goal"]).toEqual([{ rev: 30, by: "alice", ts: NOW + 30, text: "secret" }]);
    expect(JSON.stringify(other)).not.toContain('"old"');
    expect(JSON.stringify(other)).not.toContain('"new"');
    expect(renderMemoryView(document, demo).textContent).not.toContain("secret");
  });
  it("A3 no selected room supplies no history or room identity", () => {
    const vm = toWallVM([], undefined, { nowMs: NOW, model: { state: "unavailable", label: "Unavailable" }, network: "offline" });
    const m = vm.memory as Memory | undefined;
    expect(m?.history).toBeUndefined(); expect(m?.room).toBeUndefined();
  });
  it("M2 canonical history ignores a restrictive template override", () => {
    const tpl = template();
    const events = [opening(), ...fixture()];
    const p = projection(makeStore(events, { templates: () => tpl }));
    expect(p.projection.rejected.length).toBeGreaterThan(0);
    expect(python(events)["versions"]).toEqual(EXPECTED);
    assertHistory(p.memoryHistory?.["goal"]);
  });
  it("M2 history does not refold every prefix or refold on cache hits", () => {
    const events = Array.from({ length: 24 }, (_, i) => memoryOp(i + 1, i, `v${i + 1}`));
    const store = makeStore(events);
    const fold = vi.spyOn(Plan, "foldPlan");
    const expected = events.map(e => ({ rev: e.lamport, by: e.agent, ts: e.ts, text: e.op!["text"] as string })).reverse();
    const p = projection(store);
    // At most one display fold and one template-free canonical fold, not one per version.
    expect(fold.mock.calls.length).toBeLessThanOrEqual(2);
    const coldCalls = fold.mock.calls.length;
    store.plan("demo"); store.plans(); store.plan("demo");
    expect(fold.mock.calls.length).toBe(coldCalls);
    assertHistory(p.memoryHistory?.["goal"], expected);
  });
  it("M2 cached history invalidates on a late arrival that unblocks a later revision", () => {
    const store = makeStore([fixture()[1]!]); store.plan("demo");
    expect(store.ingest(fixture()[0])).toBe(true);
    assertHistory(projection(store).memoryHistory?.["goal"]);
  });
  it("M6 cached reads preserve projection equivalence and isolate returned mutation", () => {
    const store = makeStore(); const before = Plan.foldPlan(fixture()).projection;
    expect(projection(store).projection).toEqual(before);
    const first = projection(store);
    try { (first.memoryHistory?.["goal"] as Version[] | undefined)?.pop(); } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
    }
    assertHistory(projection(store).memoryHistory?.["goal"]);
    expect(projection(store).projection).toEqual(before);
  });
  it("M6 legacy callers may omit the additive history fields", () => {
    const store = makeStore(); const { room, source, projection: p, invalidOps } = projection(store);
    const legacy: Projection = { room, source, projection: p, invalidOps };
    const result = toWallVM([], undefined, { nowMs: NOW, model: { state: "unavailable", label: "Unavailable" }, network: "offline" }, [legacy]);
    expect(result.memory?.sections[0]?.text).toBe("new");
    expect(result.memory?.sections[0]?.rev).toBe(9);
  });
});
