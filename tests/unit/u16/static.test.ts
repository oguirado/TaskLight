// O15 (static half): import discipline for src/config and the whole of src.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const SRC = join(process.cwd(), "src");
function walk(d: string): string[] {
  return readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const files = walk(SRC);
const rel = (p: string) => relative(process.cwd(), p).split("\\").join("/");

describe("O15 static surface", () => {
  test("firebase/remote-config is imported only by src/config/firebase_rc.ts, and that file does import it", () => {
    const hits = files.filter((f) => /firebase\/remote-config/.test(strip(readFileSync(f, "utf8")))).map(rel);
    expect(hits).toEqual(["src/config/firebase_rc.ts"]);
  });
  test("firebase_rc.ts calls getRemoteConfig and reads values only through getValue(...).asString() (no asNumber/asBoolean)", () => {
    const s = strip(readFileSync(join(SRC, "config/firebase_rc.ts"), "utf8"));
    expect(s).toMatch(/getRemoteConfig\s*\(/);
    expect(s).toMatch(/asString\s*\(/);
    expect(s).not.toMatch(/asNumber|asBoolean/);
  });
  test("src/config uses no firestore, ai, rAF or console", () => {
    const cfg = files.filter((f) => rel(f).startsWith("src/config/"));
    expect(cfg.length).toBeGreaterThan(5);
    for (const f of cfg) {
      const s = strip(readFileSync(f, "utf8"));
      expect(s, rel(f)).not.toMatch(/firebase\/(firestore|ai|app-check|auth)|requestAnimationFrame|console\./);
    }
  });
  test("only firebase_rc.ts under src/config imports from firebase/*", () => {
    const cfg = files.filter((f) => rel(f).startsWith("src/config/") && rel(f) !== "src/config/firebase_rc.ts");
    for (const f of cfg) expect(strip(readFileSync(f, "utf8")), rel(f)).not.toMatch(/from\s+["']firebase\//);
  });
  test("expected module files exist", () => {
    const names = files.map(rel);
    for (const n of ["types", "keys", "parse", "hash", "live", "badge", "index", "firebase_rc"]) expect(names).toContain(`src/config/${n}.ts`);
  });
});
