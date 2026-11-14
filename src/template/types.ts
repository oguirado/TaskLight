import type { TemplateSpec, FieldRule } from '../render/types';
import type { ComponentId, TemplateField } from './components';
import type { TokenName, Tokens } from './tokens';
import type { LensId } from '../lens';
export type { LensId };
export type SlotKey = 's1' | 's2' | 's3' | 's4' | 's5' | 's6' | 's7' | 's8' | 's9' | 's10' | 's11' | 's12';
export interface UserSlot { id: SlotKey; component: ComponentId; field: TemplateField; label: string; row: number; col: number }
export interface UserTemplate { v: 1; lens_id: LensId; name: string; grid: { cols: 1 | 2 | 3 }; tokens: Tokens; slots: UserSlot[] }

export type OpKind = 'add_slot' | 'remove_slot' | 'move_slot' | 'rename_label' | 'set_token';
export interface EditOp {
  op: OpKind; slot: SlotKey | null; component: ComponentId | null; field: TemplateField | null;
  row: number | null; col: number | null; label: string | null; token: TokenName | null; value: string | null;
}
export interface Proposal { ops: EditOp[] }

export interface CompiledTemplate {
  templateHash: string;
  spec: TemplateSpec;
  allowlist: Readonly<Partial<Record<TemplateField, FieldRule>>>;
  labels: Readonly<Record<string, string>>;
}

export type TplRejectCode = 'NOT_PLAIN' | 'MISSING_FIELD' | 'UNKNOWN_FIELD' | 'WRONG_TYPE' | 'BAD_VERSION'
  | 'BAD_LENS' | 'BAD_NAME' | 'BAD_GRID' | 'BAD_TOKEN' | 'BAD_TOKEN_VALUE' | 'TOO_MANY_SLOTS' | 'TOO_FEW_SLOTS'
  | 'BAD_SLOT_ID' | 'DUPLICATE_SLOT' | 'BAD_COMPONENT' | 'FIELD_COMPONENT_MISMATCH' | 'FIELD_NOT_IN_LENS'
  | 'DUPLICATE_FIELD' | 'MISSING_STATUS' | 'OUT_OF_GRID' | 'CELL_TAKEN' | 'BAD_LABEL' | 'CODE_LIKE' | 'CONTROL_CHAR'
  | 'EMPTY_PROPOSAL' | 'TOO_MANY_OPS' | 'BAD_OP' | 'OP_FIELDS' | 'SLOT_NOT_FOUND' | 'SLOT_EXISTS' | 'PROMPT_TOO_LARGE';
export interface TplReject { code: TplRejectCode; path: string; detail?: string }
export type TplResult<T> = { ok: true; value: T } | { ok: false; errors: TplReject[] };
