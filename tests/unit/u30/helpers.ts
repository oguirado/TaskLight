import type {
  EditOp, LensId, TemplateStore, TplReject, TplResult, UserSlot, UserTemplate,
} from '../../../src/template';

export const clone = <T>(x: T): T => structuredClone(x);

export function codes<T>(r: TplResult<T>): string[] {
  return r.ok ? [] : r.errors.map((e) => e.code);
}
export function errs<T>(r: TplResult<T>): TplReject[] {
  return r.ok ? [] : r.errors;
}
export function has<T>(r: TplResult<T>, code: string, pathPrefix?: string): boolean {
  return errs(r).some((e) => e.code === code && (pathPrefix === undefined || e.path.startsWith(pathPrefix)));
}

export const TOKENS_OK = { accent: 'blue', density: 'normal', radius: 'soft', scale: 'md' } as const;

const S = (id: UserSlot['id'], component: UserSlot['component'], field: UserSlot['field'],
  label: string, row: number, col: number): UserSlot => ({ id, component, field, label, row, col });

/** dev-valid fixture: 5 slots on 2 cols (cells r1c1 r1c2 r2c1 r2c2 r3c1 taken). */
export function baseDev(): UserTemplate {
  return {
    v: 1, lens_id: 'dev', name: 'Base', grid: { cols: 2 }, tokens: { ...TOKENS_OK },
    slots: [
      S('s1', 'chip', 'status', 'Status', 1, 1),
      S('s2', 'headline', 'headline', 'Title', 1, 2),
      S('s3', 'text', 'summary', 'Summary', 2, 1),
      S('s4', 'next', 'next_action', 'Next', 2, 2),
      S('s5', 'steps', 'steps', 'Steps', 3, 1),
    ],
  };
}
/** study-valid fixture: baseDev + progress at s6 r3c2. */
export function baseStudy(): UserTemplate {
  const t = baseDev();
  t.lens_id = 'study';
  t.slots.push(S('s6', 'progress', 'progress', 'Progress', 3, 2));
  return t;
}

export function op(p: Partial<EditOp> & { op: EditOp['op'] }): EditOp {
  return {
    slot: null, component: null, field: null, row: null, col: null, label: null, token: null, value: null, ...p,
  };
}
export const addSlot = (slot: EditOp['slot'], component: NonNullable<EditOp['component']>,
  field: NonNullable<EditOp['field']>, row: number, col: number, label: string): EditOp =>
  op({ op: 'add_slot', slot, component, field, row, col, label });
export const removeSlot = (slot: EditOp['slot']): EditOp => op({ op: 'remove_slot', slot });
export const moveSlot = (slot: EditOp['slot'], row: number, col: number): EditOp =>
  op({ op: 'move_slot', slot, row, col });
export const renameLabel = (slot: EditOp['slot'], label: string): EditOp =>
  op({ op: 'rename_label', slot, label });
export const setToken = (token: EditOp['token'], value: string): EditOp =>
  op({ op: 'set_token', token, value });

/** Recursively frozen check. */
export function deepFrozen(x: unknown, seen = new Set<unknown>()): boolean {
  if (x === null || typeof x !== 'object') return true;
  if (seen.has(x)) return true;
  seen.add(x);
  if (!Object.isFrozen(x)) return false;
  return Object.values(x as object).every((v) => deepFrozen(v, seen));
}
export function anyFrozen(x: unknown, seen = new Set<unknown>()): boolean {
  if (x === null || typeof x !== 'object') return false;
  if (seen.has(x)) return false;
  seen.add(x);
  if (Object.isFrozen(x)) return true;
  return Object.values(x as object).some((v) => anyFrozen(v, seen));
}

/** Independent canonical JSON: sorted keys, no whitespace. */
export function sortedJson(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(sortedJson).join(',')}]`;
  if (x !== null && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(x);
}

export class FakeStore implements TemplateStore {
  ring = new Map<LensId, unknown>();
  saves: Array<{ lens: LensId; ring: unknown }> = [];
  failNext = false;
  loadValue: { set: boolean; v: unknown } = { set: false, v: undefined };
  onSave: (() => void) | undefined;
  load(lens: LensId): Promise<unknown> {
    if (this.loadValue.set) return Promise.resolve(this.loadValue.v);
    return Promise.resolve(this.ring.has(lens) ? structuredClone(this.ring.get(lens)) : undefined);
  }
  save(lens: LensId, ring: unknown): Promise<void> {
    this.onSave?.();
    if (this.failNext) { this.failNext = false; return Promise.reject(new Error('disk full')); }
    this.saves.push({ lens, ring: structuredClone(ring) });
    this.ring.set(lens, structuredClone(ring));
    return Promise.resolve();
  }
}
