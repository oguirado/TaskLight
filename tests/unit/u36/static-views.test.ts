import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../..");
const VIEWS = join(REPO, "src/views");
const walk = (d: string): string[] => existsSync(d) ? readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; }) : [];
const files = () => walk(VIEWS).filter((f) => /\.ts$/.test(f));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
/** Guard against vacuous passes: the scan only counts once index.ts is a real implementation. */
const implemented = () => {
  const idx = join(VIEWS, "index.ts");
  expect(existsSync(idx) && !/U36 stub/.test(readFileSync(idx, "utf8")), "src/views/index.ts is still the stub").toBe(true);
};

describe("U36 static scan of src/views (B2)", () => {
  it("types.ts and index.ts exist; index is not a stub; implementation is more than the two entry files", () => {
    expect(existsSync(join(VIEWS, "types.ts"))).toBe(true);
    expect(existsSync(join(VIEWS, "index.ts"))).toBe(true);
    const idx = readFileSync(join(VIEWS, "index.ts"), "utf8");
    expect(idx).not.toMatch(/U36 stub/);
    expect(idx).toMatch(/mountWall/);
    const total = files().reduce((n, f) => n + strip(readFileSync(f, "utf8")).length, 0);
    expect(total).toBeGreaterThan(3000);
  });

  const BAD: [string, RegExp][] = [
    ["innerHTML", /innerHTML/],
    ["outerHTML", /outerHTML/],
    ["insertAdjacentHTML", /insertAdjacentHTML/],
    ["document.write", /document\s*\.\s*write(ln)?\b/],
    ["eval(", /\beval\s*\(/],
    ["new Function", /new\s+Function\b/],
  ];

  it.each(BAD)("no %s anywhere in src/views (comments stripped)", (_n, re) => {
    implemented();
    const fs = files();
    expect(fs.length).toBeGreaterThanOrEqual(2);
    for (const f of fs) expect(strip(readFileSync(f, "utf8")), f).not.toMatch(re);
  });

  it("no Firebase / sync / network access in src/views (pure view layer)", () => {
    implemented();
    for (const f of files()) {
      const s = strip(readFileSync(f, "utf8"));
      expect(s, f).not.toMatch(/from\s+["'](firebase|@firebase)[/"']/);
      expect(s, f).not.toMatch(/from\s+["'][./]*\/(sync|ai|ledger)(\/|["'])/);
      expect(s, f).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon)\b/);
    }
  });

  it("types.ts declares the spec's exported names", () => {
    const s = readFileSync(join(VIEWS, "types.ts"), "utf8");
    for (const n of ["SourceKind", "SourceVM", "StepStateVM", "StepDetailVM", "StepVM", "TaskStatusVM", "AttentionVM", "AccentVM", "TaskVM", "WorkspaceVM",
      "AgendaItemVM", "AgendaGroupVM", "ArchivedVM", "ViewId", "WallVM", "WallHandlers", "WallHandle"]) {
      expect(s, n).toMatch(new RegExp(`export\\s+(type|interface)\\s+${n}\\b`));
    }
  });

  it("index.ts exports mountWall", () => {
    expect(readFileSync(join(VIEWS, "index.ts"), "utf8")).toMatch(/export\s+(function|const)\s+mountWall\b|export\s*\{[^}]*\bmountWall\b/);
  });
});
