import { describe, expect, it } from "vitest";
import { strictParse, toChatMessages } from "../../../src/providers";
import type { Rung } from "../../../src/providers";

const SCHEMA = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };

describe("toChatMessages (SPEC_U47 adapter ladder)", () => {
  it("rung 2: first message is a system message carrying JSON.stringify(schema) and the one-object instruction; user prompt last", () => {
    const m = toChatMessages("PROMPT-XYZ", SCHEMA, 2);
    expect(m.length).toBeGreaterThanOrEqual(2);
    expect(m[0]?.role).toBe("system");
    expect(m[0]?.content).toContain(JSON.stringify(SCHEMA));
    expect(m[0]?.content).toContain("Reply with one JSON object only");
    expect(m[m.length - 1]).toEqual({ role: "user", content: "PROMPT-XYZ" });
  });
  it("rung 3: plain prompt, one user message, no schema text", () => {
    expect(toChatMessages("PROMPT-XYZ", SCHEMA, 3)).toEqual([{ role: "user", content: "PROMPT-XYZ" }]);
  });
  it("rung 1: user prompt is the last message (schema travels in the transport request, not here)", () => {
    const m = toChatMessages("PROMPT-XYZ", SCHEMA, 1);
    expect(m[m.length - 1]).toEqual({ role: "user", content: "PROMPT-XYZ" });
    expect(m.length).toBeLessThanOrEqual(2);
  });
  it.each([1, 2, 3] as Rung[])("rung %i: roles limited to system|user and contents are strings", (r) => {
    for (const x of toChatMessages("p", SCHEMA, r)) { expect(["system", "user"]).toContain(x.role); expect(typeof x.content).toBe("string"); }
  });
  it.each([1, 2, 3] as Rung[])("rung %i: the prompt is passed verbatim (no trimming, no template)", (r) => {
    const p = "  line1\n\tline2 </x> ${y}  ";
    expect(toChatMessages(p, SCHEMA, r).at(-1)?.content).toBe(p);
  });
  it("pure: input schema not mutated, same output twice", () => {
    const s = JSON.parse(JSON.stringify(SCHEMA)) as object;
    const a = toChatMessages("p", s, 2), b = toChatMessages("p", s, 2);
    expect(a).toEqual(b); expect(s).toEqual(SCHEMA);
  });
});

describe("strictParse (rung 3 extraction)", () => {
  it("returns the trimmed text for a single JSON object", () => { expect(strictParse('  \n{"a":1}\n ')).toBe('{"a":1}'); });
  it.each(['[1,2]', '"str"', "42", "true", "null", '{"a":{"b":[1,{"c":null}]}}'])("accepts single JSON value %s", (t) => {
    expect(strictParse(` ${t} `)).toBe(t);
  });
  it("accepts a bare enum token (text/x.enum outputs such as status) and trims it", () => {
    expect(strictParse("  running\n")).toBe("running");
    expect(strictParse("waiting_input")).toBe("waiting_input");
  });
  it.each(["", "   ", "\n\t"])("empty or blank %j -> null", (t) => { expect(strictParse(t)).toBeNull(); });
  it.each(['{"a":1', "{oops}", '{"a":1,}', "[1,2", "{'a':1}"])("malformed JSON %j -> null", (t) => { expect(strictParse(t)).toBeNull(); });
  it("two JSON values -> null (single value only)", () => {
    expect(strictParse('{"a":1} {"b":2}')).toBeNull();
    expect(strictParse('{"a":1}\n{"b":2}')).toBeNull();
  });
  it("prose around a JSON object -> null (strict, no scavenging)", () => {
    expect(strictParse('Here is the answer: {"a":1}')).toBeNull();
    expect(strictParse('{"a":1} hope that helps')).toBeNull();
  });
  it("multi-word prose is not a bare enum token", () => {
    expect(strictParse("the status is running")).toBeNull();
    expect(strictParse("running, blocked")).toBeNull();
  });
  it("never throws on hostile input", () => {
    for (const t of ["\u0000", "{".repeat(10000), "[".repeat(10000), "\uD800", "x".repeat(200000), "__proto__", '{"__proto__":{"x":1}}']) {
      expect(() => strictParse(t)).not.toThrow();
    }
  });
});
