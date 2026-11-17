// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createAgentStore } from "../../../src/app/agent_store";

type Field = "plan" | "step" | "evidence";
const fields: Field[] = ["plan", "step", "evidence"];

function event(n: number, field?: Field, payload?: unknown) {
  return {
    id: `e-${n.toString(16).padStart(16, "0")}`,
    room: "demo", agent: "alice", act: field === "evidence" || field === undefined ? "heartbeat" : field,
    lamport: n, ts: n * 1000, text: "activity",
    ...(field === undefined ? {} : { [field]: payload }),
  };
}

function payload(field: Field, extra: Record<string, unknown> = {}): object {
  if (field === "plan") return { title: "Plan", steps: [{ text: "Task", accept: "Verified" }], ...extra };
  if (field === "step") return { index: 0, state: "active", ...extra };
  return [{ path: "proof.txt", ...extra }];
}

function assertRejected(field: Field, value: unknown, compacted: boolean) {
  const store = createAgentStore({ maxPerRoom: 1 });
  expect(store.ingestChecked(event(1))).toBe("accepted");
  if (compacted) expect(store.ingestChecked(event(2))).toBe("accepted");
  const before = { events: store.events("demo"), since: store.since(), states: store.states(), plans: store.plans() };
  expect(store.ingestChecked(event(3, field, value))).toBe("invalid");
  expect({ events: store.events("demo"), since: store.since(), states: store.states(), plans: store.plans() }).toEqual(before);
  // Invalid input must not consume the event identity.
  expect(store.ingestChecked(event(3, field, payload(field)))).toBe("accepted");
}

describe.each(fields)("D2 %s payload validation", field => {
  describe.each([false, true])("after compaction: %s", compacted => {
    it.each(["__proto__", "constructor", "prototype"])("rejects own %s at the payload root", key => {
      const value = payload(field);
      Object.defineProperty(value, key, { value: { polluted: true }, enumerable: true });
      assertRejected(field, value, compacted);
    });

    it.each(["__proto__", "constructor", "prototype"])("rejects nested own %s", key => {
      const hostile = JSON.parse(`{"${key}": {"polluted": true}}`) as Record<string, unknown>;
      assertRejected(field, payload(field, { details: [{ nested: hostile }] }), compacted);
    });

    const nonJson: [string, () => unknown][] = [
      ["undefined", () => undefined],
      ["function", () => () => "hidden"],
      ["symbol", () => Symbol("hidden")],
      ["NaN", () => NaN],
      ["Infinity", () => Infinity],
      ["negative Infinity", () => -Infinity],
      ["Date", () => new Date(0)],
    ];
    it.each(nonJson)("rejects nested non-JSON %s", (_name, makeValue) => {
      assertRejected(field, payload(field, { details: { value: makeValue() } }), compacted);
    });

    it("rejects an accessor without invoking it", () => {
      let reads = 0;
      const details = Object.defineProperty({}, "value", { enumerable: true, get() { reads++; return "hidden"; } });
      assertRejected(field, payload(field, { details }), compacted);
      expect(reads).toBe(0);
    });
  });

  it("accepts legitimate nested JSON metadata", () => {
    const store = createAgentStore();
    const valid = event(1, field, payload(field, { details: { items: [null, true, 42, "é😀", { verified: false }] } }));
    expect(store.ingestChecked(valid)).toBe("accepted");
    expect(store.events("demo")).toEqual([valid]);
  });
});

describe("D2 evidence on operation events", () => {
  function operation(evidence: unknown) {
    return { ...event(1, "evidence", evidence), act: "op", op: { kind: "memory.set", section: "goal", text: "Ready", base_rev: 0 } };
  }

  it("accepts legitimate nested evidence on an operation", () => {
    const store = createAgentStore();
    const valid = operation([{ path: "proof.txt", details: { checks: ["passed", { count: 1 }], optional: null } }]);
    expect(store.ingestChecked(valid)).toBe("accepted");
    expect(store.events("demo")).toEqual([valid]);
  });
});
