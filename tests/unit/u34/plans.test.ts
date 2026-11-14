import { describe, expect, it } from "vitest";
import { contractHash, diffPlans, driftRules } from "../../../src/agents";
import type { AgentState, PlanDiff, StepState } from "../../../src/agents/types";
import { contract, mkState } from "./fixture";

/* ---- reference FNV-1a 32 over canonical JSON (sorted keys) of {title, steps}; UTF-8 bytes (ORACLE J5) ---- */
const fnv1a32 = (s: string): string => {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
};
const canon = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map((x) => canon(x === undefined ? null : x)).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
};
const refHash = (c: { title: string; steps: { text: string; accept?: string }[] }): string => fnv1a32(canon({ title: c.title, steps: c.steps }));

describe("A2 reference implementation self-check (published FNV-1a 32 vectors)", () => {
  it.each([["", "811c9dc5"], ["a", "e40c292c"], ["foobar", "bf9cf968"]])("fnv1a32(%j) = %s", (s, h) => {
    expect(fnv1a32(s)).toBe(h);
  });
  it("canonical JSON sorts keys recursively and omits undefined", () => {
    expect(canon({ title: "t", steps: [{ text: "x", accept: undefined }, { text: "y", accept: "z" }] })).toBe('{"steps":[{"text":"x"},{"accept":"z","text":"y"}],"title":"t"}');
  });
});

const INPUTS = {
  A: { title: "Refactor auth module", steps: [{ text: "Read current auth code" }, { text: "Write failing tests", accept: "Tests fail for the right reason" }] },
  B: { title: "", steps: [{ text: "x" }] },
  C: { title: "Überprüfung ✓ 😀", steps: [{ text: "a\"b\\c\n" }, { text: "é" }] },
};

describe("A2 contractHash", () => {
  it.each(Object.entries(INPUTS))("fixed input %s equals the reference FNV-1a 32 of its canonical JSON", (_n, c) => {
    const h = contractHash(c);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(h).toBe(refHash(c));
  });

  it("the three fixed inputs have three distinct hashes", () => {
    expect(new Set(Object.values(INPUTS).map((c) => contractHash(c))).size).toBe(3);
  });

  it("only title and steps count: hash/version/lamport are ignored", () => {
    const a = { ...INPUTS.A, hash: "deadbeef", version: 9, lamport: 77 };
    expect(contractHash(a)).toBe(refHash(INPUTS.A));
  });

  it("key order of the input objects does not matter, absent accept equals undefined accept", () => {
    const reordered = { steps: [{ accept: "Tests fail for the right reason", text: "Write failing tests" }], title: "T" };
    const normal = { title: "T", steps: [{ text: "Write failing tests", accept: "Tests fail for the right reason" }] };
    expect(contractHash(reordered)).toBe(contractHash(normal));
    expect(contractHash({ title: "T", steps: [{ text: "a" }] })).toBe(contractHash({ title: "T", steps: [{ text: "a", accept: undefined } as { text: string }] }));
  });

  it("title, step order, step text and accept each change the hash", () => {
    const base = { title: "T", steps: [{ text: "a" }, { text: "b" }] };
    const h = contractHash(base);
    expect(contractHash({ ...base, title: "U" })).not.toBe(h);
    expect(contractHash({ ...base, steps: [{ text: "b" }, { text: "a" }] })).not.toBe(h);
    expect(contractHash({ ...base, steps: [{ text: "a" }, { text: "c" }] })).not.toBe(h);
    expect(contractHash({ ...base, steps: [{ text: "a" }, { text: "b", accept: "ok" }] })).not.toBe(h);
  });

  it("does not throw on huge or hostile text", () => {
    expect(() => contractHash({ title: "__proto__", steps: [{ text: "constructor" }, { text: "😀".repeat(200_000) }] })).not.toThrow();
  });
});

describe("A3 diffPlans case table", () => {
  const P = (...t: string[]) => contract("T", t);
  const D = (over: Partial<PlanDiff> = {}): PlanDiff => ({ added: [], removed: [], reordered: false, edited: [], ...over });
  const CASES: [string, string[], string[], PlanDiff][] = [
    ["identical", ["a", "b", "c"], ["a", "b", "c"], D()],
    ["both empty", [], [], D()],
    ["append one", ["a", "b"], ["a", "b", "c"], D({ added: ["c"] })],
    ["append two keeps next order", ["a"], ["a", "x", "y"], D({ added: ["x", "y"] })],
    ["insert in the middle", ["a", "c"], ["a", "b", "c"], D({ added: ["b"] })],
    ["insert at the front shifts without edits", ["a", "b"], ["x", "a", "b"], D({ added: ["x"] })],
    ["remove the last", ["a", "b", "c"], ["a", "b"], D({ removed: ["c"] })],
    ["remove two keeps prev order", ["a", "b", "c", "d"], ["a", "d"], D({ removed: ["b", "c"] })],
    ["remove everything", ["a", "b"], [], D({ removed: ["a", "b"] })],
    ["add to empty", [], ["a", "b"], D({ added: ["a", "b"] })],
    ["swap two", ["a", "b"], ["b", "a"], D({ reordered: true })],
    ["rotate three", ["a", "b", "c"], ["c", "a", "b"], D({ reordered: true })],
    ["reverse four", ["a", "b", "c", "d"], ["d", "c", "b", "a"], D({ reordered: true })],
    ["single edit is one edit, not add+remove", ["a", "b", "c"], ["a", "B", "c"], D({ edited: [{ from: "b", to: "B" }] })],
    ["two edits", ["a", "b", "c"], ["a", "X", "Y"], D({ edited: [{ from: "b", to: "X" }, { from: "c", to: "Y" }] })],
    ["edit the first step", ["a", "b"], ["z", "b"], D({ edited: [{ from: "a", to: "z" }] })],
    ["edit plus append", ["a", "b"], ["a", "B", "c"], D({ added: ["c"], edited: [{ from: "b", to: "B" }] })],
    ["reorder plus append", ["a", "b"], ["b", "a", "c"], D({ added: ["c"], reordered: true })],
    ["reorder plus removal of a step past the end of next", ["a", "b", "c"], ["b", "a"], D({ removed: ["c"], reordered: true })],
    ["J7 removing a middle step is a removal, not an edit into its neighbour", ["a", "b", "c"], ["a", "c"], D({ removed: ["b"] })],
    ["same relative order of common steps is not a reorder", ["a", "x", "b"], ["a", "y", "b"], D({ edited: [{ from: "x", to: "y" }] })],
    ["text comparison is exact (case and whitespace)", ["a b"], ["a  b"], D({ edited: [{ from: "a b", to: "a  b" }] })],
  ];

  it.each(CASES)("%s", (_n, prev, next, expected) => {
    expect(diffPlans(P(...prev), P(...next))).toEqual(expected);
  });

  it("title changes alone are not a step diff", () => {
    expect(diffPlans(contract("One", ["a"]), contract("Two", ["a"]))).toEqual(D());
  });

  it("accept text is not part of the step text comparison", () => {
    const prev = { ...P("a"), steps: [{ text: "a", accept: "x" }] };
    const next = { ...P("a"), steps: [{ text: "a", accept: "y" }] };
    expect(diffPlans(prev, next)).toEqual(D());
  });

  it("does not mutate its inputs and works with hostile text", () => {
    const prev = P("__proto__", "constructor"); const next = P("constructor", "__proto__", "toString");
    const before = JSON.stringify([prev, next]);
    const d = diffPlans(prev, next);
    expect(JSON.stringify([prev, next])).toBe(before);
    expect(d.added).toEqual(["toString"]);
    expect(d.reordered).toBe(true);
  });
});

describe("A4 driftRules table", () => {
  const D = (over: Partial<PlanDiff> = {}): PlanDiff => ({ added: [], removed: [], reordered: false, edited: [], ...over });
  /** state whose contract is the plan under review: texts a..e with the given states */
  const S = (states: StepState[]): AgentState => {
    const texts = ["a", "b", "c", "d", "e"].slice(0, states.length);
    return mkState({ stepStates: states }, texts);
  };
  const ST = S(["done", "active", "pending", "pending"]);
  const CASES: [string, PlanDiff, AgentState, "on_track" | "drift" | "needs_user"][] = [
    ["empty diff", D(), ST, "on_track"],
    ["only additions", D({ added: ["x", "y"] }), ST, "on_track"],
    ["edit of a pending step", D({ edited: [{ from: "c", to: "C" }] }), ST, "on_track"],
    ["additions plus edit of pending", D({ added: ["x"], edited: [{ from: "d", to: "D" }] }), ST, "on_track"],
    ["removed a done step", D({ removed: ["a"] }), ST, "drift"],
    ["removed an active step", D({ removed: ["b"] }), ST, "drift"],
    ["removed a pending step", D({ removed: ["c"] }), ST, "needs_user"],
    ["removed two pending steps", D({ removed: ["c", "d"] }), ST, "needs_user"],
    ["reorder only", D({ reordered: true }), ST, "needs_user"],
    ["reorder plus additions", D({ reordered: true, added: ["x"] }), ST, "needs_user"],
    ["removed pending plus additions", D({ removed: ["c"], added: ["x"] }), ST, "needs_user"],
    ["removed done AND pending: drift outranks needs_user", D({ removed: ["c", "a"] }), ST, "drift"],
    ["removed active plus reorder: drift outranks needs_user", D({ removed: ["b"], reordered: true }), ST, "drift"],
    ["removed done step when everything is done", D({ removed: ["b"] }), S(["done", "done"]), "drift"],
    ["removal on an all-pending plan", D({ removed: ["a"] }), S(["pending", "pending"]), "needs_user"],
  ];

  it.each(CASES)("%s -> %s", (_n, diff, state, expected) => {
    const v = driftRules(diff, state);
    expect(v.verdict).toBe(expected);
    expect(v.source).toBe("rules");
    expect(typeof v.reason).toBe("string");
    expect(v.reason.length).toBeGreaterThan(0);
    expect(v.reason.length).toBeLessThanOrEqual(140);
  });

  it("reasons stay within 140 characters even with huge step texts", () => {
    const big = "é".repeat(5000);
    const st = mkState({ stepStates: ["done"] }, [big]);
    const v = driftRules(D({ removed: [big] }), st);
    expect(v.verdict).toBe("drift");
    expect(v.reason.length).toBeLessThanOrEqual(140);
  });

  it("does not mutate the diff or the state and never throws on a state without contract", () => {
    const diff = D({ removed: ["a"], added: ["z"] });
    const st = Object.freeze(S(["done", "pending"]));
    const snap = JSON.stringify([diff, st]);
    driftRules(diff, st);
    expect(JSON.stringify([diff, st])).toBe(snap);
    expect(() => driftRules(D({ removed: ["a"] }), mkState())).not.toThrow();
    expect(() => driftRules(D({ removed: ["__proto__", "constructor"] }), ST)).not.toThrow();
  });

  it("J6 a removed step unknown to the state is treated as pending: needs_user", () => {
    expect(driftRules(D({ removed: ["not in the contract"] }), ST).verdict).toBe("needs_user");
  });
});
