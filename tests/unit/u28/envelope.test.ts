import { describe, it, expect } from "vitest";
import { densify, measure, canonicalJson, sha256Hex, toLine, CTX_LIMITS, CTX_RC, CTX_SCHEMA } from "../../../src/ctx";
import { refSha, refCanon, refEnv, deepFreeze } from "./ref";

describe("C1 envelope_seal", () => {
  it("seals densify({text:'a'}) with sha256(canonical(data))", () => {
    const r = densify({ text: "a" });
    expect(r.ok).toBe(true); expect(r.rc).toBe(0); expect(r.verb).toBe("densify");
    expect(r.schema).toBe("ctx.resp/v1");
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.sha256).toBe(refSha(refCanon(r.data)));
    expect(r.sha256).toBe(sha256Hex(canonicalJson(r.data)));
  });
  it("envelope has exactly the keys {schema,ok,rc,verb,data,sha256}", () => {
    expect(Object.keys(measure({ text: "x" })).sort()).toEqual(["data", "ok", "rc", "schema", "sha256", "verb"]);
  });
  it("whole line equals the independent reference envelope", () => {
    const r = measure({ text: "abc" });
    expect(toLine(r)).toBe(refCanon(refEnv("measure", 0, { utf16: 3, tokens: null, tokens_source: "absent" })));
  });
  it("ok iff rc 0 (control: rc 2 gives ok false)", () => {
    const bad = densify({ text: 5 });
    expect(bad.rc).toBe(2); expect(bad.ok).toBe(false);
  });
  it("constants", () => {
    expect(CTX_SCHEMA).toBe("ctx.resp/v1");
    expect(CTX_RC).toEqual({ OK: 0, USAGE: 2, STALE: 4, BUDGET: 6, ABSENT: 7, TIMEOUT: 124 });
    expect(CTX_LIMITS.PACK_MAX_CHARS).toBe(7300);
  });
});

describe("B3 canonical json + sha256", () => {
  it("sorts keys by UTF-16 code unit, no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { z: [1, { y: 2, x: 3 }], c: "é" }, B: 0 })).toBe('{"B":0,"a":{"c":"é","z":[1,{"x":3,"y":2}]},"b":1}');
  });
  it("escapes strings via JSON.stringify", () => {
    expect(canonicalJson({ k: 'a"\n\u0001' })).toBe(JSON.stringify({ k: 'a"\n\u0001' }));
  });
  it("sha256Hex matches known vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("é😀")).toBe(refSha("é😀"));
  });
});

describe("B1 total and pure", () => {
  it("never throws on hostile input and never mutates", () => {
    const hostile: unknown[] = [undefined, null, 1, "s", [], Symbol.iterator, () => 1,
      new Proxy({}, { get() { throw new Error("boom"); }, ownKeys() { throw new Error("boom"); } })];
    const circ: Record<string, unknown> = {}; circ.self = circ; hostile.push(circ);
    for (const h of hostile) for (const f of [densify, measure]) {
      expect(() => f(h)).not.toThrow();
      expect(f(h).rc).toBe(2);
    }
  });
  it("frozen input works, equal input -> byte-identical lines", () => {
    const i = deepFreeze({ text: "x\nx\n\u001b[1m" });
    expect(toLine(densify(i))).toBe(toLine(densify({ text: "x\nx\n\u001b[1m" })));
    expect(toLine(densify(i))).toBe(toLine(densify(i)));
  });
});
