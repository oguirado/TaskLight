import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(n) ? [p] : []; });
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const rel = (p: string) => relative(process.cwd(), p).split("\\").join("/");
const files = [...walk(join(process.cwd(), "src/privacy")), ...walk(join(process.cwd(), "src/ledger"))];

describe("U19 static surface", () => {
  test("module files named by the spec exist", () => {
    const names = files.map(rel);
    for (const n of ["privacy/types", "privacy/policy", "privacy/syncProjection", "privacy/screenshotGate", "privacy/index", "ledger/types", "ledger/ledger", "ledger/flush", "ledger/panelModel", "ledger/index"]) expect(names).toContain(`src/${n}.ts`);
  });
  test("no firebase imports (Firestore only through the injected LedgerRemote), no DOM, no rAF, no console", () => {
    for (const f of files) {
      const s = strip(readFileSync(f, "utf8"));
      expect(s, rel(f)).not.toMatch(/from\s+["']firebase\/|require\(["']firebase/);
      expect(s, rel(f)).not.toMatch(/\b(document|window|localStorage|indexedDB)\b/);
      expect(s, rel(f)).not.toMatch(/requestAnimationFrame|console\./);
    }
  });
  test("no dependency on raw-event modules or on U14/U15/U20 surfaces", () => {
    for (const f of files) expect(strip(readFileSync(f, "utf8")), rel(f)).not.toMatch(/from\s+["'][^"']*\/(ingest|sync|firebase|ui|app)(\/|["'])/);
  });
});
