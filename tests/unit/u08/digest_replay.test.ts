import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, digestHex, normalise, replayDigest, replaySchedule } from "../../../src/ingest/index";
import type { CapsuleEvent } from "../../../src/ingest/index";
import { genRaw, mkEvent, normaliseAll } from "./helpers";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const permute = <T>(a: readonly T[]): T[] => a.map((_, i) => a[(i * 37 + 11) % a.length]!);

describe("B11 digestHex / canonicalJson", () => {
  it("SHA-256 known answers", () => {
    expect(digestHex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(digestHex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("matches node sha256 over multi-block, unicode and long inputs", () => {
    for (const s of ["a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(119), "héllo … \u{1F600}", "x".repeat(100000)]) expect(digestHex(s)).toBe(sha(s));
  });
  it("canonicalJson sorts keys, no whitespace, integers", () => {
    const e = mkEvent();
    const { eventId: _id, ...rest } = e;
    const a = canonicalJson(rest);
    expect(a).not.toMatch(/\s(?=[^"]*(?:"[^"]*"[^"]*)*$)/);
    expect(a).toBe('{"kind":"output","projectId":"p1","redactions":0,"source":"agent","sourceSeq":1,"text":"hello","tier":"standard","truncated":false,"ts":1000}');
    const shuffled = { ts: 1000, truncated: false, tier: "standard", text: "hello", sourceSeq: 1, source: "agent", redactions: 0, kind: "output", projectId: "p1" } as Omit<CapsuleEvent, "eventId">;
    expect(canonicalJson(shuffled)).toBe(a);
  });
  it("escapes strings like JSON.stringify", () => {
    const { eventId: _id, ...rest } = mkEvent({ text: 'q"uote\n…\\' });
    expect(canonicalJson(rest)).toContain(JSON.stringify('q"uote\n…\\'));
  });
});

describe("I9 digest stable and order invariant", () => {
  const raws = genRaw();
  it("200 generated events normalise OK (positive control)", () => {
    expect(raws.length).toBe(200);
    expect(normaliseAll(normalise, raws).length).toBe(200);
  });
  it("two runs and a shuffled order give the same 64-hex digest", () => {
    const a = replayDigest(normaliseAll(normalise, raws));
    const b = replayDigest(normaliseAll(normalise, raws));
    const evs = normaliseAll(normalise, raws);
    const c = replayDigest(permute(evs));
    const d = replayDigest([...evs].reverse());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([a, b, c, d]).size).toBe(1);
  });
  it("equals SHA-256 of the sorted canonical lines joined by newline (known answer)", () => {
    const evs = normaliseAll(normalise, raws);
    const sorted = [...evs].sort((x, y) => x.ts - y.ts || (x.projectId < y.projectId ? -1 : x.projectId > y.projectId ? 1 : 0) || (x.source < y.source ? -1 : x.source > y.source ? 1 : 0) || x.sourceSeq - y.sourceSeq);
    expect(replayDigest(permute(evs))).toBe(sha(sorted.map((e) => canonicalJson(e)).join("\n")));
  });
  it("does not mutate its input order", () => {
    const evs = permute(normaliseAll(normalise, raws));
    const snap = evs.map((e) => e.eventId);
    replayDigest(evs);
    expect(evs.map((e) => e.eventId)).toEqual(snap);
  });
  it("sort key ties on ts are broken by projectId, source, sourceSeq", () => {
    const evs = [
      mkEvent({ projectId: "b", ts: 5 }), mkEvent({ projectId: "a", ts: 5, source: "git", kind: "push" }),
      mkEvent({ projectId: "a", ts: 5, sourceSeq: 2 }), mkEvent({ projectId: "a", ts: 5, sourceSeq: 1 }),
    ];
    expect(replayDigest(evs)).toBe(replayDigest([...evs].reverse()));
    const expected = sha([...evs].sort((x, y) =>
      x.ts - y.ts || (x.projectId < y.projectId ? -1 : x.projectId > y.projectId ? 1 : 0) ||
      (x.source < y.source ? -1 : x.source > y.source ? 1 : 0) || x.sourceSeq - y.sourceSeq)
      .map((e) => canonicalJson(e)).join("\n"));
    expect(replayDigest(evs)).toBe(expected);
  });
});

describe("I10 digest sensitive", () => {
  const evs = normaliseAll(normalise, genRaw());
  const base = replayDigest(evs);
  it("one char of text changes the digest", () => {
    const m = evs.map((e, i) => (i === 123 ? { ...e, text: e.text + "!" } : e));
    expect(replayDigest(m)).not.toBe(base);
  });
  it("any single field change changes the digest", () => {
    const e0 = mkEvent();
    const d0 = replayDigest([e0]);
    const variants: Partial<CapsuleEvent>[] = [
      { projectId: "p2" }, { source: "git", kind: "push" }, { kind: "error" }, { sourceSeq: 2 }, { ts: 1001 },
      { text: "hellp" }, { redactions: 1 }, { truncated: true }, { tier: "private" }, { eventId: "f".repeat(64) },
    ];
    for (const v of variants) expect(replayDigest([{ ...e0, ...v }]), JSON.stringify(v)).not.toBe(d0);
  });
  it("dropping or duplicating an event changes the digest", () => {
    expect(replayDigest(evs.slice(1))).not.toBe(base);
    expect(replayDigest([...evs, evs[0]!])).not.toBe(base);
  });
});

describe("I15 replay_schedule", () => {
  const e = (ts: number, seq: number) => mkEvent({ ts, sourceSeq: seq });
  it("sorted by ts, atMs relative to first, divided by speed", () => {
    const s = replaySchedule([e(1000, 1), e(3000, 3), e(2000, 2)], 2);
    expect(s.map((x) => x.atMs)).toEqual([0, 500, 1000]);
    expect(s.map((x) => x.event.ts)).toEqual([1000, 2000, 3000]);
  });
  it("speed outside [0.25, 16] or non-finite -> empty", () => {
    const evs = [e(1000, 1), e(2000, 2)];
    for (const sp of [0, -1, 0.24, 16.01, 100, NaN, Infinity, -Infinity]) expect(replaySchedule(evs, sp), String(sp)).toEqual([]);
  });
  it("boundary speeds accepted", () => {
    expect(replaySchedule([e(0, 1), e(1000, 2)], 0.25).map((x) => x.atMs)).toEqual([0, 4000]);
    expect(replaySchedule([e(0, 1), e(1600, 2)], 16).map((x) => x.atMs)).toEqual([0, 100]);
  });
  it("empty input and non-zero first ts; monotone over 200 shuffled events; input not mutated", () => {
    expect(replaySchedule([], 1)).toEqual([]);
    expect(replaySchedule([e(5000, 1)], 1)[0]!.atMs).toBe(0);
    const evs = permute(normaliseAll(normalise, genRaw()));
    const copy = [...evs];
    const s = replaySchedule(evs, 1);
    expect(evs).toEqual(copy);
    expect(s.length).toBe(200);
    expect(s[0]!.atMs).toBe(0);
    for (let i = 1; i < s.length; i++) expect(s[i]!.atMs).toBeGreaterThanOrEqual(s[i - 1]!.atMs);
  });
});
