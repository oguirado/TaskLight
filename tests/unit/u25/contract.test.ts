/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { types } from "node:util";
import { B2_KEYWORDS, LENS_LIMITS, STEP_STATE, STUDY_STATUSES, validateLens } from "../../../src/lens/index";
import {
  anyCode, clone, devDescriptor, hasCode, planSchema, rehash, studyDescriptor, studyT9, withStatuses,
  type D,
} from "./helpers";

const v = (d: unknown) => validateLens(d) as D;

describe("positive controls (fixtures are valid)", () => {
  it("dev and study descriptors validate", () => {
    expect(v(devDescriptor()).ok).toBe(true);
    expect(v(studyDescriptor()).ok).toBe(true);
  });
  it("label may contain spaces and be exactly LABEL_MAX long", () => {
    const d = studyDescriptor(); d.label = "My Study Lens"; expect(v(rehash(d)).ok).toBe(true);
    d.label = "x".repeat(LENS_LIMITS.LABEL_MAX); expect(v(rehash(d)).ok).toBe(true);
  });
  it("constants match spec", () => {
    expect(LENS_LIMITS.STATUSES_MAX).toBe(8);
    expect(LENS_LIMITS.STATUSES_MIN).toBe(2);
    expect([...B2_KEYWORDS]).toEqual(["type", "properties", "required", "items", "enum", "nullable"]);
    expect([...STUDY_STATUSES]).toEqual(["not_started", "reading", "practising", "stuck", "review_due", "done"]);
    expect([...STEP_STATE]).toEqual(["todo", "doing", "done"]);
  });
});

describe("B1 totality", () => {
  it.each([undefined, null, 0, 42, "x", true, [], [1], () => 1, Symbol("s"), 10n, new Date(0), new Map()])(
    "garbage %# is rejected without throwing", (g) => {
      expect(() => validateLens(g)).not.toThrow();
      expect(v(g).ok).toBe(false);
    });
  it("cyclic input does not throw or hang", () => {
    const d: D = studyDescriptor(); d.layout.self = d;
    expect(() => validateLens(d)).not.toThrow();
    expect(v(d).ok).toBe(false);
  });
  it("is deterministic, errors sorted by path then code, input never mutated (L15)", () => {
    const bad = withStatuses(studyDescriptor(), ["reading", "reading"]);
    bad.label = "<b>"; bad.extra = 1;
    const before = clone(bad);
    const a = v(bad), b = v(bad);
    expect(a.ok).toBe(false);
    expect(a).toEqual(b);
    expect(bad).toEqual(before);
    const keys = a.errors.map((e: D) => `${e.path}\u0000${e.code}`);
    expect(keys).toEqual([...keys].sort());
  });
  it("detail never echoes descriptor strings", () => {
    const d = studyDescriptor(); d.label = "<img src=x onerror=SECRETMARK>";
    const r = v(rehash(d));
    expect(hasCode(r, "CODE_LIKE", "label")).toBe(true);
    for (const e of r.errors) expect(e.detail ?? "").not.toMatch(/SECRETMARK|img/);
  });
});

describe("L5 / B2 plain data only, remote code", () => {
  it("function as layout.order -> REMOTE_CODE", () => {
    const d = studyDescriptor(); d.layout.order = () => 1;
    expect(hasCode(v(d), "REMOTE_CODE", "layout.order")).toBe(true);
  });
  it("getter label -> REMOTE_CODE and getter never invoked", () => {
    const d = studyDescriptor(); let calls = 0;
    Object.defineProperty(d, "label", { enumerable: true, get() { calls++; return "x"; } });
    let r: D; expect(() => { r = v(d); }).not.toThrow();
    expect(hasCode(r, "REMOTE_CODE", "label")).toBe(true);
    expect(calls).toBe(0);
  });
  it("nested getter is REMOTE_CODE and not invoked", () => {
    const d = studyDescriptor(); let calls = 0;
    Object.defineProperty(d.layout, "step_rows", { enumerable: true, get() { calls++; return 5; } });
    expect(anyCode(v(d), ["REMOTE_CODE"])).toBe(true);
    expect(calls).toBe(0);
  });
  it.each<[string, () => unknown]>([
    ["symbol", () => Symbol("x")], ["bigint", () => 1n], ["RegExp", () => /x/],
    ["Promise", () => Promise.resolve(1)], ["class instance", () => new (class Foo { a = 1; })()],
    ["function", () => function f() { return 1; }],
  ])("%s anywhere in descriptor -> REMOTE_CODE", (_n, mk) => {
    const d = studyDescriptor(); d.template[0].field = mk();
    expect(anyCode(v(d), ["REMOTE_CODE"])).toBe(true);
    const e = studyDescriptor(); e.task_schemas.status.schema.enum.push(mk());
    expect(anyCode(v(e), ["REMOTE_CODE"])).toBe(true);
  });
  it.skip("Proxy-backed value -> REMOTE_CODE [R8 threat model: non-blocking debt]", () => {
    const d = studyDescriptor(); d.layout = new Proxy(d.layout, {});
    expect(types.isProxy(d.layout)).toBe(true);
    expect(hasCode(v(d), "REMOTE_CODE")).toBe(true);
  });
  it.each<[string, () => unknown]>([["Date", () => new Date(0)], ["Map", () => new Map()], ["Set", () => new Set()]])(
    "%s -> NOT_PLAIN", (_n, mk) => {
      const d = studyDescriptor(); d.layout.order = mk();
      expect(anyCode(v(d), ["NOT_PLAIN", "REMOTE_CODE"])).toBe(true);
    });
  it("null-prototype plain object is accepted", () => {
    const d = studyDescriptor(); d.layout = Object.assign(Object.create(null), d.layout);
    expect(v(d).ok).toBe(true);
  });
  it("non-finite numbers rejected", () => {
    for (const n of [NaN, Infinity, -Infinity]) {
      const d = studyDescriptor(); d.layout.step_rows = n; expect(v(d).ok).toBe(false);
    }
  });
});

describe("L5 / B3 code-like strings", () => {
  it.each(["<img src=x>", "a>b", "http://evil", "x://y", "javascript:alert(1)", "x".repeat(41)])(
    "label %j -> CODE_LIKE", (label) => {
      const d = studyDescriptor(); d.label = label;
      expect(hasCode(v(rehash(d)), "CODE_LIKE", "label")).toBe(true);
    });
  it("binding field URL -> CODE_LIKE", () => {
    const d = studyDescriptor(); d.template[1].field = "https://x/a.js";
    expect(anyCode(v(rehash(d)), ["CODE_LIKE"])).toBe(true);
  });
  it("raw HTML in template field / slot / prompt_pack / source / kind -> CODE_LIKE", () => {
    const mut: ((d: D) => void)[] = [
      (d) => { d.template[1].field = "<script>x</script>"; },
      (d) => { d.template[1].slot = "<b>"; },
      (d) => { d.prompt_pack.version = "<i>"; },
      (d) => { d.kind_groups.tab[0] = "<x>"; },
      (d) => { d.template[1].field = "A B"; },
    ];
    for (const m of mut) { const d = studyDescriptor(); m(d); expect(v(rehash(d)).ok).toBe(false); }
    const d = studyDescriptor(); d.kind_groups.tab[0] = "<x>";
    expect(anyCode(v(rehash(d)), ["CODE_LIKE", "BAD_KIND_GROUP"])).toBe(true);
  });
});

describe("B4 exact keys", () => {
  it("missing key -> MISSING_FIELD", () => {
    for (const k of Object.keys(studyDescriptor())) {
      const d = studyDescriptor(); delete d[k];
      expect(hasCode(v(d), "MISSING_FIELD", k)).toBe(true);
    }
  });
  it("unknown key -> UNKNOWN_FIELD", () => {
    const d = studyDescriptor(); d.foo = 1; expect(hasCode(v(d), "UNKNOWN_FIELD", "foo")).toBe(true);
  });
  it.each(["attention", "privacy_tier", "inference_source", "limits"])(
    "universal enum shadow %s -> UNKNOWN_FIELD (L7)", (k) => {
      const d = devDescriptor(); d[k] = ["none", "now"];
      expect(hasCode(v(d), "UNKNOWN_FIELD", k)).toBe(true);
    });
  it("wrong types -> WRONG_TYPE", () => {
    const muts: [string, any][] = [["statuses", "x"], ["tasks", 3], ["label", 5], ["template", {}], ["layout", []],
      ["kind_groups", []], ["sources", "agent"], ["prompt_pack", "v1"], ["task_schemas", []]];
    for (const [k, val] of muts) {
      const d = studyDescriptor(); d[k] = val; expect(anyCode(v(d), ["WRONG_TYPE"])).toBe(true);
    }
  });
});

describe("B5 lens id", () => {
  it.each(["desk", "Dev", "", "dev ", "d".repeat(20), "__proto__"])("lens_id %j -> BAD_LENS_ID", (id) => {
    const d = devDescriptor(); d.lens_id = id; expect(hasCode(v(rehash(d)), "BAD_LENS_ID", "lens_id")).toBe(true);
  });
  it("lens_id of wrong type -> not ok", () => {
    const d = devDescriptor(); d.lens_id = 3; expect(v(rehash(d)).ok).toBe(false);
  });
});

describe("L3/L6 statuses (B6)", () => {
  it("nine statuses -> TOO_MANY_STATUSES; exactly eight -> ok (STRATEGY oracle)", () => {
    const nine = withStatuses(studyDescriptor(), [...STUDY_STATUSES, "archived", "paused", "later"].slice(0, 9));
    expect(nine.statuses).toHaveLength(9);
    expect(hasCode(v(nine), "TOO_MANY_STATUSES")).toBe(true);
    const eight = withStatuses(studyDescriptor(), [...STUDY_STATUSES, "archived", "paused"]);
    expect(eight.statuses).toHaveLength(8);
    expect(v(eight).ok).toBe(true);
  });
  it("far more than eight is rejected; 7 accepted", () => {
    const many = Array.from({ length: 20 }, (_, i) => `s${i}`);
    expect(hasCode(v(withStatuses(studyDescriptor(), many)), "TOO_MANY_STATUSES")).toBe(true);
    expect(v(withStatuses(studyDescriptor(), many.slice(0, 7))).ok).toBe(true);
  });
  it("duplicate / case / empty / single", () => {
    expect(hasCode(v(withStatuses(studyDescriptor(), ["reading", "reading"])), "DUPLICATE_STATUS")).toBe(true);
    expect(hasCode(v(withStatuses(studyDescriptor(), ["Reading", "done"])), "BAD_STATUS")).toBe(true);
    expect(hasCode(v(withStatuses(studyDescriptor(), [])), "TOO_FEW_STATUSES")).toBe(true);
    expect(hasCode(v(withStatuses(studyDescriptor(), ["done"])), "TOO_FEW_STATUSES")).toBe(true);
    expect(v(withStatuses(studyDescriptor(), ["a", "b"])).ok).toBe(true);
  });
  it.each(["1abc", "_x", "a-b", "a b", "a".repeat(25), "<x>", ""])("bad status %j -> BAD_STATUS", (s) => {
    expect(hasCode(v(withStatuses(studyDescriptor(), ["reading", s])), "BAD_STATUS")).toBe(true);
  });
  it("24-char status accepted", () => {
    expect(v(withStatuses(studyDescriptor(), ["reading", "a".repeat(24)])).ok).toBe(true);
  });
  it("order is significant: reordering changes the hash and a stale hash is rejected", () => {
    const a = studyDescriptor();
    const re = withStatuses(a, [...a.statuses].reverse());
    expect(re.template_hash).not.toBe(a.template_hash);
    const stale = { ...re, template_hash: a.template_hash };
    expect(hasCode(v(stale), "HASH_MISMATCH")).toBe(true);
  });
  it("status enum order must match statuses order -> SCHEMA_MISMATCH", () => {
    const d = studyDescriptor(); d.task_schemas.status.schema.enum.reverse();
    expect(hasCode(v(rehash(d)), "SCHEMA_MISMATCH")).toBe(true);
  });
});

describe("B8 tasks", () => {
  it("unknown task -> UNKNOWN_TASK", () => {
    const d = studyDescriptor(); d.tasks.push("bogus"); expect(hasCode(v(rehash(d)), "UNKNOWN_TASK")).toBe(true);
  });
  it("status mandatory -> MISSING_TASK", () => {
    const d = studyDescriptor(); d.tasks = d.tasks.filter((t: string) => t !== "status"); delete d.task_schemas.status;
    expect(hasCode(v(rehash(d)), "MISSING_TASK")).toBe(true);
  });
  it("task without schema, or schema without task -> SCHEMA_MISMATCH", () => {
    const a = studyDescriptor(); delete a.task_schemas.digest;
    expect(hasCode(v(rehash(a)), "SCHEMA_MISMATCH")).toBe(true);
    const b = studyDescriptor(); b.tasks = b.tasks.filter((t: string) => t !== "digest");
    expect(hasCode(v(rehash(b)), "SCHEMA_MISMATCH")).toBe(true);
  });
  it("plan is optional (T9 shape validates for study)", () => {
    expect(v(studyT9()).ok).toBe(true);
  });
  it("T9 shape also validates for dev lens without plan/checklist", () => {
    const d = devDescriptor();
    d.tasks = d.tasks.filter((t: string) => t !== "plan"); delete d.task_schemas.plan;
    d.template = d.template.filter((x: D) => x.slot !== "checklist"); d.layout.step_rows = 0;
    expect(v(rehash(d)).ok).toBe(true);
  });
});

describe("L4 / B9 B2 keyword set", () => {
  it("maxLength at steps.items.properties.text -> OFF_B2_KEYWORD with full path", () => {
    const d = studyDescriptor();
    d.task_schemas.plan.schema.properties.steps.items.properties.text.maxLength = 80;
    expect(hasCode(v(rehash(d)), "OFF_B2_KEYWORD",
      "task_schemas.plan.schema.properties.steps.items.properties.text.maxLength")).toBe(true);
  });
  it("additionalProperties:false at root -> OFF_B2_KEYWORD with full path", () => {
    const d = studyDescriptor(); d.task_schemas.plan.schema.additionalProperties = false;
    expect(hasCode(v(rehash(d)), "OFF_B2_KEYWORD", "task_schemas.plan.schema.additionalProperties")).toBe(true);
  });
  it.each(["pattern", "maxItems", "minItems", "minLength", "format", "$ref", "oneOf", "default", "description", "minimum"])(
    "%s anywhere -> OFF_B2_KEYWORD (also in status and digest)", (kw) => {
      const a = studyDescriptor(); a.task_schemas.status.schema[kw] = 1;
      expect(hasCode(v(rehash(a)), "OFF_B2_KEYWORD", `task_schemas.status.schema.${kw}`)).toBe(true);
      const b = studyDescriptor(); b.task_schemas.digest.schema.properties.needs_you.items[kw] = 1;
      expect(hasCode(v(rehash(b)), "OFF_B2_KEYWORD",
        `task_schemas.digest.schema.properties.needs_you.items.${kw}`)).toBe(true);
    });
  it("every object must list all its properties in required", () => {
    const d = studyDescriptor(); d.task_schemas.plan.schema.required = ["steps"];
    expect(anyCode(v(rehash(d)), ["SCHEMA_MISMATCH"])).toBe(true);
    const e = studyDescriptor(); e.task_schemas.plan.schema.properties.steps.items.required = ["text"];
    expect(anyCode(v(rehash(e)), ["SCHEMA_MISMATCH"])).toBe(true);
  });
  it("nullable true anywhere is rejected", () => {
    const d = studyDescriptor(); d.task_schemas.plan.schema.properties.progress.nullable = true;
    expect(v(rehash(d)).ok).toBe(false);
  });
});

describe("B10 exact shapes", () => {
  const bad: [string, (d: D) => void][] = [
    ["status mime", (d) => { d.task_schemas.status.mimeType = "application/json"; }],
    ["status type", (d) => { d.task_schemas.status.schema.type = "number"; }],
    ["plan mime", (d) => { d.task_schemas.plan.mimeType = "text/x.enum"; }],
    ["plan progress string", (d) => { d.task_schemas.plan.schema.properties.progress.type = "string"; }],
    ["plan state enum", (d) => { d.task_schemas.plan.schema.properties.steps.items.properties.state.enum = ["todo", "done"]; }],
    ["plan state enum order", (d) => { d.task_schemas.plan.schema.properties.steps.items.properties.state.enum = ["done", "doing", "todo"]; }],
    ["plan steps not array", (d) => { d.task_schemas.plan.schema.properties.steps.type = "string"; }],
    ["plan extra property", (d) => {
      d.task_schemas.plan.schema.properties.extra = { type: "string", nullable: false };
      d.task_schemas.plan.schema.required.push("extra");
    }],
    ["summary lacks field", (d) => {
      delete d.task_schemas.summary.schema.properties.summary; d.task_schemas.summary.schema.required = ["headline"];
    }],
    ["next_action attention enum", (d) => { d.task_schemas.next_action.schema.properties.attention.enum = ["none"]; }],
    ["digest brief type", (d) => { d.task_schemas.digest.schema.properties.brief.type = "number"; }],
  ];
  it.each(bad)("%s -> SCHEMA_MISMATCH", (_n, m) => {
    const d = studyDescriptor(); m(d); expect(hasCode(v(rehash(d)), "SCHEMA_MISMATCH")).toBe(true);
  });
  it("plan schema carries no limits (maxItems/maxLength belong to U05 validator)", () => {
    expect(JSON.stringify(planSchema())).not.toMatch(/max|min/);
  });
});

describe("B11 prompt pack", () => {
  it("id must equal lens_id", () => {
    const d = studyDescriptor(); d.prompt_pack.id = "dev"; expect(v(rehash(d)).ok).toBe(false);
  });
  it("version must match IDENT_RE", () => {
    for (const ver of ["V1", "", "v 1", "1v", "v".repeat(40)]) {
      const d = studyDescriptor(); d.prompt_pack.version = ver; expect(v(rehash(d)).ok).toBe(false);
    }
    const d = studyDescriptor(); d.prompt_pack.version = "v2"; expect(v(rehash(d)).ok).toBe(true);
  });
  it("prompt text is not allowed in a lens (extra key)", () => {
    const d = studyDescriptor(); d.prompt_pack.text = "do x"; expect(v(rehash(d)).ok).toBe(false);
  });
});

describe("L11 / B12 sources and kinds", () => {
  it("study declaring a dev source -> BAD_SOURCE", () => {
    const d = studyDescriptor(); d.sources.push("git"); expect(hasCode(v(rehash(d)), "BAD_SOURCE")).toBe(true);
  });
  it("dev declaring a study source -> BAD_SOURCE; unknown source -> BAD_SOURCE", () => {
    const d = devDescriptor(); d.sources.push("tab"); expect(hasCode(v(rehash(d)), "BAD_SOURCE")).toBe(true);
    const e = devDescriptor(); e.sources.push("fax"); expect(hasCode(v(rehash(e)), "BAD_SOURCE")).toBe(true);
  });
  it("study kind_groups with key git -> BAD_KIND_GROUP", () => {
    const d = studyDescriptor(); d.kind_groups.git = ["commit"];
    expect(hasCode(v(rehash(d)), "BAD_KIND_GROUP")).toBe(true);
  });
  it("kind_groups keys must equal sources (missing key)", () => {
    const d = studyDescriptor(); delete d.kind_groups.doc; expect(hasCode(v(rehash(d)), "BAD_KIND_GROUP")).toBe(true);
  });
  it("empty group and kinds repeated across groups -> BAD_KIND_GROUP", () => {
    const a = studyDescriptor(); a.kind_groups.doc = []; expect(hasCode(v(rehash(a)), "BAD_KIND_GROUP")).toBe(true);
    const b = studyDescriptor(); b.kind_groups.doc = ["tab_pinned"];
    expect(hasCode(v(rehash(b)), "BAD_KIND_GROUP")).toBe(true);
  });
  it("dev groups must equal U08 EVENT_KIND by source", () => {
    const a = devDescriptor(); a.kind_groups.ci.pop(); expect(hasCode(v(rehash(a)), "BAD_KIND_GROUP")).toBe(true);
    const b = devDescriptor(); b.kind_groups.git.push("tag"); expect(hasCode(v(rehash(b)), "BAD_KIND_GROUP")).toBe(true);
  });
  it("study kinds equal the [TARGET] vocabulary (mismatch rejected)", () => {
    const a = studyDescriptor(); a.kind_groups.tab = ["tab_pinned"]; expect(hasCode(v(rehash(a)), "BAD_KIND_GROUP")).toBe(true);
  });
});

describe("L14 / B13 B14 template and layout", () => {
  it("progress bound with textContent -> BAD_TEMPLATE", () => {
    const d = studyDescriptor(); d.template.find((x: D) => x.slot === "progress").write = "textContent";
    expect(hasCode(v(rehash(d)), "BAD_TEMPLATE")).toBe(true);
  });
  it("dev with checklist but step_rows 0 -> BAD_LAYOUT", () => {
    const d = devDescriptor(); d.layout.step_rows = 0; expect(hasCode(v(rehash(d)), "BAD_LAYOUT")).toBe(true);
  });
  it("study without plan but with checklist -> BAD_TEMPLATE", () => {
    const d = studyT9(); d.template.push({ slot: "checklist", field: "steps", write: "textContent" });
    expect(hasCode(v(rehash(d)), "BAD_TEMPLATE")).toBe(true);
  });
  it("slot/field/write must match SLOT_ALLOWLIST; unknown slot; duplicate slot", () => {
    const mk = (m: (d: D) => void) => { const d = studyDescriptor(); m(d); return v(rehash(d)); };
    expect(hasCode(mk((d) => { d.template[1].write = "class"; }), "BAD_TEMPLATE")).toBe(true); // headline class
    expect(hasCode(mk((d) => { d.template[1].write = "innerHTML"; }), "BAD_TEMPLATE")).toBe(true);
    expect(hasCode(mk((d) => { d.template[1].field = "summary"; }), "BAD_TEMPLATE")).toBe(true);
    expect(hasCode(mk((d) => { d.template[1].slot = "script_slot"; }), "BAD_TEMPLATE")).toBe(true);
    expect(hasCode(mk((d) => { d.template.push({ ...d.template[1] }); }), "BAD_TEMPLATE")).toBe(true);
  });
  it("checklist may write class as well as textContent", () => {
    const d = studyDescriptor(); d.template.find((x: D) => x.slot === "checklist").write = "class";
    expect(v(rehash(d)).ok).toBe(true);
  });
  it("binding keys are exact", () => {
    const d = studyDescriptor(); d.template[0].extra = 1; expect(v(rehash(d)).ok).toBe(false);
    const e = studyDescriptor(); delete e.template[0].write; expect(v(rehash(e)).ok).toBe(false);
  });
  it("focus_banner flag and slot must agree (both directions) -> BAD_LAYOUT", () => {
    const a = studyDescriptor(); a.layout.focus_banner = false; expect(hasCode(v(rehash(a)), "BAD_LAYOUT")).toBe(true);
    const b = devDescriptor(); b.layout.focus_banner = true; expect(hasCode(v(rehash(b)), "BAD_LAYOUT")).toBe(true);
  });
  it("step_rows 5 without checklist, step_rows 3, bad order -> BAD_LAYOUT", () => {
    const a = studyT9(); a.layout.step_rows = 5; expect(hasCode(v(rehash(a)), "BAD_LAYOUT")).toBe(true);
    const b = studyDescriptor(); b.layout.step_rows = 3; expect(v(rehash(b)).ok).toBe(false);
    const c = studyDescriptor(); c.layout.order = "project_then_attention"; expect(v(rehash(c)).ok).toBe(false);
  });
});

describe("L8 / B15 hash verification", () => {
  it("stale template_hash -> HASH_MISMATCH", () => {
    const d = studyDescriptor(); d.statuses[1] = "skimming"; d.task_schemas.status.schema.enum[1] = "skimming";
    expect(hasCode(v(d), "HASH_MISMATCH")).toBe(true);
    expect(v(rehash(d)).ok).toBe(true);
  });
  it("editing the template without rehash -> HASH_MISMATCH", () => {
    const d = studyDescriptor(); d.template[1].write = "textContent"; d.label = "Other";
    expect(hasCode(v(d), "HASH_MISMATCH")).toBe(true);
  });
  it("a hash that is not 8 lowercase hex is rejected", () => {
    for (const h of ["ABCDEF12", "abc", "", "zzzzzzzz", "000000000"]) {
      const d = studyDescriptor(); d.template_hash = h; expect(v(d).ok).toBe(false);
    }
  });
});

describe("B16 freezing / copy", () => {
  it("returns a deep-frozen copy, input untouched and not frozen (L2)", () => {
    const d = studyDescriptor(); const snap = clone(d);
    const r = v(d); expect(r.ok).toBe(true);
    expect(r.value).not.toBe(d);
    expect(r.value.template).not.toBe(d.template);
    expect(Object.isFrozen(d)).toBe(false);
    expect(Object.isFrozen(d.template)).toBe(false);
    expect(Object.isFrozen(d.task_schemas.plan.schema)).toBe(false);
    expect(d).toEqual(snap);
    expect(r.value).toEqual(snap);
  });
  it("later mutation of the input does not leak into the returned value", () => {
    const d = studyDescriptor(); const r = v(d); d.statuses.push("zzz"); d.layout.step_rows = 0;
    expect(r.value.statuses).not.toContain("zzz"); expect(r.value.layout.step_rows).toBe(5);
  });
});
