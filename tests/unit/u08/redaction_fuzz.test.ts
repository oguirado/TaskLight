// Repair loop 4 (fuzz): deterministic, dependency-free redaction fuzz matrix for U08 (SPEC B6/B7/B8/B9).
// Invariants per generated case (a secret = any substring listed in `secrets`):
//   A. normalise(): accepted => no secret in any output field and hasRedactResidue(text) is false;
//      rejected => errors never echo a secret (B8). Fail-closed rejection is allowed, silently leaking is not.
//   B. hasRedactResidue agrees: if redact(text).text still contains a secret, hasRedactResidue(that text) must be true.
//   C. redact(text).text itself contains no secret (B6: every match is replaced).
// All fake secrets are assembled at runtime (PRNG + concatenation); no literal secret is stored in this file.
import { afterAll, describe, expect, it } from "vitest";
import { normalise, redact } from "../../../src/ingest/index";
import { hasRedactResidue } from "../../../src/ingest/redact";
import { INGEST_LIMITS } from "../../../src/ingest/limits";
import { mkReg, rawEnv } from "./helpers";

const j = (...p: string[]): string => p.join("");
const CAP = INGEST_LIMITS.EVENT_TEXT_MAX;

// ---------------------------------------------------------------- PRNG and alphabets
class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  f(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number { return Math.floor(this.f() * n); }
  pick<T>(a: readonly T[]): T { return a[this.int(a.length)]!; }
  str(al: string, n: number): string { let o = ""; for (let i = 0; i < n; i++) o += al[this.int(al.length)]; return o; }
  between(lo: number, hi: number): number { return lo + this.int(hi - lo + 1); }
}
const LOW = "abcdefghijklmnopqrstuvwxyz";
const UP = LOW.toUpperCase();
const DIG = "0123456789";
const ALNUM = UP + LOW + DIG;
const B64URL = ALNUM + "-_";
const B64 = ALNUM + "+/";
const HEX = "0123456789abcdef";

function entropy(s: string): number {
  const m = new Map<string, number>();
  for (const c of s) m.set(c, (m.get(c) ?? 0) + 1);
  let h = 0;
  for (const v of m.values()) { const p = v / s.length; h -= p * Math.log2(p); }
  return h;
}
function until(min: number, gen: () => string): string {
  for (let i = 0; i < 500; i++) { const s = gen(); if (s.length >= 32 && entropy(s) >= min) return s; }
  throw new Error("generator could not reach entropy");
}
const val = (r: Rng, n = 10): string => r.str(ALNUM, n);
const word = (r: Rng): string => r.str(LOW, r.between(6, 9));
const words = (r: Rng, n: number): string[] => Array.from({ length: n }, () => word(r));
const cv = (s: string, r: Rng): string => {
  switch (r.int(5)) {
    case 0: return s;
    case 1: return s.toUpperCase();
    case 2: return s.toLowerCase();
    case 3: return s[0]!.toUpperCase() + s.slice(1).toLowerCase();
    default: return [...s].map((c, i) => (i % 2 ? c.toLowerCase() : c.toUpperCase())).join("");
  }
};

// ---------------------------------------------------------------- instances
type Tier = "spec" | "robust"; // spec = named by B6; robust = common real-world shape of the same class
interface Inst { v: string; text: string; secrets: string[]; term: boolean; tier: Tier }
const I = (v: string, text: string, secrets: string[], term = true, tier: Tier = "spec"): Inst => ({ v, text, secrets, term, tier });

const NL = "\n";

// ---- KEY_ASSIGN
interface Val { v: string; raw: string; inner?: string; secrets: string[]; term: boolean; tier: Tier }
const KINDS: Array<(r: Rng) => Val> = [
  (r) => { const s = val(r, 10); return { v: "bare", raw: s, inner: s, secrets: [s], term: true, tier: "spec" }; },
  (r) => { const s = r.str(ALNUM + "!#$%^&*-_+~.?/|:@=", 12); return { v: "bare-symbols", raw: s, inner: s, secrets: [s], term: true, tier: "spec" }; },
  (r) => { const w = words(r, 3); const i = w.join(" "); return { v: "dq-spaces", raw: `"${i}"`, inner: i, secrets: [i, ...w], term: true, tier: "spec" }; },
  (r) => { const w = words(r, 3); const i = w.join(" "); return { v: "sq-spaces", raw: `'${i}'`, secrets: [i, ...w], term: true, tier: "spec" }; },
  (r) => { const w = words(r, 4); const i = `${w[0]},${w[1]};${w[2]} ${w[3]}`; return { v: "dq-punct", raw: `"${i}"`, inner: i, secrets: [i, ...w], term: true, tier: "spec" }; },
  (r) => { const w = words(r, 3); const i = `${w[0]}\\"${w[1]} ${w[2]}`; return { v: "dq-escaped-quote", raw: `"${i}"`, secrets: w, term: true, tier: "spec" }; },
  (r) => { const w = words(r, 3); const i = `${w[0]}\\'${w[1]} ${w[2]}`; return { v: "sq-escaped-quote", raw: `'${i}'`, secrets: w, term: true, tier: "spec" }; },
  (r) => { const w = words(r, 4); return { v: "dq-newline", raw: `"${w[0]} ${w[1]}${NL}${w[2]} ${w[3]}"`, secrets: w, term: true, tier: "spec" }; },
  (r) => { const w = words(r, 2); return { v: "dq-tab", raw: `"${w[0]}\t${w[1]}"`, secrets: w, term: true, tier: "spec" }; },
  (r) => { const w = words(r, 2); return { v: "dq-padded", raw: `"  ${w[0]} ${w[1]}  "`, secrets: w, term: true, tier: "spec" }; },
  (r) => { const s = val(r, 11); return { v: "backtick", raw: "`" + s + "`", secrets: [s], term: true, tier: "spec" }; },
  (r) => { const w = words(r, 3); return { v: "backtick-spaces", raw: "`" + w.join(" ") + "`", secrets: w, term: true, tier: "robust" }; },
  (r) => { const w = words(r, 3); return { v: "unterminated-dq", raw: `"${w.join(" ")}`, secrets: [w.join(" "), ...w], term: false, tier: "spec" }; },
  (r) => { const w = words(r, 3); return { v: "unterminated-sq", raw: `'${w.join(" ")}`, secrets: [w.join(" "), ...w], term: false, tier: "spec" }; },
  (r) => { const s = r.str(DIG, r.between(6, 8)); return { v: "pin", raw: s, inner: s, secrets: [s], term: true, tier: "spec" }; },
  (r) => { const w = words(r, 4); const i = `${w[0]}=${w[1]}:${w[2]} ${w[3]}`; return { v: "dq-eq-colon", raw: `"${i}"`, inner: i, secrets: w, term: true, tier: "spec" }; },
];
const KA_NAMES = ["API_KEY", "api_key", "apiKey", "SECRET", "client_secret", "clientSecret", "PASSWORD", "password", "passwd", "DB_PASSWORD",
  "db.password", "config.db.password", "a.b.c.token", "aws_secret_access_key", "AWS_SESSION_TOKEN", "auth-token", "x-api-key", "private_key",
  "SECRET_KEY", "GITHUB_TOKEN", "secret_value", "accessToken", "refresh_token", "my.app.secret.key"];
const SEPS = ["=", "= ", " = ", ":", ": ", ":   ", "\t: ", ":\n  "];

function genKeyAssign(r: Rng): Inst[] {
  const out: Inst[] = [];
  const nm = (): string => cv(r.pick(KA_NAMES), r);
  for (const k of KINDS) {
    for (let n = 0; n < 3; n++) {
      const x = k(r); const sep = r.pick(SEPS);
      out.push(I(`plain/${x.v}`, `${nm()}${sep}${x.raw}`, x.secrets, x.term, x.tier));
    }
  }
  const withInner = KINDS.map((k) => k(r)).filter((x) => x.inner !== undefined);
  for (const x of withInner) {
    out.push(I(`json/${x.v}`, `{"${nm()}": "${x.inner}"}`, x.secrets, true, "spec"));
    out.push(I(`json-escaped/${x.v}`, `{\\"${nm()}\\":\\"${x.inner}\\"}`, x.secrets, true, "robust"));
    out.push(I(`quoted-name-sq/${x.v}`, `'${nm()}': ${x.raw}`, x.secrets, true, "spec"));
    out.push(I(`quoted-name-dq-eq/${x.v}`, `"${nm()}"=${x.raw}`, x.secrets, true, "spec"));
    out.push(I(`go-walrus/${x.v}`, `${nm()} := "${x.inner}"`, x.secrets, true, "robust"));
    out.push(I(`ruby-hashrocket/${x.v}`, `'${nm()}' => '${x.inner}'`, x.secrets, true, "robust"));
    out.push(I(`php-hashrocket/${x.v}`, `"${nm()}" => "${x.inner}"`, x.secrets, true, "robust"));
  }
  for (const x of [KINDS[0]!(r), KINDS[2]!(r), KINDS[3]!(r), KINDS[14]!(r)]) {
    out.push(I(`yaml/${x.v}`, `${nm()}: ${x.raw}${NL}other: 1`, x.secrets, true, "spec"));
    out.push(I(`yaml-folded/${x.v}`, `${nm()}:${NL}  ${x.raw}${NL}other: 1`, x.secrets, true, "spec"));
    out.push(I(`env-export/${x.v}`, `export ${nm().toUpperCase()}=${x.raw}`, x.secrets, true, "spec"));
    out.push(I(`env-prefix-cmd/${x.v}`, `${nm().toUpperCase()}=${x.raw} node app.js`, x.secrets, true, "spec"));
    out.push(I(`cli-flag/${x.v}`, `--${r.pick(["password", "api-key", "token", "client-secret"])}=${x.raw}`, x.secrets, true, "spec"));
  }
  for (const x of [KINDS[0]!(r), KINDS[1]!(r)]) {
    out.push(I(`url-query/${x.v}`, `https://host.example/p?a=1&${r.pick(["password", "token", "api_key", "secret"])}=${x.raw}&b=2`, x.secrets));
  }
  return out;
}

// ---- API keys
function genApiKey(r: Rng): Inst[] {
  const formats: Array<[string, () => string]> = [
    ["aiza", () => until(3.6, () => j("AI", "za") + r.str(B64URL, 35))],
    ["sk", () => until(3.6, () => j("s", "k-") + r.str(ALNUM, 48))],
    ["ghp", () => until(3.6, () => j("gh", "p_") + r.str(ALNUM, 36))],
    ["slack", () => until(3.6, () => j("xo", "xb-") + r.str(DIG, 12) + "-" + r.str(DIG, 12) + "-" + r.str(ALNUM, 24))],
    ["sk-proj", () => until(3.6, () => j("s", "k-proj-") + r.str(B64URL, 64))],
    ["hex40", () => until(3.55, () => r.str(HEX, 40))],
  ];
  const out: Inst[] = [];
  for (const rep of [0, 1]) {
    for (const [name, mk] of formats) {
      const k = mk();
      const forms: Array<[string, string]> = [
        ["bare", k], ["x-api-key-header", `X-API-Key: ${k}`], ["api_key-assign", `api_key=${k}`], ["key-query", `https://api.example/v1?key=${k}`],
        ["apiKey-dq", `apiKey: "${k}"`], ["apiKey-json", `{"apiKey":"${k}"}`],
      ];
      for (const [f, t] of forms) out.push(I(`${name}/${f}#${rep}`, t, [k]));
    }
  }
  return out;
}

// ---- BEARER
function genBearer(r: Rng): Inst[] {
  const out: Inst[] = [];
  const toks: Array<[string, () => string, string]> = [
    ["alnum", () => val(r, 20), ""],
    ["token68", () => r.str(B64URL + "._~+/", 18) + "==", ""],
    ["long-hi", () => until(3.6, () => r.str(B64URL, 48)), ""],
    ["dq", () => val(r, 16), '"'],
    ["sq", () => val(r, 16), "'"],
  ];
  const heads = ["Authorization: ", "authorization: ", "AUTHORIZATION: ", "", "-H 'Authorization: ", '{"Authorization": "', "proxy-authorization="];
  const kws = ["Bearer", "bearer", "BEARER", "bEaReR"];
  const gaps = [" ", "  ", "\t", "\n"];
  for (const [tn, mk, q] of toks) {
    for (let n = 0; n < 4; n++) {
      const t = mk(); const h = r.pick(heads); const kw = r.pick(kws); const gap = r.pick(gaps);
      const tail = h.endsWith("'") ? "'" : h.endsWith('"') ? '"}' : "";
      out.push(I(`${tn}/${kw}/${JSON.stringify(h)}/${JSON.stringify(gap)}`, `${h}${kw}${gap}${q}${t}${q}${tail}`, [t]));
    }
  }
  return out;
}

// ---- JWT
function genJwt(r: Rng): Inst[] {
  const mk = (): { jwt: string; p: string; s: string } => {
    const h = j("ey", "J") + r.str(B64URL, r.between(10, 40));
    const p = j("ey", "J") + r.str(B64URL, r.between(10, 80));
    const s = r.str(B64URL, r.between(20, 60));
    return { jwt: `${h}.${p}.${s}`, p, s };
  };
  const out: Inst[] = [];
  for (let n = 0; n < 4; n++) {
    const { jwt, p, s } = mk(); const sec = [jwt, p, s];
    out.push(I("bare", jwt, sec), I("bearer", `Authorization: Bearer ${jwt}`, sec), I("token-assign", `token=${jwt}`, sec),
      I("json-idToken", `{"idToken":"${jwt}"}`, sec), I("cookie", `cookie: session=${jwt}; Path=/`, sec),
      I("quoted", `'${jwt}'`, sec), I("url-query", `https://app.example/cb?id_token=${jwt}&state=x`, sec),
      I("url-fragment", `https://app.example/cb#access_token=${jwt}`, sec), I("trailing-dot", `${jwt}.`, sec),
      I("jwt-assign-name", `jwt: ${jwt}`, sec));
    const b = mk(); out.push(I("two", `${jwt} ${b.jwt}`, [...sec, b.jwt, b.p, b.s]));
  }
  return out;
}

// ---- PRIVATE_KEY
function pemBody(r: Rng, lines: number): string[] {
  return Array.from({ length: lines }, (_, i) => r.str(B64, i === lines - 1 ? 44 : 64) + (i === lines - 1 ? "=" : ""));
}
function genPem(r: Rng): Inst[] {
  const out: Inst[] = [];
  const B = "-----";
  const types: Array<[string, Tier]> = [["", "spec"], ["RSA ", "spec"], ["EC ", "spec"], ["DSA ", "spec"], ["OPENSSH ", "spec"], ["ENCRYPTED ", "spec"],
    ["RSA-PSS ", "robust"], ["EC-P256 ", "robust"]];
  for (const [t, tier] of types) {
    for (const n of [1, 3, 12, 30]) {
      const body = pemBody(r, n); const hdr = `BEGIN ${t}PRIVATE KEY`; const end = `END ${t}PRIVATE KEY`;
      const sec = [...body, hdr];
      out.push(I(`terminated/${JSON.stringify(t)}/${n}`, `${B}${hdr}${B}${NL}${body.join(NL)}${NL}${B}${end}${B}`, sec, true, tier));
    }
  }
  for (const n of [1, 3, 12]) {
    const body = pemBody(r, n);
    out.push(I(`unterminated/${n}`, `${B}BEGIN RSA PRIVATE KEY${B}${NL}${body.join(NL)}`, [...body, "BEGIN RSA PRIVATE KEY"], false));
    out.push(I(`unterminated-cut-mid-line/${n}`, `${B}BEGIN PRIVATE KEY${B}${NL}${body.join(NL)}`.slice(0, -17), [...body.slice(0, -1), "BEGIN PRIVATE KEY"], false));
  }
  const b1 = pemBody(r, 4);
  out.push(I("escaped-newlines", `${B}BEGIN PRIVATE KEY${B}\\n${b1.join("\\n")}\\n${B}END PRIVATE KEY${B}\\n`, b1));
  out.push(I("space-joined", `${B}BEGIN PRIVATE KEY${B} ${b1.join(" ")} ${B}END PRIVATE KEY${B}`, b1));
  out.push(I("indented", [`${B}BEGIN RSA PRIVATE KEY${B}`, ...b1, `${B}END RSA PRIVATE KEY${B}`].map((l) => "    " + l).join(NL), b1));
  out.push(I("comment-prefixed", [`${B}BEGIN EC PRIVATE KEY${B}`, ...b1, `${B}END EC PRIVATE KEY${B}`].map((l) => "# " + l).join(NL), b1));
  out.push(I("quote-prefixed", [`${B}BEGIN EC PRIVATE KEY${B}`, ...b1, `${B}END EC PRIVATE KEY${B}`].map((l) => "> " + l).join(NL), b1));
  const iv = r.str(HEX, 32);
  out.push(I("legacy-headers", `${B}BEGIN RSA PRIVATE KEY${B}${NL}Proc-Type: 4,ENCRYPTED${NL}DEK-Info: AES-128-CBC,${iv}${NL}${NL}${b1.join(NL)}${NL}${B}END RSA PRIVATE KEY${B}`, [...b1, iv]));
  const b2 = pemBody(r, 3), b3 = pemBody(r, 3);
  out.push(I("two-blocks", `${B}BEGIN PRIVATE KEY${B}${NL}${b2.join(NL)}${NL}${B}END PRIVATE KEY${B} between ${B}BEGIN EC PRIVATE KEY${B}${NL}${b3.join(NL)}${NL}${B}END EC PRIVATE KEY${B}`, [...b2, ...b3]));
  out.push(I("blank-lines-in-body", `${B}BEGIN PRIVATE KEY${B}${NL}${b2[0]}${NL}${NL}${b2[1]}${NL}${B}END PRIVATE KEY${B}`, b2.slice(0, 2)));
  out.push(I("assigned-json-string", `private_key: "${B}BEGIN PRIVATE KEY${B}\\n${b1.join("\\n")}\\n${B}END PRIVATE KEY${B}\\n"`, b1));
  return out;
}

// ---- URL_CREDS
function genUrlCreds(r: Rng): Inst[] {
  const out: Inst[] = [];
  const schemes = ["https", "http", "postgres", "postgresql", "mysql", "mongodb", "mongodb+srv", "redis", "amqps", "ftp", "ssh", "git+https", "s3"];
  const specials = "!$%^&*-_=+~#.?]";
  for (let n = 0; n < 26; n++) {
    const sc = schemes[n % schemes.length]!;
    const user = r.str(LOW + DIG, r.between(4, 9)) + r.pick(["", ".x", "_y", "-z"]);
    const pw = n % 2 ? val(r, r.between(8, 14)) : r.str(ALNUM + specials, r.between(8, 14));
    const rest = r.pick(["host.example/repo.git", "db.internal:5432/app?sslmode=require", "h.example:8080/a/b#frag", "10.0.0.5/x"]);
    out.push(I(`${sc}/${n % 2 ? "alnum" : "specials"}`, `${sc}://${user}:${pw}@${rest}`, [pw, `${user}:${pw}`]));
  }
  for (let n = 0; n < 3; n++) {
    const pw = val(r, 12); const u = r.str(LOW, 7);
    out.push(I("empty-user", `redis://:${pw}@cache.example:6379/0`, [pw], true, "robust"));
    out.push(I("user-is-email", `https://${u}@${r.str(LOW, 7)}.example.com:${pw}@dbhost/`, [pw, `:${pw}@`], true, "robust"));
    const p1 = val(r, 8), p2 = val(r, 8);
    out.push(I("password-contains-at", `postgres://${u}:${p1}@${p2}@dbhost:5432/x`, [p1, p2], true, "robust"));
    out.push(I("password-contains-colon", `postgres://${u}:${p1}:${p2}@db.example/x`, [p1, p2]));
  }
  return out;
}

// ---- APPCHECK_DEBUG
function uuid(r: Rng, upper = false): string {
  const u = [r.str(HEX, 8), r.str(HEX, 4), r.str(HEX, 4), r.str(HEX, 4), r.str(HEX, 12)].join("-");
  return upper ? u.toUpperCase() : u;
}
function genAppCheck(r: Rng): Inst[] {
  const out: Inst[] = [];
  const phrases = ["AppCheck debug token:", "App Check debug token:", "appcheck debug token:", "APPCHECK DEBUG TOKEN:", "AppCheck Debug Token:"];
  for (let n = 0; n < 5; n++) {
    for (const ph of phrases) {
      const u = uuid(r, n % 2 === 1); const last = u.slice(-12);
      const forms: Array<[string, string]> = [
        ["bare", `${ph} ${u}`], ["dq", `${ph} "${u}"`], ["sq", `${ph} '${u}'`], ["backtick", `${ph} \`${u}\``], ["period", `${ph} ${u}. You will need to add it in the console.`],
        ["paren", `${ph} (${u})`], ["newline", `${ph}${NL}${u}`], ["spaces", `${ph}    ${u}`],
      ];
      for (const [f, t] of forms) out.push(I(`${ph}/${f}`, t, [u, last]));
    }
  }
  for (let n = 0; n < 4; n++) {
    const u = uuid(r, n % 2 === 1); const last = u.slice(-12); const E = j("FIREBASE_APPCHECK", "_DEBUG_TOKEN");
    const forms: Array<[string, string]> = [
      ["env", `${E}=${u}`], ["export-dq", `export ${E}="${u}"`], ["js-assign", `self.${E} = '${u}';`], ["yaml", `${E}: ${u}`],
      ["json", `{"${E}":"${u}"}`], ["lower", `${E.toLowerCase()}=${u}`], ["window-dq", `window.${E}="${u}"`], ["spaced-eq", `${E} = ${u}`],
      ["json-escaped", `{\\"${E}\\":\\"${u}\\"}`],
    ];
    for (const [f, t] of forms) out.push(I(`env-var/${f}`, t, [u, last], true, f === "json-escaped" ? "robust" : "spec"));
  }
  return out;
}

// ---- EMAIL
function genEmail(r: Rng): Inst[] {
  const out: Inst[] = [];
  const tlds = ["com", "org", "io", "co", "net", "dev", "museum", "info", "technology", "COM"];
  const dom = (labels: number): string => Array.from({ length: labels }, () => r.str(LOW, r.between(4, 8))).join(".") + "." + r.pick(tlds);
  const locals: Array<[string, () => string]> = [
    ["dotted", () => r.str(LOW, 6) + "." + r.str(LOW, 7)], ["underscore", () => r.str(LOW, 6) + "_" + r.str(LOW, 6)], ["plus-tag", () => r.str(LOW, 7) + "+" + r.str(LOW, 6)],
    ["hyphen", () => r.str(LOW, 6) + "-" + r.str(LOW, 6)], ["percent", () => r.str(LOW, 6) + "%" + r.str(LOW, 6)], ["upper", () => r.str(UP, 8)], ["digits", () => r.str(LOW, 6) + r.str(DIG, 4)],
  ];
  for (const [ln, lm] of locals) {
    for (const labels of [1, 2, 3, 4]) {
      const l = lm(); const d = dom(labels); const a = `${l}@${d}`;
      out.push(I(`${ln}/labels${labels}`, a, [a, l, d]));
    }
  }
  const forms = (a: string): Array<[string, string]> => [["mailto", `mailto:${a}`], ["name-angle", `From: Ann Lee <${a}>`], ["name-quoted-angle", `"Ann Lee" <${a}>`], ["to-assign", `--to=${a}`], ["git-author", `Author: Ann <${a}>`]];
  for (let n = 0; n < 6; n++) {
    const l = r.str(LOW, 7) + "." + r.str(LOW, 6); const d = dom(r.between(1, 3)); const a = `${l}@${d}`;
    for (const [f, t] of forms(a)) out.push(I(`ctx/${f}`, t, [a, l, d]));
  }
  for (const sp of ["'", "!", "#", "$", "&", "*", "=", "?", "^", "|", "~", "{", "}", "/"]) {
    const c1 = r.str(LOW, 7), c2 = r.str(LOW, 7); const d = dom(2);
    out.push(I(`special-local/${sp}`, `${c1}${sp}${c2}@${d}`, [c1, c2, d], true, "robust"));
  }
  return out;
}

// ---- HOME_PATH
function genHome(r: Rng): Inst[] {
  const out: Inst[] = [];
  const users = (): Array<[string, string]> => [["plain", r.str(LOW, 7)], ["dotted", r.str(LOW, 6) + "." + r.str(LOW, 6)], ["dash", r.str(LOW, 6) + "-" + r.str(LOW, 6)],
    ["underscore", r.str(LOW, 6) + "_" + r.str(DIG, 3)], ["digits", r.str(LOW, 5) + r.str(DIG, 4)], ["mixed", r.str(ALNUM, 8)]];
  for (const [un, u] of users()) {
    const forms: Array<[string, string, Tier]> = [
      ["unix", `at run (/home/${u}/proj/src/main.ts:10:5)`, "spec"], ["mac", `/Users/${u}/Library/Caches/x.log`, "spec"], ["wsl", `/mnt/c/Users/${u}/Desktop/a.txt`, "spec"],
      ["file-url", `file:///home/${u}/app/index.js`, "spec"], ["win", `C:\\Users\\${u}\\AppData\\Local\\x`, "spec"], ["win-fwd", `C:/Users/${u}/code`, "spec"],
      ["win-lower-drive-path", `c:\\users\\${u}\\x`, "robust"], ["win-upper-path", `C:\\USERS\\${u}\\x`, "robust"], ["win-json-escaped", `C:\\\\Users\\\\${u}\\\\app\\\\x.js`, "robust"],
      ["win-d-drive", `D:\\Users\\${u}\\x`, "spec"], ["end-of-string", `cwd=/home/${u}`, "spec"], ["quoted", `open '/Users/${u}/x'`, "spec"],
    ];
    for (const [f, t, tier] of forms) out.push(I(`${un}/${f}`, t, [u], true, tier));
  }
  for (let n = 0; n < 3; n++) {
    const tail = "é" + r.str(LOW, 6); const u = r.str(LOW, 4) + tail;
    out.push(I("non-ascii-user", `/home/${u}/x`, [tail], true, "robust"));
  }
  return out;
}

// ---- HIGH_ENTROPY
function genEntropy(r: Rng): Inst[] {
  const out: Inst[] = [];
  const als: Array<[string, string, number]> = [["b64url", B64URL, 3.6], ["b64", B64, 3.6], ["hex", HEX, 3.55], ["alnum", ALNUM, 3.6]];
  const lens = [32, 33, 40, 43, 64, 86, 128, 256];
  for (const [an, al, min] of als) {
    for (const len of lens) {
      const t = until(min, () => r.str(al, len)); out.push(I(`${an}/${len}`, t, [t]));
    }
  }
  for (let n = 0; n < 4; n++) {
    const t = until(3.6, () => r.str(B64, 44)) + "=";
    out.push(I("padded", t, [t]));
    const a = until(3.6, () => r.str(B64URL, 36)), b = until(3.6, () => r.str(B64URL, 36));
    out.push(I("two-dot-separated", `${a}.${b}`, [a, b]), I("two-colon-separated", `${a}:${b}`, [a, b]), I("two-space-separated", `${a} ${b}`, [a, b]));
    const l1 = until(3.6, () => r.str(B64, 76)), l2 = until(3.6, () => r.str(B64, 76)), l3 = r.str(B64, 40) + "==";
    out.push(I("wrapped-blob", [l1, l2, l3].join(NL), [l1, l2]));
    out.push(I("after-unnamed-assign", `sig=${a}&ref=${b}`, [a, b]));
    out.push(I("json-unnamed", `{"blob":"${a}","id":"${b}"}`, [a, b]));
    out.push(I("path-embedded", `/var/data/${a}/file`, [a]));
  }
  return out;
}

const CLASSES: Array<{ name: string; gen: (r: Rng) => Inst[] }> = [
  { name: "API_KEY", gen: genApiKey }, { name: "BEARER", gen: genBearer }, { name: "JWT", gen: genJwt }, { name: "PRIVATE_KEY", gen: genPem },
  { name: "URL_CREDS", gen: genUrlCreds }, { name: "KEY_ASSIGN", gen: genKeyAssign }, { name: "APPCHECK_DEBUG", gen: genAppCheck },
  { name: "EMAIL", gen: genEmail }, { name: "HOME_PATH", gen: genHome }, { name: "HIGH_ENTROPY", gen: genEntropy },
];
const POOL: Record<string, Inst[]> = {};
CLASSES.forEach((c, i) => { POOL[c.name] = c.gen(new Rng(0x5eed0000 + i * 7919)); });

// ---------------------------------------------------------------- contexts
const CONTEXTS: Array<[string, (s: string) => string]> = [
  ["plain", (s) => s], ["words-around", (s) => `error while handling ${s} now`], ["sq", (s) => `'${s}'`], ["dq", (s) => `"${s}"`], ["backtick", (s) => "`" + s + "`"],
  ["paren", (s) => `(${s})`], ["bracket", (s) => `[${s}]`], ["brace", (s) => `{${s}}`], ["angle", (s) => `<${s}>`], ["dot-after", (s) => `${s}.`],
  ["comma-after", (s) => `${s},`], ["semi-after", (s) => `${s};`], ["ellipsis-after", (s) => `${s}...`], ["json-string", (s) => `{"message":"${s}","ok":true}`],
  ["yaml", (s) => `msg: ${s}${NL}next: 1`], ["env", (s) => `export NOTE=${s}`], ["cli", (s) => `cmd --note=${s} --verbose`], ["cli-quoted", (s) => `cmd --note '${s}' -v`],
  ["multiline", (s) => `line one${NL}${s}${NL}line three`], ["string-start", (s) => `${s} trailing words`], ["string-end", (s) => `leading words ${s}`],
  ["tabs", (s) => `\t${s}\t`], ["unicode-neighbours", (s) => `日本語 ${s} 日本語🔑`], ["unicode-adjacent", (s) => `🔑${s}🔑`],
  ["log-line", (s) => `2026-11-13T10:00:00Z INFO [worker-3] ${s} (took 14ms)`], ["code-fence", (s) => "```" + NL + s + NL + "```"],
];

// ---------------------------------------------------------------- invariant checker
interface Stat { cases: number; accepted: number; rejected: number; fails: Map<string, number>; failVariants: Map<string, number> }
const STATS = new Map<string, Stat>();
const stat = (cls: string): Stat => {
  let s = STATS.get(cls); if (!s) { s = { cases: 0, accepted: 0, rejected: 0, fails: new Map(), failVariants: new Map() }; STATS.set(cls, s); } return s;
};
const bump = (m: Map<string, number>, k: string): void => { m.set(k, (m.get(k) ?? 0) + 1); };

function fieldsOf(v: object): string[] {
  const rec = v as Record<string, unknown>;
  const flat = Object.keys(rec).filter((k) => k !== "eventId").map((k) => String(rec[k]));
  const copy = { ...rec, eventId: "" };
  return [...flat, JSON.stringify(copy)];
}

function check(cls: string, variant: string, ctx: string, text: string, secrets: string[], opts: { requireNoReject?: boolean } = {}): string[] {
  const st = stat(cls); st.cases += 1;
  const kinds: string[] = [];
  const lbl = (k: string): void => { kinds.push(k); bump(st.fails, k); };
  const r = redact(text);
  const leakR = secrets.filter((s) => r.text.includes(s));
  if (leakR.length > 0) {
    lbl("C:redact-leaks");
    if (!hasRedactResidue(r.text)) lbl("B:residue-disagrees");
  }
  const out = normalise(rawEnv({ text, kind: "output" }), mkReg());
  if (out.ok) {
    st.accepted += 1;
    if (fieldsOf(out.value).some((f) => secrets.some((s) => f.includes(s)))) lbl("A:normalise-output-leaks");
    if (hasRedactResidue(out.value.text)) lbl("A:accepted-with-residue");
  } else {
    st.rejected += 1;
    const e = JSON.stringify(out.errors);
    if (secrets.some((s) => e.includes(s))) lbl("A:error-echoes-secret");
    if (opts.requireNoReject) lbl("A:unexpected-reject");
  }
  if (kinds.length > 0) bump(st.failVariants, `${variant}`);
  return kinds.map((k) => `${k} | ${cls}/${variant} | ctx=${ctx} | secrets=${JSON.stringify(secrets).slice(0, 160)} | text=${JSON.stringify(text).slice(0, 200)}`);
}

const report = (fails: string[], total: number): void => {
  expect(fails.slice(0, 6), `${fails.length}/${total} failing cases`).toEqual([]);
};

// ---------------------------------------------------------------- the matrix
let MATRIX = 0;
for (const c of CLASSES) {
  const insts = POOL[c.name]!;
  describe(`fuzz ${c.name}: ${insts.length} variants x ${CONTEXTS.length} contexts`, () => {
    it.each(CONTEXTS.map(([n, w]) => [n, w] as const))("context %s", (cn, wrap) => {
      const fails: string[] = [];
      for (const x of insts) { MATRIX += 1; fails.push(...check(c.name, x.v + (x.tier === "robust" ? " [robust]" : ""), cn, wrap(x.text), x.secrets)); }
      report(fails, insts.length);
    });
    it("control: most cases are redacted and forwarded, not blanket-rejected", () => {
      const s = stat(c.name);
      expect(s.accepted / Math.max(1, s.cases)).toBeGreaterThanOrEqual(0.7);
    });
  });
}

describe("fuzz multiple secrets per line (all classes mixed, seeded)", () => {
  const r = new Rng(0xabcddcba);
  const pool = CLASSES.flatMap((c) => POOL[c.name]!.filter((x) => x.term).map((x) => ({ c: c.name, x })));
  const seps = [" ", ", ", "; ", " | ", NL, " and ", "\t", " -- ", " => "];
  it("2-4 secrets per event, random separators and wrappers", () => {
    const fails: string[] = [];
    for (let n = 0; n < 700; n++) {
      const k = r.between(2, 4); const picks = Array.from({ length: k }, () => r.pick(pool));
      let text = picks[0]!.x.text; const secrets = [...picks[0]!.x.secrets];
      for (const p of picks.slice(1)) { text += r.pick(seps) + p.x.text; secrets.push(...p.x.secrets); }
      const [cn, wrap] = r.pick(CONTEXTS); MATRIX += 1;
      fails.push(...check("MULTI", picks.map((p) => p.c).join("+") + ":" + picks.map((p) => p.x.v).join("+"), cn, wrap(text), secrets));
    }
    report(fails, 700);
  });
});

describe("fuzz truncation boundary at EVENT_TEXT_MAX (secret straddles the cap)", () => {
  const filler = (n: number): string => { if (n <= 0) return ""; const b = "lorem ipsum dolor sit amet "; let s = ""; while (s.length < n) s += b; return s.slice(0, n - 1) + " "; };
  for (const c of CLASSES) {
    it(`${c.name}`, () => {
      const r = new Rng(0x7a7a0000 + c.name.length * 131);
      const insts = POOL[c.name]!;
      const sample = Array.from({ length: 8 }, () => r.pick(insts));
      const fails: string[] = [];
      let total = 0;
      for (const x of sample) {
        const ds = [-40, -1, 1, 2, 3, 7, 13, 30, 31, 32, 33, Math.floor(x.text.length / 2), x.text.length - 1, x.text.length, x.text.length + 1, x.text.length + 2];
        for (const emoji of [false, true]) {
          for (const d of ds) {
            const start = CAP - d; if (start < 0) continue;
            const pre = emoji && start > 4 ? "🔑" + filler(start - 2) : filler(start);
            const text = pre + x.text + " " + filler(300);
            total += 1; MATRIX += 1;
            fails.push(...check(c.name + "@cap", x.v, `d=${d}${emoji ? ",emoji" : ""}`, text, x.secrets));
            const out = normalise(rawEnv({ text, kind: "output" }), mkReg());
            if (out.ok) {
              const t = out.value.text;
              if (t.length > CAP) fails.push(`B9:over-cap | ${c.name}/${x.v} | d=${d} | len=${t.length}`);
              if (out.value.truncated && !t.endsWith("…")) fails.push(`B9:no-ellipsis | ${c.name}/${x.v} | d=${d}`);
              if (/\[REDACTED(?::[A-Z_]*)?\]?…?$/.test(t) && !/\[REDACTED:[A-Z_]+\]…?$/.test(t)) fails.push(`B9:partial-marker | ${c.name}/${x.v} | d=${d}`);
              if (/[\ud800-\udbff]…?$/.test(t)) fails.push(`B9:split-surrogate | ${c.name}/${x.v} | d=${d}`);
            }
          }
        }
      }
      report(fails, total);
    });
  }
});

describe("review inputs (REVIEW.md hydrogen-api, HOLD) through the full envelope", () => {
  const cases: Array<{ id: string; text: string; secrets: string[] }> = [
    { id: "1 dotted KEY_ASSIGN key swallowed by JWT", text: j("config.db.", "pass", "word=", "hunt", "er2"), secrets: [j("hunt", "er2")] },
    { id: "2 3-label email domain swallowed by JWT", text: j("contact ali", "ce@mail.", "corp.com"), secrets: [j("ali", "ce"), j("mail.", "corp.com"), j("ali", "ce@mail.corp.com")] },
    { id: "3 unterminated quoted KEY_ASSIGN tail", text: j("PASS", "WORD=\"my ", "secret ", "phrase"), secrets: [j("my ", "secret ", "phrase"), j("secret ", "phrase"), "phrase"] },
    { id: "4a URL_CREDS with @ in userinfo", text: j("https://ali", "ce@exam", "ple.com:", "pw", "Fake9@host/"), secrets: [j("pw", "Fake9"), j(":pw", "Fake9@")] },
    { id: "4b PRIVATE_KEY hyphenated header", text: j("-----BEGIN RSA", "-PSS PRIVATE KEY-----\n", "bodyFake", "Body0123456789", "\n-----END RSA-PSS PRIVATE KEY-----"), secrets: [j("bodyFake", "Body0123456789")] },
    { id: "5 dotted key variants", text: j("a.b.token=", "tok", "Fake12345 x.y.secret: ", "sec", "Fake67890"), secrets: [j("tok", "Fake12345"), j("sec", "Fake67890")] },
    { id: "6 email domain 4 labels", text: j("mail ma", "ry.sm", "ith@a.b.c.example.org now"), secrets: [j("ma", "ry.sm", "ith"), "a.b.c.example.org"] },
    { id: "7 unterminated single quote", text: j("api_", "key='one two ", "three"), secrets: ["one two three", "two three", "three"] },
  ];
  it.each(cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    MATRIX += 1;
    const base = JSON.stringify({ source: "agent", projectId: "p1", sourceSeq: 1, ts: 1000, kind: "output", text: c.text });
    const out = normalise(base, mkReg());
    const kinds = check("REVIEW", c.id, "envelope", c.text, c.secrets);
    expect(kinds, JSON.stringify(out)).toEqual([]);
  });
});

describe("fuzz controls", () => {
  it("benign text is accepted unchanged", () => {
    for (const t of ["Approve migration?", "step 3 ok", "build passed in 12s (3 tests)", "日本語 ok 🔑"]) {
      const o = normalise(rawEnv({ text: t, kind: "output" }), mkReg());
      expect(o.ok && o.value.text === t && o.value.redactions === 0).toBe(true);
    }
  });
  it("secrets over several lines and unicode are removed without breaking the envelope", () => {
    const t = `日本語\n${j("pass", "word=", "pad", "Fake12345")}\n🔑`;
    const o = normalise(rawEnv({ text: t, kind: "output" }), mkReg());
    expect(!o.ok || !o.value.text.includes(j("pad", "Fake12345"))).toBe(true);
  });
});

afterAll(() => {
  const rows = [...STATS.entries()].map(([cls, s]) => ({
    cls, cases: s.cases, accepted: s.accepted, rejected: s.rejected, fails: Object.fromEntries(s.fails),
    failingVariants: [...s.failVariants.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
  }));
  console.log("[FUZZ-SUMMARY] matrix=" + MATRIX + " " + JSON.stringify(rows));
});
