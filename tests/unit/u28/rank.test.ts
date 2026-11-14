import { describe, it, expect } from "vitest";
import { rank, toLine } from "../../../src/ctx";
import { ex, errs, fixIn, fixOut } from "./ref";

const mk = (texts: string[]) => texts.map((t, i) => ex(`s/${i}`, 1, 1, t));
const out = (texts: string[], terms: string[]) => rank({ excerpts: mk(texts), terms }).data as { order: number[]; scores: number[] };

describe("C3 rank_bm25", () => {
  const texts = ["nothing relevant", "migration blocked", "migration blocked migration"];
  it("orders [2,1,0] with integer scores", () => {
    const o = out(texts, ["migration", "blocked"]);
    expect(o.order).toEqual([2, 1, 0]);
    expect(o.scores.every(Number.isSafeInteger)).toBe(true);
    expect(o.scores).toEqual([1019004, 998353, 0]); // aligned with `order` (ASSUMPTION, see ORACLE.md)
  });
  it("equals golden rank_01", () => {
    expect(toLine(rank(fixIn("rank_01")))).toBe(fixOut("rank_01"));
  });
  it("two identical excerpts keep input order (tie stable)", () => {
    const o = out(["foo bar", "zzz", "foo bar", "foo bar"], ["foo"]);
    expect(o.order).toEqual([0, 2, 3, 1]);
  });
  it("zero terms or all-zero scores keep input order", () => {
    expect(out(["a", "b", "c"], []).order).toEqual([0, 1, 2]);
    expect(out(["a", "b", "c"], ["zzz"]).order).toEqual([0, 1, 2]);
    expect(out(["a", "b", "c"], ["zzz"]).scores).toEqual([0, 0, 0]);
  });
  it("case-insensitive; duplicate terms (any case) dedupe", () => {
    const a = out(texts, ["migration", "blocked"]);
    expect(out(texts.map((t) => t.toUpperCase()), ["MIGRATION", "Blocked", "migration"])).toEqual(a);
  });
  it("tokens are [a-z0-9_]+ runs: punctuation splits, underscore joins", () => {
    expect(out(["x", "foo-bar", "foo_bar"], ["bar"]).order).toEqual([1, 0, 2]);
    expect(out(["x", "foo-bar", "foo_bar"], ["foo_bar"]).order).toEqual([2, 0, 1]);
  });
  it("deterministic across runs", () => {
    const i = { excerpts: mk(texts), terms: ["migration"] };
    expect(toLine(rank(i))).toBe(toLine(rank(i)));
  });
});

describe("B8 limits", () => {
  it("64 excerpts ok, 65 -> rc 2 TOO_MANY", () => {
    expect(rank({ excerpts: mk(Array(64).fill("a")), terms: [] }).rc).toBe(0);
    const r = rank({ excerpts: mk(Array(65).fill("a")), terms: [] });
    expect(r.rc).toBe(2); expect(errs(r).some((e) => e.code === "TOO_MANY")).toBe(true);
  });
  it("excerpt text 2000 ok, 2001 -> TOO_LONG", () => {
    expect(rank({ excerpts: mk(["a".repeat(2000)]), terms: [] }).rc).toBe(0);
    const r = rank({ excerpts: mk(["a".repeat(2001)]), terms: [] });
    expect(r.rc).toBe(2); expect(errs(r).some((e) => e.code === "TOO_LONG")).toBe(true);
  });
  it("32 terms ok, 33 -> TOO_MANY; term 40 chars ok, 41 -> TOO_LONG", () => {
    const t = (n: number) => Array.from({ length: n }, (_, i) => "t" + i);
    expect(rank({ excerpts: mk(["a"]), terms: t(32) }).rc).toBe(0);
    expect(errs(rank({ excerpts: mk(["a"]), terms: t(33) })).some((e) => e.code === "TOO_MANY")).toBe(true);
    expect(rank({ excerpts: mk(["a"]), terms: ["a".repeat(40)] }).rc).toBe(0);
    expect(errs(rank({ excerpts: mk(["a"]), terms: ["a".repeat(41)] })).some((e) => e.code === "TOO_LONG")).toBe(true);
  });
  it("unknown key / wrong type -> rc 2", () => {
    expect(rank({ excerpts: [], terms: [], extra: 1 }).rc).toBe(2);
    expect(rank({ excerpts: "x", terms: [] }).rc).toBe(2);
  });
});
