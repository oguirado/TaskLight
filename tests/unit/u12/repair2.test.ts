import { describe, expect, it } from 'vitest';
import { createLedger, type FrameRecord } from '../../../src/perf';
import { make, frames } from './helpers';

// Repair loop 2 regression tests (Hydrogen r1 HOLD items; see ORACLE.md "Repair loop 2").
const rec = (jsUs: number): FrameRecord => ({ startUs: 0, jsUs, applied: 0, deferred: 0, tier: 'T0' });

describe('U12 repair2 B13 overCeiling follows GovernorConfig.ceilingMs', () => {
  it('ceilingMs 5: frames of 6000 us count as overCeiling through gov.ledger', () => {
    const { gov, clock } = make({ ceilingMs: 5, ceilingHitsToDrop: 99 });
    frames(gov, clock, 10, 6000);
    expect(gov.ledger.stats().overCeiling).toBe(10);
  });
  it('ceilingMs 5: frames of 4500 us are not over ceiling (negative control)', () => {
    const { gov, clock } = make({ ceilingMs: 5, ceilingHitsToDrop: 99 });
    frames(gov, clock, 10, 4500);
    expect(gov.ledger.stats().overCeiling).toBe(0);
  });
  it('default 11.1 ms still counts 12000 but not 11000', () => {
    const { gov, clock } = make();
    frames(gov, clock, 3, 12000); frames(gov, clock, 3, 11000);
    expect(gov.ledger.stats().overCeiling).toBe(3);
  });
});

describe('U12 repair2 B13 maxUs initialisation', () => {
  it('single negative jsUs record yields maxUs equal to that value, not 0', () => {
    const l = createLedger(8);
    l.record(rec(-10));
    expect(l.stats().maxUs).toBe(-10);
  });
  it('all-negative window max is the largest value', () => {
    const l = createLedger(8);
    [-30, -10, -20].forEach((v) => l.record(rec(v)));
    expect(l.stats().maxUs).toBe(-10);
  });
});

describe('U12 repair2 B16 evaluation cadence independent of window size', () => {
  it('windowFrames < evalEveryFrames still evaluates every evalEveryFrames frames', () => {
    const { gov, clock } = make({ windowFrames: 30, evalEveryFrames: 60 });
    frames(gov, clock, 120, 5000); // two evaluations, p95 5000 > 4000 budget each
    expect(gov.tier()).toBe('T1');
  });
  it('negative control: same config with 3900 us frames stays T0', () => {
    const { gov, clock } = make({ windowFrames: 30, evalEveryFrames: 60 });
    frames(gov, clock, 120, 3900);
    expect(gov.tier()).toBe('T0');
  });
});
