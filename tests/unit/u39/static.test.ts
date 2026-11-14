// U39 static guards over src/router (pass on the stubs by design; they protect the real code).
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = resolve(__dirname, "../../../src/router");
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const files = (): string[] => readdirSync(DIR).filter((f) => f.endsWith(".ts"));

describe("hygiene of src/router", () => {
  it("has the planned files", () => {
    for (const f of ["types.ts", "tokenize.ts", "table.ts", "score.ts", "route.ts", "nano.ts", "index.ts"]) expect(files()).toContain(f);
  });
  it.each(files())("%s: no innerHTML / outerHTML / insertAdjacentHTML / eval / new Function", (f) => {
    expect(strip(readFileSync(resolve(DIR, f), "utf8"))).not.toMatch(/\b(innerHTML|outerHTML|insertAdjacentHTML|eval|document\s*\.\s*write)\b|new\s+Function\b|\bFunction\s*\(/);
  });
  it.each(files())("%s: no firebase/* import (U06 is the only caller)", (f) => {
    expect(strip(readFileSync(resolve(DIR, f), "utf8"))).not.toMatch(/(from\s+|import\s*\(\s*|require\s*\(\s*)["']firebase(\/|["'])/);
  });
  it.each(files())("%s: no console, storage, network or chrome global", (f) => {
    const s = strip(readFileSync(resolve(DIR, f), "utf8"));
    expect(s).not.toMatch(/\bconsole\s*\./);
    expect(s).not.toMatch(/\b(localStorage|sessionStorage|indexedDB|fetch\s*\(|XMLHttpRequest|chrome\s*\.)/);
  });
  it.each(files())("%s: no Math.random / Date.now (deterministic)", (f) => {
    expect(strip(readFileSync(resolve(DIR, f), "utf8"))).not.toMatch(/Math\s*\.\s*random|Date\s*\.\s*now|new\s+Date\b/);
  });
  it("reuses effectiveMode/SOURCE_FLOORS from src/lens instead of redefining them", () => {
    const all = files().map((f) => strip(readFileSync(resolve(DIR, f), "utf8"))).join("\n");
    expect(all).not.toMatch(/function\s+effectiveMode\b|const\s+effectiveMode\b|const\s+SOURCE_FLOORS\b/);
    expect(all).not.toMatch(/\bcreateHybrid\s*\(/);
  });
  it("does not import src/schema/enums route task (U39b stays independent)", () => {
    const all = files().map((f) => strip(readFileSync(resolve(DIR, f), "utf8"))).join("\n");
    expect(all).not.toMatch(/from\s+["']\.\.\/ai\/(hybrid|firebase)["']/);
  });
});
