import type { EditOp, Proposal, TplReject, TplResult, UserSlot, UserTemplate } from './types';
import { TOKENS } from './tokens';
import { COMPONENTS } from './components';
import { TPL_LIMITS } from './limits';
import { validateTemplate, isPlainObject, sortErrors, collectNotPlain } from './validate';

const SLOT_KEYS: readonly string[] = ['s1','s2','s3','s4','s5','s6','s7','s8','s9','s10','s11','s12'];
const TEMPLATE_FIELDS = ['status','attention','headline','summary','next_action','steps','progress','inference_source','stale','updated_at'] as const;
const OP_KINDS = ['add_slot','remove_slot','move_slot','rename_label','set_token'] as const;
const TOKEN_NAMES = ['accent','density','radius','scale'] as const;

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

const REQUIRED: Record<string, string[]> = {
  add_slot: ['slot','component','field','row','col','label'],
  remove_slot: ['slot'],
  move_slot: ['slot','row','col'],
  rename_label: ['slot','label'],
  set_token: ['token','value'],
};
const ALL_OP_KEYS = ['op','slot','component','field','row','col','label','token','value'] as const;

export function validateProposal(p: unknown): TplResult<Proposal> {
  const plainErrs: TplReject[] = [];
  try { collectNotPlain(p, '', plainErrs, new Set()); } catch { plainErrs.push({ code: 'NOT_PLAIN', path: '' }); }
  if (plainErrs.length) return { ok: false, errors: sortErrors(plainErrs) };
  if (!isPlainObject(p)) {
    // proposal expects {ops}
    if (Array.isArray(p) || typeof p !== 'object' || p === null)
      return { ok: false, errors: [{ code: 'WRONG_TYPE', path: '' }] };
    return { ok: false, errors: [{ code: 'WRONG_TYPE', path: '' }] };
  }
  const obj = p as Record<string, unknown>;
  const errors: TplReject[] = [];
  const exp: string[] = ['ops'];
  const expSet = new Set(exp);
  for (const k of exp) if (!(k in obj)) errors.push({ code: 'MISSING_FIELD', path: k });
  for (const k of Object.keys(obj)) if (!expSet.has(k)) errors.push({ code: 'UNKNOWN_FIELD', path: k });
  if (!('ops' in obj)) {
    return { ok: false, errors: sortErrors(errors) };
  }
  const opsRaw = obj.ops;
  if (!Array.isArray(opsRaw)) {
    errors.push({ code: 'WRONG_TYPE', path: 'ops' });
    return { ok: false, errors: sortErrors(errors) };
  }
  if (opsRaw.length === 0) errors.push({ code: 'EMPTY_PROPOSAL', path: 'ops' });
  if (opsRaw.length > TPL_LIMITS.OPS_MAX) errors.push({ code: 'TOO_MANY_OPS', path: 'ops' });

  // validate each op
  for (let i=0;i<opsRaw.length;i++) {
    const opRaw = opsRaw[i];
    const opPath = `ops[${i}]`;
    if (!isPlainObject(opRaw)) {
      errors.push({ code: 'WRONG_TYPE', path: opPath });
      continue;
    }
    for (const k of ALL_OP_KEYS) if (!(k in opRaw)) errors.push({ code: 'MISSING_FIELD', path: `${opPath}.${k}` });
    const opSet = new Set<string>(ALL_OP_KEYS);
    for (const k of Object.keys(opRaw)) if (!opSet.has(k)) errors.push({ code: 'UNKNOWN_FIELD', path: `${opPath}.${k}` });

    // op kind
    let opKind: string | null = null;
    if ('op' in opRaw) {
      const o = (opRaw as Record<string,unknown>).op;
      if (typeof o !== 'string') errors.push({ code: 'WRONG_TYPE', path: `${opPath}.op` });
      else if (!(OP_KINDS as readonly string[]).includes(o)) errors.push({ code: 'BAD_OP', path: `${opPath}.op` });
      else opKind = o;
    }
    // slot
    if ('slot' in opRaw) {
      const s = (opRaw as Record<string,unknown>).slot;
      if (s !== null) {
        if (typeof s !== 'string') errors.push({ code: 'WRONG_TYPE', path: `${opPath}.slot` });
        else if (!SLOT_KEYS.includes(s)) errors.push({ code: 'BAD_SLOT_ID', path: `${opPath}.slot` });
      }
    }
    // component
    if ('component' in opRaw) {
      const c = (opRaw as Record<string,unknown>).component;
      if (c !== null) {
        if (typeof c !== 'string') errors.push({ code: 'WRONG_TYPE', path: `${opPath}.component` });
        else if (!(COMPONENTS as readonly string[]).includes(c)) errors.push({ code: 'BAD_COMPONENT', path: `${opPath}.component` });
      }
    }
    // field
    if ('field' in opRaw) {
      const f = (opRaw as Record<string,unknown>).field;
      if (f !== null) {
        if (typeof f !== 'string') errors.push({ code: 'WRONG_TYPE', path: `${opPath}.field` });
        else if (!(TEMPLATE_FIELDS as readonly string[]).includes(f)) errors.push({ code: 'FIELD_COMPONENT_MISMATCH', path: `${opPath}.field` });
      }
    }
    // row
    if ('row' in opRaw) {
      const r = (opRaw as Record<string,unknown>).row;
      if (r !== null) {
        if (typeof r !== 'number') errors.push({ code: 'WRONG_TYPE', path: `${opPath}.row` });
        else if (!Number.isSafeInteger(r)) errors.push({ code: 'WRONG_TYPE', path: `${opPath}.row` });
      }
    }
    // col
    if ('col' in opRaw) {
      const c = (opRaw as Record<string,unknown>).col;
      if (c !== null) {
        if (typeof c !== 'number') errors.push({ code: 'WRONG_TYPE', path: `${opPath}.col` });
        else if (!Number.isSafeInteger(c)) errors.push({ code: 'WRONG_TYPE', path: `${opPath}.col` });
      }
    }
    // label
    if ('label' in opRaw) {
      const l = (opRaw as Record<string,unknown>).label;
      if (l !== null) {
        if (typeof l !== 'string') errors.push({ code: 'WRONG_TYPE', path: `${opPath}.label` });
        else {
          if (l.length < 1 || l.length > TPL_LIMITS.LABEL_MAX) errors.push({ code: 'BAD_LABEL', path: `${opPath}.label` });
          if (hasCodeLike(l)) errors.push({ code: 'CODE_LIKE', path: `${opPath}.label` });
          if (hasControl(l)) errors.push({ code: 'CONTROL_CHAR', path: `${opPath}.label` });
        }
      }
    }
    // token
    let tokenValid: string | null = null;
    if ('token' in opRaw) {
      const tk = (opRaw as Record<string,unknown>).token;
      if (tk !== null) {
        if (typeof tk !== 'string') errors.push({ code: 'WRONG_TYPE', path: `${opPath}.token` });
        else if (!(TOKEN_NAMES as readonly string[]).includes(tk)) errors.push({ code: 'BAD_TOKEN', path: `${opPath}.token` });
        else tokenValid = tk;
      }
    }
    // value
    if ('value' in opRaw) {
      const v = (opRaw as Record<string,unknown>).value;
      if (v !== null) {
        if (typeof v !== 'string') errors.push({ code: 'WRONG_TYPE', path: `${opPath}.value` });
        else if (tokenValid !== null) {
          const allowed = (TOKENS as Record<string, readonly string[]>)[tokenValid]!;
          if (!allowed.includes(v)) errors.push({ code: 'BAD_TOKEN_VALUE', path: `${opPath}.value` });
        }
      }
    }

    // OP_FIELDS per kind
    if (opKind !== null) {
      const req = new Set(REQUIRED[opKind]!);
      const allNonOp = ['slot','component','field','row','col','label','token','value'] as const;
      for (const k of allNonOp) {
        const val = (opRaw as Record<string,unknown>)[k];
        if (req.has(k)) {
          if (val === null || val === undefined) {
            // required must be non-null; test accepts either MISSING_FIELD or OP_FIELDS; we already have missing key case; for null we emit OP_FIELDS
            errors.push({ code: 'OP_FIELDS', path: `${opPath}.${k}` });
          }
        } else {
          if (val !== null && val !== undefined) {
            errors.push({ code: 'OP_FIELDS', path: `${opPath}.${k}` });
          }
        }
      }
    }
  }

  if (errors.length) return { ok: false, errors: sortErrors(errors) };
  // build Proposal copy without mutating input
  return { ok: true, value: structuredClone(p) as unknown as Proposal };
}

// Per-property touch tracking (B9): an error is attributed to the operation
// that last changed the offending property, never to a later benign edit.
// - geo: placement/shape changes (add_slot, remove_slot, move_slot)
// - label: label changes (add_slot, rename_label)
// - comp: component/field/identity changes (add_slot is the only op that sets them)
interface TouchMaps {
  geo: ReadonlyMap<string, number>;
  label: ReadonlyMap<string, number>;
  comp: ReadonlyMap<string, number>;
  token: ReadonlyMap<string, number>;
}

// Attribute a final-revalidation error to the op that caused it (B9).
function attributeError(
  e: TplReject,
  ops: readonly EditOp[],
  finalSlots: readonly UserSlot[],
  touch: TouchMaps,
  baseStatusId: string | null,
): number {
  const fallback = ops.length - 1;
  const slotIdx = /^slots\[(\d+)\]/.exec(e.path)?.[1];
  const slotId = slotIdx !== undefined ? finalSlots[Number(slotIdx)]?.id : undefined;
  if (e.code === 'MISSING_STATUS') {
    // blame the remove that dropped the status slot
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i]!;
      if (o.op === 'remove_slot' && o.slot === baseStatusId) return i;
    }
  }
  if (e.code === 'CELL_TAKEN' && slotId !== undefined) {
    // the collision was created by whichever placement change (add/move) put
    // one of the two slots in the cell last; label edits never cause it.
    const s = finalSlots.find((x) => x.id === slotId);
    if (s) {
      let best = touch.geo.get(slotId) ?? -1;
      for (const other of finalSlots) {
        if (other.id !== slotId && other.row === s.row && other.col === s.col) {
          best = Math.max(best, touch.geo.get(other.id) ?? -1);
        }
      }
      if (best >= 0) return best;
    }
  }
  if (e.code === 'TOO_MANY_SLOTS') {
    // blame the add that first pushed the count past the cap
    let count = finalSlots.length - ops.filter((o) => o.op === 'add_slot').length + ops.filter((o) => o.op === 'remove_slot').length;
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i]!;
      if (o.op === 'add_slot') count++;
      else if (o.op === 'remove_slot') count--;
      if (o.op === 'add_slot' && count > TPL_LIMITS.SLOTS_MAX) return i;
    }
    return fallback;
  }
  if (e.code === 'TOO_FEW_SLOTS') {
    for (let i = ops.length - 1; i >= 0; i--) {
      if (ops[i]!.op === 'remove_slot') return i;
    }
    return fallback;
  }
  if ((e.code === 'BAD_TOKEN' || e.code === 'BAD_TOKEN_VALUE') && e.path.startsWith('tokens.')) {
    const name = e.path.slice('tokens.'.length);
    const touched = touch.token.get(name);
    if (touched !== undefined) return touched;
  }
  if (slotId !== undefined) {
    // Route by the offending property: a label error follows the last label
    // write, a geometry error the last placement write, a component/field/id
    // error the last op that set it. A later rename must not steal blame
    // for an earlier bad move, and vice versa.
    const sufIdx = e.path.lastIndexOf('.');
    const suffix = sufIdx >= 0 ? e.path.slice(sufIdx + 1) : '';
    let touched: number | undefined;
    if (suffix === 'label') touched = touch.label.get(slotId);
    else if (suffix === 'row' || suffix === 'col') touched = touch.geo.get(slotId);
    else if (suffix === 'component' || suffix === 'field' || suffix === 'id') touched = touch.comp.get(slotId);
    else if (suffix === '') touched = touch.geo.get(slotId);
    if (touched !== undefined) return touched;
    // Fallback: any touch of this slot, latest first.
    const any = Math.max(touch.geo.get(slotId) ?? -1, touch.label.get(slotId) ?? -1, touch.comp.get(slotId) ?? -1);
    if (any >= 0) return any;
  }
  return fallback;
}

export function applyOps(t: UserTemplate, p: Proposal): TplResult<UserTemplate> {
  // total, never throws, never mutates
  try {
    // validate the base template first (B2): hostile inputs are rejected
    // here, before any clone could invoke an accessor.
    const vbase = validateTemplate(t);
    if (!vbase.ok) return vbase;

    // validate proposal shape (covers BAD_TOKEN etc when called directly without validateProposal)
    const vprop = validateProposal(p);
    if (!vprop.ok) return vprop as TplResult<UserTemplate>;

    const ops = (vprop.value as Proposal).ops;
    const copy = structuredClone(vbase.value) as UserTemplate;

    const baseStatusId = vbase.value.slots.find((s) => s.field === 'status')?.id ?? null;
    const geoTouch = new Map<string, number>();
    const labelTouch = new Map<string, number>();
    const compTouch = new Map<string, number>();
    const tokenTouch = new Map<string, number>();
    const opErrs: TplReject[] = [];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      const opPath = `ops[${i}]`;
      if (op.slot !== null) {
        if (op.op === 'add_slot' || op.op === 'remove_slot' || op.op === 'move_slot') geoTouch.set(op.slot, i);
        if (op.op === 'add_slot' || op.op === 'rename_label') labelTouch.set(op.slot, i);
        if (op.op === 'add_slot') compTouch.set(op.slot, i);
      }
      if (op.op === 'set_token' && op.token !== null) tokenTouch.set(op.token, i);
      if (op.op === 'add_slot') {
        if (copy.slots.some((s) => s.id === op.slot)) {
          opErrs.push({ code: 'SLOT_EXISTS', path: opPath });
        } else {
          const newSlot: UserSlot = {
            id: op.slot!,
            component: op.component!,
            field: op.field!,
            label: op.label!,
            row: op.row!,
            col: op.col!,
          };
          copy.slots.push(newSlot);
        }
      } else if (op.op === 'remove_slot') {
        const idx = copy.slots.findIndex((s) => s.id === op.slot);
        if (idx < 0) opErrs.push({ code: 'SLOT_NOT_FOUND', path: opPath });
        else copy.slots.splice(idx, 1);
      } else if (op.op === 'move_slot') {
        const s = copy.slots.find((x) => x.id === op.slot);
        if (!s) opErrs.push({ code: 'SLOT_NOT_FOUND', path: opPath });
        else { s.row = op.row!; s.col = op.col!; }
      } else if (op.op === 'rename_label') {
        const s = copy.slots.find((x) => x.id === op.slot);
        if (!s) opErrs.push({ code: 'SLOT_NOT_FOUND', path: opPath });
        else s.label = op.label!;
      } else if (op.op === 'set_token') {
        if (op.token !== null && op.value !== null) {
          (copy.tokens as Record<string, string>)[op.token] = op.value;
        }
      }
    }
    if (opErrs.length) return { ok: false, errors: sortErrors(opErrs) };

    // revalidate result (B3-B6); attribute each error to its causing op
    const v2 = validateTemplate(copy);
    if (!v2.ok) {
      const touch: TouchMaps = { geo: geoTouch, label: labelTouch, comp: compTouch, token: tokenTouch };
      const mapped: TplReject[] = v2.errors.map((e) => {
        const idx = attributeError(e, ops, copy.slots, touch, baseStatusId);
        const prefixed = e.path ? `ops[${idx}].${e.path}` : `ops[${idx}]`;
        return e.detail !== undefined ? { code: e.code, path: prefixed, detail: e.detail } : { code: e.code, path: prefixed };
      });
      return { ok: false, errors: sortErrors(mapped) };
    }
    return { ok: true, value: v2.value };
  } catch {
    return { ok: false, errors: [{ code: 'NOT_PLAIN', path: '' }] };
  }
}
