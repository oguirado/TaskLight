import { describe, expect, it } from 'vitest';
import type { Tier } from '../../../src/perf';
import { FakeClock, make, frames } from './helpers';

// Tests that need a clean "one window == one evaluation" view use windowFrames=evalEveryFrames=60
// so successive evaluations see non-overlapping samples (B16 allows this via config).
const W60 = { windowFrames: 60, evalEveryFrames: 60 } as const;

describe('U12 B14/B15 measurement and tier table', () => {
  it('endFrame records jsUs = now - start into the ledger', () => {
    const { gov, clock } = make();
    frames(gov, clock, 10, 3000);
    const s = gov.ledger.stats();
    expect(s.count).toBe(10);
    expect(s.p95Us).toBe(3000);
    expect(s.maxUs).toBe(3000);
  });

  it.each([
    ['T0', 8, 'full', true], ['T1', 4, 'no_blur_shadow', true],
    ['T2', 2, 'no_transitions', false], ['T3', 1, 'none', false],
  ] as const)('tier %s policy', (t, max, effects, interp) => {
    const { gov } = make();
    gov.setOverride(t);
    expect(gov.tier()).toBe(t);
    expect(gov.policy()).toEqual({ tier: t, maxPatches: max, interpolate: interp, effects });
    expect(gov.maxPatchesThisFrame()).toBe(max);
    expect(gov.effectsEnabled()).toBe(t === 'T0');
  });

  it('maxPatches = max_patches_per_frame >> tierIndex, floored at 1', () => {
    const { gov } = make({ maxPatchesPerFrame: 2 });
    const seen: number[] = [];
    for (const t of ['T0', 'T1', 'T2', 'T3'] as Tier[]) { gov.setOverride(t); seen.push(gov.maxPatchesThisFrame()); }
    expect(seen).toEqual([2, 1, 1, 1]);
  });

  it('frameJsBudgetMs returns configured budget', () => {
    const { gov } = make({ frameJsBudgetMs: 3 });
    expect(gov.frameJsBudgetMs()).toBe(3);
  });

  it('starts at T0 with 0 transitions', () => {
    const { gov } = make();
    expect(gov.tier()).toBe('T0');
    expect(gov.transitions()).toBe(0);
  });

  it('clock going backwards: records 0, never throws', () => {
    const { gov, clock } = make();
    clock.t = 10000;
    gov.beginFrame();
    clock.t = 5000;
    expect(() => gov.endFrame(0, 0)).not.toThrow();
    const s = gov.ledger.stats();
    expect(s.count).toBe(1);
    expect(s.maxUs).toBe(0);
  });
});

describe('U12 O11 degrade_on_sustained_load', () => {
  it('(a) 120 frames at 5000us -> T1, 4 patches, effects off', () => {
    const { gov, clock } = make();
    frames(gov, clock, 60, 5000);
    expect(gov.tier()).toBe('T0');                 // one evaluation is not enough (degradeEvals=2)
    frames(gov, clock, 59, 5000);
    expect(gov.tier()).toBe('T0');
    frames(gov, clock, 1, 5000);
    expect(gov.tier()).toBe('T1');
    expect(gov.maxPatchesThisFrame()).toBe(4);
    expect(gov.effectsEnabled()).toBe(false);
    expect(gov.transitions()).toBe(1);
  });
  it('(a2) sustained load keeps stepping one tier at a time and clamps at T3', () => {
    const { gov, clock } = make();
    const seen = new Set<Tier>();
    for (let i = 0; i < 20; i++) { frames(gov, clock, 60, 5000); seen.add(gov.tier()); }
    expect(gov.tier()).toBe('T3');
    expect(gov.maxPatchesThisFrame()).toBe(1);
    expect(gov.transitions()).toBe(3);
    expect(seen.has('T1') && seen.has('T2')).toBe(true);
  });
  it('(b) negative control: 120 frames at 3900us stays T0, 0 transitions (and ledger measured them)', () => {
    const { gov, clock } = make();
    frames(gov, clock, 120, 3900);
    expect(gov.tier()).toBe('T0');
    expect(gov.transitions()).toBe(0);
    expect(gov.ledger.stats().count).toBe(120);
    expect(gov.ledger.stats().p95Us).toBe(3900);
  });
  it('fewer than evalEveryFrames frames: no evaluation', () => {
    const { gov, clock } = make();
    frames(gov, clock, 59, 5000);
    expect(gov.tier()).toBe('T0');
    expect(gov.ledger.stats().count).toBe(59);
  });
  it('p95 exactly at budget (4000) is not over budget', () => {
    const { gov, clock } = make();
    frames(gov, clock, 240, 4000);
    expect(gov.tier()).toBe('T0');
    expect(gov.ledger.stats().p95Us).toBe(4000);
  });
});

describe('U12 O12 hysteresis_no_oscillation', () => {
  it('windows alternating p95 4400/3600 after a drop: no further transitions, never back to T0', () => {
    const { gov, clock } = make(W60);
    frames(gov, clock, 120, 4400);                   // 2 evals over budget -> T1
    expect(gov.tier()).toBe('T1');
    expect(gov.transitions()).toBe(1);
    for (let i = 0; i < 20; i++) {                   // 1200 frames
      frames(gov, clock, 60, i % 2 === 0 ? 3600 : 4400);
      expect(gov.tier()).toBe('T1');
      expect(gov.transitions()).toBe(1);
    }
    expect(gov.ledger.stats(60).count).toBe(60);
  });
  it('alternating from T0: over-budget evals never consecutive -> no transition at all', () => {
    const { gov, clock } = make(W60);
    for (let i = 0; i < 20; i++) frames(gov, clock, 60, i % 2 === 0 ? 4400 : 3600);
    expect(gov.tier()).toBe('T0');
    expect(gov.transitions()).toBe(0);
    expect(gov.ledger.stats(60).count).toBe(60);
  });
  it('band [2ms,4ms] resets the upgrade streak', () => {
    const { gov, clock } = make(W60);
    frames(gov, clock, 120, 5000);
    expect(gov.tier()).toBe('T1');
    frames(gov, clock, 180, 1000);                   // 3 qualifying evals
    frames(gov, clock, 60, 3000);                    // band -> streak reset
    frames(gov, clock, 180, 1000);                   // 3 more: still not enough
    expect(gov.tier()).toBe('T1');
    frames(gov, clock, 60, 1000);                    // 4th consecutive
    expect(gov.tier()).toBe('T0');
  });
});

describe('U12 O13 upgrade_requires_streak', () => {
  it('from T1: T1 at 3rd qualifying eval, T0 exactly at 4th', () => {
    const { gov, clock } = make(W60);
    frames(gov, clock, 120, 5000);
    expect(gov.tier()).toBe('T1');
    frames(gov, clock, 60, 1000); expect(gov.tier()).toBe('T1');
    frames(gov, clock, 60, 1000); expect(gov.tier()).toBe('T1');
    frames(gov, clock, 60, 1000); expect(gov.tier()).toBe('T1');
    frames(gov, clock, 60, 1000); expect(gov.tier()).toBe('T0');
    expect(gov.transitions()).toBe(2);
    expect(gov.maxPatchesThisFrame()).toBe(8);
  });
  it('p95 exactly 2000 (== upgradeRatio*budget) does not qualify', () => {
    const { gov, clock } = make(W60);
    frames(gov, clock, 120, 5000);
    frames(gov, clock, 600, 2000);
    expect(gov.tier()).toBe('T1');
  });
  it('upgrade rises one step only', () => {
    const { gov, clock } = make(W60);
    for (let i = 0; i < 6; i++) frames(gov, clock, 60, 5000); // T0->T1->T2->T3
    expect(gov.tier()).toBe('T3');
    frames(gov, clock, 240, 1000);
    expect(gov.tier()).toBe('T2');
  });
});

describe('U12 O14 ceiling_spike_drop', () => {
  it('(a) 2 frames > 11.1ms inside 1ms load: immediate T0->T1, before next eval', () => {
    const { gov, clock } = make();
    frames(gov, clock, 10, 1000);
    frames(gov, clock, 1, 12000);
    expect(gov.tier()).toBe('T0');
    frames(gov, clock, 1, 12000);
    expect(gov.tier()).toBe('T1');
    expect(gov.transitions()).toBe(1);
    expect(gov.ledger.stats().overCeiling).toBe(2);
  });
  it('(b) negative control: 1 spike frame stays T0 (and is counted)', () => {
    const { gov, clock } = make();
    frames(gov, clock, 10, 1000);
    frames(gov, clock, 1, 12000);
    frames(gov, clock, 10, 1000);
    expect(gov.tier()).toBe('T0');
    expect(gov.transitions()).toBe(0);
    expect(gov.ledger.stats().overCeiling).toBe(1);
  });
  it('frames of exactly 11100us do not count as ceiling hits', () => {
    const { gov, clock } = make();
    frames(gov, clock, 2, 11100);
    expect(gov.ledger.stats().count).toBe(2);
    expect(gov.ledger.stats().overCeiling).toBe(0);
    expect(gov.tier()).toBe('T0');
  });
  it('ceiling counter resets after a drop: next single spike does not drop, second does', () => {
    const { gov, clock } = make();
    frames(gov, clock, 2, 12000);
    expect(gov.tier()).toBe('T1');
    frames(gov, clock, 5, 1000);
    frames(gov, clock, 1, 12000);
    expect(gov.tier()).toBe('T1');
    frames(gov, clock, 1, 12000);
    expect(gov.tier()).toBe('T2');
  });
});

describe('U12 O15 override_pins_tier', () => {
  it('pins T3 through 240 frames at 500us; after null a full upgrade streak is needed', () => {
    const { gov, clock } = make(W60);
    gov.setOverride('T3');
    for (let i = 0; i < 4; i++) {
      frames(gov, clock, 60, 500);
      expect(gov.tier()).toBe('T3');
      expect(gov.maxPatchesThisFrame()).toBe(1);
    }
    gov.setOverride(null);
    expect(gov.tier()).toBe('T3');                  // resumes from the pinned tier
    frames(gov, clock, 60, 500); expect(gov.tier()).toBe('T3');
    frames(gov, clock, 60, 500); expect(gov.tier()).toBe('T3');
    frames(gov, clock, 60, 500); expect(gov.tier()).toBe('T3');
    frames(gov, clock, 60, 500); expect(gov.tier()).toBe('T2');
  });
  it('override suspends degrade: pinned T0 under heavy load stays T0', () => {
    const { gov, clock } = make();
    gov.setOverride('T0');
    frames(gov, clock, 600, 9000);
    expect(gov.ledger.stats().p95Us).toBe(9000);
    expect(gov.tier()).toBe('T0');
    expect(gov.transitions()).toBe(0);
  });
  it('override suspends ceiling spikes', () => {
    const { gov, clock } = make();
    gov.setOverride('T0');
    frames(gov, clock, 5, 12000);
    expect(gov.tier()).toBe('T0');
    expect(gov.ledger.stats().overCeiling).toBe(5);
  });
  it('initial cfg.override pins the starting tier', () => {
    const { gov } = make({ override: 'T2' });
    expect(gov.tier()).toBe('T2');
    expect(gov.maxPatchesThisFrame()).toBe(2);
  });
  it('invalid override value is ignored; previous state kept', () => {
    const { gov } = make();
    gov.setOverride('T2');
    gov.setOverride('T9' as unknown as Tier);
    expect(gov.tier()).toBe('T2');
  });
});

describe('U12 FrameCaps structural contract with U11', () => {
  it('has the five FrameCaps members', () => {
    const { gov } = make();
    for (const k of ['maxPatchesThisFrame', 'frameJsBudgetMs', 'effectsEnabled', 'beginFrame', 'endFrame'] as const) {
      expect(typeof gov[k]).toBe('function');
    }
    gov.beginFrame(); gov.endFrame(0, 0);
    expect(gov.ledger.stats().count).toBe(1);
    expect(new FakeClock().nowUs()).toBe(0);
  });
});
