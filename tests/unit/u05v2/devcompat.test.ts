import { describe, expect, it } from "vitest";
import { DEV_LENS, validateLensVocab } from "../../../src/schema/index";
import type { LensVocab } from "../../../src/schema/index";
import { A, codes, has, j, patch, state, vPatch, vState, vTask } from "./helpers";
import type { V } from "./helpers";

// V13: the v1 oracle (O1-O15, N1-N10) re-run through the v2 entry points, once with the default lens
// (arg omitted) and once with explicit DEV_LENS. Results must be identical to each other and to v1.
const item = (id: string) => ({ projectId: id, reason: "r", attention: "low" });
type Case = { name: string; run: (lens?: LensVocab) => V; ok?: true; code?: string; path?: string; value?: unknown };
const T = (task: string, raw: string, extra: Record<string, unknown> = {}) => (lens?: LensVocab) =>
  vTask(task, raw, { ...(lens ? { lens } : {}), ...extra });
const S = (s: unknown, tier: "private" | "standard" | "shared") => (lens?: LensVocab) => vState(s, tier, lens);
const Pt = (p: unknown, tier: "private" | "standard" | "shared") => (lens?: LensVocab) => vPatch(p, tier, lens);

const cases: Case[] = [
  { name: "O1 status bare", run: T("status", "blocked"), ok: true, value: { status: "blocked" } },
  { name: "O2 status off enum", run: T("status", "waiting"), code: "ENUM_VIOLATION" },
  { name: "O2b status casing", run: T("status", "Blocked"), code: "ENUM_VIOLATION" },
  { name: "O13 status quoted", run: T("status", '  "blocked" \n'), ok: true, value: { status: "blocked" } },
  { name: "O3 summary boundary", run: T("summary", j({ headline: A(120), summary: "b".repeat(600) })), ok: true },
  { name: "O4 headline 121", run: T("summary", j({ headline: A(121), summary: "s" })), code: "TOO_LONG", path: "headline" },
  { name: "O4b summary 601", run: T("summary", j({ headline: "h", summary: A(601) })), code: "TOO_LONG", path: "summary" },
  { name: "O5 extra key", run: T("summary", j({ headline: "h", summary: "s", html: "x" })), code: "UNKNOWN_FIELD", path: "html" },
  { name: "O6 truncated", run: T("summary", '{"headline":"Build fa'), code: "PARSE_ERROR" },
  { name: "O7 wrong type", run: T("summary", '{"headline":42}'), code: "WRONG_TYPE", path: "headline" },
  { name: "O7b missing", run: T("summary", '{"headline":42}'), code: "MISSING_FIELD", path: "summary" },
  { name: "O8 control char", run: T("next_action", j({ next_action: "x\u0007", attention: "high" })), code: "CONTROL_CHAR" },
  { name: "O8b DEL", run: T("next_action", j({ next_action: "a\u007fb", attention: "high" })), code: "CONTROL_CHAR" },
  { name: "O8c newline/tab ok", run: T("next_action", j({ next_action: "a\nb\tc", attention: "high" })), ok: true },
  { name: "O10 hallucinated project", run: T("digest", j({ needs_you: [item("p9")], brief: "b" }), { knownProjectIds: new Set(["p1"]) }), code: "UNKNOWN_PROJECT" },
  { name: "O10b no ctx", run: T("digest", j({ needs_you: [item("p9")], brief: "b" })), ok: true },
  { name: "O11 overflow", run: T("digest", j({ needs_you: Array.from({ length: 13 }, (_, i) => item(`q${i}`)), brief: "b" })), code: "TOO_MANY_ITEMS" },
  { name: "O11b dup", run: T("digest", j({ needs_you: [item("p1"), item("p1")], brief: "b" })), code: "DUPLICATE_PROJECT" },
  { name: "O11c twelve ok", run: T("digest", j({ needs_you: Array.from({ length: 12 }, (_, i) => item(`q${i}`)), brief: "b" })), ok: true },
  { name: "N2 screenshot status", run: T("screenshot", j({ status: "nope", note: "n" })), code: "ENUM_VIOLATION", path: "status" },
  { name: "N2b screenshot note 141", run: T("screenshot", j({ status: "idle", note: A(141) })), code: "TOO_LONG", path: "note" },
  { name: "O15a raw too large", run: T("summary", " ".repeat(8193)), code: "TOO_LARGE_RAW" },
  { name: "O15a empty", run: T("status", " \n\t"), code: "EMPTY" },
  { name: "N1 not object", run: T("summary", "[]"), code: "NOT_OBJECT" },
  { name: "N3 proto key", run: T("summary", '{"headline":"h","summary":"s","__proto__":{"x":1}}'), code: "UNKNOWN_FIELD", path: "__proto__" },
  { name: "O9 private summary", run: S(state({ summary: "secret" }), "private"), code: "PRIVATE_TEXT", path: "summary" },
  { name: "O9b private headline", run: S(state({ headline: "h" }), "private"), code: "PRIVATE_TEXT", path: "headline" },
  { name: "O9c private none ok", run: S(state(), "private"), ok: true, value: { ...state(), lens_id: "dev" } },
  { name: "O9d standard text ok", run: S(state({ summary: "fine" }), "standard"), ok: true, value: { ...state({ summary: "fine" }), lens_id: "dev" } },
  { name: "O9e shared text ok", run: S(state({ summary: "fine" }), "shared"), ok: true },
  { name: "N5 bad rev", run: S(state({ rev: -1 }), "standard"), code: "BAD_INT", path: "rev" },
  { name: "N5b bad updated_at", run: S(state({ updated_at: 0.5 }), "standard"), code: "BAD_INT", path: "updated_at" },
  { name: "N6 bad status", run: S(state({ status: "paused" }), "standard"), code: "ENUM_VIOLATION", path: "status" },
  { name: "N6b study status under dev", run: S(state({ status: "reading" }), "standard"), code: "ENUM_VIOLATION", path: "status" },
  { name: "N6c bad source", run: S(state({ inference_source: "on_device" }), "standard"), code: "BAD_SOURCE" },
  { name: "N6d null state", run: S(null, "standard"), code: "NOT_OBJECT" },
  { name: "state unknown field", run: S(state({ extra: 1 }), "standard"), code: "UNKNOWN_FIELD", path: "extra" },
  { name: "state explicit lens_id dev", run: S(state({ lens_id: "dev" }), "standard"), ok: true, value: { ...state(), lens_id: "dev" } },
  { name: "patch positive", run: Pt(patch(), "standard"), ok: true },
  { name: "O15b empty patch", run: Pt(patch({ fields: {} }), "standard"), code: "EMPTY_PATCH" },
  { name: "O15c unknown field", run: Pt(patch({ fields: { rev: 3 } }), "standard"), code: "UNKNOWN_FIELD", path: "fields.rev" },
  { name: "N7 headline 121", run: Pt(patch({ fields: { headline: A(121) } }), "standard"), code: "TOO_LONG", path: "fields.headline" },
  { name: "N7b status nope", run: Pt(patch({ fields: { status: "nope" } }), "standard"), code: "ENUM_VIOLATION", path: "fields.status" },
  { name: "N7c study status under dev", run: Pt(patch({ fields: { status: "review_due" } }), "standard"), code: "ENUM_VIOLATION", path: "fields.status" },
  { name: "N7d base_rev", run: Pt(patch({ base_rev: -1 }), "standard"), code: "BAD_INT", path: "base_rev" },
  { name: "N8 empty prompt_version", run: Pt(patch({ prompt_version: "" }), "standard"), code: "WRONG_TYPE", path: "prompt_version" },
  { name: "N9 private text", run: Pt(patch({ fields: { summary: "s" } }), "private"), code: "PRIVATE_TEXT", path: "fields.summary" },
  { name: "N9b private status+attention ok", run: Pt(patch({ fields: { status: "done", attention: "now" } }), "private"), ok: true },
  { name: "N10 non-object patch", run: Pt([], "standard"), code: "NOT_OBJECT" },
  { name: "patch explicit lens_id dev", run: Pt(patch({ lens_id: "dev" }), "standard"), ok: true },
];

describe("V13 dev_regression: v1 oracle through v2 entry points", () => {
  it("DEV_LENS is itself a valid LensVocab", () => {
    expect(validateLensVocab(DEV_LENS).ok).toBe(true);
  });
  for (const c of cases) {
    it(`${c.name}: default lens == explicit DEV_LENS == v1 expectation`, () => {
      const dflt = c.run();
      const expl = c.run(DEV_LENS);
      expect(expl).toEqual(dflt);
      if (c.ok) {
        expect(dflt.ok).toBe(true);
        if (c.value !== undefined) expect(dflt.ok && dflt.value).toEqual(c.value);
      } else {
        expect(has(dflt, c.code as string, c.path), `${c.name}: ${codes(dflt).join(",")}`).toBe(true);
      }
    });
  }
  it("v1 call shapes still type-check at runtime: 3rd arg undefined == omitted", () => {
    expect(vState(state(), "standard", undefined)).toEqual(vState(state(), "standard", DEV_LENS));
  });
  it("legacy docs: no lens_id anywhere still validates, and never gains plan fields", () => {
    const r = vState(state(), "standard");
    expect(r.ok && Object.keys(r.value).sort()).toEqual(
      ["attention", "inference_source", "lens_id", "observed_rev", "rev", "status", "updated_at", "writer_uid"],
    );
    const p = vPatch(patch(), "standard");
    expect(p.ok && p.value.fields).toEqual({ status: "done" });
  });
});
