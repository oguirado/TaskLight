// U46 static guards (O8). Source-text checks; schema export-name snapshot.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as schema from "../../../src/schema/index";
import { FOUR_SOURCES, SCHEMA_EXPORTS_PRE_U46 } from "./fixtures";

const ROOT = resolve(__dirname, "../../..");
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (rel: string): string => strip(readFileSync(resolve(ROOT, rel), "utf8"));

describe("O8 src/privacy/policy.ts hygiene", () => {
  it("has no non-type import/export from ../schema (u06 vi.mocks src/schema)", () => {
    const s = read("src/privacy/policy.ts");
    const stmts = s.match(/(?:^|\n)\s*(?:import|export)\b[^;]*?from\s+["'][^"']*schema[^"']*["']/g) ?? [];
    for (const st of stmts) expect(st.trim(), st).toMatch(/^(import|export)\s+type\b/);
    expect(s).not.toMatch(/\brequire\s*\(\s*["'][^"']*schema/);
    expect(s).not.toMatch(/\bimport\s*\(\s*["'][^"']*schema/);
  });
  it("imports nothing from ingest/sync/firebase/ui/app/ledger/router", () => {
    for (const f of ["src/privacy/policy.ts", "src/privacy/types.ts"]) {
      expect(read(f), f).not.toMatch(/from\s+["'](?:\.\.\/(?:ingest|sync|ui|app|ledger|router)|firebase)(?:\/[^"']*)?["']/);
    }
  });
  it("no console, DOM or storage/network globals", () => {
    const s = read("src/privacy/policy.ts");
    expect(s).not.toMatch(/\bconsole\s*\./);
    expect(s).not.toMatch(/\b(document|window|localStorage|sessionStorage|fetch\s*\(|XMLHttpRequest)\b/);
  });
  it("no eval / new Function / Math.random / Date (pure, deterministic)", () => {
    const s = read("src/privacy/policy.ts");
    expect(s).not.toMatch(/\beval\b|new\s+Function\b|Math\s*\.\s*random|Date\s*\.\s*now|new\s+Date\b/);
  });
  it("exports the three new names (text)", () => {
    const s = read("src/privacy/policy.ts");
    expect(s).toMatch(/export\s+const\s+PROVIDER_KINDS\b/);
    expect(s).toMatch(/export\s+function\s+isProviderKind\b/);
    expect(s).toMatch(/export\s+function\s+assertProviderAllowed\b/);
  });
  it("src/privacy/index.ts still re-exports policy via export *", () => {
    expect(read("src/privacy/index.ts")).toMatch(/export\s+\*\s+from\s+["']\.\/policy["']/);
  });
});

describe("O8 src/schema surface", () => {
  it("export names of src/schema/index unchanged vs pre-U46 (no ProviderKind/PROVIDER_KINDS in schema)", () => {
    expect(Object.keys(schema).sort()).toEqual([...SCHEMA_EXPORTS_PRE_U46].sort());
  });
  it("src/schema/enums.ts: INFERENCE_SOURCE literal is the exact 4-value frozen list, no provider symbols", () => {
    const s = read("src/schema/enums.ts");
    expect(s).toMatch(/INFERENCE_SOURCE\s*=\s*Object\.freeze\(\[\s*"ON_DEVICE",\s*"IN_CLOUD",\s*"LOCAL_SERVER",\s*"REMOTE_PROVIDER"\s*\]\s*as const\)/);
    expect(s).not.toMatch(/ProviderKind|PROVIDER_KINDS/);
  });
});

describe("rules text parity (also in tests/rules/u46_sources.test.ts)", () => {
  it("R1 exactly 2 `inference_source in [...]` lists, each equal as a set to INFERENCE_SOURCE", () => {
    const txt = readFileSync(resolve(ROOT, "firebase/firestore.rules"), "utf8");
    const m = [...txt.matchAll(/inference_source\s+in\s+\[([^\]]*)\]/g)];
    expect(m.length).toBe(2);
    for (const x of m) {
      const vals = (x[1] ?? "").split(",").map((v) => v.trim().replace(/^'|'$/g, "")).sort();
      expect(vals).toEqual([...schema.INFERENCE_SOURCE].sort());
      expect(vals).toEqual([...FOUR_SOURCES].sort());
    }
  });
  it("private capsule key whitelist still excludes inference_source (line-30 hasOnly list)", () => {
    const txt = readFileSync(resolve(ROOT, "firebase/firestore.rules"), "utf8");
    const m = txt.match(/tierOf\(w, p\) == 'private'\s*\?\s*\(request\.resource\.data\.keys\(\)\.hasOnly\(\[([^\]]*)\]\)/);
    expect(m).not.toBeNull();
    expect(m?.[1] ?? "").not.toMatch(/inference_source/);
  });
});
