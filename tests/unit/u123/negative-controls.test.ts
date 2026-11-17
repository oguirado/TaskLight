// @vitest-environment node
import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { foldPlan } from "../../../src/plan";
import type { RoomEvent } from "../../../src/agents/types";
import { bytes, display, event, takeoverHistory, template } from "./oracle";
import { retainedEnvelopes, storageGate } from "./retained-heap";

function returnedArrayMutant(raw: RoomEvent[]) {
  return Object.freeze({ events: () => display(raw, 2).map(e => structuredClone(e)) });
}
function prepare(room: string, bounded: boolean) {
  const raw = Array.from({ length: 8 }, (_, i) => event(100 + i, { room, text: "raw-only negative control" }));
  const sizes = new Map(raw.map(e => [e.id, bytes(e)]));
  const mutant = returnedArrayMutant(bounded ? raw.slice(-2) : raw);
  return { mutant, sizes, __u123HeapRoot: room, candidate: mutant };
}

describe("U123 A6: demonstrated, independent negative controls", () => {
  it("A6 display-only replay mutant fails the A2 ownership/receipt oracle", () => {
    const history = takeoverHistory();
    const full = foldPlan(history, template).projection;
    const mutant = foldPlan(display(history, 2), template).projection;
    expect(full.rejected.at(-1)?.code).toBe("claimed_by_other");
    expect(mutant.tasks[0]?.assignee).toBe("bob");
    expect(() => assert.deepEqual(mutant, full)).toThrow(assert.AssertionError);
    console.info("U123 negative control: display-only replay REJECTED (claimed_by_other lost)");
  });

  it("A6 returned-array-only mutant fails the same heap storage gate while bounded control passes", async () => {
    const bounded = prepare("u123-bounded-control", true);
    const boundedInventory = await retainedEnvelopes("u123-bounded-control", bounded.sizes);
    expect(bounded.mutant.events()).toHaveLength(2);
    expect(boundedInventory.recent.objects, "calibration: only the two retained envelopes survive GC").toBe(2);
    expect(() => storageGate(boundedInventory, 2, 16 * 1024 * 1024)).not.toThrow();
    const hidden = prepare("u123-hidden-control", false);
    const hiddenInventory = await retainedEnvelopes("u123-hidden-control", hidden.sizes);
    expect(hidden.mutant.events()).toHaveLength(2);
    expect(hiddenInventory.recent.objects).toBe(8);
    expect(() => storageGate(hiddenInventory, 2, 16 * 1024 * 1024)).toThrow(/raw recent retention exceeds budget/);
    console.info("U123 negative control: hidden raw history REJECTED", JSON.stringify(hiddenInventory));
  }, 30_000);

  it("A6 byte-limit-disabled mutant fails the A4 UTF-8 envelope oracle", () => {
    const history = [event(100, { text: "a" }), event(101, { text: "é" })];
    const budget = bytes(history[0]) + bytes(history[1]) - 1;
    const expected = display(history, 2, budget);
    const mutant = display(history, 2, Infinity);
    expect(expected).toEqual([history[1]]); expect(mutant).toHaveLength(2);
    expect(() => assert.deepEqual(mutant, expected)).toThrow(assert.AssertionError);
    console.info("U123 negative control: disabled byte budget REJECTED");
  });
});
