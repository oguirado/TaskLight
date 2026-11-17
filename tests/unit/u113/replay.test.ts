import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentStore } from "../../../src/app/agent_store";
import type { AgentStore, PlanProjectionResult, TemplateResolver } from "../../../src/app/agent_store";
import { event, fixture, opEvent, template } from "../u85/helpers";
import { arrivals, CLOCK, roomHistory, SEEDS, tryMutation } from "./histories";
import type { Mutable } from "./histories";
import { UncachedReference } from "./uncached-reference";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(CLOCK); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const resolveTemplate: TemplateResolver = () => structuredClone(template);

function equivalent(store: AgentStore, reference: UncachedReference, rooms = ["demo"]): void {
  for (const room of rooms) expect(store.plan(room), `plan(${room}) full replay`).toEqual(reference.plan(room));
  expect(store.states(), "states full replay").toEqual(reference.states());
  expect(store.plans(), "plans full replay and order").toEqual(reference.plans());
  expect(store.since(), "maximum-Lamport cursors").toEqual(reference.since());
}
function fill(store: AgentStore, reference: UncachedReference, events = fixture()): void {
  for (const item of events) {
    expect(store.ingestChecked(item)).toBe("accepted");
    reference.retain(item);
  }
}

describe("A1 seeded prefix equivalence", () => {
  it.each(SEEDS)("A1 seed %i: mixed reordered arrivals, duplicate ids, two rooms and two instances", seed => {
    const stores = [createAgentStore({ templates: resolveTemplate, maxPerRoom: 2 }),
      createAgentStore({ templates: resolveTemplate, maxPerRoom: 3 })];
    const references = [new UncachedReference(resolveTemplate), new UncachedReference(resolveTemplate)];
    const seen = new Set<string>();
    for (const item of arrivals(seed)) {
      const expected = seen.has(item.id) ? "duplicate" : "accepted";
      seen.add(item.id);
      stores.forEach((store, i) => {
        expect(store.ingestChecked(item), `seed=${seed} id=${item.id}`).toBe(expected);
        references[i]!.retain(item);
        for (let read = 0; read < 2; read++) equivalent(store, references[i]!, ["demo", "zeta", "only-legacy", "empty"]);
      });
    }
    for (const store of stores) {
      expect(store.plans().map(plan => plan.room)).toEqual(["demo", "zeta"]);
      const result = store.plan("demo")!;
      expect(result.source).toBe("v2");
      expect(result.invalidOps).toBe(0);
      expect(result.rejectedOps).toBe(2);
      expect(result.errors?.map(error => error.code)).toEqual(["stale_rev", "not_found"]);
      expect(result.projection.plan).toMatchObject({ title: "Reopened", state: "active", opened_lamport: 17 });
      expect(result.projection.tasks).toEqual([]);
      expect(result.projection.memory["goal"]).toMatchObject({ text: "after reopen", rev: 18, by: "alice" });
      expect(result.projection.archived_plans).toHaveLength(1);
      expect(result.projection.archived_plans[0]).toMatchObject({ tasks_total: 2, tasks_done: 1 });
      expect(store.states().find(state => state.room === "demo" && state.agent === "alice")).toMatchObject({
        stepStates: ["active"], openQuestions: [],
      });
    }
    const before = stores[1]!.plan("demo");
    expect(stores[0]!.ingest(opEvent(4000, { kind: "memory.set", section: "goal", text: "store one only", base_rev: 18 }))).toBe(true);
    expect(stores[0]!.plan("demo")?.projection.memory["goal"]?.text).toBe("store one only");
    expect(stores[1]!.plan("demo")).toEqual(before);
  });

  it("A1 equal-Lamport arrivals use ordinal event ids rather than arrival order", () => {
    const low = opEvent(100, { kind: "memory.set", section: "goal", text: "first", base_rev: 0 });
    const high = { ...opEvent(101, { kind: "memory.set", section: "goal", text: "second", base_rev: 100 }), lamport: 100 };
    const lowBeat = event(102, { lamport: 100, text: "low" });
    const highBeat = event(103, { lamport: 100, text: "high" });
    const store = createAgentStore();
    const reference = new UncachedReference();
    for (const item of [highBeat, high, lowBeat, low]) {
      expect(store.ingest(item)).toBe(true); reference.retain(item);
      equivalent(store, reference);
    }
    expect(store.since()).toEqual({ demo: 100 });
    expect(store.plan("demo")?.projection.memory["goal"]).toMatchObject({ text: "second", rev: 100 });
    expect(store.states()[0]).toMatchObject({ lastText: "high", lastSeen: highBeat.ts });
  });

  it("M1 preserves undefined cases, public result shape and plans room ordering", () => {
    const store = createAgentStore();
    expect(store.plan("empty")).toBeUndefined();
    expect(store.plan(null as unknown as string)).toBeUndefined();
    expect(store.states()).toEqual([]);
    expect(store.plans()).toEqual([]);
    expect(store.ingest(event(99, { room: "legacy" }))).toBe(true);
    expect(store.plan("legacy")).toBeUndefined();
    for (const [n, room] of [[100, "zeta"], [101, "alpha"]] as const) {
      expect(store.ingest({ ...opEvent(n, { kind: "memory.set", section: "goal", text: room, base_rev: 0 }), room })).toBe(true);
    }
    expect(store.plans().map(plan => plan.room)).toEqual(["alpha", "zeta"]);
    expect(Object.keys(store.plan("alpha")!).sort()).toEqual(["errors", "invalidOps", "projection", "rejectedOps", "room", "source"]);
  });

  it("M5 display retention keeps all operations and pruned legacy activity in both folds", () => {
    const heartbeat = event(10, { ts: 1_700_000_600_000 });
    const takeover = event(20, { act: "op", agent: "bob", ts: 1_700_000_700_000,
      op: { kind: "task.claim", task_id: "T01", takeover: true } });
    const history = [...fixture().slice(0, 4), heartbeat,
      ...[11, 12, 13].map(n => event(n, { agent: "bob" })), takeover];
    const store = createAgentStore({ templates: resolveTemplate, maxPerRoom: 2 });
    const reference = new UncachedReference(resolveTemplate);
    fill(store, reference, history);
    equivalent(store, reference);
    expect(store.plan("demo")?.projection.rejected.at(-1)?.code).toBe("claimed_by_other");
    expect(store.events("demo").filter(item => item.act !== "op")).toHaveLength(2);
    expect(store.events("demo").filter(item => item.act === "op")).toHaveLength(5);
    expect(store.events("demo").some(item => item.id === heartbeat.id)).toBe(false);
    expect(store.states().find(state => state.agent === "alice")?.lastSeen).toBe(heartbeat.ts);
  });

  it.each([0, -1, 1.5, NaN, Infinity])("M5 invalid maxPerRoom %s still throws RangeError", maxPerRoom => {
    expect(() => createAgentStore({ maxPerRoom })).toThrow(RangeError);
  });
});

describe("A2 late arrival and A4 non-plan invalidation", () => {
  it("A2 withheld fixture claim invalidates both reads without increasing since", () => {
    const store = createAgentStore({ templates: resolveTemplate });
    const reference = new UncachedReference(resolveTemplate);
    const history = fixture();
    const claim = history.find(item => item.op?.kind === "task.claim")!;
    fill(store, reference, history.filter(item => item.id !== claim.id));
    equivalent(store, reference);
    expect(store.plan("demo")?.projection.tasks[0]?.assignee).toBeNull();
    const cursor = store.since();
    expect(store.ingestChecked(claim)).toBe("accepted"); reference.retain(claim);
    expect(store.since()).toEqual(cursor);
    equivalent(store, reference);
    expect(store.plan("demo")?.projection.tasks.find(task => task.id === "T01")?.assignee).toBe("alice");
    equivalent(store, reference);
  });

  it("M3 late legacy heartbeat changes takeover despite unchanged maximum Lamport", () => {
    const store = createAgentStore({ templates: resolveTemplate, maxPerRoom: 2 });
    const reference = new UncachedReference(resolveTemplate);
    const takeover = event(20, { act: "op", agent: "bob", ts: 1_700_000_700_000,
      op: { kind: "task.claim", task_id: "T01", takeover: true } });
    fill(store, reference, [...fixture().slice(0, 4), takeover]);
    equivalent(store, reference);
    expect(store.plan("demo")?.projection.tasks[0]?.assignee).toBe("bob");
    const cursor = store.since();
    const heartbeat = event(10, { ts: 1_700_000_600_000 });
    expect(store.ingestChecked(heartbeat)).toBe("accepted"); reference.retain(heartbeat);
    expect(store.since()).toEqual(cursor);
    equivalent(store, reference);
    expect(store.plan("demo")?.projection.tasks[0]?.assignee).toBe("alice");
    expect(store.plan("demo")?.errors?.at(-1)?.code).toBe("claimed_by_other");
    expect(store.states().find(state => state.agent === "alice")?.lastSeen).toBe(heartbeat.ts);
  });

  it("A4 memory before any plan invalidates cached undefined; heartbeat updates states", () => {
    const store = createAgentStore({ templates: resolveTemplate });
    const reference = new UncachedReference(resolveTemplate);
    expect(store.plan("demo")).toBeUndefined(); expect(store.states()).toEqual([]);
    const memory = opEvent(100, { kind: "memory.set", section: "goal", text: "updated", base_rev: 0 });
    expect(store.ingestChecked(memory)).toBe("accepted"); reference.retain(memory);
    equivalent(store, reference);
    const before = store.plan("demo")!.projection;
    expect(before.plan).toBeNull();
    expect(before.memory["goal"]).toMatchObject({ text: "updated", rev: memory.lamport });
    const beat = event(101, { text: "still working" });
    expect(store.ingest(beat)).toBe(true); reference.retain(beat);
    equivalent(store, reference);
    expect(store.plan("demo")?.projection.rollup).toEqual(before.rollup);
    expect(store.states()[0]).toMatchObject({ lastSeen: beat.ts, lastText: "still working" });
  });

  it("M6 room memory survives before-plan, close and reopen at every prefix", () => {
    const store = createAgentStore({ templates: resolveTemplate });
    const reference = new UncachedReference(resolveTemplate);
    // A-U113a: include the added pre-close cancellation; U109 MUST M6 keeps the close/reopen fixture legal.
    for (const item of roomHistory("demo", 5000).filter(item => item.lamport <= 18)) {
      expect(store.ingestChecked(item)).toBe("accepted"); reference.retain(item);
      equivalent(store, reference);
      if (item.lamport === 1) expect(store.plan("demo")?.projection.plan).toBeNull();
      if (item.lamport === 15) expect(store.plan("demo")?.projection.plan?.state).toBe("closed");
      if (item.lamport === 16) expect(store.plan("demo")?.projection.memory["goal"]).toMatchObject({ text: "while closed", rev: 16 });
      if (item.lamport === 17) expect(store.plan("demo")?.projection.memory["goal"]).toMatchObject({ text: "while closed", rev: 16 });
    }
    expect(store.plan("demo")?.projection.memory["goal"]).toMatchObject({ text: "after reopen", rev: 18 });
  });

  it("M3 accepted semantic rejection updates complete diagnostic receipts", () => {
    const store = createAgentStore({ templates: resolveTemplate });
    const reference = new UncachedReference(resolveTemplate);
    fill(store, reference); equivalent(store, reference);
    const rejected = { ...opEvent(100, { kind: "task.claim", task_id: "T01" }), agent: "bob" };
    expect(store.ingestChecked(rejected)).toBe("accepted"); reference.retain(rejected);
    equivalent(store, reference);
    expect(store.plan("demo")).toMatchObject({ invalidOps: 0, rejectedOps: 1,
      errors: [{ id: rejected.id, lamport: 100, code: "claimed_by_other" }] });
    expect(store.plan("demo")?.projection.rejected.at(-1)).toMatchObject({ id: rejected.id, code: "claimed_by_other" });
  });

  it("M3 activity.beat invalidates live receipts without changing semantic revisions", () => {
    const store = createAgentStore({ templates: resolveTemplate });
    const reference = new UncachedReference(resolveTemplate);
    fill(store, reference, fixture().slice(0, 5)); equivalent(store, reference);
    const before = store.plan("demo")!.projection;
    const beat = opEvent(100, { kind: "activity.beat", task_id: "T01", micro_id: "T01.M01", run_id: "run_113", op_id: "beat_113" });
    expect(store.ingestChecked(beat)).toBe("accepted"); reference.retain(beat);
    equivalent(store, reference);
    const after = store.plan("demo")!.projection;
    expect(after.tasks[0]?.microtasks[0]?.live).toEqual({ agent: "alice", run_id: "run_113", beat_ts: beat.ts, beat_lamport: 100 });
    expect(after.tasks[0]?.rev).toBe(before.tasks[0]?.rev);
    expect(after.tasks[0]?.microtasks[0]?.rev).toBe(before.tasks[0]?.microtasks[0]?.rev);
    expect(after.rollup).toEqual(before.rollup);
    vi.setSystemTime(CLOCK + 10_000_000);
    expect(store.plan("demo")?.projection).toEqual(after);
  });
});

describe("A5 hostile inputs and defensive ownership", () => {
  it.each(["__proto__", "constructor", "prototype"])("A5 own %s operation key is invalid and cannot change projections or cursors", key => {
    const store = createAgentStore({ templates: resolveTemplate });
    const reference = new UncachedReference(resolveTemplate);
    fill(store, reference); equivalent(store, reference);
    const before = { plan: structuredClone(store.plan("demo")), states: store.states(), since: store.since() };
    const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
    const op = JSON.parse(`{"kind":"memory.set","section":"notes","text":"bad","base_rev":0,"${key}":{"polluted":true}}`) as Record<string, unknown>;
    expect(Object.hasOwn(op, key)).toBe(true);
    expect(store.ingestChecked(opEvent(100, op))).toBe("invalid");
    expect(store.ingest(opEvent(100, op))).toBe(false);
    expect({ plan: store.plan("demo"), states: store.states(), since: store.since() }).toEqual(before);
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototype);
    const corrected = opEvent(100, { kind: "memory.set", section: "notes", text: "safe", base_rev: 0 });
    expect(store.ingestChecked(corrected)).toBe("accepted"); reference.retain(corrected);
    expect(store.ingestChecked(corrected)).toBe("duplicate");
    equivalent(store, reference);
  });

  it("A5 __proto__ room is rejected and constructor room remains isolated", () => {
    const store = createAgentStore({ templates: resolveTemplate });
    const reference = new UncachedReference(resolveTemplate);
    fill(store, reference);
    const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
    expect(store.ingestChecked({ ...event(99), room: "__proto__" })).toBe("invalid");
    expect(store.plan("__proto__")).toBeUndefined(); expect(store.events("__proto__")).toEqual([]);
    const memory = { ...opEvent(100, { kind: "memory.set", section: "goal", text: "constructor only", base_rev: 0 }), room: "constructor" };
    expect(store.ingestChecked(memory)).toBe("accepted"); reference.retain(memory);
    equivalent(store, reference, ["demo", "constructor", "__proto__"]);
    expect(store.plan("constructor")?.projection.memory["goal"]?.text).toBe("constructor only");
    expect(store.plan("demo")?.projection.memory["goal"]?.text).toBe("Ship TaskLight");
    expect(Object.hasOwn(store.since(), "constructor")).toBe(true);
    expect(store.since()["constructor"]).toBe(100);
    expect(Object.hasOwn(store.since(), "__proto__")).toBe(false);
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototype);
  });

  it("A5 conflicting valid payload with an accepted id is duplicate globally; invalid payload remains invalid", () => {
    const store = createAgentStore({ templates: resolveTemplate });
    const reference = new UncachedReference(resolveTemplate);
    fill(store, reference); equivalent(store, reference);
    const first = fixture()[0]!;
    const conflict = { ...first, room: "other", lamport: 9999, op: { kind: "memory.set", section: "goal", text: "conflict", base_rev: 0 } };
    expect(store.ingestChecked(conflict)).toBe("duplicate");
    expect(store.ingest(conflict)).toBe(false);
    expect(store.ingestChecked({ ...conflict, lamport: -1 })).toBe("invalid");
    expect(store.plan("other")).toBeUndefined(); expect(store.events("other")).toEqual([]);
    equivalent(store, reference);
  });

  it("A5 mutating post-ingest caller events and returned events cannot alter either projection", () => {
    const store = createAgentStore({ templates: resolveTemplate });
    const reference = new UncachedReference(resolveTemplate);
    const input = [...fixture(), event(100, { act: "plan", plan: { title: "Original", steps: [{ text: "Original step" }] } }),
      event(101, { act: "question", text: "Original question", evidence: [{ path: "tests/unit/u85/evidence.md", sha256: "a".repeat(64) }] })];
    fill(store, reference, input); equivalent(store, reference);
    (input[0]!.op!["brief"] as Record<string, string>)["goal"] = "caller mutation";
    (input[7]!.op!["evidence"] as { sha256: string }[])[0]!.sha256 = "b".repeat(64);
    input[8]!.plan!.steps[0]!.text = "caller step";
    input[9]!.text = "caller question"; input[9]!.evidence![0]!.path = "changed";
    const output = store.events("demo");
    output[0]!.text = "display mutation";
    (output[0]!.op!["brief"] as Record<string, string>)["goal"] = "display brief";
    equivalent(store, reference);
  });

  it("A5 returned nested projections and states cannot mutate retained results", () => {
    const store = createAgentStore({ templates: resolveTemplate });
    const reference = new UncachedReference(resolveTemplate);
    fill(store, reference, [...fixture(), event(100, { act: "plan", plan: { title: "Original", steps: [{ text: "Original step" }] } }),
      event(101, { act: "question", text: "Original question" })]);
    equivalent(store, reference);
    const result = store.plan("demo")! as Mutable<PlanProjectionResult>;
    const states = store.states();
    const alice = states.find(state => state.agent === "alice")!;
    const actions = [
      () => { result.projection.tasks[0]!.microtasks[0]!.evidence[0]!.sha256 = "changed"; },
      () => { result.projection.tasks[0]!.title = "changed"; },
      () => { result.projection.memory["goal"]!.text = "changed"; },
      () => { result.projection.plan!.brief["goal"] = "changed"; },
      () => { result.projection.rollup.progress_pct = -1; },
      () => { alice.contract!.steps[0]!.text = "changed"; },
      () => { alice.stepStates[0] = "done"; },
      () => { alice.openQuestions[0]!.text = "changed"; },
      () => { states.splice(0); },
    ];
    for (const action of actions) { tryMutation(action); equivalent(store, reference); }
  });

  it.each(["errors", "rejectedOps", "invalidOps", "template"] as const)("A5 returned %s mutation is isolated", field => {
    const source = structuredClone(template);
    const independent = structuredClone(template);
    const store = createAgentStore({ templates: () => source });
    const reference = new UncachedReference(() => independent);
    fill(store, reference, [...fixture(), { ...opEvent(100, { kind: "task.claim", task_id: "T01" }), agent: "bob" }]);
    equivalent(store, reference);
    const result = store.plan("demo")! as Mutable<PlanProjectionResult>;
    tryMutation(() => {
      switch (field) {
        case "errors": result.errors![0]!.code = "changed"; result.errors!.push({ code: "changed" }); break;
        case "rejectedOps": result.rejectedOps = 999; break;
        case "invalidOps": result.invalidOps = 999; break;
        case "template": result.template!.name = "changed by consumer"; break;
      }
    });
    equivalent(store, reference);
    expect(source.name, "returned templates must not alias resolver-owned data").toBe(independent.name);
  });
});
