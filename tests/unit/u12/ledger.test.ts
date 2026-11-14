import { describe, expect, it } from 'vitest';
import { createLedger, type FrameRecord } from '../../../src/perf';

const rec = (jsUs: number): FrameRecord => ({ startUs: 0, jsUs, applied: 0, deferred: 0, tier: 'T0' });
const fill = (l: ReturnType<typeof createLedger>, vals: number[]) => vals.forEach((v) => l.record(rec(v)));

describe('U12 ledger (B12/B13)', () => {
  it('exposes capacity', () => { expect(createLedger(256).capacity).toBe(256); });

  it('empty ledger: zeros', () => {
    const l = createLedger(256);
    expect(l.stats()).toEqual({ count: 0, p50Us: 0, p95Us: 0, maxUs: 0, overBudget: 0, overCeiling: 0 });
  });

  it('O10 p95_nearest_rank: 1000..100000 step 1000', () => {
    const l = createLedger(256);
    fill(l, Array.from({ length: 100 }, (_, i) => (i + 1) * 1000));
    const s = l.stats(100);
    expect(s.count).toBe(100);
    expect(s.p50Us).toBe(50000);
    expect(s.p95Us).toBe(95000);
    expect(s.maxUs).toBe(100000);
    expect(s.overCeiling).toBe(89); // 12000..100000 strictly > 11100
  });

  it('input order does not matter (unsorted fixture)', () => {
    const l = createLedger(256);
    const v = Array.from({ length: 100 }, (_, i) => (i + 1) * 1000);
    fill(l, [...v].reverse());
    const s = l.stats(100);
    expect([s.p50Us, s.p95Us, s.maxUs]).toEqual([50000, 95000, 100000]);
  });

  it('overBudget counts jsUs > 4000 (AMBIGUITY: ledger has no budget param; 4 ms default assumed)', () => {
    const l = createLedger(256);
    fill(l, Array.from({ length: 100 }, (_, i) => (i + 1) * 1000));
    expect(l.stats(100).overBudget).toBe(96); // 5000..100000
  });

  it('boundaries are strict: exactly 11100 is not over ceiling; 11101 is', () => {
    const l = createLedger(8);
    fill(l, [11100, 11100, 11101]);
    expect(l.stats().overCeiling).toBe(1);
  });

  it('nearest-rank on n=20 (rank 19 for p95, 10 for p50)', () => {
    const l = createLedger(256);
    fill(l, Array.from({ length: 20 }, (_, i) => (i + 1) * 1000));
    const s = l.stats(20);
    expect(s.p95Us).toBe(19000);
    expect(s.p50Us).toBe(10000);
  });

  it('single sample', () => {
    const l = createLedger(8);
    fill(l, [4242]);
    const s = l.stats();
    expect([s.count, s.p50Us, s.p95Us, s.maxUs]).toEqual([1, 4242, 4242, 4242]);
  });

  it('lastN selects the newest samples; ring overwrites oldest beyond capacity', () => {
    const l = createLedger(256);
    fill(l, Array.from({ length: 300 }, (_, i) => (i + 1) * 10)); // 10..3000
    expect(l.stats().count).toBe(120);                 // default lastN = windowFrames 120 [TARGET-spec]
    expect(l.stats(10).count).toBe(10);
    expect(l.stats(10).maxUs).toBe(3000);
    expect(l.stats(10).p50Us).toBe(2950);              // newest 10: 2910..3000, rank 5
  });

  it('lastN beyond capacity clamps to capacity; oldest entries are gone', () => {
    const l = createLedger(4);
    fill(l, [100, 200, 300, 400, 500, 600]);
    const s = l.stats(1000);
    expect(s.count).toBe(4);
    expect(s.maxUs).toBe(600);
    expect(s.p50Us).toBe(400); // window 300,400,500,600 -> rank 2 -> 400
  });

  it('record keeps integer microseconds', () => {
    const l = createLedger(8);
    fill(l, [1000, 2000, 3000]);
    expect(Number.isInteger(l.stats().p95Us)).toBe(true);
    expect(l.stats().p95Us).toBe(3000);
  });
});
