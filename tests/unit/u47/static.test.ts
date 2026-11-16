// U47 static guards (spec acceptance 12 plus import discipline). Pass on the stubs by design.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const f = join(d, n);
  return statSync(f).isDirectory() ? walk(f) : [f];
});
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const PROV = walk(join(ROOT, "src/providers")).filter((f) => f.endsWith(".ts"));
const read = (f: string): string => readFileSync(f, "utf8");

describe("src/ai is untouched (sha256 snapshot taken by the oracle author from the then-current files)", () => {
  const snap = JSON.parse(read(join(__dirname, "ai_snapshot.json"))) as { files: Record<string, string> };
  const now = Object.fromEntries(walk(join(ROOT, "src/ai")).map((f) => [relative(join(ROOT, "src/ai"), f).split(sep).join("/"),
    createHash("sha256").update(readFileSync(f)).digest("hex")]));
  it("snapshot is non-trivial", () => { expect(Object.keys(snap.files).length).toBeGreaterThanOrEqual(6); });
  it("same file set (no src/ai file added or removed)", () => { expect(Object.keys(now).sort()).toEqual(Object.keys(snap.files).sort()); });
  it.each(Object.keys(snap.files))("%s byte-identical", (f) => { expect(now[f]).toBe(snap.files[f]); });
});

describe("hygiene of src/providers", () => {
  it("has the planned files", () => {
    const names = PROV.map((f) => relative(join(ROOT, "src/providers"), f));
    for (const f of ["types.ts", "index.ts"]) expect(names).toContain(f);
  });
  it.each(PROV)("%s: no chrome. identifier (raw text, comments included)", (f) => { expect(read(f)).not.toMatch(/\bchrome\./); });
  it.each(PROV)("%s: no chrome global, DOM, storage, network or console", (f) => {
    const s = strip(read(f));
    expect(s).not.toMatch(/\bchrome\b/);
    expect(s).not.toMatch(/\b(localStorage|sessionStorage|indexedDB|fetch\s*\(|XMLHttpRequest|WebSocket|document\s*\.|window\s*\.)/);
    expect(s).not.toMatch(/\bconsole\s*\./);
  });
  it.each(PROV)("%s: no firebase package, no createHybrid, no ../ai/hybrid|firebase import (makeHybrid is injected)", (f) => {
    const s = strip(read(f));
    expect(s).not.toMatch(/from\s+["']firebase(\/|["'])/);
    expect(s).not.toMatch(/\bcreateHybrid\b/);
    expect(s).not.toMatch(/from\s+["']\.\.\/ai\/(hybrid|firebase|parity|config)["']/);
  });
  it.each(PROV.filter((f) => !f.endsWith("types.ts")))("%s: no real timers, wall clock or randomness (Clock is injected; types.ts only declares the Clock interface)", (f) => {
    const s = strip(read(f));
    expect(s).not.toMatch(/(^|[^.\w])setTimeout\s*\(|(^|[^.\w])setInterval\s*\(|\bDate\s*\.\s*now|new\s+Date\b|Math\s*\.\s*random|performance\s*\.\s*now/);
  });
  it.each(PROV)("%s: AMEND_A: value imports from ../schema limited to validateTaskOutput and TASK_SCHEMAS", (f) => {
    const s = strip(read(f));
    for (const m of s.matchAll(/import\s+(?!type\b)\{([^}]*)\}\s*from\s*["']\.\.\/schema(?:\/[\w./]*)?["']/g)) {
      const names = (m[1] ?? "").split(",").map((x) => x.trim().replace(/^type\s+/, "").replace(/\s+as\s+.*/, "")).filter(Boolean);
      for (const n of names) expect(["validateTaskOutput", "TASK_SCHEMAS"]).toContain(n);
    }
  });
  it("U46 policy is imported, never re-implemented (no violation vocabulary in src/providers)", () => {
    const all = PROV.map((f) => strip(read(f))).join("\n");
    expect(all).not.toMatch(/REMOTE_FOR_PRIVATE|REMOTE_FOR_SHARED|LOCAL_PRIVATE_NOT_ALLOWED|CLOUD_PROVIDER_FOR_PRIVATE|LOCAL_NOT_LOOPBACK/);
  });
  it("no file outside the exclusive write surface is referenced for edit: router/agents consumers not imported at runtime", () => {
    const all = PROV.map((f) => strip(read(f))).join("\n");
    expect(all).not.toMatch(/import\s+(?!type\b)[^;]*from\s*["']\.\.\/(router|agents|app|sync|reconcile)(\/|["'])/);
  });
});
