// Repair r6 (hydrogen-api review r5, BLOCKING defects 1-3; DISP_03 item 1 privacy leak + item 5 B6/B8).
// Extends the r5 fuzz with:
//  (1) KEY_ASSIGN escaped inner quote at depth >= 1 followed by a delimiter (value tail leaked),
//  (2) BEARER token wrapped in escaped quotes (\" \\\" \'),
//  (3) quoted marker-prefix bypass: text that STARTS like a redaction marker ("[REDACTED:X] real_secret")
//      then a real secret, for every B6 class,
//  (4) every class x {raw, escaped-quote wrapped, marker-prefixed} x every encoding (d0..d3, shell, json-in-json).
// Deterministic PRNG; every fake secret is assembled at runtime. Invariants as in r5:
//   C. redact(text).text holds no secret; B. if it does, hasRedactResidue(that) is true;
//   A. normalise accepted => no secret in any field and no residue; rejected => errors never echo a secret.
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
const DQ = '"';

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
const jsonInJson = (inner: string): string => JSON.stringify({ log: JSON.stringify({ payload: inner }) });
const jsonInJson3 = (inner: string): string => JSON.stringify({ a: JSON.stringify({ b: JSON.stringify({ c: inner }) }) });
const ENCS = [...ENC.map(([n]) => n), "json-in-json", "json-in-json-3"];

interface Case { cls: string; variant: string; text: string; secrets: string[] }
const word = (r: Rng, n = 9): string => r.str(LOW, n) + r.str("0123456789", 3);

function encodeAll(cls: string, variant: string, base: string, secrets: string[]): Case[] {
  const out: Case[] = ENC.map(([n, f]) => ({ cls, variant: `${variant}/${n}`, text: f(base), secrets }));
  out.push({ cls, variant: `${variant}/json-in-json`, text: jsonInJson(base), secrets });
  out.push({ cls, variant: `${variant}/json-in-json-3`, text: jsonInJson3(base), secrets });
  return out;
}

// ------------------------------------------------ (1) KEY_ASSIGN: escaped inner quote + delimiter
const NAMES = ["password", "API_KEY", "auth_token", "CLIENT_SECRET"];
const SEPS = [":", "=", ": ", " = "];
// head, escaped inner quote, delimiter, tail. Tail is what leaked.
const DELIMS: Array<[string, string]> = [
  ["space", " "], ["comma", ","], ["semi", ";"], ["rbrace", "}"], ["rbracket", "]"],
  ["tab", "\t"], ["real-nl", NL], ["comma-space", ", "], ["ellipsis", "…"],
];
function genKeyAssign(r: Rng): Case[] {
  const cs: Case[] = [];
  for (const name of NAMES) for (const sep of SEPS) for (const [dn, d] of DELIMS) {
    const a = word(r), b = word(r);
    const secrets = [a, b];
    const inner = `${a}${BS}"${d}${b}`;            // raw value with an escaped inner quote then delimiter
    // raw (depth 0 literal) doc and the same doc already carrying one escape level (literal depth 1)
    const raw = `{"${name}"${sep}"${inner}"}`;
    const lit1 = esc(raw);                          // {\"password\":\"abc\\\" def\"}
    for (const [bn, base] of [["raw", raw], ["lit-d1", lit1]] as const) {
      cs.push(...encodeAll("KEY_ASSIGN", `esc-inner/${name}${sep.trim()}/${dn}/${bn}`, base, secrets));
    }
    // single-quoted escaped inner quote
    const innerSq = `${a}${BS}'${d}${b}`;
    const rawSq = `{${name}${sep}'${innerSq}'}`;
    cs.push(...encodeAll("KEY_ASSIGN", `esc-inner-sq/${name}${sep.trim()}/${dn}`, rawSq, secrets));
    cs.push(...encodeAll("KEY_ASSIGN", `esc-inner-sq-lit1/${name}${sep.trim()}/${dn}`, esc(rawSq), secrets));
  }
  // the review's exact input (depth-1 literal): PASSWORD=\"abc\\\" def_secret\"
  const a = word(r), b = word(r);
  cs.push({ cls: "KEY_ASSIGN", variant: "review/exact", text: `PASSWORD=${BS}"${a}${BS}${BS}${BS}" ${b}${BS}"`, secrets: [a, b] });
  cs.push(...encodeAll("KEY_ASSIGN", "review/exact-enc", `PASSWORD=${BS}"${a}${BS}${BS}${BS}" ${b}${BS}"`, [a, b]));
  return cs;
}

// ------------------------------------------------ (2) BEARER escaped quotes
function genBearer(r: Rng): Case[] {
  const cs: Case[] = [];
  const shapes: Array<[string, (t: string) => string]> = [
    ["dq-plain", (t) => `Bearer ${DQ}${t}${DQ}`],
    ["esc-dq-d1", (t) => `Bearer ${BS}"${t}${BS}"`],
    ["esc-dq-d2", (t) => `Bearer ${BS}${BS}${BS}"${t}${BS}${BS}${BS}"`],
    ["esc-sq-d1", (t) => `Bearer ${BS}'${t}${BS}'`],
    ["esc-dq-lower", (t) => `bearer ${BS}"${t}${BS}"`],
    ["esc-dq-tabs", (t) => `BEARER\t${BS}"${t}${BS}"`],
  ];
  const tails = ["", ", next: 1", " trailing words", "}"];
  for (let i = 0; i < 3; i++) for (const [sn, f] of shapes) for (const [ti, tail] of tails.entries()) {
    const tok = r.str(ALNUM, 16);
    cs.push(...encodeAll("BEARER", `esc/${sn}/t${ti}/v${i}`, `Authorization: ${f(tok)}${tail}`, [tok]));
    cs.push(...encodeAll("BEARER", `esc-json/${sn}/t${ti}/v${i}`, `{"h":"Authorization: ${f(tok)}${tail}"}`, [tok]));
  }
  return cs;
}

// ------------------------------------------------ class secrets (runtime-built)
interface Sec { text: string; secrets: string[] }
const CLS = ["KEY_ASSIGN", "BEARER", "JWT", "PRIVATE_KEY", "URL_CREDS", "APPCHECK_DEBUG", "EMAIL", "HOME_PATH", "HIGH_ENTROPY"];
function secretFor(cls: string, r: Rng): Sec {
  switch (cls) {
    case "KEY_ASSIGN": { const a = word(r); return { text: `API_KEY=${a}`, secrets: [a] }; }
    case "BEARER": { const t = r.str(ALNUM, 16); return { text: `Authorization: Bearer ${t}`, secrets: [t] }; }
    case "JWT": { const j = ["eyJ" + r.str(B64URL, 12), r.str(B64URL, 14), r.str(B64URL, 16)]; return { text: `session ${j.join(".")} issued`, secrets: j }; }
    case "PRIVATE_KEY": {
      const b = [r.str(ALNUM + "+/", 40), r.str(ALNUM + "+/", 40)];
      return { text: `${"-----BEGIN RSA PRIVATE" + " KEY-----"}${NL}${b[0]}${NL}${b[1]}${NL}${"-----END RSA PRIVATE" + " KEY-----"}`, secrets: b }; // fake PEM markers built at runtime to avoid scanner hits
    }
    case "URL_CREDS": { const pw = word(r, 8); return { text: `clone https://${word(r, 7)}:${pw}@host.example/repo.git`, secrets: [pw] }; }
    case "APPCHECK_DEBUG": {
      const u = [r.str(HEX, 8), r.str(HEX, 4), r.str(HEX, 4), r.str(HEX, 4), r.str(HEX, 12)].join("-");
      return { text: `FIREBASE_APPCHECK_DEBUG_TOKEN=${u}`, secrets: [u] };
    }
    case "EMAIL": { const l = word(r, 6); return { text: `contact ${l}@${word(r, 5)}.example.com now`, secrets: [l] }; }
    case "HOME_PATH": { const u = word(r, 7); return { text: `error at /home/${u}/proj/a.ts:1`, secrets: [u] }; }
    default: { const e = r.str(ALNUM, 44); return { text: `value ${e} here`, secrets: [e] }; }
  }
}

// ------------------------------------------------ (3)+(4) marker-prefix and escaped-wrapper, every class
const MARKER_TAGS = (cls: string): string[] => [cls, "X", "KEY_ASSIGN", "HIGH_ENTROPY"];
function genClassMatrix(r: Rng): Case[] {
  const cs: Case[] = [];
  for (const cls of CLS) {
    for (let i = 0; i < 2; i++) {
      const { text, secrets } = secretFor(cls, r);
      for (const tag of MARKER_TAGS(cls)) {
        const m = `[REDACTED:${tag}]`;
        const forms: Array<[string, string]> = [
          ["q-dq", `${DQ}${m} ${text}${DQ}`],
          ["q-sq", `'${m} ${text}'`],
          ["q-bt", `\`${m} ${text}\``],
          ["q-esc-dq", `${BS}"${m} ${text}${BS}"`],
          ["q-esc-sq", `${BS}'${m} ${text}${BS}'`],
          ["q-dq-nospace-nl", `${DQ}${m}${NL}${text}${DQ}`],
          ["unq", `${m} ${text}`],
          ["kv-dq", `note=${DQ}${m} ${text}${DQ}`],
          ["json-kv", `{"msg":"${m} ${text.replace(/\\/g, BS + BS).replace(/"/g, BS + DQ).replace(/\n/g, BS + "n")}"}`],
        ];
        for (const [fn, base] of forms) cs.push(...encodeAll(cls, `marker/${tag}/${fn}/v${i}`, base, secrets));
      }
      // escaped-quote wrapper around the class secret (depth >= 1 once encoded)
      const wraps: Array<[string, string]> = [
        ["esc-wrap-d1", `say ${BS}"${text}${BS}" done`],
        ["esc-wrap-d2", `say ${BS}${BS}${BS}"${text}${BS}${BS}${BS}" done`],
        ["esc-wrap-sq", `say ${BS}'${text}${BS}' done`],
        ["esc-wrap-comma", `{${BS}"m${BS}":${BS}"${text}${BS}",${BS}"ok${BS}":true}`],
      ];
      for (const [wn, base] of wraps) cs.push(...encodeAll(cls, `${wn}/v${i}`, base, secrets));
    }
  }
  return cs;
}

// ------------------------------------------------ direct redact() regressions from the review
function genDirect(r: Rng): Case[] {
  const cs: Case[] = [];
  for (const name of ["PASSWORD", "token", "API_KEY", "client_secret"]) for (const sep of ["=", ":", ": "]) {
    const s = r.str(LOW, 6) + r.str("0123456789", 4);
    cs.push({ cls: "KEY_ASSIGN", variant: `direct/marker-X/${name}${sep.trim()}`, text: `${name}${sep}"[REDACTED:X] ${s}"`, secrets: [s] });
    cs.push({ cls: "KEY_ASSIGN", variant: `direct/marker-lower/${name}${sep.trim()}`, text: `${name}${sep}"[REDACTED:x] ${s}"`, secrets: [s] });
    cs.push({ cls: "KEY_ASSIGN", variant: `direct/marker-real/${name}${sep.trim()}`, text: `${name}${sep}'[REDACTED:KEY_ASSIGN] ${s}'`, secrets: [s] });
    cs.push({ cls: "KEY_ASSIGN", variant: `direct/marker-tail-comma/${name}${sep.trim()}`, text: `${name}${sep}"[REDACTED:X], ${s}"`, secrets: [s] });
  }
  return cs;
}

// ------------------------------------------------ invariant checker
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

const POOL: Case[] = [
  ...genKeyAssign(new Rng(0x5eed06)), ...genBearer(new Rng(0xbea6e6)),
  ...genClassMatrix(new Rng(0xa11ce6)), ...genDirect(new Rng(0xd1ec76)),
];

describe("fuzz r6: every class x every encoding (escaped-quote, marker-prefix)", () => {
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

describe("r6 review defects (B6/B7/B8)", () => {
  it("defect 1: KEY_ASSIGN escaped inner quote at depth >= 1, review input exact", () => {
    const cs = POOL.filter((p) => p.variant.startsWith("review/"));
    expect(cs.length).toBeGreaterThan(0);
    for (const c of cs) expect(check(c), c.variant).toEqual([]);
  });
  it("defect 1: every escaped-inner-quote KEY_ASSIGN case at depth >= 1 (raw docs encoded d1..d3, json-in-json)", () => {
    const cs = POOL.filter((p) => p.variant.startsWith("esc-inner") && !p.variant.endsWith("/d0"));
    expect(cs.length).toBeGreaterThan(500);
    const fails = cs.flatMap(check);
    expect(fails.slice(0, 5), `${fails.length}/${cs.length} failing`).toEqual([]);
  });
  it("defect 2: BEARER with escaped-quote tokens never leaks the token", () => {
    const cs = POOL.filter((p) => p.cls === "BEARER" && p.variant.startsWith("esc"));
    expect(cs.length).toBeGreaterThan(500);
    const fails = cs.flatMap(check);
    expect(fails.slice(0, 5), `${fails.length}/${cs.length} failing`).toEqual([]);
  });
  it("defect 2: review input exact (Authorization: Bearer \\\"tok\\\") is redacted, counted, and not left as residue", () => {
    const tok = "tok_" + new Rng(7).str(LOW, 8) + "123";
    const text = `Authorization: Bearer ${BS}"${tok}${BS}"`;
    const rd = redact(text);
    expect(rd.text).not.toContain(tok);
    expect(rd.classes).toContain("BEARER");
    expect(rd.redactions).toBeGreaterThan(0);
    const out = normalise(rawEnv({ text, kind: "output" }), mkReg());
    if (out.ok) { expect(out.value.text).not.toContain(tok); expect(out.value.redactions).toBeGreaterThan(0); }
  });
  it("defect 3: redact() of a quoted marker-prefix followed by a real secret removes the secret (review input)", () => {
    const s = "real_" + new Rng(9).str(LOW, 6);
    const rd = redact(`PASSWORD="[REDACTED:X] ${s}"`);
    expect(rd.text).not.toContain(s);
    expect(rd.redactions).toBeGreaterThan(0);
    expect(rd.classes).toContain("KEY_ASSIGN");
  });
  it("defect 3: all direct marker-prefix variants and every class x marker-prefix leak nothing", () => {
    const cs = POOL.filter((p) => p.variant.startsWith("direct/") || p.variant.startsWith("marker/"));
    expect(cs.length).toBeGreaterThan(1500);
    const fails = cs.flatMap(check);
    expect(fails.slice(0, 5), `${fails.length}/${cs.length} failing`).toEqual([]);
  });
  it("controls: an already-redacted value is not re-redacted and stays accepted without residue", () => {
    for (const t of ["PASSWORD=[REDACTED:KEY_ASSIGN]", `PASSWORD="[REDACTED:KEY_ASSIGN]"`, "Authorization: Bearer [REDACTED:BEARER]"]) {
      const rd = redact(t);
      expect(rd.text).toBe(t);
      expect(hasRedactResidue(t)).toBe(false);
    }
  });
  it("controls: benign escaped JSON and benign quoted prose are accepted unchanged", () => {
    for (const text of [esc(JSON.stringify({ message: "build ok", n: 3 })), `say ${BS}"hello world${BS}" done`, `"[REDACTED:X]" then plain words`]) {
      const o = normalise(rawEnv({ text, kind: "output" }), mkReg());
      expect(o.ok && o.value.text).toBe(text);
    }
  });
  it("generator is non-vacuous and builds secrets at runtime", () => {
    expect(POOL.length).toBeGreaterThan(8000);
    expect(POOL.every((c) => c.secrets.length > 0 && c.secrets.every((s) => s.length >= 8 || c.cls === "EMAIL" || c.cls === "KEY_ASSIGN"))).toBe(true);
    expect(new Set(CLS).size).toBe(9);
  });
});
