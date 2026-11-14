// Repair r5 (hydrogen-api review, BLOCKING): KEY_ASSIGN double-escaped quote bypass
// (privacy leak + B8 fail-closed failure). Extends the redaction fuzz with escape-depth
// variants for every B6 class. Deterministic PRNG; every fake secret is assembled at runtime.
// Invariants (same as redaction_fuzz.test.ts):
//   C. redact(text).text holds no secret;  B. if it does, hasRedactResidue(that) must be true;
//   A. normalise accepted => no secret in any field and no residue; rejected => errors never echo a secret.
// Encodings: d0 raw, d1/d2/d3 JSON-string escape depth 1..3, json-in-json (stringified object inside
// a stringified object), shell single-quoted, shell double-quoted, shell $'...' (ANSI-C).
import { describe, expect, it } from "vitest";
import { normalise, redact } from "../../../src/ingest/index";
import { hasRedactResidue } from "../../../src/ingest/redact";
import { mkReg, rawEnv } from "./helpers";

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
  str(al: string, n: number): string { let o = ""; for (let i = 0; i < n; i++) o += al[this.int(al.length)]; return o; }
}
const LOW = "abcdefghijklmnopqrstuvwxyz";
const ALNUM = LOW + LOW.toUpperCase() + "0123456789";
const HEX = "0123456789abcdef";
const B64URL = ALNUM + "-_";
const NL = "\n";
const BS = "\\";

// ---------------------------------------------------------------- encodings
const esc = (s: string): string => JSON.stringify(s).slice(1, -1);
const ENC: Array<[string, (s: string) => string]> = [
  ["d0", (s) => s],
  ["d1", esc],
  ["d2", (s) => esc(esc(s))],
  ["d3", (s) => esc(esc(esc(s)))],
  ["shell-sq", (s) => `sh -c '${s.replace(/'/g, "'" + BS + "''")}'`],
  ["shell-dq", (s) => `sh -c "${s.replace(/(["\\$`])/g, BS + "$1")}"`],
  ["shell-ansi", (s) => `sh -c $'${s.replace(/\\/g, BS + BS).replace(/'/g, BS + "'").replace(/\n/g, BS + "n")}'`],
  ["shell-dq-of-d1", (s) => `sh -c "${esc(s).replace(/(["\\$`])/g, BS + "$1")}"`],
];
// JSON-in-JSON is a structural variant (the inner document is stringified, then the outer one):
const jsonInJson = (inner: string): string => JSON.stringify({ log: JSON.stringify({ payload: inner }) });
const jsonInJson3 = (inner: string): string => JSON.stringify({ a: JSON.stringify({ b: JSON.stringify({ c: inner }) }) });

interface Case { cls: string; variant: string; text: string; secrets: string[] }
const word = (r: Rng, n = 9): string => r.str(LOW, n) + r.str("0123456789", 3);

function encodeAll(cls: string, variant: string, base: string, secrets: string[]): Case[] {
  const out: Case[] = ENC.map(([n, f]) => ({ cls, variant: `${variant}/${n}`, text: f(base), secrets }));
  out.push({ cls, variant: `${variant}/json-in-json`, text: jsonInJson(base), secrets });
  out.push({ cls, variant: `${variant}/json-in-json-3`, text: jsonInJson3(base), secrets });
  return out;
}

// ---------------------------------------------------------------- KEY_ASSIGN
const NAMES = ["password", "API_KEY", "auth_token", "CLIENT_SECRET"];
const SEPS = [":", "=", ": ", " = "];
// value body templates: a = head word, b = tail word (after whitespace, the part that leaked)
const BODIES: Array<[string, (a: string, b: string) => string]> = [
  ["bs-n", (a, b) => `${a}${BS}ndef ${b}`],
  ["bs-t", (a, b) => `${a}${BS}tdef ${b}`],
  ["bs-slash", (a, b) => `${a}${BS}/def ${b}`],
  ["bs-u", (a, b) => `${a}${BS}u0041 ${b}`],
  ["bs-bs", (a, b) => `${a}${BS}${BS}ndef ${b}`],
  ["real-nl", (a, b) => `${a}${NL}def ${b}`],
  ["real-tab", (a, b) => `${a}\tdef ${b}`],
  ["spaces", (a, b) => `${a} def ${b}`],
  ["escaped-dq", (a, b) => `${a}${BS}"x ${b}`],
  ["bare", (a) => a],
];
function genKeyAssign(r: Rng): Case[] {
  const cs: Case[] = [];
  for (const name of NAMES) for (const sep of SEPS) for (const [bn, body] of BODIES) {
    const a = word(r), b = word(r);
    const secrets = bn === "bare" ? [a] : [a, b];
    const v = body(a, b);
    for (const q of ['"', "'", ""]) {
      if (q === "" && bn !== "bare") continue;
      const nameQ = q === '"' ? `"${name}"` : name;
      cs.push(...encodeAll("KEY_ASSIGN", `${name}${sep.trim()}/${bn}/q${q || "none"}`, `{${nameQ}${sep}${q}${v}${q}}`, secrets));
    }
  }
  // the review's exact inputs: text is {\"password\":\"abc\ndef leaked_secret\"} and the \'...\' form
  const x = word(r), y = word(r);
  cs.push({ cls: "KEY_ASSIGN", variant: "review/dq", text: `{${BS}"password${BS}":${BS}"${x}${BS}ndef ${y}${BS}"}`, secrets: [x, y] });
  cs.push({ cls: "KEY_ASSIGN", variant: "review/sq", text: `{${BS}'password${BS}':${BS}'${x}${BS}ndef ${y}${BS}'}`, secrets: [x, y] });
  return cs;
}

// ---------------------------------------------------------------- other classes
// Fake PEM markers are assembled at runtime so scanners and push protection do not flag the source.
const PEM_BEGIN = "-----BEGIN RSA PRIVATE" + " KEY-----";
const PEM_END = "-----END RSA PRIVATE" + " KEY-----";

function genOthers(r: Rng): Case[] {
  const cs: Case[] = [];
  const wrap = (s: string): string => `{"note":"${s}","ok":true}`;
  for (let i = 0; i < 4; i++) {
    const tok = r.str(ALNUM, 16);
    cs.push(...encodeAll("BEARER", `v${i}`, wrap(`Authorization: Bearer ${tok}`), [tok]));
    const jwt = ["eyJ" + r.str(B64URL, 12), r.str(B64URL, 14), r.str(B64URL, 16)];
    cs.push(...encodeAll("JWT", `v${i}`, wrap(`session ${jwt.join(".")} issued`), jwt));
    const body = [r.str(ALNUM + "+/", 40), r.str(ALNUM + "+/", 40)];
    cs.push(...encodeAll("PRIVATE_KEY", `v${i}`, wrap(`${PEM_BEGIN}${NL}${body[0]}${NL}${body[1]}${NL}${PEM_END}`), body));
    const user = word(r, 7), pw = word(r, 8);
    cs.push(...encodeAll("URL_CREDS", `v${i}`, wrap(`clone https://${user}:${pw}@host.example/repo.git`), [pw]));
    const u = [r.str(HEX, 8), r.str(HEX, 4), r.str(HEX, 4), r.str(HEX, 4), r.str(HEX, 12)].join("-");
    cs.push(...encodeAll("APPCHECK_DEBUG", `phrase${i}`, wrap(`AppCheck debug token: "${u}" set it`), [u]));
    cs.push(...encodeAll("APPCHECK_DEBUG", `env${i}`, wrap(`FIREBASE_APPCHECK_DEBUG_TOKEN=${u}`), [u]));
    const local = word(r, 6);
    cs.push(...encodeAll("EMAIL", `v${i}`, wrap(`contact ${local}@${word(r, 5)}.example.com now`), [local]));
    const un = word(r, 7);
    cs.push(...encodeAll("HOME_PATH", `unix${i}`, wrap(`error at /home/${un}/proj/a.ts:1`), [un]));
    cs.push(...encodeAll("HOME_PATH", `win${i}`, wrap(`error at C:${BS}Users${BS}${un}${BS}proj${BS}a.ts`), [un]));
    const ent = r.str(ALNUM, 44);
    cs.push(...encodeAll("HIGH_ENTROPY", `v${i}`, wrap(`value ${ent} here`), [ent]));
  }
  return cs;
}

// ---------------------------------------------------------------- invariant checker
const fieldsOf = (v: object): string[] => {
  const rec = v as Record<string, unknown>;
  return [...Object.keys(rec).filter((k) => k !== "eventId").map((k) => String(rec[k])), JSON.stringify({ ...rec, eventId: "" })];
};
function check(c: Case): string[] {
  const k: string[] = [];
  const rd = redact(c.text);
  if (c.secrets.some((s) => rd.text.includes(s))) {
    k.push("C:redact-leaks");
    if (!hasRedactResidue(rd.text)) k.push("B:residue-disagrees");
  }
  const out = normalise(rawEnv({ text: c.text, kind: "output" }), mkReg());
  if (out.ok) {
    if (fieldsOf(out.value).some((f) => c.secrets.some((s) => f.includes(s)))) k.push("A:normalise-output-leaks");
    if (hasRedactResidue(out.value.text)) k.push("A:accepted-with-residue");
  } else if (c.secrets.some((s) => JSON.stringify(out.errors).includes(s))) k.push("A:error-echoes-secret");
  return k.map((x) => `${x} | ${c.cls}/${c.variant} | text=${JSON.stringify(c.text).slice(0, 180)}`);
}

const POOL: Case[] = [...genKeyAssign(new Rng(0x5eed05)), ...genOthers(new Rng(0xa11ce5))];
const CLS = ["KEY_ASSIGN", "BEARER", "JWT", "PRIVATE_KEY", "URL_CREDS", "APPCHECK_DEBUG", "EMAIL", "HOME_PATH", "HIGH_ENTROPY"];
const ENCS = [...ENC.map(([n]) => n), "json-in-json", "json-in-json-3"];

describe("escape-depth fuzz r5: every class x every encoding", () => {
  for (const cls of CLS) {
    describe(cls, () => {
      it.each(ENCS)("encoding %s", (enc) => {
        const cases = POOL.filter((c) => c.cls === cls && c.variant.endsWith(`/${enc}`));
        expect(cases.length).toBeGreaterThan(0);
        const fails = cases.flatMap(check);
        expect(fails.slice(0, 5), `${fails.length}/${cases.length} failing`).toEqual([]);
      });
    });
  }
});

describe("KEY_ASSIGN double-escaped quote bypass (review inputs, B6 + B8)", () => {
  it("review dq/sq inputs leak nothing through redact, hasRedactResidue or normalise", () => {
    for (const c of POOL.filter((p) => p.variant.startsWith("review/"))) expect(check(c), c.variant).toEqual([]);
  });
  it("generator is non-vacuous and builds secrets at runtime", () => {
    expect(POOL.length).toBeGreaterThan(2000);
    expect(POOL.every((c) => c.secrets.length > 0 && c.secrets.every((s) => s.length >= 8 || c.cls === "EMAIL" || c.cls === "KEY_ASSIGN"))).toBe(true);
  });
  it("benign escaped JSON is accepted unchanged", () => {
    const text = esc(JSON.stringify({ message: "build ok", n: 3 }));
    const o = normalise(rawEnv({ text, kind: "output" }), mkReg());
    expect(o.ok && o.value.text).toBe(text);
  });
});
