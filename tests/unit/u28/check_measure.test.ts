import { describe, it, expect } from "vitest";
import { check, measure, toLine, sha256Hex, canonicalJson } from "../../../src/ctx";
import { errs, ex, fixIn, fixOut, refEnv, refSha } from "./ref";

describe("C11 measure_utf16", () => {
  it("'a😀é' -> utf16 4, tokens null, source absent", () => {
    const r = measure({ text: "a😀é" });
    expect(r.rc).toBe(0); expect(r.verb).toBe("measure");
    expect(r.data).toEqual({ utf16: 4, tokens: null, tokens_source: "absent" });
  });
  it("decomposed é is 2 units (UTF-16, not graphemes)", () => {
    expect((measure({ text: "é" }).data as { utf16: number }).utf16).toBe(2);
    expect((measure({ text: "" }).data as { utf16: number }).utf16).toBe(0);
  });
  it("golden measure_01; bad input rc 2", () => {
    expect(toLine(measure(fixIn("measure_01")))).toBe(fixOut("measure_01"));
    expect(measure({ text: 1 }).rc).toBe(2); expect(measure({ text: "a", x: 1 }).rc).toBe(2);
  });
});

const pk = () => ({ excerpts: [ex("a", 1, 2, "t")], maxChars: 100 });
const chk = (kind: unknown, value: unknown) => check({ kind, value });

describe("check strictness (B17)", () => {
  it("valid inputs of each kind -> rc 0, data {kind}", () => {
    for (const [k, v] of [["pack.in", pk()], ["densify.in", { text: "a" }], ["measure.in", { text: "a" }],
      ["rank.in", { excerpts: [ex("a", 1, 1, "t")], terms: ["t"] }]] as const) {
      const r = chk(k, v); expect(r.rc).toBe(0); expect(r.ok).toBe(true); expect(r.data).toEqual({ kind: k }); expect(r.verb).toBe("check");
    }
  });
  it("unknown key -> rc 2 UNKNOWN_FIELD (STRATEGY oracle: unknown key accepted)", () => {
    const r = chk("pack.in", { ...pk(), html: "x" });
    expect(r.rc).toBe(2); expect(errs(r)).toContainEqual({ code: "UNKNOWN_FIELD", path: "html" });
    expect(chk("measure.in", { text: "a", extra: 1 }).rc).toBe(2);
  });
  it("golden check_01 / check_02", () => {
    expect(toLine(check(fixIn("check_01")))).toBe(fixOut("check_01"));
    expect(toLine(check(fixIn("check_02")))).toBe(fixOut("check_02"));
  });
  it("NaN, Infinity, 2.5 -> BAD_NUMBER; true -> BOOL_AS_INT", () => {
    for (const n of [NaN, Infinity, -Infinity, 2.5]) { const r = chk("pack.in", { ...pk(), maxChars: n }); expect(r.rc).toBe(2); expect(errs(r)[0]?.code).toBe("BAD_NUMBER"); }
    for (const n of [true, false]) { const r = chk("pack.in", { ...pk(), maxChars: n }); expect(r.rc).toBe(2); expect(errs(r)[0]?.code).toBe("BOOL_AS_INT"); }
  });
  it("unsafe integer -> BAD_NUMBER", () => {
    expect(errs(chk("pack.in", { ...pk(), maxChars: 2 ** 53 }))[0]?.code).toBe("BAD_NUMBER");
  });
  it("non-plain objects and accessors -> WRONG_TYPE; getter never invoked", () => {
    let calls = 0;
    const withGetter = { excerpts: [], get maxChars() { calls++; return 5; } };
    const r = chk("pack.in", withGetter);
    expect(r.rc).toBe(2); expect(errs(r).some((e) => e.code === "WRONG_TYPE")).toBe(true); expect(calls).toBe(0);
    class K { text = "a"; }
    expect(errs(chk("measure.in", new K())).some((e) => e.code === "WRONG_TYPE")).toBe(true);
    expect(chk("measure.in", Object.create({ text: "a" })).rc).toBe(2);
    expect(chk("measure.in", new Map()).rc).toBe(2);
  });
  it("depth beyond 8 -> TOO_DEEP", () => {
    let v: unknown = "leaf"; for (let i = 0; i < 12; i++) v = { n: v };
    const r = chk("envelope", { ...refEnv("measure", 0, { utf16: 1, tokens: null, tokens_source: "absent" }), data: v });
    expect(r.rc).toBe(2); expect(errs(r).some((e) => e.code === "TOO_DEEP")).toBe(true);
  });
  it("missing / wrong-type / unknown kind -> rc 2", () => {
    expect(chk("pack.in", {}).rc).toBe(2);
    expect(chk("pack.in", "str").rc).toBe(2);
    expect(chk("nope", {}).rc).toBe(2);
    expect(check({ kind: "pack.in" }).rc).toBe(2);
    expect(check({ kind: "pack.in", value: pk(), extra: 1 }).rc).toBe(2);
    expect(check(null).rc).toBe(2);
  });
  it("errors are sorted by path then code and path never echoes input text", () => {
    const r = chk("pack.in", { zzz: "SECRET-TEXT", aaa: 1, maxChars: true, excerpts: [] });
    const e = errs(r); const keys = e.map((x) => x.path + "\u0000" + x.code);
    expect(keys).toEqual([...keys].sort());
    expect(e.some((x) => x.path.includes("SECRET-TEXT"))).toBe(false);
  });
});

describe("C9 stale_sha (envelope side)", () => {
  const sealed = () => refEnv("measure", 0, { utf16: 4, tokens: null, tokens_source: "absent" });
  it("untouched sealed envelope -> rc 0 (control)", () => {
    const r = chk("envelope", sealed()); expect(r.rc).toBe(0); expect(r.data).toEqual({ kind: "envelope" });
  });
  it("data edited after sealing -> rc 4", () => {
    const e = sealed(); (e.data as { utf16: number }).utf16 = 5;
    const r = chk("envelope", e); expect(r.rc).toBe(4); expect(r.ok).toBe(false);
  });
  it("sha uppercased / wrong -> rc 4 or 2, never 0", () => {
    const e = sealed(); expect(chk("envelope", { ...e, sha256: e.sha256.toUpperCase() }).rc).not.toBe(0);
    expect(chk("envelope", { ...e, sha256: "0".repeat(64) }).rc).toBe(4);
  });
  it("accepts every rc in {0,2,4,6,7,124} and U29 verbs; rejects others", () => {
    for (const rc of [0, 2, 4, 6, 7, 124]) expect(chk("envelope", refEnv("pack", rc, { errors: [] })).rc).toBe(0);
    for (const v of ["densify", "rank", "pack", "measure", "check", "page", "find", "census", "tail", "state"])
      expect(chk("envelope", refEnv(v, 0, {})).rc).toBe(0);
    expect(chk("envelope", refEnv("pack", 3, {})).rc).toBe(2);
    expect(chk("envelope", refEnv("bogus", 0, {})).rc).toBe(2);
    expect(chk("envelope", { ...refEnv("pack", 0, {}), schema: "ctx.resp/v2" }).rc).toBe(2);
    expect(chk("envelope", { ...refEnv("pack", 0, {}), extra: 1 }).rc).toBe(2);
  });
  it("real verb output validates as envelope (round trip)", () => {
    expect(chk("envelope", JSON.parse(toLine(measure({ text: "x" })))).rc).toBe(0);
    expect(sha256Hex(canonicalJson({}))).toBe(refSha("{}"));
  });
});
