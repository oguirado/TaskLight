import type { PaintLedger, LedgerStats } from './types';

const DEFAULT_BUDGET_US = 4000;
const CEILING_US = 11100;
const DEFAULT_LAST_N = 120;

export function createLedger(
  capacity: number,
  budgetUs: number = DEFAULT_BUDGET_US,
  ceilingUs: number = CEILING_US,
): PaintLedger {
  const cap = Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : 0;
  const budget = Number.isFinite(budgetUs) ? budgetUs : DEFAULT_BUDGET_US;
  const ceiling = Number.isFinite(ceilingUs) ? ceilingUs : CEILING_US;
  const buf = new Int32Array(cap);
  let head = 0; // next write position
  let stored = 0; // number of valid entries (<= cap)

  function recordJs(jsUs: number): void {
    if (cap === 0) return;
    const v = Math.trunc(jsUs);
    const iv = Number.isFinite(v) ? v : 0;
    buf[head] = iv;
    head = (head + 1) % cap;
    if (stored < cap) stored++;
  }

  return {
    capacity: cap,
    record(r) {
      recordJs(r.jsUs);
    },
    stats(lastN?: number): LedgerStats {
      const raw = lastN === undefined ? DEFAULT_LAST_N : lastN;
      const requested = Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_LAST_N;
      const n = Math.max(0, Math.min(requested, stored));
      if (n === 0) {
        return { count: 0, p50Us: 0, p95Us: 0, maxUs: 0, overBudget: 0, overCeiling: 0 };
      }
      // collect newest n values: oldest of the window is at (head - n + cap) % cap
      const vals: number[] = new Array(n);
      const startIndex = (((head - n) % cap) + cap) % cap;
      let overBudget = 0;
      let overCeiling = 0;
      let maxUs = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < n; i++) {
        const v = buf[(startIndex + i) % cap] as number;
        vals[i] = v;
        if (v > budget) overBudget++;
        if (v > ceiling) overCeiling++;
        if (v > maxUs) maxUs = v;
      }
      vals.sort((a, b) => a - b);
      const rank = (p: number): number => Math.max(1, Math.ceil(p * n));
      const p50Us = vals[rank(0.5) - 1] as number;
      const p95Us = vals[rank(0.95) - 1] as number;
      return { count: n, p50Us, p95Us, maxUs, overBudget, overCeiling };
    },
  };
}
