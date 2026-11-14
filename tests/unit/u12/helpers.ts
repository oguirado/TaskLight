import type { FrameGovernor, GovernorConfig, Tier } from '../../../src/perf';
import { createGovernor } from '../../../src/perf';

export class FakeClock { t = 0; nowUs(): number { return this.t; } }

export const CFG: GovernorConfig = {
  frameJsBudgetMs: 4, ceilingMs: 11.1, maxPatchesPerFrame: 8,
  windowFrames: 120, evalEveryFrames: 60, degradeEvals: 2,
  upgradeRatio: 0.5, upgradeEvals: 4, ceilingHitsToDrop: 2, override: null,
};

export function make(cfg: Partial<GovernorConfig> = {}) {
  const clock = new FakeClock();
  const gov = createGovernor({ ...CFG, ...cfg }, clock);
  return { clock, gov };
}

/** n frames each costing jsUs of JS time */
export function frames(gov: FrameGovernor, clock: FakeClock, n: number, jsUs: number): void {
  for (let i = 0; i < n; i++) {
    gov.beginFrame();
    clock.t += jsUs;
    gov.endFrame(0, 0);
    clock.t += 16667 - jsUs > 0 ? 16667 - jsUs : 0; // idle remainder of the frame
  }
}
export const tiers: Tier[] = ['T0', 'T1', 'T2', 'T3'];
