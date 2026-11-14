import { createLedger } from './ledger';
import type { Clock, FrameGovernor, GovernorConfig, Tier, TierPolicy } from './types';

const TIERS: readonly Tier[] = ['T0', 'T1', 'T2', 'T3'];
const EFFECTS: readonly TierPolicy['effects'][] = ['full', 'no_blur_shadow', 'no_transitions', 'none'];
const INTERPOLATE: readonly boolean[] = [true, true, false, false];

function tierIndex(t: Tier): number {
  return TIERS.indexOf(t);
}

export function createGovernor(cfg: GovernorConfig, clock: Clock): FrameGovernor {
  const budgetUs = Math.round(cfg.frameJsBudgetMs * 1000);
  const ceilingUs = Math.round(cfg.ceilingMs * 1000);
  const ledger = createLedger(256, budgetUs, ceilingUs);

  let override: Tier | null = null;
  if (cfg.override !== null && TIERS.includes(cfg.override)) {
    override = cfg.override;
  }
  let idx = override !== null ? tierIndex(override) : 0;
  let transitionsCount = 0;
  let frameCount = 0;
  let startUs: number | null = null;
  let clockSkew = 0;
  void clockSkew;
  let degradeStreak = 0;
  let upgradeStreak = 0;
  let spikeFrames: number[] = [];

  function currentTier(): Tier {
    return TIERS[idx] as Tier;
  }

  function dropTier(): void {
    if (idx < TIERS.length - 1) {
      idx++;
      transitionsCount++;
    }
  }

  function riseTier(): void {
    if (idx > 0) {
      idx--;
      transitionsCount++;
    }
  }

  function resetStreaks(): void {
    degradeStreak = 0;
    upgradeStreak = 0;
    spikeFrames = [];
  }

  function maxPatches(): number {
    const v = cfg.maxPatchesPerFrame >> idx;
    return v < 1 ? 1 : v;
  }

  function evaluate(): void {
    const s = ledger.stats(cfg.windowFrames);
    const minSamples = Math.min(cfg.evalEveryFrames, cfg.windowFrames);
    if (s.count < minSamples) return;
    if (s.p95Us > budgetUs) {
      degradeStreak++;
      upgradeStreak = 0;
      if (degradeStreak >= cfg.degradeEvals) {
        dropTier();
        degradeStreak = 0;
      }
    } else if (s.p95Us < cfg.upgradeRatio * budgetUs) {
      upgradeStreak++;
      degradeStreak = 0;
      if (upgradeStreak >= cfg.upgradeEvals) {
        riseTier();
        upgradeStreak = 0;
      }
    } else {
      degradeStreak = 0;
      upgradeStreak = 0;
    }
  }

  return {
    tier(): Tier {
      return currentTier();
    },
    policy(): TierPolicy {
      return {
        tier: currentTier(),
        maxPatches: maxPatches(),
        interpolate: INTERPOLATE[idx] as boolean,
        effects: EFFECTS[idx] as TierPolicy['effects'],
      };
    },
    transitions(): number {
      return transitionsCount;
    },
    setOverride(t: Tier | null): void {
      if (t !== null && !TIERS.includes(t)) return;
      override = t;
      if (t !== null) {
        idx = tierIndex(t);
      }
      resetStreaks();
    },
    ledger,
    maxPatchesThisFrame(): number {
      return maxPatches();
    },
    frameJsBudgetMs(): number {
      return cfg.frameJsBudgetMs;
    },
    effectsEnabled(): boolean {
      return idx === 0;
    },
    beginFrame(): void {
      startUs = clock.nowUs();
    },
    endFrame(applied: number, deferred: number): void {
      const now = clock.nowUs();
      let jsUs = 0;
      const start = startUs;
      startUs = null;
      if (start !== null) {
        jsUs = now - start;
        if (jsUs < 0) {
          jsUs = 0;
          clockSkew++;
        }
      }
      const tierAtFrame = currentTier();
      ledger.record({ startUs: start ?? now, jsUs, applied, deferred, tier: tierAtFrame });
      frameCount++;

      if (override !== null) return;

      // Ceiling spike: immediate drop, window-aware counter.
      if (jsUs > ceilingUs) {
        spikeFrames.push(frameCount);
        // prune spikes older than windowFrames
        spikeFrames = spikeFrames.filter((f) => frameCount - f < cfg.windowFrames);
        if (spikeFrames.length >= cfg.ceilingHitsToDrop) {
          dropTier();
          spikeFrames = [];
          degradeStreak = 0;
          upgradeStreak = 0;
        }
      } else {
        // prune stale spikes so distant hits don't accumulate
        if (spikeFrames.length > 0) {
          spikeFrames = spikeFrames.filter((f) => frameCount - f < cfg.windowFrames);
        }
      }

      if (cfg.evalEveryFrames > 0 && frameCount % cfg.evalEveryFrames === 0) {
        evaluate();
      }
    },
  };
}
