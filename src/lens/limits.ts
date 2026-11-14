// STUB (oracle phase U25): constants per SPEC_U25 §2; behaviour modules are wrong on purpose.
export const LENS_LIMITS = {
  STATUSES_MIN: 2,
  STATUSES_MAX: 8,
  STATUS_RE: /^[a-z][a-z0-9_]{0,23}$/,
  LENS_ID_RE: /^[a-z][a-z0-9_]{0,15}$/,
  IDENT_RE: /^[a-z][a-z0-9_.-]{0,31}$/,
  LABEL_MAX: 40,
  PLAN_STEPS_MAX: 5,
  STEP_TEXT_MAX: 80,
  PROGRESS_MIN: 0,
  PROGRESS_MAX: 100,
} as const;
export const B2_KEYWORDS = ["type", "properties", "required", "items", "enum", "nullable"] as const;
export const STUDY_STATUSES = ["not_started", "reading", "practising", "stuck", "review_due", "done"] as const;
export const STEP_STATE = ["todo", "doing", "done"] as const;
