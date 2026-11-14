import { ATTENTION, INFERENCE_SOURCE, STEP_STATE } from "./enums";
import type { Attention, InferenceSource, PrivacyTier, StepState, TaskId } from "./enums";
import { DEV_LENS, validateLensVocab } from "./lens";
import type { LensVocab } from "./lens";
import type { CapsulePatch, CapsuleState, PatchFields, PlanStep, TaskOutputMap } from "./types";
import { LIMITS } from "./limits";

export type RejectCode =
  | "EMPTY" | "TOO_LARGE_RAW" | "PARSE_ERROR" | "NOT_OBJECT" | "MISSING_FIELD"
  | "UNKNOWN_FIELD" | "WRONG_TYPE" | "ENUM_VIOLATION" | "TOO_LONG" | "CONTROL_CHAR"
  | "TOO_MANY_ITEMS" | "UNKNOWN_PROJECT" | "DUPLICATE_PROJECT" | "PRIVATE_TEXT"
  | "BAD_SOURCE" | "BAD_INT" | "EMPTY_PATCH"
  | "BAD_LENS" | "LENS_MISMATCH" | "OUT_OF_RANGE";
export interface Reject { code: RejectCode; path: string; detail?: string }
export type Validated<T> = { ok: true; value: T } | { ok: false; errors: Reject[] };
export interface ValidateCtx { knownProjectIds?: ReadonlySet<string>; lens?: LensVocab }

const ATTENTION_SET: ReadonlySet<string> = new Set<string>(ATTENTION);
const SOURCE_SET: ReadonlySet<string> = new Set<string>(INFERENCE_SOURCE);
const STEP_STATE_SET: ReadonlySet<string> = new Set<string>(STEP_STATE);

function resolveLens(lens: LensVocab | undefined): Validated<LensVocab> {
  if (lens === undefined) return { ok: true, value: DEV_LENS };
  return validateLensVocab(lens);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function sortErrors(errors: Reject[]): Reject[] {
  return [...errors].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );
}

function fail<T>(errors: Reject[]): Validated<T> {
  return { ok: false, errors: sortErrors(errors) };
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x7f) return true;
    if (c < 0x20 && c !== 0x0a && c !== 0x09) return true;
  }
  return false;
}

function checkString(
  errors: Reject[],
  value: unknown,
  path: string,
  max: number,
): void {
  if (typeof value !== "string") {
    errors.push({ code: "WRONG_TYPE", path });
    return;
  }
  if (value.length > max) errors.push({ code: "TOO_LONG", path });
  if (hasControlChar(value)) errors.push({ code: "CONTROL_CHAR", path });
}

function checkEnum(
  errors: Reject[],
  value: unknown,
  path: string,
  set: ReadonlySet<string>,
): void {
  if (typeof value !== "string") {
    errors.push({ code: "WRONG_TYPE", path });
    return;
  }
  if (!set.has(value)) errors.push({ code: "ENUM_VIOLATION", path });
}

function isNonNegSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function checkProgress(errors: Reject[], value: unknown, path: string): number | undefined {
  if (typeof value !== "number") {
    errors.push({ code: "WRONG_TYPE", path });
    return undefined;
  }
  if (!Number.isInteger(value)) {
    errors.push({ code: "BAD_INT", path });
    return undefined;
  }
  if (value < LIMITS.PROGRESS_MIN || value > LIMITS.PROGRESS_MAX) {
    errors.push({ code: "OUT_OF_RANGE", path });
    return undefined;
  }
  return value;
}

function checkSteps(errors: Reject[], value: unknown, path: string): PlanStep[] | undefined {
  if (!Array.isArray(value)) {
    errors.push({ code: "WRONG_TYPE", path });
    return undefined;
  }
  if (value.length > LIMITS.STEPS_MAX) {
    errors.push({ code: "TOO_MANY_ITEMS", path });
  }
  const out: PlanStep[] = [];
  for (let i = 0; i < value.length; i++) {
    const el: unknown = value[i];
    const base = `${path}[${i}]`;
    if (!isPlainObject(el)) {
      errors.push({ code: "WRONG_TYPE", path: base });
      continue;
    }
    for (const k of Object.keys(el)) {
      if (k !== "text" && k !== "state") errors.push({ code: "UNKNOWN_FIELD", path: `${base}.${k}` });
    }
    if (!Object.hasOwn(el, "text")) errors.push({ code: "MISSING_FIELD", path: `${base}.text` });
    else checkString(errors, el["text"], `${base}.text`, LIMITS.STEP_TEXT_MAX);
    if (!Object.hasOwn(el, "state")) errors.push({ code: "MISSING_FIELD", path: `${base}.state` });
    else if (typeof el["state"] !== "string") {
      errors.push({ code: "WRONG_TYPE", path: `${base}.state` });
    } else if (!STEP_STATE_SET.has(el["state"] as string)) {
      errors.push({ code: "ENUM_VIOLATION", path: `${base}.state` });
    }
    if (typeof el["text"] === "string" && typeof el["state"] === "string") {
      out.push({ text: el["text"] as string, state: el["state"] as StepState });
    }
  }
  return out;
}

export function validateTaskOutput<K extends TaskId>(
  task: K,
  raw: string,
  ctx?: ValidateCtx,
): Validated<TaskOutputMap[K]> {
  const lensResult = resolveLens(ctx?.lens);
  if (!lensResult.ok) return fail<TaskOutputMap[K]>([{ code: "BAD_LENS", path: "lens" }]);
  const lensStatuses: ReadonlySet<string> = new Set<string>(lensResult.value.statuses);
  if (typeof raw !== "string") {
    return fail<TaskOutputMap[K]>([{ code: "WRONG_TYPE", path: "" }]);
  }
  if (raw.length > LIMITS.RAW_MAX) {
    return fail<TaskOutputMap[K]>([{ code: "TOO_LARGE_RAW", path: "" }]);
  }
  if (raw.trim().length === 0) {
    return fail<TaskOutputMap[K]>([{ code: "EMPTY", path: "" }]);
  }
  if (task !== "status" && task !== "summary" && task !== "next_action" && task !== "screenshot" && task !== "digest" && task !== "plan") {
    if (typeof task !== "string") {
      return fail<TaskOutputMap[K]>([{ code: "WRONG_TYPE", path: "task" }]);
    }
    return fail<TaskOutputMap[K]>([{ code: "ENUM_VIOLATION", path: "task" }]);
  }

  if (task === "status") {
    const trimmed = raw.trim();
    if (lensStatuses.has(trimmed)) {
      return { ok: true, value: { status: trimmed } as TaskOutputMap[K] };
    }
    if (trimmed.startsWith('"')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = undefined;
      }
      if (typeof parsed === "string" && lensStatuses.has(parsed)) {
        return { ok: true, value: { status: parsed } as TaskOutputMap[K] };
      }
    }
    return fail<TaskOutputMap[K]>([{ code: "ENUM_VIOLATION", path: "status" }]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail<TaskOutputMap[K]>([{ code: "PARSE_ERROR", path: "" }]);
  }
  if (!isPlainObject(parsed)) {
    return fail<TaskOutputMap[K]>([{ code: "NOT_OBJECT", path: "" }]);
  }
  const obj: Record<string, unknown> = parsed;
  const errors: Reject[] = [];

  if (task === "summary") {
    const allowed: ReadonlySet<string> = new Set(["headline", "summary"]);
    for (const k of Object.keys(obj)) {
      if (!allowed.has(k)) errors.push({ code: "UNKNOWN_FIELD", path: k });
    }
    if (!Object.hasOwn(obj, "headline")) errors.push({ code: "MISSING_FIELD", path: "headline" });
    else checkString(errors, obj["headline"], "headline", LIMITS.HEADLINE_MAX);
    if (!Object.hasOwn(obj, "summary")) errors.push({ code: "MISSING_FIELD", path: "summary" });
    else checkString(errors, obj["summary"], "summary", LIMITS.SUMMARY_MAX);
    if (errors.length > 0) return fail<TaskOutputMap[K]>(errors);
    return {
      ok: true,
      value: { headline: obj["headline"] as string, summary: obj["summary"] as string } as TaskOutputMap[K],
    };
  }

  if (task === "next_action") {
    const allowed: ReadonlySet<string> = new Set(["next_action", "attention"]);
    for (const k of Object.keys(obj)) {
      if (!allowed.has(k)) errors.push({ code: "UNKNOWN_FIELD", path: k });
    }
    if (!Object.hasOwn(obj, "next_action")) errors.push({ code: "MISSING_FIELD", path: "next_action" });
    else checkString(errors, obj["next_action"], "next_action", LIMITS.NEXT_ACTION_MAX);
    if (!Object.hasOwn(obj, "attention")) errors.push({ code: "MISSING_FIELD", path: "attention" });
    else checkEnum(errors, obj["attention"], "attention", ATTENTION_SET);
    if (errors.length > 0) return fail<TaskOutputMap[K]>(errors);
    return {
      ok: true,
      value: { next_action: obj["next_action"] as string, attention: obj["attention"] as Attention } as TaskOutputMap[K],
    };
  }

  if (task === "screenshot") {
    const allowed: ReadonlySet<string> = new Set(["status", "note"]);
    for (const k of Object.keys(obj)) {
      if (!allowed.has(k)) errors.push({ code: "UNKNOWN_FIELD", path: k });
    }
    if (!Object.hasOwn(obj, "status")) errors.push({ code: "MISSING_FIELD", path: "status" });
    else checkEnum(errors, obj["status"], "status", lensStatuses);
    if (!Object.hasOwn(obj, "note")) errors.push({ code: "MISSING_FIELD", path: "note" });
    else checkString(errors, obj["note"], "note", LIMITS.NOTE_MAX);
    if (errors.length > 0) return fail<TaskOutputMap[K]>(errors);
    return {
      ok: true,
      value: { status: obj["status"] as string, note: obj["note"] as string } as TaskOutputMap[K],
    };
  }

  if (task === "plan") {
    const allowed: ReadonlySet<string> = new Set(["steps", "progress"]);
    for (const k of Object.keys(obj)) {
      if (!allowed.has(k)) errors.push({ code: "UNKNOWN_FIELD", path: k });
    }
    let stepsOut: PlanStep[] | undefined;
    if (!Object.hasOwn(obj, "steps")) errors.push({ code: "MISSING_FIELD", path: "steps" });
    else stepsOut = checkSteps(errors, obj["steps"], "steps");
    let progress: number | undefined;
    if (!Object.hasOwn(obj, "progress")) errors.push({ code: "MISSING_FIELD", path: "progress" });
    else progress = checkProgress(errors, obj["progress"], "progress");
    if (errors.length > 0) return fail<TaskOutputMap[K]>(errors);
    return {
      ok: true,
      value: { steps: stepsOut as PlanStep[], progress: progress as number } as TaskOutputMap[K],
    };
  }

  if (task === "digest") {
    const allowed: ReadonlySet<string> = new Set(["needs_you", "brief"]);
    for (const k of Object.keys(obj)) {
      if (!allowed.has(k)) errors.push({ code: "UNKNOWN_FIELD", path: k });
    }
    const needValue = obj["needs_you"];
    const items: Record<string, unknown>[] = [];
    let itemsValid = true;
    if (!Object.hasOwn(obj, "needs_you")) {
      errors.push({ code: "MISSING_FIELD", path: "needs_you" });
      itemsValid = false;
    } else if (!Array.isArray(needValue)) {
      errors.push({ code: "WRONG_TYPE", path: "needs_you" });
      itemsValid = false;
    } else {
      if (needValue.length > LIMITS.NEEDS_YOU_MAX) {
        errors.push({ code: "TOO_MANY_ITEMS", path: "needs_you" });
      }
      const seen = new Set<string>();
      let dup = false;
      for (let i = 0; i < needValue.length; i++) {
        const rawItem: unknown = needValue[i];
        const base = `needs_you[${i}]`;
        if (!isPlainObject(rawItem)) {
          errors.push({ code: "WRONG_TYPE", path: base });
          continue;
        }
        const item = rawItem;
        items.push(item);
        const itemAllowed: ReadonlySet<string> = new Set(["projectId", "reason", "attention"]);
        for (const k of Object.keys(item)) {
          if (!itemAllowed.has(k)) errors.push({ code: "UNKNOWN_FIELD", path: `${base}.${k}` });
        }
        if (!Object.hasOwn(item, "projectId")) {
          errors.push({ code: "MISSING_FIELD", path: `${base}.projectId` });
        } else {
          const pid: unknown = item["projectId"];
          if (typeof pid !== "string") {
            errors.push({ code: "WRONG_TYPE", path: `${base}.projectId` });
          } else {
            if (hasControlChar(pid)) errors.push({ code: "CONTROL_CHAR", path: `${base}.projectId` });
            if (seen.has(pid)) dup = true;
            else seen.add(pid);
            if (ctx?.knownProjectIds !== undefined && !ctx.knownProjectIds.has(pid)) {
              errors.push({ code: "UNKNOWN_PROJECT", path: `${base}.projectId` });
            }
          }
        }
        if (!Object.hasOwn(item, "reason")) {
          errors.push({ code: "MISSING_FIELD", path: `${base}.reason` });
        } else {
          checkString(errors, item["reason"], `${base}.reason`, LIMITS.REASON_MAX);
        }
        if (!Object.hasOwn(item, "attention")) {
          errors.push({ code: "MISSING_FIELD", path: `${base}.attention` });
        } else {
          checkEnum(errors, item["attention"], `${base}.attention`, ATTENTION_SET);
        }
      }
      if (dup) errors.push({ code: "DUPLICATE_PROJECT", path: "needs_you" });
    }
    if (!Object.hasOwn(obj, "brief")) {
      errors.push({ code: "MISSING_FIELD", path: "brief" });
    } else {
      checkString(errors, obj["brief"], "brief", LIMITS.BRIEF_MAX);
    }
    if (errors.length > 0 || !itemsValid) return fail<TaskOutputMap[K]>(errors);
    const needsYou = items.map((it) => ({
      projectId: it["projectId"] as string,
      reason: it["reason"] as string,
      attention: it["attention"] as Attention,
    }));
    // Preserve original order including non-object items is impossible here: errors non-empty prevents success.
    return {
      ok: true,
      value: { needs_you: needsYou, brief: obj["brief"] as string } as TaskOutputMap[K],
    };
  }

  return fail<TaskOutputMap[K]>([{ code: "ENUM_VIOLATION", path: "task" }]);
}

export function validateInferenceSource(v: unknown): Validated<InferenceSource> {
  if (typeof v === "string" && SOURCE_SET.has(v)) {
    return { ok: true, value: v as InferenceSource };
  }
  return fail<InferenceSource>([{ code: "BAD_SOURCE", path: "inference_source" }]);
}

export function validateCapsuleState(s: unknown, tier: PrivacyTier, lens?: LensVocab): Validated<CapsuleState> {
  const lensResult = resolveLens(lens);
  if (!lensResult.ok) return fail<CapsuleState>([{ code: "BAD_LENS", path: "lens" }]);
  const lensStatuses: ReadonlySet<string> = new Set<string>(lensResult.value.statuses);
  if (!isPlainObject(s)) {
    return fail<CapsuleState>([{ code: "NOT_OBJECT", path: "" }]);
  }
  const obj: Record<string, unknown> = s;
  const errors: Reject[] = [];
  const allowed: ReadonlySet<string> = new Set([
    "lens_id", "rev", "observed_rev", "status", "headline", "summary", "next_action",
    "steps", "progress", "attention", "inference_source", "updated_at", "writer_uid",
  ]);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) errors.push({ code: "UNKNOWN_FIELD", path: k });
  }
  let lensId = "dev";
  if (Object.hasOwn(obj, "lens_id")) {
    if (typeof obj["lens_id"] !== "string") {
      errors.push({ code: "WRONG_TYPE", path: "lens_id" });
    } else {
      lensId = obj["lens_id"] as string;
      if (lensId !== lensResult.value.lens_id) errors.push({ code: "LENS_MISMATCH", path: "lens_id" });
    }
  } else if (lensResult.value.lens_id !== "dev") {
    errors.push({ code: "LENS_MISMATCH", path: "lens_id" });
  }
  if (!Object.hasOwn(obj, "rev")) errors.push({ code: "MISSING_FIELD", path: "rev" });
  else if (!isNonNegSafeInt(obj["rev"])) errors.push({ code: "BAD_INT", path: "rev" });
  if (!Object.hasOwn(obj, "observed_rev")) errors.push({ code: "MISSING_FIELD", path: "observed_rev" });
  else if (!isNonNegSafeInt(obj["observed_rev"])) errors.push({ code: "BAD_INT", path: "observed_rev" });
  if (!Object.hasOwn(obj, "updated_at")) errors.push({ code: "MISSING_FIELD", path: "updated_at" });
  else if (!isNonNegSafeInt(obj["updated_at"])) errors.push({ code: "BAD_INT", path: "updated_at" });
  if (!Object.hasOwn(obj, "status")) errors.push({ code: "MISSING_FIELD", path: "status" });
  else checkEnum(errors, obj["status"], "status", lensStatuses);
  if (!Object.hasOwn(obj, "attention")) errors.push({ code: "MISSING_FIELD", path: "attention" });
  else checkEnum(errors, obj["attention"], "attention", ATTENTION_SET);
  if (!Object.hasOwn(obj, "inference_source")) {
    errors.push({ code: "MISSING_FIELD", path: "inference_source" });
  } else if (!(typeof obj["inference_source"] === "string" && SOURCE_SET.has(obj["inference_source"]))) {
    errors.push({ code: "BAD_SOURCE", path: "inference_source" });
  }
  if (!Object.hasOwn(obj, "writer_uid")) {
    errors.push({ code: "MISSING_FIELD", path: "writer_uid" });
  } else if (typeof obj["writer_uid"] !== "string") {
    errors.push({ code: "WRONG_TYPE", path: "writer_uid" });
  } else if (hasControlChar(obj["writer_uid"] as string)) {
    errors.push({ code: "CONTROL_CHAR", path: "writer_uid" });
  }
  const textLimits: Record<string, number> = {
    headline: LIMITS.HEADLINE_MAX,
    summary: LIMITS.SUMMARY_MAX,
    next_action: LIMITS.NEXT_ACTION_MAX,
  };
  for (const k of ["headline", "summary", "next_action"]) {
    if (Object.hasOwn(obj, k)) {
      checkString(errors, obj[k], k, textLimits[k] as number);
      if (tier !== "standard" && tier !== "shared") errors.push({ code: "PRIVATE_TEXT", path: k });
    }
  }
  let stepsOut: PlanStep[] | undefined;
  if (Object.hasOwn(obj, "steps")) {
    stepsOut = checkSteps(errors, obj["steps"], "steps");
    if (tier !== "standard" && tier !== "shared") errors.push({ code: "PRIVATE_TEXT", path: "steps" });
  }
  let progress: number | undefined;
  if (Object.hasOwn(obj, "progress")) {
    progress = checkProgress(errors, obj["progress"], "progress");
  }
  if (errors.length > 0) return fail<CapsuleState>(errors);
  const value: CapsuleState = {
    lens_id: lensId,
    rev: obj["rev"] as number,
    observed_rev: obj["observed_rev"] as number,
    status: obj["status"] as string,
    attention: obj["attention"] as Attention,
    inference_source: obj["inference_source"] as InferenceSource,
    updated_at: obj["updated_at"] as number,
    writer_uid: obj["writer_uid"] as string,
    ...(Object.hasOwn(obj, "headline") ? { headline: obj["headline"] as string } : {}),
    ...(Object.hasOwn(obj, "summary") ? { summary: obj["summary"] as string } : {}),
    ...(Object.hasOwn(obj, "next_action") ? { next_action: obj["next_action"] as string } : {}),
    ...(stepsOut !== undefined ? { steps: stepsOut } : {}),
    ...(progress !== undefined ? { progress } : {}),
  };
  return { ok: true, value };
}

export function validatePatch(p: unknown, tier: PrivacyTier, lens?: LensVocab): Validated<CapsulePatch> {
  const lensResult = resolveLens(lens);
  if (!lensResult.ok) return fail<CapsulePatch>([{ code: "BAD_LENS", path: "lens" }]);
  const lensStatuses: ReadonlySet<string> = new Set<string>(lensResult.value.statuses);
  if (!isPlainObject(p)) {
    return fail<CapsulePatch>([{ code: "NOT_OBJECT", path: "" }]);
  }
  const obj: Record<string, unknown> = p;
  const errors: Reject[] = [];
  const allowed: ReadonlySet<string> = new Set([
    "lens_id", "projectId", "base_rev", "observed_rev", "prompt_version", "template_hash",
    "inference_source", "fields",
  ]);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) errors.push({ code: "UNKNOWN_FIELD", path: k });
  }
  let lensId = "dev";
  if (Object.hasOwn(obj, "lens_id")) {
    if (typeof obj["lens_id"] !== "string") {
      errors.push({ code: "WRONG_TYPE", path: "lens_id" });
    } else {
      lensId = obj["lens_id"] as string;
      if (lensId !== lensResult.value.lens_id) errors.push({ code: "LENS_MISMATCH", path: "lens_id" });
    }
  } else if (lensResult.value.lens_id !== "dev") {
    errors.push({ code: "LENS_MISMATCH", path: "lens_id" });
  }
  if (!Object.hasOwn(obj, "projectId")) errors.push({ code: "MISSING_FIELD", path: "projectId" });
  else if (typeof obj["projectId"] !== "string") errors.push({ code: "WRONG_TYPE", path: "projectId" });
  else if (hasControlChar(obj["projectId"] as string)) errors.push({ code: "CONTROL_CHAR", path: "projectId" });
  if (!Object.hasOwn(obj, "base_rev")) errors.push({ code: "MISSING_FIELD", path: "base_rev" });
  else if (!isNonNegSafeInt(obj["base_rev"])) errors.push({ code: "BAD_INT", path: "base_rev" });
  if (!Object.hasOwn(obj, "observed_rev")) errors.push({ code: "MISSING_FIELD", path: "observed_rev" });
  else if (!isNonNegSafeInt(obj["observed_rev"])) errors.push({ code: "BAD_INT", path: "observed_rev" });
  if (!Object.hasOwn(obj, "prompt_version")) {
    errors.push({ code: "MISSING_FIELD", path: "prompt_version" });
  } else if (typeof obj["prompt_version"] !== "string" || (obj["prompt_version"] as string).length === 0) {
    errors.push({ code: "WRONG_TYPE", path: "prompt_version" });
  }
  if (!Object.hasOwn(obj, "template_hash")) {
    errors.push({ code: "MISSING_FIELD", path: "template_hash" });
  } else if (typeof obj["template_hash"] !== "string" || (obj["template_hash"] as string).length === 0) {
    errors.push({ code: "WRONG_TYPE", path: "template_hash" });
  }
  if (!Object.hasOwn(obj, "inference_source")) {
    errors.push({ code: "MISSING_FIELD", path: "inference_source" });
  } else if (!(typeof obj["inference_source"] === "string" && SOURCE_SET.has(obj["inference_source"]))) {
    errors.push({ code: "BAD_SOURCE", path: "inference_source" });
  }

  let fields: PatchFields | undefined;
  if (!Object.hasOwn(obj, "fields")) {
    errors.push({ code: "MISSING_FIELD", path: "fields" });
  } else if (!isPlainObject(obj["fields"])) {
    errors.push({ code: "WRONG_TYPE", path: "fields" });
  } else {
    const rawFields: Record<string, unknown> = obj["fields"] as Record<string, unknown>;
    const fieldKeys = Object.keys(rawFields);
    const fieldAllowed: ReadonlySet<string> = new Set(["status", "headline", "summary", "next_action", "attention", "steps", "progress"]);
    if (fieldKeys.length === 0) {
      errors.push({ code: "EMPTY_PATCH", path: "fields" });
    } else {
      for (const k of fieldKeys) {
        if (!fieldAllowed.has(k)) errors.push({ code: "UNKNOWN_FIELD", path: `fields.${k}` });
      }
      let stepsOut: PlanStep[] | undefined;
      let progress: number | undefined;
      for (const k of fieldKeys) {
        if (!fieldAllowed.has(k)) continue;
        const fpath = `fields.${k}`;
        if (k === "status") checkEnum(errors, rawFields[k], fpath, lensStatuses);
        else if (k === "attention") checkEnum(errors, rawFields[k], fpath, ATTENTION_SET);
        else if (k === "headline") checkString(errors, rawFields[k], fpath, LIMITS.HEADLINE_MAX);
        else if (k === "summary") checkString(errors, rawFields[k], fpath, LIMITS.SUMMARY_MAX);
        else if (k === "next_action") checkString(errors, rawFields[k], fpath, LIMITS.NEXT_ACTION_MAX);
        else if (k === "steps") stepsOut = checkSteps(errors, rawFields[k], fpath);
        else if (k === "progress") progress = checkProgress(errors, rawFields[k], fpath);
      }
      if (tier !== "standard" && tier !== "shared") {
        for (const k of ["headline", "summary", "next_action"]) {
          if (Object.hasOwn(rawFields, k)) {
            errors.push({ code: "PRIVATE_TEXT", path: `fields.${k}` });
          }
        }
        if (Object.hasOwn(rawFields, "steps")) {
          errors.push({ code: "PRIVATE_TEXT", path: "fields.steps" });
        }
      }
      // Build patch fields copy from validated raw values (only when this block adds no error for those keys).
      const built: Record<string, unknown> = {};
      for (const k of fieldKeys) {
        if (k === "steps") {
          if (stepsOut !== undefined) built[k] = stepsOut;
        } else if (k === "progress") {
          if (progress !== undefined) built[k] = progress;
        } else if (fieldAllowed.has(k)) {
          built[k] = rawFields[k];
        }
      }
      fields = built as PatchFields;
    }
  }
  if (errors.length > 0) return fail<CapsulePatch>(errors);
  return {
    ok: true,
    value: {
      lens_id: lensId,
      projectId: obj["projectId"] as string,
      base_rev: obj["base_rev"] as number,
      observed_rev: obj["observed_rev"] as number,
      prompt_version: obj["prompt_version"] as string,
      template_hash: obj["template_hash"] as string,
      inference_source: obj["inference_source"] as InferenceSource,
      fields: fields as PatchFields,
    },
  };
}
