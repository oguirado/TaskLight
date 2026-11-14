import type { TplReject, TplResult, UserTemplate, UserSlot, SlotKey, LensId } from './types';
import { TOKENS } from './tokens';
import { COMPONENTS, COMPONENT_FIELDS } from './components';
import { TPL_LIMITS } from './limits';
import { resolveLens } from './hash';

const SLOT_KEYS: readonly string[] = ['s1','s2','s3','s4','s5','s6','s7','s8','s9','s10','s11','s12'];
const TEMPLATE_FIELDS = ['status','attention','headline','summary','next_action','steps','progress','inference_source','stale','updated_at'] as const;

type TemplateFieldAlias = (typeof TEMPLATE_FIELDS)[number];
void 0 as unknown as TemplateFieldAlias;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

function hasCodeLike(s: string): boolean {
  return s.includes('<') || s.includes('>') || s.includes('://') || s.toLowerCase().includes('javascript:');
}
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}
export function sortErrors(errs: TplReject[]): TplReject[] {
  return [...errs].sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    if (a.code < b.code) return -1;
    if (a.code > b.code) return 1;
    return 0;
  });
}

const MAX_DEPTH = 128;

function isArrayIndex(k: string): boolean {
  if (!/^(0|[1-9]\d*)$/.test(k)) return false;
  const n = Number(k);
  return Number.isSafeInteger(n) && n < 4294967295;
}

// Descriptor-based walk (B2): array and object accessors are rejected without
// invocation. Any inspection failure (revoked proxy, throwing trap, excessive
// nesting) becomes NOT_PLAIN and is never resumed past.
export function collectNotPlain(v: unknown, path: string, errs: TplReject[], seen: Set<unknown>, depth = 0): void {
  if (depth > MAX_DEPTH) {
    errs.push({ code: 'NOT_PLAIN', path });
    return;
  }
  try {
    if (v === null) return;
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') return;
    if (v === undefined || t === 'function' || t === 'symbol' || t === 'bigint') {
      errs.push({ code: 'NOT_PLAIN', path });
      return;
    }
    if (Array.isArray(v)) {
      if (seen.has(v)) return;
      seen.add(v);
      try {
        const descs = Object.getOwnPropertyDescriptors(v) as Record<string, PropertyDescriptor>;
        for (const k of Object.keys(descs)) {
          if (k === 'length') continue;
          const d = descs[k]!;
          const childPath = isArrayIndex(k) ? `${path}[${k}]` : (path === '' ? k : `${path}.${k}`);
          if (d.get !== undefined || d.set !== undefined) {
            errs.push({ code: 'NOT_PLAIN', path: childPath });
          } else {
            collectNotPlain(d.value, childPath, errs, seen, depth + 1);
          }
        }
      } finally {
        seen.delete(v);
      }
      return;
    }
    if (typeof v === 'object') {
      if (seen.has(v)) return;
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        errs.push({ code: 'NOT_PLAIN', path });
        return;
      }
      // plain object: inspect descriptors to detect accessors without invoking
      const descs = Object.getOwnPropertyDescriptors(v);
      seen.add(v);
      try {
        for (const k of Object.keys(descs)) {
          const d = descs[k] as PropertyDescriptor;
          const childPath = path === '' ? k : `${path}.${k}`;
          if (d.get !== undefined || d.set !== undefined) {
            errs.push({ code: 'NOT_PLAIN', path: childPath });
          } else {
            collectNotPlain(d.value, childPath, errs, seen, depth + 1);
          }
        }
      } finally {
        seen.delete(v);
      }
      return;
    }
    errs.push({ code: 'NOT_PLAIN', path });
  } catch {
    errs.push({ code: 'NOT_PLAIN', path });
  }
}

function cloneTemplate(t: unknown): UserTemplate {
  return structuredClone(t) as UserTemplate;
}

export function validateTemplate(input: unknown): TplResult<UserTemplate> {
  const plainErrs: TplReject[] = [];
  try {
    collectNotPlain(input, '', plainErrs, new Set());
  } catch {
    plainErrs.push({ code: 'NOT_PLAIN', path: '' });
  }
  if (plainErrs.length) return { ok: false, errors: sortErrors(plainErrs) };
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ code: 'WRONG_TYPE', path: '' }] };
  }
  const obj = input as Record<string, unknown>;
  const errors: TplReject[] = [];

  const topExpected = ['v', 'lens_id', 'name', 'grid', 'tokens', 'slots'] as const;
  const topSet = new Set<string>(topExpected);
  for (const k of topExpected) if (!(k in obj)) errors.push({ code: 'MISSING_FIELD', path: k });
  for (const k of Object.keys(obj)) if (!topSet.has(k)) errors.push({ code: 'UNKNOWN_FIELD', path: k });

  // v
  if ('v' in obj) {
    const v = obj.v;
    if (typeof v !== 'number') errors.push({ code: 'WRONG_TYPE', path: 'v' });
    else if (!Number.isSafeInteger(v)) errors.push({ code: 'WRONG_TYPE', path: 'v' });
    else if (v !== 1) errors.push({ code: 'BAD_VERSION', path: 'v' });
  }
  // lens_id (B3): must resolve via U25 getLens
  let lensValid: LensId | null = null;
  let lensAllowed: readonly string[] | null = null;
  if ('lens_id' in obj) {
    const lid = obj.lens_id;
    if (typeof lid !== 'string') errors.push({ code: 'WRONG_TYPE', path: 'lens_id' });
    else if (lid !== 'dev' && lid !== 'study') errors.push({ code: 'BAD_LENS', path: 'lens_id' });
    else {
      const res = resolveLens(lid);
      if (!res.resolved) errors.push({ code: 'BAD_LENS', path: 'lens_id' });
      else {
        lensValid = lid as LensId;
        lensAllowed = res.allowedFields;
      }
    }
  }
  // name
  if ('name' in obj) {
    const n = obj.name;
    if (typeof n !== 'string') errors.push({ code: 'WRONG_TYPE', path: 'name' });
    else {
      if (n.length < 1 || n.length > TPL_LIMITS.NAME_MAX) errors.push({ code: 'BAD_NAME', path: 'name' });
      if (hasCodeLike(n)) errors.push({ code: 'CODE_LIKE', path: 'name' });
      if (hasControl(n)) errors.push({ code: 'CONTROL_CHAR', path: 'name' });
    }
  }
  // grid
  let colsValid: number | null = null;
  if ('grid' in obj) {
    const g = obj.grid;
    if (!isPlainObject(g)) errors.push({ code: 'WRONG_TYPE', path: 'grid' });
    else {
      const exp: string[] = ['cols'];
      const set = new Set(exp);
      for (const k of exp) if (!(k in g)) errors.push({ code: 'MISSING_FIELD', path: `grid.${k}` });
      for (const k of Object.keys(g)) if (!set.has(k)) errors.push({ code: 'UNKNOWN_FIELD', path: `grid.${k}` });
      if ('cols' in g) {
        const c = (g as Record<string, unknown>).cols;
        if (typeof c !== 'number') errors.push({ code: 'WRONG_TYPE', path: 'grid.cols' });
        else if (!Number.isSafeInteger(c)) errors.push({ code: 'WRONG_TYPE', path: 'grid.cols' });
        else if (c < 1 || c > 3) errors.push({ code: 'BAD_GRID', path: 'grid.cols' });
        else colsValid = c;
      }
    }
  }
  // tokens
  if ('tokens' in obj) {
    const tok = obj.tokens;
    if (!isPlainObject(tok)) errors.push({ code: 'WRONG_TYPE', path: 'tokens' });
    else {
      const names = ['accent', 'density', 'radius', 'scale'] as const;
      const nameSet = new Set<string>(names);
      for (const k of names) if (!(k in tok)) errors.push({ code: 'BAD_TOKEN', path: `tokens.${k}` });
      for (const k of Object.keys(tok)) if (!nameSet.has(k)) errors.push({ code: 'BAD_TOKEN', path: `tokens.${k}` });
      for (const k of names) {
        if (!(k in tok)) continue;
        const val = (tok as Record<string, unknown>)[k];
        if (typeof val !== 'string') errors.push({ code: 'WRONG_TYPE', path: `tokens.${k}` });
        else {
          const allowed = (TOKENS as Record<string, readonly string[]>)[k]!;
          if (!allowed.includes(val)) errors.push({ code: 'BAD_TOKEN_VALUE', path: `tokens.${k}` });
        }
      }
    }
  }

  // slots
  if ('slots' in obj) {
    const slotsRaw = obj.slots;
    if (!Array.isArray(slotsRaw)) errors.push({ code: 'WRONG_TYPE', path: 'slots' });
    else {
      if (slotsRaw.length > TPL_LIMITS.SLOTS_MAX) errors.push({ code: 'TOO_MANY_SLOTS', path: 'slots' });
      if (slotsRaw.length < TPL_LIMITS.SLOTS_MIN) errors.push({ code: 'TOO_FEW_SLOTS', path: 'slots' });
      const idSeen = new Map<string, number>();
      const fieldSeen = new Set<string>();
      const cellSeen = new Map<string, number>();
      let hasStatus = false;

      for (let i = 0; i < slotsRaw.length; i++) {
        const slotRaw = slotsRaw[i];
        const slotPath = `slots[${i}]`;
        if (!isPlainObject(slotRaw)) {
          errors.push({ code: 'WRONG_TYPE', path: slotPath });
          continue;
        }
        const slotExpected = ['id', 'component', 'field', 'label', 'row', 'col'] as const;
        const slotSet = new Set<string>(slotExpected);
        for (const k of slotExpected) if (!(k in slotRaw)) errors.push({ code: 'MISSING_FIELD', path: `${slotPath}.${k}` });
        for (const k of Object.keys(slotRaw)) if (!slotSet.has(k)) errors.push({ code: 'UNKNOWN_FIELD', path: `${slotPath}.${k}` });

        // id
        let slotId: string | null = null;
        if ('id' in slotRaw) {
          const id = (slotRaw as Record<string, unknown>).id;
          if (typeof id !== 'string') errors.push({ code: 'WRONG_TYPE', path: `${slotPath}.id` });
          else if (!SLOT_KEYS.includes(id)) errors.push({ code: 'BAD_SLOT_ID', path: `${slotPath}.id` });
          else {
            slotId = id;
            if (idSeen.has(id)) errors.push({ code: 'DUPLICATE_SLOT', path: `${slotPath}.id` });
            else idSeen.set(id, i);
          }
        }
        // component
        let comp: string | null = null;
        if ('component' in slotRaw) {
          const c = (slotRaw as Record<string, unknown>).component;
          if (typeof c !== 'string') errors.push({ code: 'WRONG_TYPE', path: `${slotPath}.component` });
          else if (!(COMPONENTS as readonly string[]).includes(c)) errors.push({ code: 'BAD_COMPONENT', path: `${slotPath}.component` });
          else comp = c;
        }
        // field
        let field: string | null = null;
        if ('field' in slotRaw) {
          const f = (slotRaw as Record<string, unknown>).field;
          if (typeof f !== 'string') errors.push({ code: 'WRONG_TYPE', path: `${slotPath}.field` });
          else if (!(TEMPLATE_FIELDS as readonly string[]).includes(f)) {
            errors.push({ code: 'FIELD_COMPONENT_MISMATCH', path: `${slotPath}.field` });
          } else {
            field = f;
          }
        }
        // label
        if ('label' in slotRaw) {
          const lab = (slotRaw as Record<string, unknown>).label;
          if (typeof lab !== 'string') errors.push({ code: 'WRONG_TYPE', path: `${slotPath}.label` });
          else {
            if (lab.length < 1 || lab.length > TPL_LIMITS.LABEL_MAX) errors.push({ code: 'BAD_LABEL', path: `${slotPath}.label` });
            if (hasCodeLike(lab)) errors.push({ code: 'CODE_LIKE', path: `${slotPath}.label` });
            if (hasControl(lab)) errors.push({ code: 'CONTROL_CHAR', path: `${slotPath}.label` });
          }
        }
        // row / col
        let rowVal: number | null = null;
        let colVal: number | null = null;
        if ('row' in slotRaw) {
          const r = (slotRaw as Record<string, unknown>).row;
          if (typeof r !== 'number') errors.push({ code: 'WRONG_TYPE', path: `${slotPath}.row` });
          else if (!Number.isSafeInteger(r)) errors.push({ code: 'WRONG_TYPE', path: `${slotPath}.row` });
          else rowVal = r;
        }
        if ('col' in slotRaw) {
          const cc = (slotRaw as Record<string, unknown>).col;
          if (typeof cc !== 'number') errors.push({ code: 'WRONG_TYPE', path: `${slotPath}.col` });
          else if (!Number.isSafeInteger(cc)) errors.push({ code: 'WRONG_TYPE', path: `${slotPath}.col` });
          else colVal = cc;
        }
        // grid
        if (rowVal !== null) {
          if (rowVal < 1 || rowVal > TPL_LIMITS.ROWS_MAX) errors.push({ code: 'OUT_OF_GRID', path: `${slotPath}.row` });
        }
        if (colVal !== null) {
          if (colVal < 1 || (colsValid !== null && colVal > colsValid))
            errors.push({ code: 'OUT_OF_GRID', path: `${slotPath}.col` });
          else if (colsValid === null && (colVal < 1 || colVal > 3))
            errors.push({ code: 'OUT_OF_GRID', path: `${slotPath}.col` });
          // also handle case colsValid null but col >3 handled above
        }
        // CELL_TAKEN
        if (rowVal !== null && colVal !== null) {
          // only consider if row/col are ints (already)
          const key = `${rowVal}:${colVal}`;
          if (cellSeen.has(key)) errors.push({ code: 'CELL_TAKEN', path: slotPath });
          else cellSeen.set(key, i);
        }
        // FIELD_COMPONENT_MISMATCH
        if (comp !== null && field !== null) {
          const allowed = (COMPONENT_FIELDS as Record<string, readonly string[]>)[comp];
          if (!allowed || !allowed.includes(field))
            errors.push({ code: 'FIELD_COMPONENT_MISMATCH', path: `${slotPath}.field` });
        }
        // FIELD_NOT_IN_LENS (B5): field must be bound in the lens template
        if (field !== null && lensAllowed !== null) {
          if (!lensAllowed.includes(field))
            errors.push({ code: 'FIELD_NOT_IN_LENS', path: `${slotPath}.field` });
        }
        // DUPLICATE_FIELD + MISSING_STATUS tracking
        if (field !== null) {
          if (fieldSeen.has(field)) errors.push({ code: 'DUPLICATE_FIELD', path: `${slotPath}.field` });
          else fieldSeen.add(field);
          if (field === 'status') hasStatus = true;
        }
      }
      if (!hasStatus) errors.push({ code: 'MISSING_STATUS', path: 'slots' });
    }
  }

  if (errors.length) return { ok: false, errors: sortErrors(errors) };
  return { ok: true, value: cloneTemplate(input) };
}
