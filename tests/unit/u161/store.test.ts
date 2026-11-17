import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentStore } from "../../../src/app/agent_store";
import type { TemplateResolver } from "../../../src/app/agent_store";
import { foldPlan } from "../../../src/plan";
import { canonicalStarterTemplateHash } from "../../../src/app/starter_templates";
import { A, B, CLOCK, FIRST_TITLE, SECOND_TITLE, MISSION, admit, event, expectClean,
  expectedProjection, history, opening, resolver, task } from "./history";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(CLOCK); });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); });

describe("U161 generation-aware browser folding", () => {
  it("M1/M2 closed A followed by open B retains the archive, memory and current tasks without rejections", () => {
    const events = history();
    const expected = expectedProjection(events);
    expect(expected.archived_plans).toEqual([{
      id: "p1", title: FIRST_TITLE, template_id: A.id,
      opened_ts: events[0]!.ts, closed_ts: events[5]!.ts,
      tasks_total: 1, tasks_done: 0, outcome: "Retired to verify archive continuity",
    }]);
    expect(expected.plan).toMatchObject({ title: SECOND_TITLE, template_id: B.id,
      template_hash: B.hash, opened_lamport: 7, phase: "execute" });
    expect(expected.tasks).toHaveLength(1);
    expect(expected.tasks[0]).toMatchObject({ id: "T01", type: "task", phase: "plan" });
    expect(expected.memory["mission"]?.text).toBe(MISSION);
    const store = createAgentStore({ templates: resolver });
    admit(store, events);
    expectClean(store.plan("demo"), expected);
  });

  it("M2 a previously cached closed archive survives a live opening with a different template", () => {
    const events = history();
    const store = createAgentStore({ templates: resolver });
    admit(store, events.slice(0, 6));
    const before = structuredClone(store.plan("demo")!.projection.archived_plans);
    expect(before.map(plan => plan.title)).toEqual([FIRST_TITLE]);
    admit(store, events.slice(6));
    expect(store.plan("demo")!.projection.archived_plans).toEqual(before);
    expectClean(store.plan("demo"), expectedProjection(events));
  });

  it("M5 rejected B opening leaves A's admitted phase and template context active", () => {
    const events = [event(1, opening(A, FIRST_TITLE)), event(2, opening(B, "Rejected B")),
      event(3, task(A)), event(4, { kind: "plan.phase", phase: "design", base_rev: 1 })];
    const store = createAgentStore({ templates: resolver }); admit(store, events);
    const result = store.plan("demo")!;
    expect(result.errors).toEqual([{ id: events[1]!.id, lamport: 2, code: "plan_exists" }]);
    expect(result.rejectedOps).toBe(1);
    expect(result.projection.plan).toMatchObject({ title: FIRST_TITLE, template_id: A.id, phase: "design" });
    expect(result.projection.tasks[0]).toMatchObject({ phase: "brief" });
    expect(result.template?.id).toBe(A.id);
  });

  it("M5/M6 equal-Lamport id ordering admits A before the rejected B even when arrivals are reversed", () => {
    const first = event(1, opening(A, FIRST_TITLE));
    const rejected = event(2, opening(B, "Rejected equal-Lamport B"), { lamport: 1 });
    const phase = event(3, { kind: "plan.phase", phase: "design", base_rev: 1 });
    const store = createAgentStore({ templates: resolver }); admit(store, [rejected, phase, first]);
    const result = store.plan("demo")!;
    expect(result.errors).toEqual([{ id: rejected.id, lamport: 1, code: "plan_exists" }]);
    expect(result.projection.plan).toMatchObject({ title: FIRST_TITLE, phase: "design", rev: 3 });
  });

  it.each(["phase", "hash"] as const)("M5/N2 invalid %s opening after closure does not consume the next generation", violation => {
    const closed = history().slice(0, 6);
    const bad = event(7, { ...opening(B, "Rejected opening"),
      ...(violation === "phase" ? { phase: "design" } : { template_hash: "0".repeat(64) }) });
    const events = [...closed, bad, event(8, opening(B, SECOND_TITLE)), event(9, task(B))];
    const store = createAgentStore({ templates: resolver }); admit(store, events);
    const result = store.plan("demo")!;
    expect(result.invalidOps).toBe(0);
    expect(result.errors?.map(error => [error.id, error.lamport])).toEqual([[bad.id, 7]]);
    expect(result.rejectedOps).toBe(1);
    expect(result.projection.archived_plans.map(plan => plan.title)).toEqual([FIRST_TITLE]);
    expect(result.projection.plan).toMatchObject({ title: SECOND_TITLE, opened_lamport: 8, template_hash: B.hash });
    expect(result.projection.tasks).toHaveLength(1);
  });

  it("M1 templates with the same id but different valid hashes keep their own phases", () => {
    const old = structuredClone(B);
    const next = { ...structuredClone(B), name: "Next version", phases: [
      { id: "next", label: "Next", exit: "Next generation verified" },
    ] };
    next.hash = canonicalStarterTemplateHash(next);
    expect(next.hash).not.toBe(old.hash);
    const resolve: TemplateResolver = (id, hash) => [old, next].find(template => template.id === id && template.hash === hash);
    const events = [event(1, opening(old, "Version one")),
      event(2, { kind: "plan.phase", phase: "review", base_rev: 1 }),
      event(3, { kind: "plan.close", base_rev: 2, outcome: "First version complete" }),
      event(4, opening(next, "Version two")), event(5, task(next))];
    const store = createAgentStore({ templates: resolve }); admit(store, events);
    expectClean(store.plan("demo"), expectedProjection(events, resolve));
    expect(store.plan("demo")!.projection.plan?.phase).toBe("next");
  });

  it("M1/M2 A to B to A preserves both archives and plan-local task numbering", () => {
    const events = [...history(), event(11, { kind: "task.set", task_id: "T01", base_rev: 9, state: "cancelled" }),
      event(12, { kind: "plan.close", base_rev: 10, outcome: "Second generation complete" }),
      event(13, opening(A, "Third plan")), event(14, task(A))];
    const store = createAgentStore({ templates: resolver }); admit(store, events);
    expectClean(store.plan("demo"), expectedProjection(events));
    expect(store.plan("demo")!.projection.archived_plans.map(plan => plan.title)).toEqual([FIRST_TITLE, SECOND_TITLE]);
    expect(store.plan("demo")!.projection.tasks[0]?.id).toBe("T01");
  });

  it("M4/M6 cold reversed replay and duplicate delivery equal the warm projection and identities", () => {
    const events = history(); const expected = expectedProjection(events);
    const warm = createAgentStore({ templates: resolver });
    for (const item of events) { admit(warm, [item]); warm.plan("demo"); }
    const cold = createAgentStore({ templates: resolver }); admit(cold, [...events].reverse());
    for (const store of [cold, warm]) {
      for (const item of events) expect(store.ingestChecked(structuredClone(item))).toBe("duplicate");
      expectClean(store.plan("demo"), expected);
      expect(store.events("demo").map(item => item.id)).toEqual(events.map(item => item.id));
      expect(store.since()).toEqual({ demo: 10 });
      expect(store.plan("demo")!.projection.replayed_ops).toEqual(expected.replayed_ops);
    }
  });

  it("M5/M6 replaying an admitted old opening under a new event id cannot switch B back to A", () => {
    const events = [...history(), event(11, { ...history()[0]!.op! }),
      event(12, { kind: "plan.phase", phase: "review", base_rev: 10 })];
    const store = createAgentStore({ templates: resolver }); admit(store, events);
    expectClean(store.plan("demo"), expectedProjection(events));
    expect(store.plan("demo")!.projection.plan).toMatchObject({ template_id: B.id, phase: "review" });
  });

  it.each(["in-place", "replacement"] as const)("M7 %s historical template constraints invalidate a warm cache at unchanged declared hash", mode => {
    let historical = structuredClone(A);
    const resolve: TemplateResolver = (id, hash) => id === A.id && hash === A.hash ? historical : resolver(id, hash);
    const store = createAgentStore({ templates: resolve }); const events = history(); admit(store, events);
    store.plan("demo"); const cursor = store.since();
    if (mode === "replacement") historical = structuredClone(historical);
    historical.memory_sections.find(section => section.id === "mission")!.max_chars = 1;
    const constrained = store.plan("demo")!;
    expect(constrained.errors).toEqual([{ id: events[1]!.id, lamport: 2, code: "bad_op" }]);
    expect(constrained.projection.memory["mission"]).toBeUndefined();
    expect(constrained.projection.archived_plans.map(plan => plan.title)).toEqual([FIRST_TITLE]);
    expect(store.since()).toEqual(cursor);
    expect(historical.hash).toBe(A.hash);
    historical.memory_sections.find(section => section.id === "mission")!.max_chars = 1500;
    expectClean(store.plan("demo"), expectedProjection(events));
  });

  it("M7 equal normalized template content with reordered keys and fresh objects preserves the projection", () => {
    const resolve: TemplateResolver = (id, hash) => {
      const template = resolver(id, hash);
      return template === undefined ? undefined : Object.fromEntries(Object.entries(structuredClone(template)).reverse()) as typeof template;
    };
    const events = history(); const store = createAgentStore({ templates: resolve }); admit(store, events);
    const expected = expectedProjection(events);
    expectClean(store.plan("demo"), expected);
    expectClean(store.plan("demo"), expected);
  });
});

describe("U161 preserved callers and negative controls", () => {
  it.each(["active", "closed"] as const)("M6 single-template %s callers preserve full output and replay identities", state => {
    const events = history().slice(0, state === "active" ? 5 : 6);
    const expected = foldPlan(events, A);
    expect(expected.stats.errors).toEqual([]);
    const store = createAgentStore({ templates: resolver }); admit(store, events);
    expectClean(store.plan("demo"), expected.projection);
    expect(store.plan("demo")!.template).toEqual(A);
    expect(foldPlan([...events].reverse(), A)).toEqual(expected);
    expect(foldPlan([...events, structuredClone(events[0]!)], A).projection).toEqual(expected.projection);
  });

  it("M6 callers without a template resolver retain legacy fold output", () => {
    const events = history().map(item => item.op?.["kind"] === "plan.open"
      ? { ...item, op: { ...item.op, phase: item.op["template_id"] === A.id ? "brief" : "plan" } } : item);
    const store = createAgentStore(); admit(store, events);
    expectClean(store.plan("demo"), foldPlan(events).projection);
    expect(store.plan("demo")).not.toHaveProperty("template");
  });

  it("N1 the positive oracle rejects the global-latest-template replay mutant", () => {
    const events = history(); const broken = foldPlan(events, B);
    expect(() => expectClean({ room: "demo", source: "v2", projection: broken.projection,
      invalidOps: broken.stats.invalid, rejectedOps: broken.stats.rejected, errors: broken.stats.errors },
    expectedProjection(events))).toThrow(/each generation must use its own template/);
  });

  it("N2 a supplied template still rejects a genuine opening hash mismatch", () => {
    const bad = event(1, { ...opening(A, FIRST_TITLE), template_hash: "0".repeat(64) });
    const result = foldPlan([bad], A);
    expect(result.stats.invalid).toBe(0);
    expect(result.stats.rejected).toBe(1);
    expect(result.stats.errors).toEqual([{ id: bad.id, lamport: 1, code: "bad_op" }]);
    expect(result.projection.plan).toBeNull();
  });

  it("N2 a phase valid only in the historical template remains a current-generation domain failure", () => {
    const bad = event(11, { kind: "plan.phase", phase: "design", base_rev: 10 });
    const store = createAgentStore({ templates: resolver }); admit(store, [...history(), bad]);
    const result = store.plan("demo")!;
    expect(result.invalidOps).toBe(0);
    expect(result.errors).toContainEqual({ id: bad.id, lamport: 11, code: "bad_op" });
    expect(result.rejectedOps).toBeGreaterThan(0);
    expect(result.projection.plan?.phase).toBe("execute");
  });
});
