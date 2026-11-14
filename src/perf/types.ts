export type Tier = 'T0' | 'T1' | 'T2' | 'T3';
export interface Clock { nowUs(): number }
export interface GovernorConfig {
  frameJsBudgetMs: number;
  ceilingMs: number;
  maxPatchesPerFrame: number;
  windowFrames: number;
  evalEveryFrames: number;
  degradeEvals: number;
  upgradeRatio: number;
  upgradeEvals: number;
  ceilingHitsToDrop: number;
  override: Tier | null;
}
export interface FrameRecord { startUs: number; jsUs: number; applied: number; deferred: number; tier: Tier }
export interface LedgerStats {
  count: number; p50Us: number; p95Us: number; maxUs: number;
  overBudget: number; overCeiling: number;
}
export interface PaintLedger {
  readonly capacity: number;
  record(r: FrameRecord): void;
  stats(lastN?: number): LedgerStats;
}
export interface TierPolicy {
  tier: Tier; maxPatches: number; interpolate: boolean;
  effects: 'full' | 'no_blur_shadow' | 'no_transitions' | 'none';
}
export interface FrameGovernor {
  tier(): Tier; policy(): TierPolicy; transitions(): number;
  setOverride(t: Tier | null): void; readonly ledger: PaintLedger;
  maxPatchesThisFrame(): number; frameJsBudgetMs(): number; effectsEnabled(): boolean;
  beginFrame(): void; endFrame(applied: number, deferred: number): void;
}
