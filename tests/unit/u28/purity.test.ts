import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SRC_CTX } from "./ref";

const SCAN = join(dirname(fileURLToPath(import.meta.url)), "purity_scan.mjs");
const run = (d: string) => spawnSync(process.execPath, [SCAN, d], { encoding: "utf8" });

describe("C15 purity_scan", () => {
  it("src/ctx has 0 hits (clock, random, firebase, LanguageModel, foreign imports)", () => {
    const r = run(SRC_CTX); expect(r.stdout).toBe(""); expect(r.status).toBe(0);
  });
  it.each([
    ["Date.now", "export const a = Date.now();"],
    ["Math.random", "export const a = Math.random();"],
    ["firebase", 'import { x } from "firebase/app";'],
    ["LanguageModel", "export const a = LanguageModel;"],
    ["ingest import", 'import { c } from "../ingest/canonical";'],
    ["bare import", 'import fs from "node:fs";'],
  ])("planted file (%s) makes the scanner exit non-zero", (_n, code) => {
    const d = mkdtempSync(join(tmpdir(), "u28-scan-"));
    try { mkdirSync(join(d, "sub")); writeFileSync(join(d, "sub", "bad.ts"), code); expect(run(d).status).toBe(1); }
    finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("control: allowed imports (./x, ../schema) are clean", () => {
    const d = mkdtempSync(join(tmpdir(), "u28-scan-"));
    try { writeFileSync(join(d, "ok.ts"), 'import type { A } from "../schema";\nimport { b } from "./b";\nexport {};'); expect(run(d).status).toBe(0); }
    finally { rmSync(d, { recursive: true, force: true }); }
  });
});
