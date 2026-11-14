import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO = resolve(__dirname, "../../..");
export const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

export function walk(dir: string, out: string[] = [], skip: readonly string[] = ["node_modules"]): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    if (skip.includes(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out, skip); else out.push(p);
  }
  return out;
}
export function read(p: string): string { return readFileSync(p, "utf8"); }
export function findUuids(text: string): string[] { return text.match(UUID_RE) ?? []; }

export function parseCsp(csp: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const d of csp.split(";").map((x) => x.trim()).filter(Boolean)) {
    const [name, ...vals] = d.split(/\s+/);
    m.set(name!.toLowerCase(), vals);
  }
  return m;
}
export function metaCsp(html: string): string | null {
  const m = /<meta\s+[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/i.exec(html);
  if (!m) return null;
  const c = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[0]);
  return c ? (c[1] ?? c[2] ?? null) : null;
}
/** violations of the iframe-embedding rule in an HTML text (static markup only). */
export function iframeViolations(html: string): string[] {
  const v: string[] = [];
  for (const m of html.matchAll(/<iframe\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\ssrc\s*=/.test(tag)) v.push(`iframe without src: ${tag}`);
    if (!/\sallow\s*=\s*["'][^"']*\blanguage-model\b[^"']*["']/.test(tag)) v.push(`iframe without allow="language-model": ${tag}`);
  }
  return v;
}
/** script-side assignment of iframe allow (S4: silently yields "unavailable"). */
export function scriptAllowAssignments(src: string): string[] {
  return [...src.matchAll(/\.allow\s*=[^=]|setAttribute\(\s*["']allow["']/g)].map((m) => m[0]);
}

// ---- CSP oracle (B15, B24). Allowlists are the ORACLE's reading of "only required Firebase/Google endpoints". ----
const FIREBASE_HOSTS = [
  "https://firebasevertexai.googleapis.com", "https://firebaseappcheck.googleapis.com", "https://content-firebaseappcheck.googleapis.com",
  "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com", "https://firestore.googleapis.com",
  "https://www.googleapis.com", "https://recaptchaenterprise.googleapis.com", "https://www.google.com",
];
export const CSP_ALLOWED: Readonly<Record<string, readonly (string | RegExp)[]>> = {
  "default-src": ["'none'", "'self'"],
  "script-src": ["'self'", "https://www.google.com/recaptcha/", "https://www.gstatic.com/recaptcha/", "https://apis.google.com"],
  "connect-src": ["'self'", ...FIREBASE_HOSTS],
  "frame-src": ["'self'", "https://www.google.com", "https://recaptcha.google.com", "https://accounts.google.com",
    /^https:\/\/[a-z0-9-]+\.(firebaseapp\.com|web\.app)$/, "https://<SITE>"],
  "img-src": ["'self'", "data:"], "style-src": ["'self'"], "font-src": ["'self'"], "worker-src": ["'self'"],
  "object-src": ["'none'"], "base-uri": ["'self'", "'none'"], "form-action": ["'self'", "'none'"],
  "frame-ancestors": [/^chrome-extension:\/\/(<EXT_ID>|[a-p]{32})$/],
};
export const CSP_MUST_HAVE: Readonly<Record<string, readonly string[]>> = {
  "script-src": ["'self'", "https://www.google.com/recaptcha/", "https://www.gstatic.com/recaptcha/"],
  "connect-src": ["'self'", "https://firebasevertexai.googleapis.com", "https://firebaseappcheck.googleapis.com",
    "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com", "https://firestore.googleapis.com"],
  "frame-src": ["https://www.google.com"],
  "object-src": ["'none'"],
};
export function cspViolations(csp: string, opts: { requireFrameAncestors: boolean }): string[] {
  const v: string[] = []; const d = parseCsp(csp);
  for (const bad of ["'unsafe-eval'", "'unsafe-inline'", "'unsafe-hashes'"]) if (csp.includes(bad)) v.push(`forbidden ${bad}`);
  for (const [name, vals] of d) {
    const allowed = CSP_ALLOWED[name];
    if (!allowed) { v.push(`directive not in oracle list: ${name}`); continue; }
    for (const x of vals) {
      if (x === "*" || x.includes("*") ) { v.push(`${name}: wildcard ${x}`); continue; }
      if (!allowed.some((a) => (typeof a === "string" ? a === x : a.test(x)))) v.push(`${name}: source not allowed: ${x}`);
    }
  }
  for (const [name, must] of Object.entries(CSP_MUST_HAVE)) for (const m of must) if (!(d.get(name) ?? []).includes(m)) v.push(`${name}: missing ${m}`);
  if (!d.has("default-src")) v.push("default-src missing");
  if (opts.requireFrameAncestors) {
    const fa = d.get("frame-ancestors");
    if (!fa || fa.length === 0) v.push("frame-ancestors missing or empty");
  }
  return v;
}
