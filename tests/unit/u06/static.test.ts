import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(__dirname, "../../../src");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; })
    .filter((p) => /\.(ts|tsx|js|mjs|cjs)$/.test(p));
const files = walk(SRC);
const rel = (p: string) => relative(SRC, p).split("\\").join("/");

describe("static: sole importer / sole caller (B2, DISP_01)", () => {
  it("only src/ai/firebase.ts imports firebase/ai", () => {
    const hits = files.filter((f) => /(from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']firebase\/ai["']/.test(readFileSync(f, "utf8"))).map(rel);
    expect(hits).toEqual(["ai/firebase.ts"]);
  });
  it("no file under src/ai other than firebase.ts imports any firebase package", () => {
    const bad = files.filter((f) => rel(f).startsWith("ai/") && rel(f) !== "ai/firebase.ts")
      .filter((f) => /["']@?firebase(\/[^"']*)?["']/.test(readFileSync(f, "utf8"))).map(rel);
    expect(bad).toEqual([]);
  });
  it("getAI / getGenerativeModel are referenced only in src/ai/firebase.ts", () => {
    const bad = files.filter((f) => /\b(getAI|getGenerativeModel)\b/.test(readFileSync(f, "utf8"))).map(rel);
    expect(bad).toEqual(["ai/firebase.ts"]);
  });
  it("the module set of SPEC_U06 section 1 exists", () => {
    const set = new Set(files.map(rel));
    for (const n of ["types", "config", "hybrid", "firebase", "parity", "index"]) expect(set.has(`ai/${n}.ts`), n).toBe(true);
  });
  it("hybrid.ts depends only on injected deps: imports nothing from firebase or the DOM-ish SDKs", () => {
    const s = readFileSync(join(SRC, "ai/hybrid.ts"), "utf8");
    expect(s).not.toMatch(/from\s+["'](?:@?firebase|\.\/firebase)/);
    expect(s).not.toMatch(/\b(?:localStorage|sessionStorage|fetch\(|XMLHttpRequest|chrome\.)/);
  });
  it("the only real implementations live under ai/, and nothing in src/ai reads clocks or logs (B19)", () => {
    const bad = files.filter((f) => rel(f).startsWith("ai/"))
      .filter((f) => /\b(Date\.now|new Date\(|performance\.now|console\.)/.test(readFileSync(f, "utf8"))).map(rel);
    expect(bad).toEqual([]);
  });
});
