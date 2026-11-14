import { describe, expect, test } from "vitest";
import { digestFreshness, revVectorOf } from "../../../src/digest";
import { cap, rec } from "./helpers";

describe("revVectorOf / digestFreshness (B14)", () => {
  test("revVectorOf maps projectId to state.rev", () => {
    expect(revVectorOf([cap("p1", { rev: 3 }), cap("p2", { rev: 5 })])).toEqual({ p1: 3, p2: 5 });
    expect(revVectorOf([])).toEqual({});
  });
  test("O10 fresh / stale / stale / stale", () => {
    const d = rec({ revVector: { p1: 3, p2: 5 } });
    expect(digestFreshness(d, { p1: 3, p2: 5 })).toBe("fresh");
    expect(digestFreshness(d, { p1: 4, p2: 5 })).toBe("stale");
    expect(digestFreshness(d, { p1: 3, p2: 5, p3: 1 })).toBe("stale");
    expect(digestFreshness(d, { p1: 3 })).toBe("stale");
  });
  test("key order does not matter; empty equals empty", () => {
    expect(digestFreshness(rec({ revVector: { a: 1, b: 2 } }), { b: 2, a: 1 })).toBe("fresh");
    expect(digestFreshness(rec({ revVector: {} }), {})).toBe("fresh");
    expect(digestFreshness(rec({ revVector: {} }), { a: 1 })).toBe("stale");
  });
  test("a lower rev is also stale (any difference)", () => {
    expect(digestFreshness(rec({ revVector: { p1: 3 } }), { p1: 2 })).toBe("stale");
  });
  test("inherited Object.prototype names are not confused with project ids", () => {
    expect(digestFreshness(rec({ revVector: { p1: 3 } }), { p1: 3, constructor: 1 })).toBe("stale");
    expect(digestFreshness(rec({ revVector: { p1: 3, toString: 2 } }), { p1: 3, hasOwnProperty: 2 })).toBe("stale");
    expect(digestFreshness(rec({ revVector: { p1: 3, toString: 2 } }), { p1: 3, toString: 2 })).toBe("fresh");
  });
  test("revVectorOf keeps project ids that shadow Object.prototype members", () => {
    const v = revVectorOf([cap("constructor", { rev: 7 }), cap("toString", { rev: 8 })]);
    expect(Object.keys(v).sort()).toEqual(["constructor", "toString"]);
    expect(Object.getOwnPropertyDescriptor(v, "constructor")!.value).toBe(7);
  });
  test("revVectorOf covers every capsule it is given (omitted-by-truncation ones included)", () => {
    const cs = Array.from({ length: 12 }, (_, k) => cap("q" + k, { rev: k }));
    expect(Object.keys(revVectorOf(cs))).toHaveLength(12);
  });
});
