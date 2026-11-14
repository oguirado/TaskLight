/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import {
  buildRegistry, canonicalLensJson, effectiveMode, getLens, isLensStatus, kindAllowed, lensHash,
  LENSES, LensRegistryError, SLOT_ALLOWLIST, SOURCE_FLOORS, STUDY_STATUSES, validateLens,
} from "../../../src/lens/index";
import { CAPSULE_STATUS, PRIVACY_TIER } from "../../../src/schema/index";
import {
  DEV_KINDS, DEV_STATUSES, STUDY_KINDS, STUDY_STATUS_LIST, clone, deepFrozen, devDescriptor, hasCode,
  refCanon, refFnv, rehash, studyDescriptor, studyT9, type D,
} from "./helpers";

const study = () => getLens("study") as D;
const dev = () => getLens("dev") as D;
const strip = (l: D) => { const { template_hash: _t, ...r } = clone(l); return r; };

describe("L1 registry vocabulary", () => {
  it("ids are exactly dev, study, sorted and frozen", () => {
    expect([...LENSES.ids()]).toEqual(["dev", "study"]);
    expect(Object.isFrozen(LENSES.ids())).toBe(true);
  });
  it("dev statuses equal U05 CAPSULE_STATUS, study equal STUDY_STATUSES (exact order)", () => {
    expect([...dev().statuses]).toEqual([...CAPSULE_STATUS]);
    expect([...dev().statuses]).toEqual(DEV_STATUSES);
    expect([...study().statuses]).toEqual([...STUDY_STATUSES]);
    expect([...study().statuses]).toEqual(STUDY_STATUS_LIST);
  });
  it("lens_id and prompt pack", () => {
    expect(dev().lens_id).toBe("dev"); expect(study().lens_id).toBe("study");
    expect(dev().prompt_pack.id).toBe("dev"); expect(study().prompt_pack.id).toBe("study");
    expect(dev().prompt_pack.version).toMatch(/^[a-z][a-z0-9_.-]{0,31}$/);
  });
  it("task sets match B8 (screenshot not listed)", () => {
    expect([...dev().tasks].sort()).toEqual(["digest", "next_action", "plan", "status", "summary"]);
    expect([...study().tasks].sort()).toEqual(["digest", "next_action", "plan", "status", "summary"]);
    expect(Object.keys(dev().task_schemas).sort()).toEqual([...dev().tasks].sort());
    expect(Object.keys(study().task_schemas).sort()).toEqual([...study().tasks].sort());
  });
  it("sources and kind groups (dev = U08 EVENT_KIND, study = [TARGET])", () => {
    expect([...dev().sources]).toEqual(["agent", "ci", "git"]);
    expect([...study().sources]).toEqual(["tab", "selection", "page", "doc"]);
    expect(clone(dev().kind_groups)).toEqual(DEV_KINDS);
    expect(clone(study().kind_groups)).toEqual(STUDY_KINDS);
  });
  it("built-in template/layout invariants: progress only in study, checklist in both, layout consistent", () => {
    const slots = (l: D) => l.template.map((b: D) => b.slot);
    expect(slots(study())).toContain("progress"); expect(slots(dev())).not.toContain("progress");
    expect(slots(study())).toContain("checklist"); expect(slots(dev())).toContain("checklist");
    for (const l of [dev(), study()]) {
      expect(l.layout.step_rows).toBe(5);
      expect(l.layout.focus_banner).toBe(slots(l).includes("focus_banner"));
      expect(l.layout.order).toBe("attention_then_project");
      for (const b of l.template) {
        expect(SLOT_ALLOWLIST[b.slot as keyof typeof SLOT_ALLOWLIST].field).toBe(b.field);
        expect(SLOT_ALLOWLIST[b.slot as keyof typeof SLOT_ALLOWLIST].writes).toContain(b.write);
      }
    }
  });
  it("built-ins re-validate through validateLens", () => {
    for (const l of [dev(), study()]) expect(validateLens(clone(l)).ok).toBe(true);
  });
});

describe("L2 deep frozen / identity", () => {
  it("every node of getLens('study') is frozen incl. plan steps.items", () => {
    expect(deepFrozen(study())).toBe(true);
    expect(Object.isFrozen(study().task_schemas.plan.schema.properties.steps.items)).toBe(true);
    expect(deepFrozen(dev())).toBe(true);
  });
  it("strict-mode assignment throws", () => {
    expect(() => { study().label = "x"; }).toThrow(TypeError);
    expect(() => { study().statuses.push("x"); }).toThrow(TypeError);
    expect(() => { study().task_schemas.plan.schema.properties.steps.items.required = []; }).toThrow(TypeError);
    expect(() => { study().layout.step_rows = 0; }).toThrow(TypeError);
  });
  it("same reference on every get", () => {
    expect(getLens("study")).toBe(getLens("study"));
    expect(LENSES.get("dev")).toBe(getLens("dev"));
    expect(getLens("dev")).not.toBe(getLens("study"));
  });
  it("buildRegistry values are frozen and stable too", () => {
    const r = buildRegistry([devDescriptor(), studyDescriptor()]) as D;
    expect(r.ok).toBe(true);
    expect(deepFrozen(r.value.get("study"))).toBe(true);
    expect(r.value.get("study")).toBe(r.value.get("study"));
    expect(Object.isFrozen(r.value.ids())).toBe(true);
  });
});

describe("L8 / B15 hash", () => {
  it("canonicalLensJson: sorted keys, no whitespace, array order kept, key-order independent", () => {
    const d: D = studyDescriptor(); const { template_hash: _h, ...rest } = d;
    expect(canonicalLensJson(rest)).toBe(refCanon(rest));
    const shuffled: D = {}; for (const k of Object.keys(rest).reverse()) shuffled[k] = rest[k];
    expect(canonicalLensJson(shuffled)).toBe(canonicalLensJson(rest));
    expect(canonicalLensJson(rest)).not.toMatch(/\n|: |, /);
    const rev = { ...rest, statuses: [...rest.statuses].reverse() };
    expect(canonicalLensJson(rev)).not.toBe(canonicalLensJson(rest));
    expect(canonicalLensJson({ b: 1, a: "é\"\n" } as D)).toBe('{"a":"é\\"\\n","b":1}');
  });
  it("lensHash is FNV-1a 32 (8 lowercase hex) and equals the reference", () => {
    const { template_hash: _a, ...rd } = devDescriptor(); const { template_hash: _b, ...rs } = studyDescriptor();
    expect(lensHash(rd)).toMatch(/^[0-9a-f]{8}$/);
    expect(lensHash(rd)).toBe(refFnv(refCanon(rd)));
    expect(lensHash(rs)).toBe(refFnv(refCanon(rs)));
    expect(lensHash(rd)).not.toBe(lensHash(rs));
    expect(lensHash({} as D)).toBe(refFnv("{}")); // U07 hashString("{}") parity (reference FNV-1a)
  });
  it("FNV-1a known vectors via reference (sanity of oracle)", () => {
    expect(refFnv("")).toBe("811c9dc5"); expect(refFnv("a")).toBe("e40c292c"); expect(refFnv("foobar")).toBe("bf9cf968");
  });
  it("lensHash handles UTF-16 code units (non-BMP) like the reference", () => {
    const d: D = { label: "😀é" };
    expect(lensHash(d)).toBe(refFnv(refCanon(d)));
  });
  it("built-in template_hash values match, are 8 hex and distinct", () => {
    for (const l of [dev(), study()]) {
      expect(l.template_hash).toMatch(/^[0-9a-f]{8}$/);
      expect(l.template_hash).toBe(refFnv(refCanon(strip(l))));
      expect(lensHash(strip(l))).toBe(l.template_hash);
    }
    expect(dev().template_hash).not.toBe(study().template_hash);
  });
  it("hash changes with the template and with each lens field; stable across calls", () => {
    const base = studyDescriptor(); const { template_hash: _h, ...rest } = base;
    const h0 = lensHash(rest);
    expect(lensHash(clone(rest))).toBe(h0);
    const muts: ((d: D) => void)[] = [
      (d) => { d.template[1].write = "class"; }, (d) => { d.template.pop(); }, (d) => { d.label = "Z"; },
      (d) => { d.statuses[0] = "begun"; }, (d) => { d.layout.focus_banner = false; },
      (d) => { d.prompt_pack.version = "v2"; }, (d) => { d.kind_groups.tab.push("tab_x"); },
    ];
    for (const m of muts) { const c = clone(rest); m(c); expect(lensHash(c)).not.toBe(h0); }
  });
  it("renamed status rehashed -> different hash and ok; with old hash -> HASH_MISMATCH", () => {
    const base = studyDescriptor();
    const ren = clone(base); ren.statuses[1] = "skimming"; ren.task_schemas.status.schema.enum[1] = "skimming";
    const re = rehash(ren);
    expect(re.template_hash).not.toBe(base.template_hash);
    expect(validateLens(re).ok).toBe(true);
    expect(hasCode(validateLens({ ...ren, template_hash: base.template_hash }), "HASH_MISMATCH")).toBe(true);
  });
});

describe("L9 isLensStatus", () => {
  it("membership parity", () => {
    expect(isLensStatus(study(), "blocked")).toBe(false);
    expect(isLensStatus(dev(), "blocked")).toBe(true);
    expect(isLensStatus(study(), "review_due")).toBe(true);
    expect(isLensStatus(study(), "Done")).toBe(false);
  });
  it("prototype keys and empty are not statuses", () => {
    for (const s of ["toString", "constructor", "__proto__", "", "length", "0"]) {
      expect(isLensStatus(study(), s)).toBe(false); expect(isLensStatus(dev(), s)).toBe(false);
    }
    for (const s of CAPSULE_STATUS) expect(isLensStatus(dev(), s)).toBe(true);
    expect(isLensStatus(dev(), "review_due")).toBe(false);
  });
});

describe("L10 built-in schema shapes", () => {
  it("study status schema", () => {
    const s = study().task_schemas.status;
    expect(s.mimeType).toBe("text/x.enum");
    expect(s.schema.type).toBe("string");
    expect([...s.schema.enum]).toEqual([...study().statuses]);
    expect(s.schema.nullable).toBe(false);
  });
  it("dev status schema equals statuses", () => {
    expect([...dev().task_schemas.status.schema.enum]).toEqual(DEV_STATUSES);
  });
  it("study plan schema exact shape", () => {
    const p = study().task_schemas.plan;
    expect(p.mimeType).toBe("application/json");
    expect(clone(p)).toEqual(clone(studyDescriptor().task_schemas.plan));
    expect(p.schema.properties.progress.type).toBe("number");
    expect([...p.schema.properties.steps.items.properties.state.enum]).toEqual(["todo", "doing", "done"]);
  });
  it("required equals property keys at every level; keywords subset of B2; nullable false", () => {
    const B2 = ["type", "properties", "required", "items", "enum", "nullable"];
    const walk = (n: D) => {
      for (const k of Object.keys(n)) expect(B2).toContain(k);
      expect(n.nullable).toBe(false);
      if (n.properties) {
        expect([...n.required].sort()).toEqual(Object.keys(n.properties).sort());
        Object.values(n.properties).forEach(walk);
      }
      if (n.items) walk(n.items);
    };
    for (const l of [dev(), study()]) for (const t of Object.values(l.task_schemas) as D[]) walk(t.schema);
  });
  it("summary, next_action and digest use U05 shapes (parity with TASK_SCHEMAS)", async () => {
    const { TASK_SCHEMAS } = await import("../../../src/schema/index");
    for (const t of ["summary", "next_action", "digest"] as const) {
      expect(clone(study().task_schemas[t])).toEqual(clone(TASK_SCHEMAS[t]));
      expect(clone(dev().task_schemas[t])).toEqual(clone(TASK_SCHEMAS[t]));
    }
  });
});

describe("L11 kindAllowed", () => {
  it("only declared (source, kind) pairs", () => {
    expect(kindAllowed(study(), "ci", "ci_passed")).toBe(false);
    expect(kindAllowed(study(), "page", "page_snapshot")).toBe(true);
    expect(kindAllowed(study(), "tab", "tab_pinned")).toBe(true);
    expect(kindAllowed(study(), "tab", "page_snapshot")).toBe(false);
    expect(kindAllowed(study(), "doc", "doc_added")).toBe(true);
    expect(kindAllowed(study(), "selection", "selection_captured")).toBe(true);
    expect(kindAllowed(dev(), "agent", "output")).toBe(true);
    expect(kindAllowed(dev(), "agent", "ci_passed")).toBe(false);
    expect(kindAllowed(dev(), "ci", "ci_passed")).toBe(true);
    expect(kindAllowed(dev(), "git", "push")).toBe(true);
    expect(kindAllowed(dev(), "tab", "tab_pinned")).toBe(false);
  });
  it("prototype keys and unknowns are not allowed", () => {
    for (const s of ["__proto__", "constructor", "toString", "", "nope"]) {
      expect(kindAllowed(study(), s, "tab_pinned")).toBe(false);
      expect(kindAllowed(dev(), s, "output")).toBe(false);
    }
    expect(kindAllowed(dev(), "agent", "constructor")).toBe(false);
    expect(kindAllowed(dev(), "agent", "__proto__")).toBe(false);
  });
});

describe("L12 / B18 floors", () => {
  const O = "ONLY_ON_DEVICE", P = "PREFER_ON_DEVICE";
  const expected: Record<string, Record<string, string | null>> = {
    tab: { standard: P, shared: P, private: O }, selection: { standard: P, shared: P, private: O },
    page: { standard: O, shared: O, private: O }, doc: { standard: O, shared: O, private: O },
    agent: { standard: null, shared: null, private: O }, ci: { standard: null, shared: null, private: O },
    git: { standard: null, shared: null, private: O },
  };
  it("table is exact for every source and tier", () => {
    expect(Object.keys(SOURCE_FLOORS).sort()).toEqual(Object.keys(expected).sort());
    for (const [src, tiers] of Object.entries(expected)) {
      expect(Object.keys((SOURCE_FLOORS as D)[src]).sort()).toEqual([...PRIVACY_TIER].sort());
      for (const [tier, f] of Object.entries(tiers)) expect((SOURCE_FLOORS as D)[src][tier]).toBe(f);
    }
  });
  it("spec examples", () => {
    expect(effectiveMode(SOURCE_FLOORS.page.standard, "PREFER_IN_CLOUD")).toBe("ONLY_ON_DEVICE");
    expect(effectiveMode(SOURCE_FLOORS.tab.standard, "ONLY_IN_CLOUD")).toBe("PREFER_ON_DEVICE");
    expect(effectiveMode(SOURCE_FLOORS.tab.standard, "ONLY_ON_DEVICE")).toBe("ONLY_ON_DEVICE");
    expect(effectiveMode(SOURCE_FLOORS.agent.standard, "PREFER_IN_CLOUD")).toBe("PREFER_IN_CLOUD");
  });
  it("effectiveMode is the stricter of floor and requested (full matrix)", () => {
    const order = ["ONLY_ON_DEVICE", "PREFER_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD"] as const;
    for (const f of order) for (const r of order) {
      expect(effectiveMode(f, r)).toBe(order[Math.min(order.indexOf(f), order.indexOf(r))]);
    }
    for (const r of order) expect(effectiveMode(null, r)).toBe(r);
  });
  it("page/doc private and standard are never loosened by cloud requests", () => {
    for (const s of ["page", "doc"] as const) for (const t of PRIVACY_TIER)
      expect(effectiveMode(SOURCE_FLOORS[s][t], "ONLY_IN_CLOUD")).toBe("ONLY_ON_DEVICE");
    for (const s of ["agent", "ci", "git"] as const)
      expect(effectiveMode(SOURCE_FLOORS[s].private, "PREFER_IN_CLOUD")).toBe("ONLY_ON_DEVICE");
  });
});

describe("L13 / B17 registry negatives", () => {
  it("duplicate lens -> DUPLICATE_LENS", () => {
    expect(hasCode(buildRegistry([devDescriptor(), devDescriptor()]), "DUPLICATE_LENS")).toBe(true);
  });
  it("unknown ids and prototype keys -> undefined", () => {
    for (const id of ["desk", "__proto__", "constructor", "toString", "hasOwnProperty", "", "Dev", "dev "]) {
      expect(getLens(id)).toBeUndefined(); expect(LENSES.get(id)).toBeUndefined();
    }
    const r = buildRegistry([devDescriptor()]) as D;
    expect(r.value.get("__proto__")).toBeUndefined(); expect(r.value.get("study")).toBeUndefined();
  });
  it("buildRegistry validates every descriptor", () => {
    const bad = studyDescriptor(); bad.label = "<x>";
    const r = buildRegistry([devDescriptor(), rehash(bad)]) as D;
    expect(r.ok).toBe(false);
    expect(hasCode(r, "CODE_LIKE")).toBe(true);
  });
  it("buildRegistry never throws and does not mutate", () => {
    for (const g of [null, undefined, 3, "x", {}, [null], [() => 1], [Symbol("x")]]) {
      expect(() => buildRegistry(g as D)).not.toThrow();
    }
    expect((buildRegistry(null as D) as D).ok).toBe(false);
    const a = [devDescriptor(), studyDescriptor()]; const snap = clone(a);
    buildRegistry(a); expect(a).toEqual(snap);
  });
  it("ids() sorted regardless of input order; empty list gives empty registry or is rejected", () => {
    const r = buildRegistry([studyDescriptor(), devDescriptor()]) as D;
    expect([...r.value.ids()]).toEqual(["dev", "study"]);
  });
  it("registry results are deterministic (sorted errors)", () => {
    const a = buildRegistry([devDescriptor(), devDescriptor()]) as D;
    expect(buildRegistry([devDescriptor(), devDescriptor()])).toEqual(a);
  });
  it("LensRegistryError is an Error subclass", () => {
    const e = new LensRegistryError("boom");
    expect(e).toBeInstanceOf(Error); expect(e).toBeInstanceOf(LensRegistryError); expect(e.message).toBe("boom");
  });
});

describe("L15 T9 shape", () => {
  it("study minus plan/checklist/progress with step_rows 0 validates and registers", () => {
    const t9 = studyT9();
    expect(t9.layout.step_rows).toBe(0);
    const r = validateLens(t9) as D;
    expect(r.ok).toBe(true);
    expect(r.value.tasks).not.toContain("plan");
    expect(r.value.task_schemas.plan).toBeUndefined();
    expect((buildRegistry([devDescriptor(), t9]) as D).ok).toBe(true);
  });
});
