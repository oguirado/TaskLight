// Oracle helpers: independent reference implementations (never import the unit under test for expected values).
/* eslint-disable @typescript-eslint/no-explicit-any */
export type D = any;

export function refFnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
export function refCanon(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(refCanon).join(",") + "]";
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + refCanon(o[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}
export function rehash(d: D): D {
  const { template_hash: _h, ...rest } = d;
  return { ...rest, template_hash: refFnv(refCanon(rest)) };
}
export const clone = <T>(v: T): T => structuredClone(v);

const nn = { nullable: false } as const;
const ATT = ["none", "low", "high", "now"];
const summarySchema = () => ({
  mimeType: "application/json",
  schema: {
    type: "object", nullable: false, required: ["headline", "summary"],
    properties: { headline: { type: "string", ...nn }, summary: { type: "string", ...nn } },
  },
});
const nextSchema = () => ({
  mimeType: "application/json",
  schema: {
    type: "object", nullable: false, required: ["next_action", "attention"],
    properties: { next_action: { type: "string", ...nn }, attention: { type: "string", enum: [...ATT], ...nn } },
  },
});
const digestSchema = () => ({
  mimeType: "application/json",
  schema: {
    type: "object", nullable: false, required: ["needs_you", "brief"],
    properties: {
      needs_you: {
        type: "array", nullable: false,
        items: {
          type: "object", nullable: false, required: ["projectId", "reason", "attention"],
          properties: {
            projectId: { type: "string", ...nn }, reason: { type: "string", ...nn },
            attention: { type: "string", enum: [...ATT], ...nn },
          },
        },
      },
      brief: { type: "string", ...nn },
    },
  },
});
export const planSchema = () => ({
  mimeType: "application/json",
  schema: {
    type: "object", nullable: false, required: ["steps", "progress"],
    properties: {
      steps: {
        type: "array", nullable: false,
        items: {
          type: "object", nullable: false, required: ["text", "state"],
          properties: {
            text: { type: "string", ...nn },
            state: { type: "string", enum: ["todo", "doing", "done"], ...nn },
          },
        },
      },
      progress: { type: "number", ...nn },
    },
  },
});
const statusSchema = (statuses: string[]) => ({
  mimeType: "text/x.enum",
  schema: { type: "string", enum: [...statuses], ...nn },
});

export const DEV_STATUSES = ["running", "waiting_input", "blocked", "failed", "done", "idle"];
export const STUDY_STATUS_LIST = ["not_started", "reading", "practising", "stuck", "review_due", "done"];
export const DEV_KINDS = {
  agent: ["output", "waiting_input", "error", "exit"],
  ci: ["ci_started", "ci_passed", "ci_failed"],
  git: ["commit", "push"],
};
export const STUDY_KINDS = {
  tab: ["tab_pinned", "tab_focused"], selection: ["selection_captured"],
  page: ["page_snapshot"], doc: ["doc_added"],
};
const b = (slot: string, field: string, write: string) => ({ slot, field, write });
const COMMON_TPL = () => [
  b("status_chip", "status", "class"), b("headline", "headline", "textContent"),
  b("summary", "summary", "textContent"), b("next_step", "next_action", "textContent"),
  b("checklist", "steps", "textContent"),
  b("source_badge", "inference_source", "class"), b("stale_badge", "stale", "class"),
];

export function devDescriptor(): D {
  return rehash({
    lens_id: "dev", label: "Dev", statuses: [...DEV_STATUSES],
    tasks: ["status", "summary", "next_action", "digest", "plan"],
    task_schemas: {
      status: statusSchema(DEV_STATUSES), summary: summarySchema(), next_action: nextSchema(),
      digest: digestSchema(), plan: planSchema(),
    },
    prompt_pack: { id: "dev", version: "v1" },
    sources: ["agent", "ci", "git"], kind_groups: clone(DEV_KINDS),
    template: COMMON_TPL(),
    layout: { step_rows: 5, focus_banner: false, order: "attention_then_project" },
    template_hash: "",
  });
}
export function studyDescriptor(): D {
  return rehash({
    lens_id: "study", label: "Study", statuses: [...STUDY_STATUS_LIST],
    tasks: ["status", "summary", "next_action", "plan", "digest"],
    task_schemas: {
      status: statusSchema(STUDY_STATUS_LIST), summary: summarySchema(), next_action: nextSchema(),
      plan: planSchema(), digest: digestSchema(),
    },
    prompt_pack: { id: "study", version: "v1" },
    sources: ["tab", "selection", "page", "doc"], kind_groups: clone(STUDY_KINDS),
    template: [...COMMON_TPL(), b("progress", "progress", "attribute"), b("focus_banner", "attention", "textContent")],
    layout: { step_rows: 5, focus_banner: true, order: "attention_then_project" },
    template_hash: "",
  });
}
/** Study descriptor with plan/checklist/progress removed (T9 shape), rehashed. */
export function studyT9(): D {
  const d = studyDescriptor();
  d.tasks = d.tasks.filter((t: string) => t !== "plan");
  delete d.task_schemas.plan;
  d.template = d.template.filter((x: D) => x.slot !== "checklist" && x.slot !== "progress");
  d.layout.step_rows = 0;
  return rehash(d);
}
export function withStatuses(d: D, statuses: string[]): D {
  const c = clone(d);
  c.statuses = statuses;
  c.task_schemas.status.schema.enum = [...statuses];
  return rehash(c);
}

export function codesOf(r: D): string[] {
  return r.ok ? [] : r.errors.map((e: D) => e.code);
}
export function hasCode(r: D, code: string, path?: string): boolean {
  return !r.ok && r.errors.some((e: D) => e.code === code && (path === undefined || e.path === path));
}
export function anyCode(r: D, codes: string[]): boolean {
  return !r.ok && r.errors.some((e: D) => codes.includes(e.code));
}
export function deepFrozen(v: unknown, seen = new Set<unknown>()): boolean {
  if (v === null || typeof v !== "object") return true;
  if (seen.has(v)) return true;
  seen.add(v);
  if (!Object.isFrozen(v)) return false;
  return Object.values(v as object).every((x) => deepFrozen(x, seen));
}
