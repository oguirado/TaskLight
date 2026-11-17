// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveActivity } from "../../../src/app/activity";
import { BASE, beat, event, fixture, FullHistory, makeStore, op } from "./oracle";

function damage(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    const record = value as Record<string, unknown>;
    try { if (typeof record[key] === "string") record[key] = "mutated"; else damage(record[key]); }
    catch (e) { if (!(e instanceof TypeError)) throw e; }
  }
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("U123 A5: hostile input, copies and ingestion contracts", () => {
  it.each([0, 6])("A5 own op.__proto__ and top-level prototype keys are invalid after %s pressure events", pressure => {
    const store = makeStore({ maxPerRoom: 2 }); const ref = new FullHistory();
    const history = [...fixture(), ...Array.from({ length: pressure }, (_, i) => event(100 + i))];
    for (const e of history) { store.ingest(e); ref.accept(e); }
    const before = { plan: store.plan("demo"), plans: store.plans(), states: store.states(), since: store.since(), events: store.events("demo") };
    const protoKeys = Object.getOwnPropertyDescriptors(Object.prototype);
    const valid = op(200, { kind: "memory.set", section: "notes", text: "safe", base_rev: 0 });
    for (const key of ["__proto__", "constructor", "prototype"]) {
      for (const nested of [true, false]) {
        const body = nested ? { ...valid, op: { ...valid.op, [key]: { u123Polluted: true } } } : { ...valid, [key]: { u123Polluted: true } };
        const bad: unknown = JSON.parse(JSON.stringify(body));
        expect(store.ingestChecked(bad), `${nested ? "op" : "envelope"}.${key}`).toBe("invalid");
        expect({ plan: store.plan("demo"), plans: store.plans(), states: store.states(), since: store.since(), events: store.events("demo") }).toEqual(before);
        expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(protoKeys);
        expect(({} as Record<string, unknown>)["u123Polluted"]).toBeUndefined();
      }
    }
    expect(store.ingestChecked(valid), "invalid inputs cannot reserve a corrected event ID").toBe("accepted"); ref.accept(valid);
    expect(store.plan("demo")).toEqual(ref.plan("demo"));
  });

  it("A5 originals, events, evidence, states, plans, templates and cursors are defensively owned after compaction", () => {
    const source = structuredClone(fixture());
    const pristine = structuredClone(source);
    const store = makeStore({ maxPerRoom: 2 }); const ref = new FullHistory();
    for (const e of [...source, event(100, { evidence: [{ path: "evidence/a.md", sha256: "a".repeat(64) }] }), event(101), event(102)]) {
      store.ingest(e); ref.accept(e);
    }
    const events = structuredClone(store.events("demo"));
    damage(source); damage(store.events("demo")); damage(store.plan("demo")); damage(store.plans()); damage(store.states());
    const cursor = store.since(); cursor["demo"] = 999999;
    expect(store.events("demo")).toEqual(events);
    expect(store.plan("demo")).toEqual(ref.plan("demo"));
    expect(store.plans()).toEqual(ref.plans()); expect(store.states()).toEqual(ref.states());
    expect(store.since()).toEqual(ref.since());
    expect(store.events("demo").filter(e => e.act === "op")).toEqual(pristine);
  });

  it("A5 recent originals and returned nested evidence remain defensive after pressure", () => {
    const store = makeStore({ maxPerRoom: 2 });
    const recent = event(102, { text: "original", evidence: [{ path: "evidence/recent.md", sha256: "c".repeat(64) }] });
    const saved = structuredClone(recent);
    for (const e of [event(100), event(101), recent]) expect(store.ingestChecked(e)).toBe("accepted");
    recent.text = "changed input"; recent.evidence![0]!.path = "changed input evidence";
    const copy = store.events("demo"); copy.at(-1)!.text = "changed output";
    copy.at(-1)!.evidence![0]!.sha256 = "changed output evidence";
    expect(store.events("demo").at(-1)).toEqual(saved);
    expect(store.states()[0]).toMatchObject({ lastText: "original", lastSeen: saved.ts });
  });

  it("A5/M7 torn JSONL tails and accepted/duplicate/malformed summary shape survive evicted IDs", () => {
    const store = makeStore({ maxPerRoom: 2 });
    const first = event(100); const second = event(101); const third = event(102);
    expect(store.ingest(first)).toBe(true); expect(store.ingest(second)).toBe(true); expect(store.ingest(third)).toBe(true);
    expect(store.ingestChecked(first)).toBe("duplicate");
    expect(store.ingest(first)).toBe(false);
    const next = event(103);
    expect(store.ingestJsonl(`${JSON.stringify(first)}\r\n${JSON.stringify(next)}\ninvalid-json\n{}\n{`)).toEqual({ accepted: 1, duplicate: 1, malformed: 2, torn: true });
    expect(store.ingestJsonl(JSON.stringify(event(104)))).toEqual({ accepted: 1, duplicate: 0, malformed: 0, torn: false });
    expect(store.ingestJsonl("")).toEqual({ accepted: 0, duplicate: 0, malformed: 0, torn: false });
    expect(store.since()).toEqual({ demo: 104 });
  });

  it("M2 validation still delegates admission and rejects unsupported operation shapes", () => {
    const store = makeStore({ maxPerRoom: 1 });
    const invalid = [op(100, { kind: "unknown.operation" }), op(101, { kind: "activity.beat", task_id: "T01" }),
      op(102, { kind: "memory.set", section: "goal", text: "x", base_rev: -1 })];
    for (const e of invalid) expect(store.ingestChecked(e)).toBe("invalid");
    expect(store.since()).toEqual({}); expect(store.plan("demo")).toBeUndefined(); expect(store.states()).toEqual([]);
  });
});

describe("U123 A7: elapsed freshness without new ingestion", () => {
  it("A7 connected active work remains working at +90000 and unknown at +90001 before and after compaction", () => {
    vi.useFakeTimers(); vi.setSystemTime(BASE);
    const store = makeStore({ maxPerRoom: 2 }); const ref = new FullHistory();
    const liveBeat = beat(10, { ts: BASE + 1000 });
    for (const e of [...fixture().slice(0, 5), liveBeat]) { expect(store.ingestChecked(e)).toBe("accepted"); ref.accept(e); }
    const expectedBeat = structuredClone(store.plan("demo")?.projection.tasks[0]?.microtasks[0]?.live);
    for (const compacted of [false, true]) {
      if (compacted) for (const e of [event(20, { agent: "bob" }), event(21, { agent: "bob" }), event(22, { agent: "bob" })]) {
        expect(store.ingestChecked(e)).toBe("accepted"); ref.accept(e);
      }
      const cursor = store.since();
      for (const [age, expected] of [[90_000, "working"], [90_001, "unknown"]] as const) {
        vi.setSystemTime(liveBeat.ts + age);
        const task = store.plan("demo")!.projection.tasks[0]!;
        const referenceTask = ref.plan("demo")!.projection.tasks[0]!;
        expect(deriveActivity(task, task.microtasks[0], Date.now(), { connected: true })).toBe(expected);
        expect(deriveActivity(task, undefined, Date.now(), { connected: true })).toBe(expected);
        expect(deriveActivity(referenceTask, referenceTask.microtasks[0], Date.now(), { connected: true })).toBe(expected);
        expect(task.microtasks[0]?.live).toEqual(expectedBeat);
        expect(store.since()).toEqual(cursor);
      }
      if (compacted) expect(store.events("demo").some(e => e.id === liveBeat.id)).toBe(false);
    }
  });
});
