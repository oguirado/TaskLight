import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentStore } from "../../../src/app/agent_store";
import { event, fixture, opEvent, template } from "../u85/helpers";
import { CLOCK } from "./histories";
import { observeWork } from "./instrumentation";
import { UncachedReference } from "./uncached-reference";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(CLOCK); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("A6 cache hit work", () => {
  it("A6 repeated plan reads do not call the full plan fold", () => {
    const store = createAgentStore({ templates: () => template });
    fixture().forEach(item => expect(store.ingest(item)).toBe(true));
    const work = observeWork();
    const expected = structuredClone(store.plan("demo"));
    const before = work.planFold.mock.calls.length;
    const actual = Array.from({ length: 3 }, () => store.plan("demo"));
    const after = work.planFold.mock.calls.length;
    expect(actual).toEqual([expected, expected, expected]);
    expect(after, "plan cache hit must not invoke Plan.foldPlan").toBe(before);
  });

  it("A6 repeated states reads do not call the full agent fold", () => {
    const store = createAgentStore();
    fixture().forEach(item => expect(store.ingest(item)).toBe(true));
    const work = observeWork();
    const expected = structuredClone(store.states());
    const before = work.stateFold.mock.calls.length;
    const actual = Array.from({ length: 3 }, () => store.states());
    const after = work.stateFold.mock.calls.length;
    expect(actual).toEqual([expected, expected, expected]);
    expect(after, "states cache hit must not invoke foldRoomWithStats").toBe(before);
  });

  it("A6 warm public reads do not sort event history again", () => {
    const store = createAgentStore({ templates: () => template });
    fixture().forEach(item => expect(store.ingest(item)).toBe(true));
    const work = observeWork();
    store.plan("demo"); store.states();
    const before = work.snapshot().historySorts;
    store.plan("demo"); store.states(); store.plans();
    const after = work.snapshot().historySorts;
    expect(after, "cache hits may canonicalize template keys but must not sort event history").toBe(before);
  });

  it("A6 an accepted update is visible before the next hit of both projections", () => {
    const store = createAgentStore({ templates: () => template });
    const reference = new UncachedReference(() => template);
    for (const item of fixture()) { expect(store.ingest(item)).toBe(true); reference.retain(item); }
    const work = observeWork();
    store.plan("demo"); store.states();
    const memory = opEvent(100, { kind: "memory.set", section: "goal", text: "updated", base_rev: 6 });
    expect(store.ingestChecked(memory)).toBe("accepted"); reference.retain(memory);
    expect(store.plan("demo")).toEqual(reference.plan("demo"));
    expect(store.states()).toEqual(reference.states());
    expect(store.plan("demo")?.projection.memory["goal"]).toMatchObject({ text: "updated", rev: 100 });
    const before = work.snapshot();
    store.plan("demo"); store.states();
    const after = work.snapshot();
    expect(after, "updated projections must become reusable after recomputation").toEqual(before);
  });

  it("A6 cached empty reads cannot hide the first accepted event", () => {
    const store = createAgentStore();
    const reference = new UncachedReference();
    expect(store.plan("demo")).toBeUndefined(); expect(store.states()).toEqual([]);
    expect(store.plan("demo")).toBeUndefined(); expect(store.states()).toEqual([]);
    const memory = opEvent(100, { kind: "memory.set", section: "goal", text: "first", base_rev: 0 });
    expect(store.ingestChecked(memory)).toBe("accepted"); reference.retain(memory);
    expect(store.plan("demo")).toEqual(reference.plan("demo"));
    expect(store.plan("demo")?.projection.memory["goal"]?.text).toBe("first");
    expect(store.states()).toEqual(reference.states());
    const beat = event(101);
    expect(store.ingest(beat)).toBe(true); reference.retain(beat);
    expect(store.states()).toEqual(reference.states());
    expect(store.states()[0]?.lastSeen).toBe(beat.ts);
  });
});
