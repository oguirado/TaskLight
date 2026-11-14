// Static purity scanner for src/ctx (C15). Usage: node purity_scan.mjs <dir>. Exit 1 on any hit.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const bad = [/Date\.now/, /Math\.random/, /firebase\//, /LanguageModel/];
const hits = [];
function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!/\.(ts|tsx|js|mjs)$/.test(n)) continue;
    const t = readFileSync(p, "utf8");
    for (const r of bad) if (r.test(t)) hits.push(`${p}: ${r}`);
    const spec = [...t.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
    for (const s of spec) {
      const ok = s.startsWith("./") || /^\.\.\/schema(\/|$)/.test(s);
      if (!ok) hits.push(`${p}: import ${s}`);
    }
  }
}
walk(process.argv[2]);
for (const h of hits) console.log(h);
process.exit(hits.length ? 1 : 0);
