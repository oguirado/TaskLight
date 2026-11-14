import { describe, expect, test } from "vitest";
import { buildPanelModel, createLedger } from "../../../src/ledger";
import type { PanelModel } from "../../../src/ledger";
import type { PrivacyTier } from "../../../src/schema";
import { COUNTERS, DAY0, countsOf, day, ev, makeClock, makeLocal, zero } from "./helpers";

const tiersOf = (m: Record<string, PrivacyTier>) => m;
const shot = (ids: string[]) => Object.fromEntries(ids.map((i) => [i, "enabled" as const]));
const build = (d: ReturnType<typeof day>, tiers: Record<string, PrivacyTier>, sync: PanelModel["syncState"] = "synced") => buildPanelModel(d, tiersOf(tiers), shot(Object.keys(tiers)), sync);
const rowOf = (m: PanelModel, p: string) => m.rows.find((r) => r.projectId === p)!;

describe("B10 verdicts", () => {
  test("zero_cloud: private with only on-device counts", () => {
    const m = build(day(DAY0, { p1: { private: zero({ on_device: 5 }) } }), { p1: "private" });
    expect(rowOf(m, "p1").verdict).toBe("zero_cloud");
  });
  test("cloud_seen on in_cloud > 0 and on fallbacks > 0", () => {
    const a = build(day(DAY0, { p1: { private: zero({ in_cloud: 1 }) } }), { p1: "private" });
    const b = build(day(DAY0, { p1: { private: zero({ fallbacks: 1 }) } }), { p1: "private" });
    expect(rowOf(a, "p1").verdict).toBe("cloud_seen");
    expect(rowOf(b, "p1").verdict).toBe("cloud_seen");
  });
  test("unverifiable on unattributed > 0 without cloud; cloud_seen wins over unverifiable", () => {
    const a = build(day(DAY0, { p1: { private: zero({ on_device: 5, unattributed: 1 }) } }), { p1: "private" });
    const b = build(day(DAY0, { p1: { private: zero({ unattributed: 1, in_cloud: 1 }) } }), { p1: "private" });
    expect(rowOf(a, "p1").verdict).toBe("unverifiable");
    expect(rowOf(b, "p1").verdict).toBe("cloud_seen");
  });
  test("not_private whenever tierNow is not private, even with cloud counts", () => {
    for (const t of ["standard", "shared"] as PrivacyTier[]) {
      const m = build(day(DAY0, { p1: { [t]: zero({ in_cloud: 3 }) } }), { p1: t });
      expect(rowOf(m, "p1").verdict).toBe("not_private");
      expect(rowOf(m, "p1").tierNow).toBe(t);
    }
  });
  test("refusals and schema_rejects alone do not break zero_cloud", () => {
    const m = build(day(DAY0, { p1: { private: zero({ on_device: 2, refusals: 4, schema_rejects: 1 }) } }), { p1: "private" });
    expect(rowOf(m, "p1").verdict).toBe("zero_cloud");
  });
  test("the verdict uses the private-tier counts only: earlier standard-tier cloud calls do not taint it", () => {
    const m = build(day(DAY0, { p2: { standard: zero({ in_cloud: 1 }), private: zero({ on_device: 2 }) } }), { p2: "private" });
    expect(rowOf(m, "p2").verdict).toBe("zero_cloud");
  });
  test("a private cloud call under another tier name is still seen: tierNow private + private.in_cloud", () => {
    const m = build(day(DAY0, { p2: { standard: zero({ on_device: 1 }), private: zero({ in_cloud: 1 }) } }), { p2: "private" });
    expect(rowOf(m, "p2").verdict).toBe("cloud_seen");
  });
});

describe("B10/B11 rows, totals, tier change", () => {
  test("O13: p2 had 1 IN_CLOUD as standard then 2 ON_DEVICE as private; p1 1 ON_DEVICE", () => {
    const d = day(DAY0, {
      p1: { private: zero({ on_device: 1 }) },
      p2: { standard: zero({ in_cloud: 1 }), private: zero({ on_device: 2 }) },
    });
    const m = build(d, { p2: "private", p1: "private" });
    expect(m.rows.map((r) => r.projectId)).toEqual(["p1", "p2"]);
    const p2 = rowOf(m, "p2");
    expect(p2.verdict).toBe("zero_cloud");
    expect(p2.tierChangedToday).toBe(true);
    expect(p2.counts.in_cloud).toBe(1);
    expect(p2.counts.on_device).toBe(2);
    expect(rowOf(m, "p1").tierChangedToday).toBe(false);
    expect(m.totals.in_cloud).toBe(1);
    expect(m.totals.on_device).toBe(3);
  });
  test("tierChangedToday ignores tiers that exist only as zero entries", () => {
    const d = day(DAY0, { p1: { private: zero({ on_device: 2 }), standard: zero(), shared: zero() } });
    expect(rowOf(build(d, { p1: "private" }), "p1").tierChangedToday).toBe(false);
  });
  test("counts sum all tiers per counter, totals sum all rows including unattributed", () => {
    const d = day(DAY0, {
      a: { private: zero({ on_device: 1, unattributed: 2 }), standard: zero({ on_device: 2, fallbacks: 1 }) },
      b: { standard: zero({ in_cloud: 4, refusals: 1, schema_rejects: 3 }) },
    });
    const m = build(d, { a: "standard", b: "standard" });
    expect(rowOf(m, "a").counts).toEqual(zero({ on_device: 3, unattributed: 2, fallbacks: 1 }));
    expect(m.totals).toEqual(zero({ on_device: 3, unattributed: 2, fallbacks: 1, in_cloud: 4, refusals: 1, schema_rejects: 3 }));
    for (const c of COUNTERS) expect(m.totals[c]).toBe(m.rows.reduce((s, r) => s + r.counts[c], 0));
  });
  test("rows are ordered by projectId regardless of key order (code-unit order)", () => {
    const d = day(DAY0, { b: { private: zero() }, a: { private: zero() }, c: { private: zero() } });
    expect(build(d, { c: "private", a: "private", b: "private" }).rows.map((r) => r.projectId)).toEqual(["a", "b", "c"]);
  });
  test("dayKey and syncState pass through; screenshot column comes from the map", () => {
    for (const s of ["synced", "pending", "local_only"] as const) expect(build(day("2026-05-05", {}), {}, s)).toMatchObject({ dayKey: "2026-05-05", syncState: s, rows: [] });
    const d = day(DAY0, { p1: { private: zero() }, p2: { private: zero() } });
    const m = buildPanelModel(d, { p1: "private", p2: "private" }, { p1: "enabled", p2: "MULTIMODAL_UNAVAILABLE" }, "synced");
    expect(rowOf(m, "p1").screenshot).toBe("enabled");
    expect(rowOf(m, "p2").screenshot).toBe("MULTIMODAL_UNAVAILABLE");
  });
  test("does not mutate its inputs", () => {
    const d = day(DAY0, { p1: { private: zero({ on_device: 1 }) } });
    const tiers = { p1: "private" as const }; const snap = JSON.stringify([d, tiers]);
    build(d, tiers);
    expect(JSON.stringify([d, tiers])).toBe(snap);
  });
});

describe("ledger -> panel end to end (O5, O6, O7)", () => {
  const run = (events: Array<ReturnType<typeof ev>>) => {
    const l = createLedger({ clock: makeClock(), local: makeLocal().store });
    for (const e of events) l.record(e);
    return buildPanelModel(l.day(), { p1: "private" }, { p1: "enabled" }, "local_only");
  };
  test("O6: 5 on-device events prove zero_cloud; one unattributed call makes it unverifiable", () => {
    const five = Array.from({ length: 5 }, () => ev());
    const m = run(five);
    expect(rowOf(m, "p1").verdict).toBe("zero_cloud");
    expect(rowOf(m, "p1").counts.on_device).toBe(5);
    const m2 = run([...five, ev({ source: null, outcome: "ok" })]);
    expect(rowOf(m2, "p1").verdict).toBe("unverifiable");
    expect(rowOf(m2, "p1").counts.unattributed).toBe(1);
  });
  test("O5: a discarded cloud result is cloud_seen (G10 red alarm)", () => {
    expect(rowOf(run([ev({ source: "IN_CLOUD", outcome: "discarded" })]), "p1").verdict).toBe("cloud_seen");
  });
  test("O7: ONLY_ON_DEVICE error with no source stays zero_cloud", () => {
    expect(rowOf(run([ev({ source: null, outcome: "error" })]), "p1").verdict).toBe("zero_cloud");
  });
  test("a project that has no events at all is not reported as cloud_seen (and no row is invented for unknown ids)", () => {
    const l = createLedger({ clock: makeClock(), local: makeLocal().store });
    const m = buildPanelModel(l.day(), { p1: "private" }, { p1: "enabled" }, "synced");
    for (const r of m.rows) expect(r.verdict).not.toBe("cloud_seen");
    expect(countsOf(l.day(), "ghost", "private")).toEqual(zero());
  });
});
