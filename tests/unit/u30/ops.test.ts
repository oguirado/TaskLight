import { describe, it, expect } from 'vitest';
import {
  validateProposal, applyOps, templateHash, type Proposal, type TplResult, type UserTemplate,
} from '../../../src/template';
import {
  baseDev, baseStudy, clone, codes, has, errs, op, addSlot, removeSlot, moveSlot, renameLabel, setToken, anyFrozen,
} from './helpers';

/** structural/enum errors may surface at validateProposal or at applyOps: take whichever rejects. */
function reject(t: UserTemplate, ops: unknown[]): TplResult<unknown> {
  const v = validateProposal({ ops });
  if (!v.ok) return v;
  return applyOps(t, v.value);
}
const applyOk = (t: UserTemplate, ops: Proposal['ops']) => {
  const v = validateProposal({ ops });
  expect(v.ok).toBe(true);
  if (!v.ok) throw new Error('unreachable');
  return applyOps(t, v.value);
};

describe('T7 proposal_shape', () => {
  const five = () => [
    renameLabel('s1', 'A'), renameLabel('s2', 'B'), renameLabel('s3', 'C'), renameLabel('s4', 'D'), renameLabel('s5', 'E'),
  ];
  it('5 ops -> TOO_MANY_OPS; 4 ops ok (boundary control)', () => {
    expect(has(validateProposal({ ops: five() }), 'TOO_MANY_OPS')).toBe(true);
    expect(validateProposal({ ops: five().slice(0, 4) }).ok).toBe(true);
  });
  it('0 ops -> EMPTY_PROPOSAL', () => {
    expect(has(validateProposal({ ops: [] }), 'EMPTY_PROPOSAL')).toBe(true);
  });
  it('off-enum token value / token name', () => {
    expect(has(reject(baseDev(), [setToken('accent', 'fuchsia')]), 'BAD_TOKEN_VALUE')).toBe(true);
    expect(has(reject(baseDev(), [setToken('accent', 'bg-red-500 x')]), 'BAD_TOKEN_VALUE')).toBe(true);
    expect(has(reject(baseDev(), [setToken('accent', 'url(https://x.example/a.png)')]), 'BAD_TOKEN_VALUE')).toBe(true);
    expect(has(reject(baseDev(), [setToken('accent', 'Blue')]), 'BAD_TOKEN_VALUE')).toBe(true);
    expect(has(reject(baseDev(), [op({ op: 'set_token', token: 'color' as never, value: 'red' })]), 'BAD_TOKEN')).toBe(true);
  });
  it('op missing a key -> MISSING_FIELD', () => {
    const o: Record<string, unknown> = { ...renameLabel('s1', 'x') };
    delete o.label;
    expect(has(validateProposal({ ops: [o] }), 'MISSING_FIELD')).toBe(true);
  });
  it('remove_slot with non-null label -> OP_FIELDS', () => {
    expect(has(validateProposal({ ops: [{ ...removeSlot('s1'), label: 'x' }] }), 'OP_FIELDS')).toBe(true);
    expect(has(validateProposal({ ops: [{ ...renameLabel('s1', 'x'), row: 1 }] }), 'OP_FIELDS')).toBe(true);
    expect(has(validateProposal({ ops: [{ ...setToken('accent', 'blue'), slot: 's1' }] }), 'OP_FIELDS')).toBe(true);
    expect(has(validateProposal({ ops: [{ ...moveSlot('s1', 1, 1), label: 'x' }] }), 'OP_FIELDS')).toBe(true);
  });
  it('required key null is rejected (MISSING_FIELD or OP_FIELDS)', () => {
    for (const o of [
      { ...addSlot('s9', 'chip', 'attention', 4, 1, 'x'), component: null },
      { ...addSlot('s9', 'chip', 'attention', 4, 1, 'x'), label: null },
      { ...moveSlot('s1', 1, 1), row: null },
      { ...renameLabel('s1', 'x'), slot: null },
      { ...removeSlot('s1'), slot: null },
      { ...setToken('accent', 'blue'), value: null },
    ]) {
      const c = codes(validateProposal({ ops: [o] }));
      expect(c.some((x) => x === 'MISSING_FIELD' || x === 'OP_FIELDS')).toBe(true);
    }
  });
  it('unknown op / unknown keys (className, style, html) / shape', () => {
    expect(has(validateProposal({ ops: [{ ...renameLabel('s1', 'x'), op: 'drop_table' }] }), 'BAD_OP')).toBe(true);
    expect(has(validateProposal({ ops: [{ ...renameLabel('s1', 'x'), className: 'x' }] }), 'UNKNOWN_FIELD')).toBe(true);
    expect(has(validateProposal({ ops: [{ ...renameLabel('s1', 'x'), style: 'color:red' }] }), 'UNKNOWN_FIELD')).toBe(true);
    expect(has(validateProposal({ ops: [renameLabel('s1', 'x')], html: '<b>' }), 'UNKNOWN_FIELD')).toBe(true);
    expect(has(validateProposal({}), 'MISSING_FIELD')).toBe(true);
    expect(has(validateProposal({ ops: 'x' }), 'WRONG_TYPE')).toBe(true);
    expect(validateProposal(null).ok).toBe(false);
    expect(validateProposal(undefined).ok).toBe(false);
    expect(validateProposal([renameLabel('s1', 'x')]).ok).toBe(false);
  });
  it('non-plain proposal / getters never invoked / never throws', () => {
    let calls = 0;
    const o = { ...renameLabel('s1', 'x') } as Record<string, unknown>;
    Object.defineProperty(o, 'label', { enumerable: true, get() { calls++; return 'x'; } });
    expect(has(validateProposal({ ops: [o] }), 'NOT_PLAIN')).toBe(true);
    expect(calls).toBe(0);
    expect(validateProposal({ ops: [new Map()] }).ok).toBe(false);
  });
  it('slot / component / field / coordinates domains', () => {
    expect(codes(reject(baseDev(), [addSlot('s13' as never, 'chip', 'attention', 4, 1, 'x')])).length).toBeGreaterThan(0);
    expect(has(reject(baseDev(), [addSlot('s9', 'iframe' as never, 'attention', 4, 1, 'x')]), 'BAD_COMPONENT')).toBe(true);
    expect(has(reject(baseDev(), [addSlot('s9', 'div class=x' as never, 'attention', 4, 1, 'x')]), 'BAD_COMPONENT')).toBe(true);
    expect(has(reject(baseDev(), [addSlot('s9', 'chip', 'attention', 4, 1.5, 'x')]), 'WRONG_TYPE')).toBe(true);
  });
  it('label code in ops: html / control / length', () => {
    expect(has(reject(baseDev(), [renameLabel('s1', '<b>x</b>')]), 'CODE_LIKE')).toBe(true);
    expect(has(reject(baseDev(), [renameLabel('s1', 'ok\u0007')]), 'CONTROL_CHAR')).toBe(true);
    expect(has(reject(baseDev(), [renameLabel('s1', 'x'.repeat(25))]), 'BAD_LABEL')).toBe(true);
    expect(has(reject(baseDev(), [addSlot('s9', 'badge', 'stale', 4, 1, 'javascript:x')]), 'CODE_LIKE')).toBe(true);
  });
  it('detail does not echo proposal strings', () => {
    const r = reject(baseDev(), [setToken('accent', 'SECRETXYZ')]);
    expect(errs(r).length).toBeGreaterThan(0);
    for (const e of errs(r)) expect(e.detail ?? '').not.toContain('SECRETXYZ');
  });
});

describe('T8 four_ops_ok', () => {
  it('add, move, rename, set_token on the study fixture', () => {
    const base = baseStudy();
    const before = clone(base);
    const h0 = templateHash(base);
    const r = applyOk(base, [
      addSlot('s7', 'badge', 'inference_source', 4, 1, 'Src'),
      moveSlot('s6', 4, 2),
      renameLabel('s1', 'Now'),
      setToken('accent', 'teal'),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.value;
    expect(t.slots).toHaveLength(7);
    expect(t.slots.find((s) => s.id === 's7')).toEqual({ id: 's7', component: 'badge', field: 'inference_source', label: 'Src', row: 4, col: 1 });
    expect(t.slots.find((s) => s.id === 's6')).toMatchObject({ row: 4, col: 2 });
    expect(t.slots.find((s) => s.id === 's1')!.label).toBe('Now');
    expect(t.tokens.accent).toBe('teal');
    expect(templateHash(t)).not.toBe(h0);
    expect(base).toEqual(before);                        // input untouched
    expect(anyFrozen(base)).toBe(false);                 // and not frozen
    expect(r.value).not.toBe(base);
  });
  it('each op kind alone', () => {
    const b = baseStudy();
    const h = templateHash(b);
    const one = (o: ReturnType<typeof op>) => {
      const r = applyOk(b, [o]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(templateHash(r.value)).not.toBe(h);
      return r;
    };
    one(renameLabel('s2', 'Heading'));
    one(setToken('density', 'roomy'));
    one(moveSlot('s5', 5, 1));
    const rem = one(removeSlot('s6'));
    if (rem.ok) expect(rem.value.slots.map((s) => s.id)).not.toContain('s6');
    one(addSlot('s8', 'badge', 'stale', 5, 2, 'Stale'));
  });
});

describe('T9 atomic_apply', () => {
  it('SLOT_NOT_FOUND at ops[1], nothing applied', () => {
    const base = baseDev();
    const before = clone(base);
    const r = applyOps(base, { ops: [renameLabel('s1', 'Now'), removeSlot('s11')] });
    expect(r.ok).toBe(false);
    expect(has(r, 'SLOT_NOT_FOUND', 'ops[1]')).toBe(true);
    expect('value' in r).toBe(false);
    expect(base).toEqual(before);
    expect(base.slots[0]!.label).toBe('Status');
  });
  it('failure at op 4 of 4 discards ops 1-3', () => {
    const base = baseDev();
    const before = clone(base);
    const r = applyOps(base, { ops: [
      renameLabel('s1', 'A'), setToken('accent', 'rose'), moveSlot('s5', 6, 1), renameLabel('s12', 'ghost'),
    ] });
    expect(r.ok).toBe(false);
    expect(has(r, 'SLOT_NOT_FOUND', 'ops[3]')).toBe(true);
    expect(base).toEqual(before);
  });
  it('SLOT_EXISTS on add of an existing id', () => {
    const r = applyOps(baseDev(), { ops: [addSlot('s1', 'badge', 'stale', 4, 1, 'x')] });
    expect(has(r, 'SLOT_EXISTS', 'ops[0]')).toBe(true);
  });
  it('move/rename of a missing slot', () => {
    expect(has(applyOps(baseDev(), { ops: [moveSlot('s10', 4, 1)] }), 'SLOT_NOT_FOUND', 'ops[0]')).toBe(true);
    expect(has(applyOps(baseDev(), { ops: [renameLabel('s10', 'x')] }), 'SLOT_NOT_FOUND', 'ops[0]')).toBe(true);
  });
  it('revalidation: removing the status chip rejects the whole proposal', () => {
    const r = applyOps(baseDev(), { ops: [renameLabel('s2', 'Z'), removeSlot('s1')] });
    expect(r.ok).toBe(false);
    expect(has(r, 'MISSING_STATUS', 'ops[')).toBe(true);
  });
  it('revalidation: lens-mismatched field, duplicate field, bad component', () => {
    expect(has(applyOps(baseDev(), { ops: [addSlot('s6', 'progress', 'progress', 3, 2, 'P')] }), 'FIELD_NOT_IN_LENS', 'ops[')).toBe(true);
    expect(has(applyOps(baseDev(), { ops: [addSlot('s6', 'headline', 'headline', 3, 2, 'H')] }), 'DUPLICATE_FIELD', 'ops[')).toBe(true);
    expect(has(applyOps(baseDev(), { ops: [addSlot('s6', 'chip', 'headline', 3, 2, 'H')] }), 'FIELD_COMPONENT_MISMATCH', 'ops[')).toBe(true);
  });
});

describe('T10 grid collisions via ops', () => {
  it('move to an occupied cell; col 3 with cols 2; row 13', () => {
    expect(has(applyOps(baseDev(), { ops: [moveSlot('s5', 1, 1)] }), 'CELL_TAKEN', 'ops[')).toBe(true);
    expect(has(applyOps(baseDev(), { ops: [moveSlot('s5', 3, 3)] }), 'OUT_OF_GRID', 'ops[')).toBe(true);
    expect(has(applyOps(baseDev(), { ops: [moveSlot('s5', 13, 1)] }), 'OUT_OF_GRID', 'ops[')).toBe(true);
    expect(has(applyOps(baseDev(), { ops: [addSlot('s6', 'badge', 'stale', 1, 1, 'x')] }), 'CELL_TAKEN', 'ops[')).toBe(true);
  });
  it('type-level invariants hold on results: swap into a freed cell works (control)', () => {
    const r = applyOps(baseDev(), { ops: [moveSlot('s1', 4, 1), moveSlot('s2', 1, 1)] });
    expect(r.ok).toBe(true);
  });
});
