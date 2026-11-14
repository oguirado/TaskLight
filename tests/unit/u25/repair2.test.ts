/* eslint-disable @typescript-eslint/no-explicit-any */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateLens } from "../../../src/lens/index";
import { rehash, studyDescriptor, type D } from "./helpers";

const v = (d: unknown) => validateLens(d) as D;

describe("repair2 B2/B6/B10: sparse arrays are rejected", () => {
  it("sparse statuses + sparse status enum (matching, rehashed) -> not ok", () => {
    let d = studyDescriptor();
    d.statuses = new Array(2);
    d.task_schemas.status.schema.enum = new Array(2);
    d = rehash(d);
    expect(v(d).ok).toBe(false);
  });
  it("one hole inside otherwise valid statuses -> not ok", () => {
    let d = studyDescriptor();
    delete d.statuses[1];
    delete d.task_schemas.status.schema.enum[1];
    d = rehash(d);
    expect(v(d).ok).toBe(false);
  });
  it.each(["tasks", "sources", "template", "statuses"])("hole in root array %s -> not ok", (k) => {
    const d = studyDescriptor();
    delete d[k][0];
    expect(v(rehash(d)).ok).toBe(false);
  });
  it("hole in kind_groups array and plan required array -> not ok", () => {
    const a = studyDescriptor(); delete a.kind_groups.tab[0];
    expect(v(rehash(a)).ok).toBe(false);
    const b = studyDescriptor(); delete b.task_schemas.plan.schema.required[0];
    expect(v(rehash(b)).ok).toBe(false);
  });
  it("validateLens does not throw on sparse input", () => {
    const d = studyDescriptor(); d.statuses = new Array(3);
    expect(() => v(d)).not.toThrow();
  });
});

describe("repair2 B3/B16: extra array properties are rejected, not dropped", () => {
  it("string payload on statuses array -> not ok", () => {
    const d = studyDescriptor(); d.statuses.payload = "<script>";
    expect(v(d).ok).toBe(false);
  });
  it("benign extra property on arrays (tasks, template, enum) -> not ok", () => {
    for (const get of [(d: D) => d.tasks, (d: D) => d.template, (d: D) => d.task_schemas.status.schema.enum, (d: D) => d.kind_groups.tab]) {
      const d = studyDescriptor(); get(d).extra = "x";
      expect(v(d).ok).toBe(false);
    }
  });
  it("non-canonical index keys on arrays ('-1', '01', '9') -> not ok", () => {
    for (const key of ["-1", "01", "99"]) {
      const d = studyDescriptor(); d.statuses[key] = "reading";
      expect(v(d).ok).toBe(false);
    }
  });
  it("any ok result equals its input structurally (nothing silently erased)", () => {
    const d = studyDescriptor(); d.tasks.note = "n";
    const r = v(d);
    if (r.ok) expect(JSON.parse(JSON.stringify(r.value))).toEqual(JSON.parse(JSON.stringify(d)));
    expect(r.ok).toBe(false);
  });
});

describe("repair2 purity: import direction src/lens -> src/schema only", () => {
  const root = join(__dirname, "../../../src/lens");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? (f === "__tests__" || f === "__fixtures__" ? [] : files(p)) : p.endsWith(".ts") ? [p] : [];
    });
  const specs = (src: string): string[] =>
    [...src.matchAll(/(?:import|export)\s[^;'"]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g)]
      .map((m) => (m[1] ?? m[2] ?? m[3] ?? m[4]) as string);
  it("every module specifier is relative (no node:*, no packages, no firebase)", () => {
    const bad: string[] = [];
    for (const f of files(root)) for (const s of specs(readFileSync(f, "utf8"))) if (!s.startsWith("./") && !s.startsWith("../")) bad.push(`${f}:${s}`);
    expect(bad).toEqual([]);
  });
  it("relative imports stay inside src/lens or src/schema", () => {
    const bad: string[] = [];
    for (const f of files(root)) for (const s of specs(readFileSync(f, "utf8"))) {
      if (!s.startsWith(".")) continue;
      const target = join(f, "..", s);
      if (!target.startsWith(root) && !target.startsWith(join(root, "../schema"))) bad.push(`${f}:${s}`);
    }
    expect(bad).toEqual([]);
  });
});
