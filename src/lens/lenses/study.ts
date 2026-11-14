import { TASK_SCHEMAS } from "../../schema/index";
import { lensHash } from "../hash";
import type { LensDescriptor, SlotBinding } from "../types";

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function planSchema() {
  return {
    mimeType: "application/json" as const,
    schema: {
      type: "object" as const,
      nullable: false as const,
      required: ["steps", "progress"],
      properties: {
        steps: {
          type: "array" as const,
          nullable: false as const,
          items: {
            type: "object" as const,
            nullable: false as const,
            required: ["text", "state"],
            properties: {
              text: { type: "string" as const, nullable: false as const },
              state: { type: "string" as const, enum: ["todo", "doing", "done"], nullable: false as const },
            },
          },
        },
        progress: { type: "number" as const, nullable: false as const },
      },
    },
  };
}

export const STUDY_STATUSES = ["not_started", "reading", "practising", "stuck", "review_due", "done"];

function statusSchema(statuses: readonly string[]) {
  return {
    mimeType: "text/x.enum" as const,
    schema: { type: "string" as const, enum: [...statuses], nullable: false as const },
  };
}

const COMMON_TPL: SlotBinding[] = [
  { slot: "status_chip", field: "status", write: "class" },
  { slot: "headline", field: "headline", write: "textContent" },
  { slot: "summary", field: "summary", write: "textContent" },
  { slot: "next_step", field: "next_action", write: "textContent" },
  { slot: "checklist", field: "steps", write: "textContent" },
  { slot: "source_badge", field: "inference_source", write: "class" },
  { slot: "stale_badge", field: "stale", write: "class" },
];

export const STUDY_KINDS = {
  tab: ["tab_pinned", "tab_focused"],
  selection: ["selection_captured"],
  page: ["page_snapshot"],
  doc: ["doc_added"],
};

function buildStudy(): LensDescriptor {
  const rest = {
    lens_id: "study" as const,
    label: "Study",
    statuses: [...STUDY_STATUSES],
    tasks: ["status", "summary", "next_action", "plan", "digest"] as LensDescriptor["tasks"],
    task_schemas: {
      status: statusSchema(STUDY_STATUSES),
      summary: clone(TASK_SCHEMAS.summary),
      next_action: clone(TASK_SCHEMAS.next_action),
      plan: planSchema(),
      digest: clone(TASK_SCHEMAS.digest),
    } as LensDescriptor["task_schemas"],
    prompt_pack: { id: "study", version: "v1" },
    sources: ["tab", "selection", "page", "doc"] as LensDescriptor["sources"],
    kind_groups: clone(STUDY_KINDS) as unknown as LensDescriptor["kind_groups"],
    template: [
      ...COMMON_TPL,
      { slot: "progress", field: "progress", write: "attribute" },
      { slot: "focus_banner", field: "attention", write: "textContent" },
    ] as LensDescriptor["template"],
    layout: { step_rows: 5 as const, focus_banner: true, order: "attention_then_project" as const },
  };
  return { ...rest, template_hash: lensHash(rest as Omit<LensDescriptor, "template_hash">) };
}

export const STUDY_LENS_DESCRIPTOR: LensDescriptor = buildStudy();
