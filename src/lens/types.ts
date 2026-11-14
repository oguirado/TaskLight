import type { TaskSchema } from "../schema/index";

export type LensId = "dev" | "study";
export type LensTaskId = "status" | "summary" | "next_action" | "screenshot" | "digest" | "plan";
export type LensSource = "agent" | "ci" | "git" | "tab" | "selection" | "page" | "doc";
export type LensMode = "PREFER_ON_DEVICE" | "ONLY_ON_DEVICE" | "PREFER_IN_CLOUD" | "ONLY_IN_CLOUD";
export type SlotId =
  | "status_chip" | "headline" | "summary" | "next_step" | "checklist"
  | "progress" | "focus_banner" | "source_badge" | "stale_badge";
export type WriteKind = "textContent" | "class" | "attribute";
export interface SlotBinding { slot: SlotId; field: string; write: WriteKind }

export interface LensDescriptor {
  lens_id: string; label: string;
  statuses: readonly string[];
  tasks: readonly LensTaskId[];
  task_schemas: Readonly<Partial<Record<LensTaskId, TaskSchema>>>;
  prompt_pack: { id: string; version: string };
  sources: readonly LensSource[];
  kind_groups: Readonly<Partial<Record<LensSource, readonly string[]>>>;
  template: readonly SlotBinding[];
  layout: { step_rows: 0 | 5; focus_banner: boolean; order: "attention_then_project" };
  template_hash: string;
}
export type Lens = Readonly<LensDescriptor> & { readonly lens_id: LensId };

export type LensRejectCode =
  | "NOT_PLAIN" | "REMOTE_CODE" | "CODE_LIKE" | "MISSING_FIELD" | "UNKNOWN_FIELD" | "WRONG_TYPE"
  | "BAD_LENS_ID" | "TOO_FEW_STATUSES" | "TOO_MANY_STATUSES" | "BAD_STATUS" | "DUPLICATE_STATUS"
  | "UNKNOWN_TASK" | "MISSING_TASK" | "OFF_B2_KEYWORD" | "SCHEMA_MISMATCH" | "BAD_SOURCE"
  | "BAD_KIND_GROUP" | "BAD_TEMPLATE" | "BAD_LAYOUT" | "HASH_MISMATCH" | "DUPLICATE_LENS";
export interface LensReject { code: LensRejectCode; path: string; detail?: string }
export type LensResult<T> = { ok: true; value: T } | { ok: false; errors: LensReject[] };

export interface LensRegistry { get(id: string): Lens | undefined; ids(): readonly LensId[] }
