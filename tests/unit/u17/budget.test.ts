import { describe, expect, test } from "vitest";
import { buildDigestInput } from "../../../src/digest";
import type { DigestInput } from "../../../src/digest";
import { NOW, cap, pid } from "./helpers";

const ok = (r: ReturnType<typeof buildDigestInput>): DigestInput => {
  expect("error" in r, JSON.stringify("error" in r ? r : "")).toBe(false);
  return r as DigestInput;
};
const SUM = (i: number) => String(i % 10).repeat(600);

/** 12 capsules, equal attention/status; priority = waiting_ms desc, so p01 is highest priority, p12 lowest */
const twelve = (extra: (i: number) => Record<string, string> = () => ({ headline: "headline-text-20ch", next_action: "next action text", summary: "" })) =>
  Array.from({ length: 12 }, (_, k) => {
    const i = k + 1;
    const e = extra(i);
    return cap(pid(i), { attention: "low", status: "running", waiting: (13 - i) * 1000,
      ...(e["headline"] ? { headline: e["headline"] } : {}), ...(e["next_action"] ? { next_action: e["next_action"] } : {}), ...(e["summary"] ? { summary: e["summary"] } : {}) });
  });
const fat = () => twelve((i) => ({ headline: "headline-text-20ch", next_action: "next action text", summary: SUM(i) }));

describe("buildDigestInput (B5-B8)", () => {
  test("O4 neg: 3 capsules fit at level 0, nothing dropped", () => {
    const caps = fat().slice(0, 3);
    const r = ok(buildDigestInput(caps, 6100, NOW));
    expect(r.truncation).toEqual({ level: 0, droppedFields: 0, omittedProjects: [] });
    expect(r.lines).toHaveLength(3);
    for (const l of r.lines) expect(l.summary).toHaveLength(600);
  });
  test("serialized is the lines' JSON joined by newline; chars is its length", () => {
    const r = ok(buildDigestInput(fat().slice(0, 4), 6100, NOW));
    expect(r.serialized).toBe(r.lines.map((l) => JSON.stringify(l)).join("\n"));
    expect(r.chars).toBe(r.serialized.length);
  });
  test("B6: lines are sorted by the B9 key regardless of input order", () => {
    const caps = fat();
    const a = ok(buildDigestInput(caps, 99999, NOW));
    const b = ok(buildDigestInput([...caps].reverse(), 99999, NOW));
    expect(a.lines.map((l) => l.projectId)).toEqual(Array.from({ length: 12 }, (_, k) => pid(k + 1)));
    expect(b.serialized).toBe(a.serialized);
  });
  test("O4 ladder L1: 12 fat capsules in 6100 chars drop summaries from the lowest priority and stop", () => {
    const r = ok(buildDigestInput(fat(), 6100, NOW));
    expect(r.chars).toBeLessThanOrEqual(6100);
    expect(r.truncation.level).toBe(1);
    expect(r.truncation.droppedFields).toBeGreaterThanOrEqual(1);
    expect(r.truncation.omittedProjects).toEqual([]);
    expect(r.lines).toHaveLength(12);
    expect(r.lines[0]!.summary).toHaveLength(600);                // top priority keeps its summary
    expect(r.lines[11]!.summary).toBeUndefined();                 // lowest loses it first
    const has = r.lines.map((l) => l.summary !== undefined);
    const firstLost = has.indexOf(false);
    expect(firstLost).toBeGreaterThan(0);
    for (let i = firstLost; i < has.length; i++) expect(has[i], "suffix property " + i).toBe(false);
    expect(r.truncation.droppedFields).toBe(has.filter((x) => !x).length);
    for (const l of r.lines) { expect(l.headline).toBe("headline-text-20ch"); expect(l.next_action).toBe("next action text"); }   // L1 stops once it fits
  });
  test("L1 stops as soon as the input fits (not all summaries dropped when fewer suffice)", () => {
    const full = ok(buildDigestInput(fat(), 99999, NOW)).chars;
    const r = ok(buildDigestInput(fat(), full - 100, NOW));
    expect(r.truncation.level).toBe(1);
    expect(r.truncation.droppedFields).toBe(1);
    expect(r.lines[11]!.summary).toBeUndefined();
    expect(r.lines[10]!.summary).toBeDefined();
  });
  test("L2: when summaries are not enough, next_action then headline go, lowest priority first", () => {
    const big = (i: number) => ({ headline: "H".repeat(100) + i, next_action: "N".repeat(150), summary: SUM(i) });
    const caps = twelve(big);
    const l1 = ok(buildDigestInput(caps, 99999, NOW));
    expect(l1.truncation.level).toBe(0);
    const r = ok(buildDigestInput(caps, 3000, NOW));
    expect(r.truncation.level).toBe(2);
    expect(r.chars).toBeLessThanOrEqual(3000);
    expect(r.lines).toHaveLength(12);
    for (const l of r.lines) expect(l.summary).toBeUndefined();
    const anyHeadlineLost = r.lines.some((l) => l.headline === undefined);
    if (anyHeadlineLost) for (const l of r.lines) expect(l.next_action, "next_action goes before headline").toBeUndefined();
    const na = r.lines.map((l) => l.next_action !== undefined);
    const firstNaLost = na.indexOf(false);
    if (firstNaLost >= 0) for (let i = firstNaLost; i < na.length; i++) expect(na[i]).toBe(false);
    expect(r.lines[0]!.next_action !== undefined || r.lines[0]!.headline !== undefined).toBe(true);   // top priority degrades last
  });
  test("L3: whole lines are omitted from the lowest priority; knownProjectIds and omittedProjects agree (B8)", () => {
    const r = ok(buildDigestInput(fat(), 500, NOW));
    expect(r.truncation.level).toBe(3);
    expect(r.chars).toBeLessThanOrEqual(500);
    expect(r.lines.length).toBeGreaterThan(0);
    expect(r.lines.length).toBeLessThan(12);
    const kept = r.lines.map((l) => l.projectId);
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, k) => pid(k + 1)));   // a prefix of the priority order
    expect([...r.knownProjectIds].sort()).toEqual([...kept].sort());
    expect([...r.truncation.omittedProjects].sort()).toEqual(Array.from({ length: 12 - kept.length }, (_, k) => pid(kept.length + k + 1)).sort());
    for (const l of r.lines) { expect(l.summary).toBeUndefined(); expect(l.next_action).toBeUndefined(); expect(l.headline).toBeUndefined(); }
  });
  test("B14: revVector keeps every valid input capsule including omitted ones", () => {
    const caps = fat().map((c, k) => ({ ...c, state: { ...c.state, rev: k + 10 } }));
    const r = ok(buildDigestInput(caps, 500, NOW));
    expect(Object.keys(r.revVector).sort()).toEqual(Array.from({ length: 12 }, (_, k) => pid(k + 1)));
    expect(r.revVector[pid(12)]).toBe(21);
  });
  test("B7: floor-set capsules are never omitted, even when non-floor capsules outrank them", () => {
    const floor = Array.from({ length: 6 }, (_, k) => cap(pid(k + 1), { status: "blocked", attention: "low", waiting: 100 }));
    const other = Array.from({ length: 6 }, (_, k) => cap(pid(k + 7), { status: "running", attention: "high", waiting: 50000 }));
    const r = ok(buildDigestInput([...other, ...floor], 500, NOW));
    expect(r.truncation.level).toBe(3);
    const kept = new Set(r.lines.map((l) => l.projectId));
    for (let i = 1; i <= 6; i++) expect(kept.has(pid(i)), pid(i)).toBe(true);
    expect(r.truncation.omittedProjects.length).toBe(6);
    for (const o of r.truncation.omittedProjects) expect(Number(o.slice(1))).toBeGreaterThan(6);
    expect(r.chars).toBeLessThanOrEqual(500);
  });
  test("O5: floor set that cannot fit -> INPUT_FLOOR_OVER_BUDGET", () => {
    const caps = Array.from({ length: 12 }, (_, k) => cap(pid(k + 1), { status: "blocked", attention: "now" }));
    expect(buildDigestInput(caps, 10, NOW)).toEqual({ error: "INPUT_FLOOR_OVER_BUDGET" });
  });
  test("non-positive or non-finite budgets fail closed", () => {
    const caps = [cap("p1")];
    for (const b of [0, -1, NaN, -Infinity]) expect(buildDigestInput(caps, b, NOW), String(b)).toEqual({ error: "INPUT_FLOOR_OVER_BUDGET" });
  });
  test("private capsules contribute no text to the input (O2 at input level)", () => {
    const r = ok(buildDigestInput([cap("p1", { tier: "private", status: "blocked", headline: "PRIV-HL", summary: "PRIV-SUM" }), cap("p2", { headline: "STD-HL" })], 6100, NOW));
    expect(r.serialized).not.toContain("PRIV-");
    expect(r.serialized).toContain("STD-HL");
    expect(r.lines.find((l) => l.projectId === "p1")).toEqual({ projectId: "p1", status: "blocked", attention: "none", waiting_ms: 1000 });
  });
  test("invalid capsules are excluded from lines, knownProjectIds and revVector", () => {
    const r = ok(buildDigestInput([cap("p1"), cap("bad", { status: "exploding" })], 6100, NOW));
    expect(r.lines.map((l) => l.projectId)).toEqual(["p1"]);
    expect(r.knownProjectIds.has("bad")).toBe(false);
    expect(Object.keys(r.revVector)).toEqual(["p1"]);
  });
  test("knownProjectIds equals the lines' ids when nothing is truncated", () => {
    const r = ok(buildDigestInput(fat().slice(0, 3), 6100, NOW));
    expect([...r.knownProjectIds].sort()).toEqual(["p01", "p02", "p03"]);
  });
});
