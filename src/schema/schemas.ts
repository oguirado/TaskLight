import { ATTENTION, CAPSULE_STATUS, STEP_STATE } from "./enums";
import type { TaskId } from "./enums";
import { validateLensVocab } from "./lens";
import type { LensVocab } from "./lens";
import type { JsonSchema, TaskSchema } from "./types";
import type { Validated } from "./validate";

function freezeDeep<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    if (Array.isArray(value)) {
      for (const item of value) freezeDeep(item);
    } else {
      for (const item of Object.values(value)) freezeDeep(item);
    }
    Object.freeze(value);
  }
  return value;
}

function statusSchema(statuses: readonly string[]): TaskSchema {
  return {
    mimeType: "text/x.enum",
    schema: { type: "string", enum: [...statuses], nullable: false },
  };
}

function planSchema(): TaskSchema {
  return {
    mimeType: "application/json",
    schema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string", nullable: false },
              state: { type: "string", enum: [...STEP_STATE], nullable: false },
            },
            required: ["text", "state"],
            nullable: false,
          },
          nullable: false,
        },
        progress: { type: "number", nullable: false },
      },
      required: ["steps", "progress"],
      nullable: false,
    },
  };
}

function buildAll(statuses: readonly string[]): Record<TaskId, TaskSchema> {
  return {
    status: statusSchema(statuses),
    summary: {
      mimeType: "application/json",
      schema: {
        type: "object",
        properties: {
          headline: { type: "string", nullable: false },
          summary: { type: "string", nullable: false },
        },
        required: ["headline", "summary"],
        nullable: false,
      },
    },
    next_action: {
      mimeType: "application/json",
      schema: {
        type: "object",
        properties: {
          next_action: { type: "string", nullable: false },
          attention: { type: "string", enum: [...ATTENTION], nullable: false },
        },
        required: ["next_action", "attention"],
        nullable: false,
      },
    },
    screenshot: {
      mimeType: "application/json",
      schema: {
        type: "object",
        properties: {
          status: { type: "string", enum: [...statuses], nullable: false },
          note: { type: "string", nullable: false },
        },
        required: ["status", "note"],
        nullable: false,
      },
    },
    digest: {
      mimeType: "application/json",
      schema: {
        type: "object",
        properties: {
          needs_you: {
            type: "array",
            items: {
              type: "object",
              properties: {
                projectId: { type: "string", nullable: false },
                reason: { type: "string", nullable: false },
                attention: { type: "string", enum: [...ATTENTION], nullable: false },
              },
              required: ["projectId", "reason", "attention"],
              nullable: false,
            },
            nullable: false,
          },
          brief: { type: "string", nullable: false },
        },
        required: ["needs_you", "brief"],
        nullable: false,
      },
    },
    plan: planSchema(),
  };
}

const devAll = buildAll(CAPSULE_STATUS);
const devTaskSchemas: Record<Exclude<TaskId, "plan">, TaskSchema> = {
  status: devAll.status,
  summary: devAll.summary,
  next_action: devAll.next_action,
  screenshot: devAll.screenshot,
  digest: devAll.digest,
};

export const TASK_SCHEMAS: Readonly<Record<Exclude<TaskId, "plan">, TaskSchema>> = freezeDeep(devTaskSchemas);

const memo = new Map<string, { key: string; value: Readonly<Record<TaskId, TaskSchema>> }>();

export function taskSchemasFor(lens: LensVocab): Validated<Readonly<Record<TaskId, TaskSchema>>> {
  const valid = validateLensVocab(lens);
  if (!valid.ok) return valid;
  const { lens_id, statuses } = valid.value;
  const key = statuses.join("\n");
  const hit = memo.get(lens_id);
  if (hit !== undefined) {
    if (hit.key !== key) {
      return { ok: false, errors: [{ code: "BAD_LENS", path: "lens" }] };
    }
    return { ok: true, value: hit.value };
  }
  const built = freezeDeep(buildAll(statuses));
  memo.set(lens_id, { key, value: built });
  return { ok: true, value: built };
}
