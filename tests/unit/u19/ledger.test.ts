import { describe, expect, test } from "vitest";
import { createLedger } from "../../../src/ledger";
import type { Ledger } from "../../../src/ledger";
import { COUNTERS, DAY0, T0, countsOf, ev, flattenDeltas, flush, makeClock, makeLocal, makeRemote, sumDeltas, zero } from "./helpers";

function boot(o: { remote?: boolean; retentionDays?: number; initial?: Parameters<typeof makeLocal>[0] } = {}) {
  const clock = makeClock(); const local = makeLocal(o.initial); const rem = makeRemote();
  const ledger: Ledger = createLedger({ clock, local: local.store, ...(o.remote === false ? {} : { remote: rem.remote }), ...(o.retentionDays !== undefined ? { retentionDays: o.retentionDays } : {}) });
  return { clock, local, rem, ledger };
}

describe("O5 cloud_counted_before_discard (B6)", () => {
  test("private ONLY_ON_DEVICE called IN_CLOUD discarded -> in_cloud 1 under private", () => {
    const { ledger } = boot();
    ledger.record(ev({ source: "IN_CLOUD", outcome: "discarded" }));
    const d = ledger.day();
    expect(d.dayKey).toBe(DAY0);
    expect(countsOf(d, "p1", "private")).toEqual(zero({ in_cloud: 1 }));
  });
  test("discarded with ON_DEVICE counts on_device", () => {
    const { ledger } = boot();
    ledger.record(ev({ source: "ON_DEVICE", outcome: "discarded" }));
    expect(countsOf(ledger.day(), "p1", "private").on_device).toBe(1);
  });
});

describe("B6 counting rules", () => {
  test("on_device and in_cloud follow the source; schema_reject adds schema_rejects on top of the source", () => {
    const { ledger } = boot();
    ledger.record(ev({ tier: "standard", mode: "PREFER_ON_DEVICE", source: "ON_DEVICE", outcome: "schema_reject" }));
    expect(countsOf(ledger.day(), "p1", "standard")).toEqual(zero({ on_device: 1, schema_rejects: 1 }));
  });
  test("refused (called false, source null) counts refusals only", () => {
    const { ledger } = boot();
    ledger.record(ev({ called: false, source: null, outcome: "refused", task: "screenshot" }));
    expect(countsOf(ledger.day(), "p1", "private")).toEqual(zero({ refusals: 1 }));
  });
  test("counts are keyed by the tier at event time", () => {
    const { ledger } = boot();
    ledger.record(ev({ tier: "standard", mode: "PREFER_IN_CLOUD", source: "IN_CLOUD" }));
    ledger.record(ev({ tier: "private" }));
    const d = ledger.day();
    expect(countsOf(d, "p1", "standard").in_cloud).toBe(1);
    expect(countsOf(d, "p1", "private").in_cloud).toBe(0);
    expect(countsOf(d, "p1", "private").on_device).toBe(1);
  });
  test("projects are separate", () => {
    const { ledger } = boot();
    ledger.record(ev({ projectId: "a" })); ledger.record(ev({ projectId: "b" })); ledger.record(ev({ projectId: "b" }));
    expect(countsOf(ledger.day(), "a", "private").on_device).toBe(1);
    expect(countsOf(ledger.day(), "b", "private").on_device).toBe(2);
  });
  test("day() of an unseen day is empty and keeps its key; day() is a snapshot (mutation does not leak back)", () => {
    const { ledger } = boot();
    expect(ledger.day("2030-01-01")).toEqual({ dayKey: "2030-01-01", byProject: {} });
    ledger.record(ev());
    const d = ledger.day() as unknown as { byProject: Record<string, Record<string, Record<string, number>>> };
    try { d.byProject["p1"]!["private"]!["on_device"] = 999; } catch { /* frozen is fine */ }
    delete (d.byProject as Record<string, unknown>)["p1"];
    expect(countsOf(ledger.day(), "p1", "private").on_device).toBe(1);
  });
  test("counters only increase across a mixed stream", () => {
    const { ledger } = boot();
    let prev = zero();
    const stream = [ev(), ev({ source: "IN_CLOUD", mode: "PREFER_ON_DEVICE" }), ev({ called: false, source: null, outcome: "refused" }), ev({ source: null, mode: "PREFER_ON_DEVICE", outcome: "error" }), ev({ outcome: "schema_reject" })];
    for (const e of stream) {
      ledger.record(e);
      const cur = countsOf(ledger.day(), "p1", "private");
      for (const c of COUNTERS) expect(cur[c], c).toBeGreaterThanOrEqual(prev[c]);
      prev = cur;
    }
  });
});

describe("O6 / O7 / B8 attribution", () => {
  test("O6: 5 ON_DEVICE ok -> on_device 5; then called+source null+ONLY_ON_DEVICE+ok -> unattributed 1", () => {
    const { ledger } = boot();
    for (let i = 0; i < 5; i++) ledger.record(ev());
    expect(countsOf(ledger.day(), "p1", "private")).toEqual(zero({ on_device: 5 }));
    ledger.record(ev({ source: null, outcome: "ok" }));
    expect(countsOf(ledger.day(), "p1", "private")).toEqual(zero({ on_device: 5, unattributed: 1 }));
  });
  test("O7: ONLY_ON_DEVICE + called + source null + error is NOT unattributed", () => {
    const { ledger } = boot();
    ledger.record(ev({ source: null, outcome: "error" }));
    expect(countsOf(ledger.day(), "p1", "private").unattributed).toBe(0);
  });
  test("O7 neg: the same event under PREFER_ON_DEVICE (cloud fallback possible) is unattributed", () => {
    const { ledger } = boot();
    ledger.record(ev({ tier: "standard", mode: "PREFER_ON_DEVICE", source: null, outcome: "error" }));
    expect(countsOf(ledger.day(), "p1", "standard").unattributed).toBe(1);
  });
  test("not called -> never unattributed", () => {
    const { ledger } = boot();
    ledger.record(ev({ called: false, source: null, outcome: "error" }));
    expect(countsOf(ledger.day(), "p1", "private").unattributed).toBe(0);
  });
});

describe("O8 fallback_rule (B7)", () => {
  test("PREFER_ON_DEVICE+IN_CLOUD and PREFER_IN_CLOUD+ON_DEVICE are fallbacks; ONLY_IN_CLOUD+IN_CLOUD is only in_cloud", () => {
    const { ledger } = boot();
    ledger.record(ev({ tier: "standard", mode: "PREFER_ON_DEVICE", source: "IN_CLOUD" }));
    ledger.record(ev({ tier: "standard", mode: "PREFER_IN_CLOUD", source: "ON_DEVICE" }));
    expect(countsOf(ledger.day(), "p1", "standard")).toEqual(zero({ in_cloud: 1, on_device: 1, fallbacks: 2 }));
    ledger.record(ev({ tier: "standard", mode: "ONLY_IN_CLOUD", source: "IN_CLOUD" }));
    expect(countsOf(ledger.day(), "p1", "standard")).toEqual(zero({ in_cloud: 2, on_device: 1, fallbacks: 2 }));
  });
  test("no fallback for matching preferences or for pinned modes", () => {
    const { ledger } = boot();
    ledger.record(ev({ tier: "standard", mode: "PREFER_ON_DEVICE", source: "ON_DEVICE" }));
    ledger.record(ev({ tier: "standard", mode: "PREFER_IN_CLOUD", source: "IN_CLOUD" }));
    ledger.record(ev({ tier: "standard", mode: "ONLY_ON_DEVICE", source: "IN_CLOUD" }));   // violation: counted as cloud, not a fallback
    ledger.record(ev({ tier: "standard", mode: "ONLY_IN_CLOUD", source: "ON_DEVICE" }));
    const c = countsOf(ledger.day(), "p1", "standard");
    expect(c.fallbacks).toBe(0);
    expect(c.in_cloud).toBe(2);
    expect(c.on_device).toBe(2);
  });
});

describe("O9 day_rollover (B6, UTC)", () => {
  test("23:59:59.999Z and 00:00:00.000Z of the next day land on two dayKeys with one count each", () => {
    const { ledger, clock } = boot();
    clock.ms = Date.parse("2026-03-01T23:59:59.999Z"); ledger.record(ev());
    clock.ms = Date.parse("2026-03-02T00:00:00.000Z"); ledger.record(ev());
    expect(countsOf(ledger.day("2026-03-01"), "p1", "private").on_device).toBe(1);
    expect(countsOf(ledger.day("2026-03-02"), "p1", "private").on_device).toBe(1);
    expect(ledger.day().dayKey).toBe("2026-03-02");
  });
  test("a non-UTC-midnight instant (late evening UTC-8) still uses the UTC day", () => {
    const { ledger, clock } = boot();
    clock.ms = Date.parse("2026-03-01T04:30:00.000Z");   // still Feb 28 evening in UTC-8
    ledger.record(ev());
    expect(countsOf(ledger.day("2026-03-01"), "p1", "private").on_device).toBe(1);
  });
});

describe("O12 invalid_event_controls (B9)", () => {
  test("refused with called true, empty projectId, IN_CLOUD with called false: no throw, counters unchanged, invalidEvents 3", () => {
    const { ledger } = boot();
    expect(() => {
      ledger.record(ev({ outcome: "refused", called: true, source: null }));
      ledger.record(ev({ projectId: "" }));
      ledger.record(ev({ called: false, source: "IN_CLOUD" }));
    }).not.toThrow();
    expect(ledger.invalidEvents()).toBe(3);
    expect(Object.keys(ledger.day().byProject).length === 0 || Object.values(ledger.day().byProject).every((r) => Object.values(r).every((c) => COUNTERS.every((k) => c[k] === 0)))).toBe(true);
  });
  test("unknown tier / mode / outcome, refused with a source, and non-objects are dropped and counted", () => {
    const { ledger } = boot();
    const bad: unknown[] = [ev({ tier: "gold" as never }), ev({ mode: "CLOUD" as never }), ev({ outcome: "weird" as never }), ev({ outcome: "refused", called: false, source: "ON_DEVICE" }), null, undefined, "x", 7, [], ev({ source: "SOMEWHERE" as never })];
    for (const b of bad) expect(() => ledger.record(b as never)).not.toThrow();
    expect(ledger.invalidEvents()).toBe(bad.length);
    expect(ledger.day().byProject).toEqual({});
  });
  test("a valid event after invalid ones still counts (pos control)", () => {
    const { ledger } = boot();
    ledger.record(ev({ projectId: "" })); ledger.record(ev());
    expect(countsOf(ledger.day(), "p1", "private").on_device).toBe(1);
    expect(ledger.invalidEvents()).toBe(1);
  });
  test("a throwing or non-finite clock never makes record throw", () => {
    const bad = { nowMs: () => NaN };
    const l = createLedger({ clock: bad, local: makeLocal().store });
    expect(() => l.record(ev())).not.toThrow();
    const thr = createLedger({ clock: { nowMs: () => { throw new Error("clock"); } }, local: makeLocal().store });
    expect(() => thr.record(ev())).not.toThrow();
  });
});

describe("B12 persistence and retention", () => {
  test("local.save runs after every valid record with the full state", () => {
    const { ledger, local } = boot();
    ledger.record(ev()); ledger.record(ev());
    expect(local.s.saves.length).toBeGreaterThanOrEqual(2);
    const last = local.last()!;
    expect(last.find((d) => d.dayKey === DAY0)!.byProject["p1"]!["private"]!.on_device).toBe(2);
  });
  test("state is restored from local.load at creation", () => {
    const seed = [{ dayKey: DAY0, byProject: { p1: { private: zero({ on_device: 4 }), standard: zero(), shared: zero() } } }];
    const { ledger } = boot({ initial: seed });
    expect(countsOf(ledger.day(), "p1", "private").on_device).toBe(4);
    ledger.record(ev());
    expect(countsOf(ledger.day(), "p1", "private").on_device).toBe(5);
  });
  test("retention: with retentionDays 3 only the last 3 days survive a rollover; default keeps 14", () => {
    const { ledger, clock, local } = boot({ retentionDays: 3 });
    for (let i = 0; i < 5; i++) { clock.ms = T0 + i * 86400000; ledger.record(ev()); }
    const kept = local.last()!.map((d) => d.dayKey).sort();
    expect(kept).toEqual(["2026-03-03", "2026-03-04", "2026-03-05"]);
    expect(ledger.day("2026-03-01").byProject).toEqual({});
    const d14 = boot();
    for (let i = 0; i < 20; i++) { d14.clock.ms = T0 + i * 86400000; d14.ledger.record(ev()); }
    expect(d14.local.last()!).toHaveLength(14);
  });
  test("a failing local.save or local.load never throws into the caller", () => {
    const a = boot(); a.local.s.saveThrows = true;
    expect(() => a.ledger.record(ev())).not.toThrow();
    expect(countsOf(a.ledger.day(), "p1", "private").on_device).toBe(1);   // memory stays authoritative for the session
    const b = makeLocal(); b.s.loadThrows = true;
    let l: Ledger | undefined;
    expect(() => { l = createLedger({ clock: makeClock(), local: b.store }); }).not.toThrow();
    expect(() => l!.record(ev())).not.toThrow();
    const c = makeLocal(); c.s.loadReturns = "garbage";
    expect(() => createLedger({ clock: makeClock(), local: c.store }).record(ev())).not.toThrow();
  });
});

describe("O10 flush_deltas_once (B13)", () => {
  test("record 3 -> delta 3; flush again -> no call; reject keeps 1 pending; later ok sends 2; remote total 5", async () => {
    const { ledger, rem } = boot();
    for (let i = 0; i < 3; i++) ledger.record(ev());
    const f1 = await ledger.flush();
    expect(f1.written).toBe(true); expect(f1.pendingKeys).toBe(0);
    expect(rem.r.calls).toHaveLength(1);
    expect(rem.r.calls[0]!.dayKey).toBe(DAY0);
    const f2 = await ledger.flush();
    expect(rem.r.calls).toHaveLength(1);
    expect(f2.written).toBe(false); expect(f2.pendingKeys).toBe(0);
    ledger.record(ev()); rem.r.rejectNext = 1;
    const f3 = await ledger.flush();
    expect(rem.r.calls).toHaveLength(2);
    expect(f3.written).toBe(false); expect(f3.pendingKeys).toBeGreaterThan(0);
    ledger.record(ev());
    const f4 = await ledger.flush();
    expect(rem.r.calls).toHaveLength(3);
    expect(f4.written).toBe(true); expect(f4.pendingKeys).toBe(0);
    const sent = (i: number) => flattenDeltas(rem.r.calls[i]!.deltas).reduce((a, x) => a + x.n, 0);
    expect([sent(0), sent(1), sent(2)]).toEqual([3, 1, 2]);
    expect(sumDeltas(rem.r.calls)[`${DAY0}|p1|private|on_device`]).toBe(5);
    expect(await ledger.flush()).toMatchObject({ written: false, pendingKeys: 0 });
    expect(rem.r.calls).toHaveLength(3);
  });
  test("deltas are numeric counts keyed by project and tier with the right counter", async () => {
    const { ledger, rem } = boot();
    ledger.record(ev({ projectId: "a", tier: "standard", mode: "PREFER_ON_DEVICE", source: "IN_CLOUD" }));
    await ledger.flush();
    const f = flattenDeltas(rem.r.calls[0]!.deltas).filter((x) => x.n > 0);
    expect(f.map((x) => `${x.project}|${x.tier}|${x.counter}|${x.n}`).sort()).toEqual(["a|standard|fallbacks|1", "a|standard|in_cloud|1"]);
  });
  test("a thrown (not rejected) applyDeltas keeps the deltas pending and flush still resolves", async () => {
    const { ledger, rem } = boot();
    ledger.record(ev()); rem.r.mode = "throw";
    const f = await ledger.flush();
    expect(f.written).toBe(false); expect(f.pendingKeys).toBeGreaterThan(0);
    rem.r.mode = "ok";
    expect((await ledger.flush()).written).toBe(true);
    expect(sumDeltas(rem.r.calls)[`${DAY0}|p1|private|on_device`]).toBe(1);
  });
  test("no remote -> flush resolves written false and local counting is unaffected", async () => {
    const { ledger } = boot({ remote: false });
    ledger.record(ev());
    expect((await ledger.flush()).written).toBe(false);
    expect(countsOf(ledger.day(), "p1", "private").on_device).toBe(1);
  });
  test("each delta is acknowledged exactly once under overlapping flushes", async () => {
    const { ledger, rem } = boot();
    rem.r.mode = "manual";
    for (let i = 0; i < 3; i++) ledger.record(ev());
    const a = ledger.flush(); const b = ledger.flush();
    await flush();
    ledger.record(ev());                       // arrives while the first flush is in flight
    rem.r.pending.forEach((p) => p.resolve());
    await Promise.all([a, b]); await flush();
    rem.r.mode = "ok";
    await ledger.flush();
    const total = sumDeltas(rem.r.calls);
    expect(total[`${DAY0}|p1|private|on_device`]).toBe(4);
  });
  test("deltas for different days go out as separate applyDeltas calls", async () => {
    const { ledger, rem, clock } = boot();
    ledger.record(ev());
    clock.ms = T0 + 86400000; ledger.record(ev());
    await ledger.flush();
    expect(rem.r.calls.map((c) => c.dayKey).sort()).toEqual(["2026-03-01", "2026-03-02"]);
    const t = sumDeltas(rem.r.calls);
    expect(t["2026-03-01|p1|private|on_device"]).toBe(1);
    expect(t["2026-03-02|p1|private|on_device"]).toBe(1);
  });
});

describe("O11 remote_doc_no_text (B14)", () => {
  test("payloads hold integers only, tier keys within the three tiers, counter keys within the six", async () => {
    const { ledger, rem } = boot();
    const mixed = [ev(), ev({ tier: "standard", mode: "PREFER_ON_DEVICE", source: "IN_CLOUD" }), ev({ tier: "shared", outcome: "schema_reject" }), ev({ called: false, source: null, outcome: "refused" }), ev({ source: null, mode: "PREFER_ON_DEVICE" })];
    for (const m of mixed) ledger.record({ ...m, prompt: "SECRET-PROMPT", output: "SECRET-OUT", headline: "SECRET-HL" } as never);
    await ledger.flush();
    expect(rem.r.calls.length).toBeGreaterThan(0);
    const json = JSON.stringify(rem.r.calls);
    expect(json).not.toMatch(/SECRET/);
    for (const c of rem.r.calls) {
      expect(c.dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const flat = flattenDeltas(c.deltas);
      expect(flat.length).toBeGreaterThan(0);
      for (const f of flat) {
        expect(f.leafOk, JSON.stringify(f)).toBe(true);
        expect(["private", "standard", "shared"]).toContain(f.tier);
        expect(COUNTERS as readonly string[]).toContain(f.counter);
        expect(f.n).toBeGreaterThanOrEqual(0);
      }
    }
  });
  test("an unknown task text cannot leak either: only projectId strings appear as non-numeric data", async () => {
    const { ledger, rem } = boot();
    ledger.record(ev({ projectId: "proj-1" }));
    await ledger.flush();
    const words = JSON.stringify(rem.r.calls[0]!.deltas).match(/"[^"]+"/g)!.map((s) => s.slice(1, -1));
    for (const w of words) expect(w === "proj-1" || /^(private|standard|shared)$/.test(w) || (COUNTERS as readonly string[]).includes(w) || /^(private|standard|shared)[./:|#](on_device|in_cloud|fallbacks|refusals|schema_rejects|unattributed)$/.test(w)).toBe(true);
  });
});
