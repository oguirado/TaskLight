import { describe, expect, it } from 'vitest';
import { createLedger, type FrameRecord } from '../../../src/perf';
import { make, frames } from './helpers';

// Repair loop 1 regression tests (Hydrogen HOLD items; see ORACLE.md "Repair loop 1").
const rec = (jsUs: number): FrameRecord => ({ startUs: 0, jsUs, applied: 0, deferred: 0, tier: 'T0' });

describe('U12 repair1 B14 unpaired endFrame', () => {
  it('endFrame without a preceding beginFrame records 0', () => {
    const { gov, clock } = make();
    gov.beginFrame(); clock.t += 1000; gov.endFrame(0, 0);
    clock.t = 50_000;
    gov.endFrame(0, 0); // unpaired
    const s = gov.ledger.stats();
    expect(s.count).toBe(2);
    expect(s.maxUs).toBe(1000);
  });
  it('endFrame before any beginFrame records 0 and does not throw', () => {
    const { gov, clock } = make();
    clock.t = 99_999;
    expect(() => gov.endFrame(0, 0)).not.toThrow();
    expect(gov.ledger.stats().maxUs).toBe(0);
  });
});

describe('U12 repair1 ledger capacity robustness', () => {
  it.each([NaN, Infinity, -Infinity, -5])('capacity %s: record/stats never throw and stats are finite', (c) => {
    const l = createLedger(c as number);
    expect(() => { l.record(rec(1000)); l.record(rec(2000)); }).not.toThrow();
    const s = l.stats();
    for (const v of Object.values(s)) expect(Number.isFinite(v)).toBe(true);
    expect(Number.isFinite(l.capacity)).toBe(true);
  });
  it('NaN capacity does not corrupt a later valid-looking read', () => {
    const l = createLedger(NaN);
    l.record(rec(5000));
    expect(Number.isNaN(l.stats().p95Us)).toBe(false);
  });
});

describe('U12 repair1 B13 overBudget uses frameJsBudgetMs', () => {
  it('budget 2 ms: 3000 us frames are overBudget', () => {
    const { gov, clock } = make({ frameJsBudgetMs: 2 });
    frames(gov, clock, 5, 3000);
    expect(gov.ledger.stats().overBudget).toBe(5);
  });
  it('budget 8 ms: 5000 us frames are not overBudget', () => {
    const { gov, clock } = make({ frameJsBudgetMs: 8 });
    frames(gov, clock, 5, 5000);
    expect(gov.ledger.stats().overBudget).toBe(0);
  });
});
