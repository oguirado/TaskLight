import { describe, it, expect } from "vitest";
import { pack, renderPack, sha256Hex, toLine, type ContextPack } from "../../../src/ctx";
import { ex, errs, fixIn, fixOut, refRender, refSha, deepFreeze } from "./ref";

const P = (r: { data: unknown }) => r.data as ContextPack;
const big = (n: number, c = "x") => c.repeat(n);

describe("C4 pack_9000 (STRATEGY oracle)", () => {
  it("one 9000-char excerpt, maxChars 7300 -> rc 6, ok false, no blocks", () => {
    const r = pack({ excerpts: [ex("a.ts", 1, 9, big(9000))], maxChars: 7300 });
    expect(r.rc).toBe(6); expect(r.ok).toBe(false); expect(P(r).blocks).toEqual([]);
  });
  it("9000 chars as 45 small excerpts: within budget, never over 7300", () => {
    const excerpts = Array.from({ length: 45 }, (_, i) => ex("f" + i, 1, 2, big(200)));
    const r = pack({ excerpts, maxChars: 7300 });
    expect(r.rc).toBe(0);
    const p = P(r);
    expect(p.total_chars).toBeLessThanOrEqual(7300);
    expect(p.total_chars).toBe(refRender(p.blocks).length);
    expect(p.blocks.length + p.dropped).toBe(45);
    expect(p.dropped).toBeGreaterThan(0);
  });
  it("zero excerpts -> rc 0, empty pack", () => {
    const r = pack({ excerpts: [], maxChars: 100 });
    expect(r.rc).toBe(0);
    expect(P(r)).toEqual({ blocks: [], dropped: 0, total_chars: 0, pack_hash: refSha("") });
  });
  it("exact fit is accepted; one char less drops it", () => {
    const e = ex("a", 1, 1, big(10)); const len = refRender([e]).length;
    expect(pack({ excerpts: [e], maxChars: len }).rc).toBe(0);
    expect(pack({ excerpts: [e], maxChars: len - 1 }).rc).toBe(6);
  });
});

describe("C5 pack_partial (positive control)", () => {
  const input = () => ({ excerpts: [ex("a.ts", 3, 40, big(4000, "a")), ex("b.ts", 1, 9, big(3000, "b")), ex("c.ts", 7, 8, big(2500, "c"))], maxChars: 7300 });
  it("2 blocks, dropped 1, total_chars == renderPack length <= 7300, coords unchanged", () => {
    const r = pack(input()); const p = P(r);
    expect(r.rc).toBe(0); expect(r.ok).toBe(true);
    expect(p.blocks).toHaveLength(2); expect(p.dropped).toBe(1);
    expect(p.total_chars).toBe(renderPack(p).length);
    expect(p.total_chars).toBeLessThanOrEqual(7300);
    expect(p.blocks.map((b) => b.coord)).toEqual([{ src: "a.ts", from: 3, to: 40 }, { src: "b.ts", from: 1, to: 9 }]);
    expect(p.blocks[0]?.text).toBe(big(4000, "a"));
  });
  it("block format is '@@ src:from-to\\n<text>\\n'", () => {
    const p = P(pack(input()));
    expect(renderPack(p)).toBe(refRender([ex("a.ts", 3, 40, big(4000, "a")), ex("b.ts", 1, 9, big(3000, "b"))]));
    expect(renderPack(p).startsWith("@@ a.ts:3-40\naaaa")).toBe(true);
  });
  it("greedy in input order, skipped excerpts do not stop later ones; no truncation", () => {
    const p = P(pack({ excerpts: [ex("a", 1, 1, big(4000)), ex("b", 1, 1, big(3500)), ex("c", 1, 1, big(100, "c"))], maxChars: 7300 }));
    expect(p.blocks.map((b) => b.coord.src)).toEqual(["a", "c"]);
    expect(p.dropped).toBe(1);
    expect(p.blocks.every((b) => b.text === big(4000) || b.text === big(100, "c"))).toBe(true);
  });
  it("pack_hash = sha256(renderPack)", () => {
    const p = P(pack(input())); expect(p.pack_hash).toBe(refSha(renderPack(p))); expect(p.pack_hash).toBe(sha256Hex(renderPack(p)));
  });
  it("does not mutate frozen input", () => { expect(pack(deepFreeze(input())).rc).toBe(0); });
});

describe("C6 pack_usage", () => {
  const e = [ex("a", 1, 1, "t")];
  it.each([[7301], [0], [1.5], [-1]])("maxChars %s -> rc 2", (m) => { expect(pack({ excerpts: e, maxChars: m }).rc).toBe(2); });
  it("maxChars 1 and 7300 accepted (controls)", () => {
    expect(pack({ excerpts: [], maxChars: 1 }).rc).toBe(0); expect(pack({ excerpts: [], maxChars: 7300 }).rc).toBe(0);
  });
  it("from:0 -> rc 2 BAD_COORD; to<from, src too long likewise", () => {
    for (const c of [{ src: "a", from: 0, to: 1 }, { src: "a", from: 3, to: 2 }, { src: "s".repeat(257), from: 1, to: 1 }]) {
      const r = pack({ excerpts: [{ coord: c, text: "t" }], maxChars: 100 });
      expect(r.rc).toBe(2);
      expect(errs(r).some((x) => x.code === "BAD_COORD" || x.code === "TOO_LONG")).toBe(true);
    }
    expect(errs(pack({ excerpts: [{ coord: { src: "a", from: 0, to: 1 }, text: "t" }], maxChars: 100 })).some((x) => x.code === "BAD_COORD")).toBe(true);
    expect(pack({ excerpts: [ex("s".repeat(256), 1, 1, "t")], maxChars: 400 }).rc).toBe(0);
  });
});

describe("C7/C8 strict input", () => {
  const base = () => ({ excerpts: [ex("a", 1, 2, "t")], maxChars: 100 });
  it("C7 extra key html -> rc 2 UNKNOWN_FIELD at html", () => {
    const r = pack({ ...base(), html: "<b>" });
    expect(r.rc).toBe(2); expect(errs(r)).toContainEqual({ code: "UNKNOWN_FIELD", path: "html" });
  });
  it("C8 NaN / bool / 2.5 and valid control", () => {
    const n = pack({ ...base(), maxChars: NaN }); expect(n.rc).toBe(2); expect(errs(n)[0]?.code).toBe("BAD_NUMBER"); expect(errs(n)[0]?.path).toBe("maxChars");
    const b = pack({ ...base(), maxChars: true }); expect(b.rc).toBe(2); expect(errs(b)[0]).toEqual({ code: "BOOL_AS_INT", path: "maxChars" });
    const f = pack({ excerpts: [{ coord: { src: "a", from: 1, to: 2.5 }, text: "t" }], maxChars: 100 });
    expect(f.rc).toBe(2); expect(errs(f).some((x) => x.code === "BAD_NUMBER")).toBe(true);
    expect(pack(base()).rc).toBe(0);
  });
  it("Infinity and missing field", () => {
    expect(errs(pack({ ...base(), maxChars: Infinity }))[0]?.code).toBe("BAD_NUMBER");
    expect(errs(pack({ excerpts: [] }))).toContainEqual({ code: "MISSING_FIELD", path: "maxChars" });
  });
  it("errors sorted by path then code", () => {
    const e = errs(pack({ zeta: 1, alpha: 2, maxChars: true, excerpts: [] }));
    const keys = e.map((x) => x.path + "\u0000" + x.code);
    expect(keys).toEqual([...keys].sort());
    expect(e.length).toBeGreaterThanOrEqual(3);
  });
});

describe("C9 stale_sha (pack side)", () => {
  it("expect mismatch -> rc 4 SHA_MISMATCH and no pack", () => {
    const r = pack({ excerpts: [ex("a.ts", 1, 1, "t", refSha("t"))], maxChars: 100, expect: { "a.ts": refSha("other") } });
    expect(r.rc).toBe(4); expect(r.ok).toBe(false);
    expect(errs(r).some((e) => e.code === "SHA_MISMATCH")).toBe(true);
    expect((r.data as Record<string, unknown>).blocks).toBeUndefined();
  });
  it("matching expect and expect for absent src -> rc 0 (controls)", () => {
    expect(pack({ excerpts: [ex("a.ts", 1, 1, "t", refSha("t"))], maxChars: 100, expect: { "a.ts": refSha("t") } }).rc).toBe(0);
    expect(pack({ excerpts: [ex("a.ts", 1, 1, "t")], maxChars: 100, expect: { "zzz": "00" } }).rc).toBe(0);
  });
});

describe("C10 determinism", () => {
  it("pack_01 twice is byte-identical to golden", () => {
    const g = fixOut("pack_01");
    expect(toLine(pack(fixIn("pack_01")))).toBe(g);
    expect(toLine(pack(fixIn("pack_01")))).toBe(g);
  });
  it("golden is the expected shape (3 blocks, 1 dropped)", () => {
    const o = JSON.parse(fixOut("pack_01")); expect(o.data.blocks).toHaveLength(3); expect(o.data.dropped).toBe(1);
  });
  it("fresh module instance (Worker) yields the same bytes", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    const w = await import("../../../src/ctx/worker");
    const out = w.handleWorkerMessage({ id: 7, verb: "pack", input: fixIn("pack_01") });
    expect(out.id).toBe(7); expect(out.line).toBe(fixOut("pack_01"));
  });
});

describe("C14 hash_sensitivity", () => {
  const mk = (c: string) => ({ excerpts: [ex("a.ts", 3, 40, big(4000, "a")), ex("b.ts", 1, 9, big(2999, "b") + c), ex("c.ts", 7, 8, big(2500, "c"))], maxChars: 7300 });
  it("one char changed -> pack_hash differs; same input -> same hash", () => {
    const h1 = P(pack(mk("b"))).pack_hash, h2 = P(pack(mk("X"))).pack_hash;
    expect(h1).toMatch(/^[0-9a-f]{64}$/); expect(h1).not.toBe(h2); expect(P(pack(mk("b"))).pack_hash).toBe(h1);
  });
});
