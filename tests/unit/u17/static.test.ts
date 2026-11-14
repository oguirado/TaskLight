// O15 static surface: src/digest imports no firebase, no ingest, no rAF, no DOM.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const DIR = join(process.cwd(), "src/digest");
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(n) ? [p] : []; });
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const files = walk(DIR);
const rel = (p: string) => relative(process.cwd(), p).split("\\").join("/");

describe("O15 static_surface", () => {
  test("expected module files exist", () => {
    const names = files.map(rel);
    for (const n of ["types", "project", "budget", "rank", "freshness", "engine", "index", "lens"]) expect(names).toContain(`src/digest/${n}.ts`);
  });
  test("no firebase/ import, no src/ingest import, no requestAnimationFrame, no DOM, no console", () => {
    for (const f of files) {
      const s = strip(readFileSync(f, "utf8"));
      expect(s, rel(f)).not.toMatch(/from\s+["']firebase\/|require\(["']firebase/);
      expect(s, rel(f)).not.toMatch(/from\s+["'][^"']*\/ingest(\/|["'])/);
      expect(s, rel(f)).not.toMatch(/requestAnimationFrame/);
      expect(s, rel(f)).not.toMatch(/\b(document|window)\./);
      expect(s, rel(f)).not.toMatch(/console\./);
    }
  });
  test("src/digest does not import src/reconcile or src/ui either (only schema, ai types, lens)", () => {
    for (const f of files) expect(strip(readFileSync(f, "utf8")), rel(f)).not.toMatch(/from\s+["'][^"']*\/(reconcile|ui|app|sync)(\/|["'])/);
  });
});
