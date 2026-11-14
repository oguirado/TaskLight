/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { validateLens } from "../../../src/lens/index";
import { hasCode, rehash, studyDescriptor, devDescriptor, refCanon, refFnv, type D } from "./helpers";

const v = (d: unknown) => validateLens(d) as D;
const rehashKeepHidden = (d: D) => { // recompute hash from enumerable fields only
  const { template_hash: _h, ...rest } = d;
  d.template_hash = refFnv(refCanon(rest));
  return d;
};

describe("repair1 B1/B2/B4/B16: hidden and symbol properties", () => {
  it("non-enumerable accessor label -> REMOTE_CODE, getter never invoked, no throw", () => {
    const d = studyDescriptor(); let calls = 0;
    Object.defineProperty(d, "label", { enumerable: false, get() { calls++; return "Study"; } });
    const r = v(d);
    expect(hasCode(r, "REMOTE_CODE")).toBe(true);
    expect(calls).toBe(0);
  });
  it("non-enumerable accessor on a nested object is rejected without invocation", () => {
    const d = studyDescriptor(); let calls = 0;
    Object.defineProperty(d.layout, "order", { enumerable: false, get() { calls++; return "attention_then_project"; } });
    expect(v(d).ok).toBe(false);
    expect(calls).toBe(0);
  });
  it("non-enumerable accessor array element is rejected without invocation", () => {
    const d = studyDescriptor(); let calls = 0;
    Object.defineProperty(d.statuses, "0", { enumerable: false, get() { calls++; return "not_started"; } });
    expect(v(d).ok).toBe(false);
    expect(calls).toBe(0);
  });
  it("non-enumerable data label with matching hash is not accepted (no silently dropped required field)", () => {
    const d = studyDescriptor();
    Object.defineProperty(d, "label", { enumerable: false, value: "Study", writable: true, configurable: true });
    rehashKeepHidden(d);
    const r = v(d);
    if (r.ok) expect(r.value.label).toBe("Study"); else expect(r.ok).toBe(false);
    expect(r.ok).toBe(false);
  });
  it("hidden extra non-enumerable data property is rejected", () => {
    const d = studyDescriptor();
    Object.defineProperty(d, "extra", { enumerable: false, value: "x" });
    expect(v(d).ok).toBe(false);
  });
  it("own symbol property (root, nested) is rejected", () => {
    const a = studyDescriptor(); (a as any)[Symbol("s")] = "x";
    expect(v(a).ok).toBe(false);
    const b = studyDescriptor(); b.layout[Symbol.for("s")] = 1;
    expect(v(b).ok).toBe(false);
    const c = studyDescriptor(); Object.defineProperty(c.template[0], Symbol("h"), { enumerable: false, value: 1 });
    expect(v(c).ok).toBe(false);
  });
  it("symbol-keyed accessor is not invoked", () => {
    const d = studyDescriptor(); let calls = 0;
    Object.defineProperty(d, Symbol("g"), { enumerable: true, get() { calls++; return 1; } });
    expect(v(d).ok).toBe(false);
    expect(calls).toBe(0);
  });
  it("valid descriptors still pass and result is complete", () => {
    const r = v(devDescriptor());
    expect(r.ok).toBe(true);
    expect(r.value.label).toBe("Dev");
  });
});

describe("repair1 B10: plan schema is exact", () => {
  const mut = (f: (s: D) => void) => { const d = studyDescriptor(); f(d.task_schemas.plan.schema); return v(rehash(d)); };
  const bad = (name: string, f: (s: D) => void) =>
    it(name, () => { expect(hasCode(mut(f), "SCHEMA_MISMATCH")).toBe(true); });
  bad("progress.enum", (s) => { s.properties.progress.enum = ["never"]; });
  bad("steps.items.properties.text.enum", (s) => { s.properties.steps.items.properties.text.enum = ["a"]; });
  bad("steps.enum", (s) => { s.properties.steps.enum = ["a"]; });
  bad("steps.items.enum", (s) => { s.properties.steps.items.enum = ["a"]; });
  bad("root enum", (s) => { s.enum = ["a"]; });
  bad("progress.items", (s) => { s.properties.progress.items = { type: "string", nullable: false }; });
  bad("text.properties", (s) => { s.properties.steps.items.properties.text.properties = {}; });
  bad("state.items", (s) => { s.properties.steps.items.properties.state.items = { type: "string", nullable: false }; });
  bad("steps.properties", (s) => { s.properties.steps.properties = {}; });
  bad("state enum reordered", (s) => { s.properties.steps.items.properties.state.enum = ["done", "doing", "todo"]; });
  bad("state enum with extra value", (s) => { s.properties.steps.items.properties.state.enum.push("skipped"); });
});

describe("repair1 B3: CODE_LIKE classification", () => {
  const t = (f: (d: D) => void, path?: string) => {
    const d = studyDescriptor(); f(d); const r = v(rehash(d));
    expect(hasCode(r, "CODE_LIKE", path)).toBe(true);
  };
  it("template write '<script>'", () => t((d) => { d.template[0].write = "<script>"; }, "template.0.write"));
  it("layout.order '<script>'", () => t((d) => { d.layout.order = "<script>"; }, "layout.order"));
  it("template slot '<script>'", () => t((d) => { d.template[0].slot = "<script>"; }, "template.0.slot"));
  it("template field 'javascript:alert(1)'", () => t((d) => { d.template[0].field = "javascript:alert(1)"; }, "template.0.field"));
  it("layout.order URL", () => t((d) => { d.layout.order = "https://x/a.js"; }, "layout.order"));
  it("domain-specific rejection is still present for write", () => {
    const d = studyDescriptor(); d.template[0].write = "<script>";
    expect(hasCode(v(rehash(d)), "BAD_TEMPLATE")).toBe(true);
  });
});
