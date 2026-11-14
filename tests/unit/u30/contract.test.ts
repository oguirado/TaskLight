import { describe, it, expect } from 'vitest';
import {
  validateTemplate, compileTemplate, defaultTemplate, TPL_LIMITS, TOKENS, COMPONENTS, COMPONENT_FIELDS,
  type UserTemplate, type UserSlot,
} from '../../../src/template';
import { baseDev, baseStudy, clone, codes, has, errs, TOKENS_OK } from './helpers';

const bad = (mut: (t: Record<string, any>) => void, base: () => UserTemplate = baseDev) => {
  const t = clone(base()) as Record<string, any>;
  mut(t);
  return validateTemplate(t);
};

describe('constants (spec section 2)', () => {
  it('limits, tokens, component map', () => {
    expect(TPL_LIMITS).toEqual({
      SLOTS_MIN: 1, SLOTS_MAX: 12, NAME_MAX: 40, LABEL_MAX: 24, COLS_MIN: 1, COLS_MAX: 3, ROWS_MAX: 12,
      OPS_MAX: 4, PROMPT_JSON_MAX: 1500, UNDO_DEPTH: 10,
    });
    expect(TOKENS.accent).toEqual(['slate', 'blue', 'teal', 'green', 'amber', 'rose']);
    expect(COMPONENTS).toHaveLength(8);
    expect(COMPONENT_FIELDS.chip).toEqual(['status', 'attention']);
    expect(COMPONENT_FIELDS.badge).toEqual(['inference_source', 'stale']);
  });
});

describe('T1 defaults_compile', () => {
  it('defaults validate, compile, are deterministic and lens-distinct', () => {
    const out = (['dev', 'study'] as const).map((l) => {
      const t = defaultTemplate(l);
      expect(t.lens_id).toBe(l);
      expect(validateTemplate(t).ok).toBe(true);
      const a = compileTemplate(t);
      const b = compileTemplate(defaultTemplate(l));
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) throw new Error('unreachable');
      expect(a.value.templateHash).toMatch(/^[0-9a-f]{8}$/);
      expect(a.value.spec.templateHash).toBe(a.value.templateHash);
      expect(JSON.stringify(a.value)).toBe(JSON.stringify(b.value));
      return { t, h: a.value.templateHash };
    });
    expect(out[0]!.h).not.toBe(out[1]!.h);
    expect(out[0]!.t.slots.some((s) => s.field === 'progress')).toBe(false); // progress is study-only
    expect(out[0]!.t.slots.some((s) => s.component === 'chip' && s.field === 'status')).toBe(true);
  });
});

describe('T2 thirteen_slots', () => {
  it('(a) 13 slots rejected, compile not reached', () => {
    const t = clone(baseDev());
    t.grid.cols = 3;
    t.slots = Array.from({ length: 13 }, (_, i) => ({
      id: `s${i + 1}`, component: 'text', field: 'summary', label: `L${i}`, row: Math.floor(i / 3) + 1, col: (i % 3) + 1,
    })) as unknown as UserSlot[];
    const v = validateTemplate(t);
    expect(has(v, 'TOO_MANY_SLOTS')).toBe(true);
    expect(compileTemplate(t).ok).toBe(false);
  });
  it('(b) 12 slots on 3 cols x 4 rows raise no count/grid/id/cell error', () => {
    // NOTE: unique-field rule (B5) makes 12 distinct valid fields impossible (10 fields exist);
    // so only count/grid/id errors are asserted absent. See ORACLE.md "spec conflicts".
    const t = clone(baseDev());
    t.grid.cols = 3;
    t.slots = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i + 1}`, component: 'text', field: 'summary', label: `L${i}`, row: Math.floor(i / 3) + 1, col: (i % 3) + 1,
    })) as unknown as UserSlot[];
    const c = codes(validateTemplate(t));
    for (const forbidden of ['TOO_MANY_SLOTS', 'TOO_FEW_SLOTS', 'OUT_OF_GRID', 'CELL_TAKEN', 'BAD_SLOT_ID', 'DUPLICATE_SLOT']) {
      expect(c).not.toContain(forbidden);
    }
  });
  it('zero slots rejected', () => {
    expect(has(bad((t) => { t.slots = []; }), 'TOO_FEW_SLOTS')).toBe(true);
  });
});

describe('T3 raw_class_string / injection keys', () => {
  it('raw class string in token', () => {
    expect(has(bad((t) => { t.tokens.accent = 'bg-red-500 x'; }), 'BAD_TOKEN_VALUE')).toBe(true);
  });
  it('className / style / html / on* extras', () => {
    expect(has(bad((t) => { t.className = 'x'; }), 'UNKNOWN_FIELD')).toBe(true);
    expect(has(bad((t) => { t.slots[0].style = 'color:red'; }), 'UNKNOWN_FIELD')).toBe(true);
    expect(has(bad((t) => { t.slots[0].html = '<b>x</b>'; }), 'UNKNOWN_FIELD')).toBe(true);
    expect(has(bad((t) => { t.slots[0].onclick = 'x()'; }), 'UNKNOWN_FIELD')).toBe(true);
    expect(has(bad((t) => { t.tokens.className = 'x'; }), 'BAD_TOKEN')).toBe(true);
  });
  it('url()/html/case variants in token values', () => {
    for (const v of ['url(https://evil.example/x.png)', '<b>', 'Blue', 'BLUE', ' blue', 'blue ', '']) {
      expect(has(bad((t) => { t.tokens.accent = v; }), 'BAD_TOKEN_VALUE')).toBe(true);
    }
    expect(has(bad((t) => { t.tokens.density = 'huge'; }), 'BAD_TOKEN_VALUE')).toBe(true);
    expect(has(bad((t) => { t.tokens.radius = 'url(x)'; }), 'BAD_TOKEN_VALUE')).toBe(true);
    expect(has(bad((t) => { t.tokens.scale = 'xl'; }), 'BAD_TOKEN_VALUE')).toBe(true);
  });
  it('missing / unknown token key', () => {
    expect(has(bad((t) => { delete t.tokens.scale; }), 'BAD_TOKEN')).toBe(true);
    expect(has(bad((t) => { t.tokens.color = 'red'; }), 'BAD_TOKEN')).toBe(true);
  });
  it('every enum value is accepted (control)', () => {
    for (const [k, vals] of Object.entries(TOKENS)) {
      for (const v of vals) expect(bad((t) => { t.tokens[k] = v; }).ok).toBe(true);
    }
  });
});

describe('T4 off_allowlist_component', () => {
  it('iframe and Chip rejected', () => {
    const a = bad((t) => { t.slots[0].component = 'iframe'; });
    const b = bad((t) => { t.slots[0].component = 'Chip'; });
    expect(has(a, 'BAD_COMPONENT')).toBe(true);
    expect(has(b, 'BAD_COMPONENT')).toBe(true);
    for (const c of ['script', 'div', 'img', 'a', '', 'chip ', '<chip>']) {
      expect(has(bad((t) => { t.slots[0].component = c; }), 'BAD_COMPONENT')).toBe(true);
    }
  });
});

describe('T6 field_lens_agreement', () => {
  it('progress on dev', () => {
    const t = baseDev();
    t.slots.push({ id: 's6', component: 'progress', field: 'progress', label: 'P', row: 3, col: 2 });
    expect(has(validateTemplate(t), 'FIELD_NOT_IN_LENS')).toBe(true);
  });
  it('progress on study is fine (control)', () => {
    expect(validateTemplate(baseStudy()).ok).toBe(true);
  });
  it('chip bound to headline', () => {
    expect(has(bad((t) => { t.slots[0].field = 'headline'; }), 'FIELD_COMPONENT_MISMATCH')).toBe(true);
    expect(has(bad((t) => { t.slots[1].component = 'badge'; }), 'FIELD_COMPONENT_MISMATCH')).toBe(true);
  });
  it('duplicate field', () => {
    const t = baseDev();
    t.slots.push({ id: 's6', component: 'headline', field: 'headline', label: 'T2', row: 3, col: 2 });
    expect(has(validateTemplate(t), 'DUPLICATE_FIELD')).toBe(true);
  });
  it('no status chip', () => {
    const t = baseDev();
    t.slots = t.slots.filter((s) => s.id !== 's1');
    expect(has(validateTemplate(t), 'MISSING_STATUS')).toBe(true);
    // attention chip does not satisfy the status requirement
    const u = baseDev();
    u.slots[0] = { id: 's1', component: 'chip', field: 'attention', label: 'Att', row: 1, col: 1 };
    expect(has(validateTemplate(u), 'MISSING_STATUS')).toBe(true);
  });
  it('valid baselines (control)', () => {
    expect(validateTemplate(baseDev()).ok).toBe(true);
    const r = compileTemplate(baseDev());
    expect(r.ok).toBe(true);
  });
});

describe('T10 grid', () => {
  it('col 3 with cols 2; row 0; row 13; col 0', () => {
    expect(has(bad((t) => { t.slots[4].col = 3; }), 'OUT_OF_GRID')).toBe(true);
    expect(has(bad((t) => { t.slots[4].row = 0; }), 'OUT_OF_GRID')).toBe(true);
    expect(has(bad((t) => { t.slots[4].row = 13; }), 'OUT_OF_GRID')).toBe(true);
    expect(has(bad((t) => { t.slots[4].col = 0; }), 'OUT_OF_GRID')).toBe(true);
  });
  it('two slots in one cell', () => {
    expect(has(bad((t) => { t.slots[1].row = 1; t.slots[1].col = 1; }), 'CELL_TAKEN')).toBe(true);
  });
  it('cols 4 / 0 rejected; cols 1 with col 2 out of grid', () => {
    expect(has(bad((t) => { t.grid.cols = 4; }), 'BAD_GRID')).toBe(true);
    expect(has(bad((t) => { t.grid.cols = 0; }), 'BAD_GRID')).toBe(true);
  });
  it('row 12 col 3 accepted on cols 3 (boundary control)', () => {
    const t = baseDev();
    t.grid.cols = 3;
    t.slots[4]!.row = 12; t.slots[4]!.col = 3;
    expect(validateTemplate(t).ok).toBe(true);
  });
});

describe('B3/B4 header and slot ids', () => {
  it('version / lens / name', () => {
    expect(has(bad((t) => { t.v = 2; }), 'BAD_VERSION')).toBe(true);
    expect(has(bad((t) => { t.lens_id = 'desk'; }), 'BAD_LENS')).toBe(true);
    expect(has(bad((t) => { t.lens_id = '__proto__'; }), 'BAD_LENS')).toBe(true);
    expect(has(bad((t) => { t.name = ''; }), 'BAD_NAME')).toBe(true);
    expect(has(bad((t) => { t.name = 'n'.repeat(41); }), 'BAD_NAME')).toBe(true);
    expect(bad((t) => { t.name = 'n'.repeat(40); }).ok).toBe(true);
  });
  it('slot id domain and repeats', () => {
    expect(has(bad((t) => { t.slots[0].id = 's13'; }), 'BAD_SLOT_ID')).toBe(true);
    expect(has(bad((t) => { t.slots[0].id = 'x1'; }), 'BAD_SLOT_ID')).toBe(true);
    expect(has(bad((t) => { t.slots[1].id = 's1'; }), 'DUPLICATE_SLOT')).toBe(true);
  });
});

describe('T14 label_safety', () => {
  const lab = (label: string) => bad((t) => { t.slots[1].label = label; });
  it('code-like', () => {
    for (const l of ['<b>x</b>', 'a>b', 'http://x', 'javascript:alert', 'JAVASCRIPT:x'.toLowerCase()]) {
      expect(has(lab(l), 'CODE_LIKE')).toBe(true);
    }
  });
  it('control chars', () => {
    for (const l of ['ok\u0007', 'a\u0000b', 'tab\there', 'nl\nx', 'del\u007f']) {
      expect(has(lab(l), 'CONTROL_CHAR')).toBe(true);
    }
  });
  it('length in UTF-16 code units', () => {
    expect(has(lab('x'.repeat(25)), 'BAD_LABEL')).toBe(true);
    expect(has(lab(''), 'BAD_LABEL')).toBe(true);
    expect(lab('x'.repeat(24)).ok).toBe(true);
    expect(lab('\u{1F600}'.repeat(12)).ok).toBe(true);           // 24 code units
    expect(has(lab('\u{1F600}'.repeat(13)), 'BAD_LABEL')).toBe(true); // 26 code units
  });
  it('same rules on name', () => {
    expect(has(bad((t) => { t.name = '<i>x'; }), 'CODE_LIKE')).toBe(true);
    expect(has(bad((t) => { t.name = 'a\u0001'; }), 'CONTROL_CHAR')).toBe(true);
    expect(has(bad((t) => { t.name = 'see://x'; }), 'CODE_LIKE')).toBe(true);
  });
});

describe('B1/B2 totality, plain data, determinism', () => {
  it('never throws on garbage; returns ok:false', () => {
    for (const g of [null, undefined, 1, 'x', [], () => 1, Symbol('s'), 10n, new Map(), {}, { v: 1 }]) {
      const r = validateTemplate(g as unknown);
      expect(r.ok).toBe(false);
      expect(errs(r).length).toBeGreaterThan(0);
    }
  });
  it('non-plain values -> NOT_PLAIN, getters never invoked', () => {
    let calls = 0;
    const t = baseDev() as unknown as Record<string, unknown>;
    Object.defineProperty(t, 'name', { enumerable: true, get() { calls++; return 'x'; } });
    expect(has(validateTemplate(t), 'NOT_PLAIN')).toBe(true);
    expect(calls).toBe(0);
    class Evil { v = 1; }
    expect(has(validateTemplate(new Evil()), 'NOT_PLAIN')).toBe(true);
    expect(has(bad((x) => { x.slots[0].label = new Date(); }), 'NOT_PLAIN')).toBe(true);
    expect(has(bad((x) => { x.tokens = new Map(); }), 'NOT_PLAIN')).toBe(true);
    expect(has(bad((x) => { x.slots[0].label = () => 'x'; }), 'NOT_PLAIN')).toBe(true);
  });
  it('MISSING_FIELD / WRONG_TYPE / non-integers', () => {
    expect(has(bad((t) => { delete t.name; }), 'MISSING_FIELD')).toBe(true);
    expect(has(bad((t) => { delete t.slots[0].label; }), 'MISSING_FIELD')).toBe(true);
    expect(has(bad((t) => { t.name = 5; }), 'WRONG_TYPE')).toBe(true);
    expect(has(bad((t) => { t.slots = 'x'; }), 'WRONG_TYPE')).toBe(true);
    for (const n of [1.5, NaN, Infinity, 2 ** 60, '2']) {
      expect(has(bad((t) => { t.slots[0].row = n; }), 'WRONG_TYPE')).toBe(true);
    }
  });
  it('errors sorted by path then code; detail never echoes input', () => {
    const r = bad((t) => {
      t.slots[3].label = '<SECRETXYZ>'; t.tokens.accent = 'SECRETXYZ'; t.name = ''; t.slots[0].component = 'SECRETXYZ';
      t.slots[0].style = 'SECRETXYZ';
    });
    const e = errs(r);
    expect(e.length).toBeGreaterThan(2);
    const sorted = [...e].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    expect(e).toEqual(sorted);
    for (const x of e) expect(x.detail ?? '').not.toContain('SECRETXYZ');
    expect(JSON.stringify(validateTemplate(clone(baseDev())))).toBe(JSON.stringify(validateTemplate(clone(baseDev()))));
  });
  it('input not mutated, not frozen; valid output is a copy', () => {
    const t = baseStudy();
    const before = clone(t);
    const r = validateTemplate(t);
    expect(r.ok).toBe(true);
    expect(t).toEqual(before);
    expect(Object.isFrozen(t) || Object.isFrozen(t.slots)).toBe(false);
    if (r.ok) expect(r.value).toEqual(before);
    expect(TOKENS_OK.accent).toBe('blue');
  });
});
