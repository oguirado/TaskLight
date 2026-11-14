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

export const DEV_STATUSES = ["running", "waiting_input", "blocked", "failed", "done", "idle"];

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

export const DEV_KINDS = {
  agent: ["output", "waiting_input", "error", "exit"],
  ci: ["ci_started", "ci_passed", "ci_failed"],
  git: ["commit", "push"],
};

function buildDev(): LensDescriptor {
  const rest = {
    lens_id: "dev" as const,
    label: "Dev",
    statuses: [...DEV_STATUSES],
    tasks: ["status", "summary", "next_action", "digest", "plan"] as LensDescriptor["tasks"],
    task_schemas: {
      status: statusSchema(DEV_STATUSES),
      summary: clone(TASK_SCHEMAS.summary),
      next_action: clone(TASK_SCHEMAS.next_action),
      digest: clone(TASK_SCHEMAS.digest),
      plan: planSchema(),
    } as LensDescriptor["task_schemas"],
    prompt_pack: { id: "dev", version: "v1" },
    sources: ["agent", "ci", "git"] as LensDescriptor["sources"],
    kind_groups: clone(DEV_KINDS) as unknown as LensDescriptor["kind_groups"],
    template: [...COMMON_TPL] as LensDescriptor["template"],
    layout: { step_rows: 5 as const, focus_banner: false, order: "attention_then_project" as const },
  };
  return { ...rest, template_hash: lensHash(rest as Omit<LensDescriptor, "template_hash">) };
}

export const DEV_LENS_DESCRIPTOR: LensDescriptor = buildDev();
