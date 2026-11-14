import { STEP_STATE, validateCapsuleState, validatePatch, validateTaskOutput } from "../../../src/schema/index";
import type { JsonSchema, LensVocab, PrivacyTier, Validated } from "../../../src/schema/index";

// Loose (any-typed) v2 entry points: the v1 stubs have no `lens` parameter / no "plan" task in their types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type V = Validated<any>;
export const STUDY: LensVocab = {
  lens_id: "study",
  statuses: ["not_started", "reading", "practising", "stuck", "review_due", "done"],
};
export const STUDY_STATUSES = STUDY.statuses;

export const vTask = (task: string, raw: string, ctx?: { lens?: LensVocab; knownProjectIds?: ReadonlySet<string> }): V =>
  (validateTaskOutput as unknown as (t: string, r: string, c?: unknown) => V)(task, raw, ctx);
export const vState = (s: unknown, tier: PrivacyTier, lens?: LensVocab): V => {
  const f = validateCapsuleState as unknown as (s: unknown, t: string, l?: unknown) => V;
  return lens === undefined ? f(s, tier) : f(s, tier, lens);
};
export const vPatch = (p: unknown, tier: PrivacyTier, lens?: LensVocab): V => {
  const f = validatePatch as unknown as (p: unknown, t: string, l?: unknown) => V;
  return lens === undefined ? f(p, tier) : f(p, tier, lens);
};

export const pairs = (r: V): string[] => (r.ok ? [] : r.errors.map((e: { path: string; code: string }) => `${e.path}:${e.code}`));
export const codes = (r: V): string[] => (r.ok ? [] : r.errors.map((e: { code: string }) => e.code));
export const has = (r: V, code: string, path?: string): boolean =>
  !r.ok && r.errors.some((e: { code: string; path: string }) => e.code === code && (path === undefined || e.path === path));
export const j = (o: unknown): string => JSON.stringify(o);
export const A = (n: number): string => "a".repeat(n);
export const step = (state: string = "todo", text = "read ch2") => ({ text, state });
export const steps = (n: number) => Array.from({ length: n }, (_, i) => step(STEP_STATE[i % 3] as string, `s${i}`));

export const state = (extra: Record<string, unknown> = {}) => ({
  rev: 1, observed_rev: 1, status: "running", attention: "none",
  inference_source: "ON_DEVICE", updated_at: 1700000000000, writer_uid: "u1", ...extra,
});
export const studyState = (extra: Record<string, unknown> = {}) =>
  state({ lens_id: "study", status: "reading", ...extra });
export const patch = (extra: Record<string, unknown> = {}) => ({
  projectId: "p1", base_rev: 1, observed_rev: 1, prompt_version: "v1", template_hash: "h",
  inference_source: "IN_CLOUD", fields: { status: "done" }, ...extra,
});
export const studyPatch = (fields: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  patch({ lens_id: "study", fields, ...extra });

export const deepFrozen = (o: unknown): boolean =>
  typeof o !== "object" || o === null || (Object.isFrozen(o) && Object.values(o).every(deepFrozen));
export const walk = (s: JsonSchema, visit: (s: JsonSchema) => void): void => {
  visit(s);
  for (const p of Object.values(s.properties ?? {})) walk(p, visit);
  if (s.items) walk(s.items, visit);
};
export const B2_KEYWORDS = new Set(["type", "properties", "required", "items", "enum", "nullable"]);
/** Smallest instance that conforms to a B2-subset schema (used for schema/validator parity). */
export const sample = (s: JsonSchema): unknown => {
  if (s.type === "object") return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, sample(v)]));
  if (s.type === "array") return s.items ? [sample(s.items)] : [];
  if (s.type === "number") return 0;
  return s.enum ? s.enum[0] : "x";
};
