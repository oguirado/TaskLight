// @vitest-environment node
import { describe, expect, it } from "vitest";
import { bytes, beat, compare, display, event, fixture, FullHistory, makeStore, op, pinned, takeoverHistory } from "./oracle";

function assertReplay(store: ReturnType<typeof makeStore>, reference: FullHistory): void {
  expect(store.plan("demo")).toEqual(reference.plan("demo"));
  expect(store.plans()).toEqual(reference.plans());
  expect(store.states()).toEqual(reference.states());
  expect(store.since()).toEqual(reference.since());
}

describe("U123 A1: pinned operations and a contiguous recent suffix", () => {
  it("A1 default keeps all semantic operations and exactly the newest 5000 of 5001 heartbeats", () => {
    const history = [...fixture(), ...Array.from({ length: 5001 }, (_, i) => event(100 + i))];
    const store = makeStore(); const ref = new FullHistory();
    for (const e of history) { expect(store.ingestChecked(e)).toBe("accepted"); ref.accept(e); }
    expect(store.events("demo")).toEqual(display(history));
    expect(store.events("demo").filter(pinned)).toEqual(fixture());
    expect(store.events("demo").filter(e => !pinned(e))).toHaveLength(5000);
    assertReplay(store, ref);
  });

  it("A1 maxPerRoom:2 combines non-ops and exact activity.beat operations after every arrival", () => {
    const history = [...fixture().slice(0, 5), beat(10), event(11), beat(12), event(13), beat(14)];
    const store = makeStore({ maxPerRoom: 2 }); const ref = new FullHistory();
    for (const e of history) {
      expect(store.ingestChecked(e)).toBe("accepted"); ref.accept(e);
      assertReplay(store, ref);
      expect(store.events("demo"), `recent suffix after ${e.id}`).toEqual(display(ref.history, 2));
    }
  });

  it("A1 default byte budget is 16 MiB and includes envelope and payload", () => {
    const store = makeStore();
    // One large, valid envelope field: the protocol places no byte cap on evidence labels.
    const huge = event(100, { evidence: [{ path: "x".repeat(16 * 1024 * 1024), sha256: "a".repeat(64) }] });
    expect(bytes(huge)).toBeGreaterThan(16 * 1024 * 1024);
    expect(store.ingestChecked(huge)).toBe("accepted");
    expect(store.events("demo").length).toBe(0);
    expect(store.states()[0]?.lastSeen).toBe(huge.ts);
    expect(store.ingestChecked(huge)).toBe("duplicate");
  });

  it("A1 late and equal-Lamport arrivals select by compareEvents and preserve all semantic payloads", () => {
    const ops = fixture();
    const recent = [event(100), event(103, { lamport: 102 }), event(102), event(101)];
    const store = makeStore({ maxPerRoom: 2 });
    for (const e of [...ops, ...recent]) expect(store.ingestChecked(e)).toBe("accepted");
    expect(store.events("demo")).toEqual([...ops, recent[2]!, recent[1]!].sort(compare));
    expect(store.ingestChecked(recent[0])).toBe("duplicate");
    expect(store.since()).toEqual({ demo: 102 });
  });

  it("A1 rejected semantic operations remain pinned with identity, payload, evidence and order", () => {
    const history = [...fixture(), op(20, { kind: "memory.set", section: "goal", text: "stale", base_rev: 0 }),
      ...Array.from({ length: 6 }, (_, i) => beat(30 + i))];
    const store = makeStore({ maxPerRoom: 2 }); const ref = new FullHistory();
    for (const e of history) { expect(store.ingestChecked(e)).toBe("accepted"); ref.accept(e); }
    expect(store.plan("demo")?.errors?.at(-1)?.code).toBe("stale_rev");
    expect(store.events("demo").filter(pinned)).toEqual(history.filter(pinned));
    assertReplay(store, ref);
    expect(store.events("demo")).toEqual(display(history, 2));
  });
});

describe("U123 A4: UTF-8 JSON envelope budgets", () => {
  it("A4 oversized owner activity still fences takeover when recent display is empty", () => {
    const store = makeStore({ maxBytesPerRoom: 1 }); const ref = new FullHistory();
    const history = takeoverHistory();
    for (const e of history) {
      expect(store.ingestChecked(e)).toBe("accepted"); ref.accept(e);
      assertReplay(store, ref);
    }
    expect(store.plan("demo")?.projection.tasks[0]?.assignee).toBe("alice");
    expect(store.plan("demo")?.projection.rejected.at(-1)?.code).toBe("claimed_by_other");
    const cursor = store.since();
    expect(store.ingestChecked(history[4])).toBe("duplicate"); expect(store.since()).toEqual(cursor);
    expect(store.events("demo")).toEqual(history.filter(pinned));
  });

  it.each(["é", "😀"])("A4 exact suffix uses UTF-8 bytes for %s", text => {
    const e1 = event(100, { text: "a" }); const e2 = event(101, { text });
    const total = bytes(e1) + bytes(e2);
    const store = makeStore({ maxPerRoom: 2, maxBytesPerRoom: total - 1 });
    expect(store.ingestChecked(e1)).toBe("accepted");
    expect(store.ingestChecked(e2)).toBe("accepted");
    expect(store.events("demo")).toEqual([e2]);
    const exact = makeStore({ maxPerRoom: 2, maxBytesPerRoom: total });
    exact.ingest(e1); exact.ingest(e2);
    expect(exact.events("demo")).toEqual([e1, e2]);
  });

  it("A4 nested operation evidence is exempt when pinned and full envelopes count when recent", () => {
    const semantic = fixture().at(-1)!;
    const first = event(100, { text: "a", evidence: [{ path: "evidence/😀.md", sha256: "a".repeat(64) }] });
    const second = beat(101, { text: "é", evidence: [{ path: "evidence/é.md", sha256: "b".repeat(64) }] });
    const store = makeStore({ maxPerRoom: 2, maxBytesPerRoom: bytes(first) + bytes(second) - 1 });
    for (const e of [...fixture(), first, second]) expect(store.ingestChecked(e)).toBe("accepted");
    expect(store.events("demo")).toContainEqual(semantic);
    expect(store.events("demo").filter(e => !pinned(e))).toEqual([second]);
  });

  it("A4 oversized non-op is accepted, updates activity, stays out of display and remains duplicate", () => {
    const store = makeStore({ maxBytesPerRoom: 1 }); const ref = new FullHistory();
    for (const e of [...fixture(), event(100, { text: "😀" })]) {
      expect(store.ingestChecked(e)).toBe("accepted"); ref.accept(e);
    }
    assertReplay(store, ref);
    const cursor = store.since();
    expect(store.events("demo")).toEqual(fixture());
    expect(store.ingestChecked(event(100, { text: "😀" }))).toBe("duplicate");
    expect(store.since()).toEqual(cursor);
    assertReplay(store, ref);
  });

  it("A4 an oversized newest event empties the suffix rather than backfilling older small events", () => {
    const small = event(100); const huge = event(101, { text: "😀".repeat(500) });
    const store = makeStore({ maxBytesPerRoom: bytes(small) });
    store.ingest(small); store.ingest(huge);
    expect(store.events("demo")).toEqual([]);
  });

  it("A4 both budgets apply independently per room after late arrivals", () => {
    const events = [event(100, { text: "é" }), event(101, { room: "other", text: "😀" }),
      event(102, { text: "a" }), event(103, { room: "other" }), event(99)];
    const budget = bytes(events[0]!) + bytes(events[2]!) - 1;
    const store = makeStore({ maxPerRoom: 2, maxBytesPerRoom: budget }); const seen = [];
    for (const e of events) {
      expect(store.ingestChecked(e)).toBe("accepted"); seen.push(e);
      for (const room of ["demo", "other"]) expect(store.events(room)).toEqual(display(seen.filter(x => x.room === room), 2, budget));
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity])("A4 invalid maxBytesPerRoom=%s throws RangeError", value => {
    expect(() => makeStore({ maxBytesPerRoom: value })).toThrow(RangeError);
  });
  it.each([0, -1, 1.5, NaN, Infinity])("M3 legacy invalid maxPerRoom=%s still throws RangeError", value => {
    expect(() => makeStore({ maxPerRoom: value })).toThrow(RangeError);
  });
});
