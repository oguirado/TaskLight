// Repair r4 (Sol review r3, DISP_03 BLOCKING; SPEC_U30 B9): a final-validation failure must be attributed to the
// operation that CAUSED it, not to a later benign edit (e.g. a label rename) of the same slot.
import { describe, expect, it } from 'vitest';
import { applyOps } from '../../../src/template';
import { baseDev, clone, errs, moveSlot, renameLabel, setToken } from './helpers';
import type { EditOp } from '../../../src/template';

const idxOf = (p: string): number => Number(/^ops\[(\d+)\]/.exec(p)?.[1] ?? -1);

describe('R4-1 B9: error attributed to the causing op', () => {
  it('review input: move s5 out of grid then rename s5 -> OUT_OF_GRID on ops[0], never ops[1]', () => {
    const base = baseDev();
    const before = clone(base);
    const r = applyOps(base, { ops: [moveSlot('s5', 13, 1), renameLabel('s5', 'Later')] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const og = r.errors.filter((e) => e.code === 'OUT_OF_GRID');
    expect(og.length).toBeGreaterThan(0);
    for (const e of og) expect(idxOf(e.path)).toBe(0);
    expect(r.errors.some((e) => idxOf(e.path) === 1)).toBe(false);
    expect(base).toEqual(before);
  });

  // generated matrix: 2-3 ops, exactly one invalid (the out-of-grid move); the others are valid edits,
  // including later edits of the SAME slot. Rows 13/20/99 and slots s1..s5, bad op at every position.
  const cases: Array<{ name: string; ops: EditOp[]; bad: number }> = [];
  for (const slot of ['s1', 's3', 's5'] as EditOp['slot'][]) for (const row of [13, 20, 99]) {
    const bad = moveSlot(slot, row, 1);
    const other: EditOp['slot'] = slot === 's5' ? 's2' : 's4';
    const fillers: EditOp[][] = [
      [renameLabel(slot, 'After')],
      [renameLabel(other, 'Other')],
      [renameLabel(slot, 'After'), setToken('accent', 'green')],
    ];
    for (const f of fillers) for (let pos = 0; pos <= f.length; pos++) {
      const ops = [...f.slice(0, pos), bad, ...f.slice(pos)];
      cases.push({ name: `${slot} row ${row} bad@${pos} of ${ops.length}`, ops, bad: pos });
    }
  }
  it('matrix is non-trivial', () => { expect(cases.length).toBeGreaterThanOrEqual(30); });
  it.each(cases)('$name', ({ ops, bad }) => {
    const r = applyOps(baseDev(), { ops });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.length).toBeGreaterThan(0);
    for (const e of r.errors) expect(idxOf(e.path), `${e.code} ${e.path}`).toBe(bad);
  });
});
