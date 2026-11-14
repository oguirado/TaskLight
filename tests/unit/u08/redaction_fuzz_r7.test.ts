// Repair r7 (hydrogen-api review r6, BLOCKING defects 1-2; DISP_03 item 1 privacy leak + item 5 B6/B8).
//  (1) BEARER used as a key-name prefix (BEARER_TOKEN="x", bearer_password: "x", bearerKey="x"): the secret value leaked.
//  (2) AppCheck debug token wrapped in JSON-escaped quotes (\"uuid\") with a LOW-entropy uuid leaked.
// Review inputs are encoded exactly; the generator widens names/separators/quotes/encodings/escape depth.
// Deterministic PRNG; every fake secret is assembled at runtime.
// Invariants: C. redact(text).text holds no secret; B. if it does, hasRedactResidue is true;
//             A. normalise accepted => no secret in any field and no residue.
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
const BS = "\\";
const esc = (s: string): string => JSON.stringify(s).slice(1, -1);
const ENC: Array<[string, (s: string) => string]> = [
  ["d0", (s) => s], ["d1", esc], ["d2", (s) => esc(esc(s))],
];
const fieldsOf = (v: object): string[] => {
  const rec = v as Record<string, unknown>;
  return [...Object.keys(rec).filter((k) => k !== "eventId").map((k) => String(rec[k])), JSON.stringify({ ...rec, eventId: "" })];
};
interface Case { label: string; text: string; secrets: string[] }
function check(c: Case): string[] {
  const k: string[] = [];
  const rd = redact(c.text);
  if (c.secrets.some((s) => rd.text.includes(s))) {
    k.push(`C:redact-leaks[${c.label}]`);
    if (!hasRedactResidue(rd.text)) k.push(`B:residue-disagrees[${c.label}]`);
  }
  const out = normalise(rawEnv({ text: c.text, kind: "output" }), mkReg());
  if (out.ok) {
    if (fieldsOf(out.value).some((f) => c.secrets.some((s) => f.includes(s)))) k.push(`A:normalise-leaks[${c.label}]`);
    if (hasRedactResidue(out.value.text)) k.push(`A:accepted-with-residue[${c.label}]`);
  }
  return k;
}
const expectClean = (cs: Case[]): void => {
  expect(cs.length).toBeGreaterThan(0);
  const fails = cs.flatMap(check);
  expect(fails.slice(0, 5), `${fails.length}/${cs.length} failing`).toEqual([]);
};

// ---- (1) BEARER-prefixed key assignment
const word = (r: Rng): string => r.str(LOW, 8) + r.str("0123456789", 3);
const NAMES = ["BEARER_TOKEN", "bearer_password", "bearerKey", "Bearer_Secret", "BEARER_API_KEY", "bearer.token", "bearer-secret"];
const SEPS = ["=", ":", ": ", " = ", " := "];
const QUOTES: Array<[string, string]> = [['"', '"'], ["'", "'"], [`${BS}"`, `${BS}"`], ["", ""]];
function genBearerKey(seed: number): Case[] {
  const r = new Rng(seed);
  const cs: Case[] = [];
  for (const name of NAMES) for (const sep of SEPS) for (const [q1, q2] of QUOTES) for (const [en, f] of ENC) {
    const v = word(r);
    const base = `${name}${sep}${q1}${v}${q2}`;
    cs.push({ label: `${name}${sep.trim()}${q1}/${en}`, text: f(base), secrets: [v] });
    cs.push({ label: `ctx ${name}${sep.trim()}${q1}/${en}`, text: f(`env: ${base} ; done`), secrets: [v] });
  }
  return cs;
}

// ---- (2) escaped AppCheck debug token, low-entropy uuid (<= 3 distinct hex symbols: ~1.6 bits/char)
function lowUuid(r: Rng): string {
  const al = r.str("0123456789abcdef", 3);
  const p = (n: number): string => r.str(al, n);
  return `${p(8)}-${p(4)}-${p(4)}-${p(4)}-${p(12)}`;
}
const AQ: Array<[string, string]> = [[`${BS}"`, `${BS}"`], [`${BS}${BS}${BS}"`, `${BS}${BS}${BS}"`], [`${BS}'`, `${BS}'`], ['"', '"'], ["'", "'"], ["", ""]];
const HEADS = ["AppCheck debug token:", "App Check debug token: ", "appcheck debug token:\t"];
function genAppCheck(seed: number): Case[] {
  const r = new Rng(seed);
  const cs: Case[] = [];
  for (const head of HEADS) for (const [q1, q2] of AQ) for (const [en, f] of ENC) {
    const u = lowUuid(r);
    cs.push({ label: `${head.trim()}${q1}/${en}`, text: f(`${head}${q1}${u}${q2}`), secrets: [u] });
    cs.push({ label: `ctx ${head.trim()}${q1}/${en}`, text: f(`log: ${head}${q1}${u}${q2} (end)`), secrets: [u] });
  }
  for (const [q1, q2] of AQ) for (const [en, f] of ENC) {
    const u = lowUuid(r);
    cs.push({ label: `ENV ${q1}/${en}`, text: f(`FIREBASE_APPCHECK_DEBUG_TOKEN=${q1}${u}${q2}`), secrets: [u] });
  }
  return cs;
}

describe("r7 review defects (B6/B8)", () => {
  it("defect 1: review inputs exact (BEARER_TOKEN / bearer_password / bearerKey)", () => {
    const secret = "secret" + "123";
    for (const t of [`BEARER_TOKEN="${secret}"`, `bearer_password: "${secret}"`, `bearerKey="${secret}"`]) {
      const rd = redact(t);
      expect(rd.text, t).not.toContain(secret);
      expect(rd.redactions, t).toBeGreaterThan(0);
      expect(rd.text, t).not.toContain(`[REDACTED:BEARER]"`);
      expectClean([{ label: t, text: t, secrets: [secret] }]);
    }
  });
  it("defect 1: BEARER-prefixed key assignment x names x seps x quotes x encodings never leaks", () => {
    expectClean(genBearerKey(0x7b3a));
  });
  it("defect 2: review input exact (escaped low-entropy uuid) is redacted", () => {
    const u = "11112222-3333-4444-5555-666677778888";
    const t = `AppCheck debug token: ${BS}"${u}${BS}"`;
    expect(redact(t).text).not.toContain(u);
    expectClean([{ label: "review", text: t, secrets: [u] }]);
  });
  it("defect 2: escaped/quoted AppCheck debug token x low-entropy uuids x encodings never leaks", () => {
    expectClean(genAppCheck(0x51c9));
  });
  it("controls: a genuine 'Bearer <token>' header is still redacted; benign prose accepted", () => {
    const tok = "tok" + "En" + "ABCdef123456";
    const rd = redact(`Authorization: Bearer ${tok}`);
    expect(rd.text).not.toContain(tok);
    const out = normalise(rawEnv({ text: "bearer of good news; token count is 3", kind: "output" }), mkReg());
    expect(out.ok).toBe(true);
  });
  it("generators are non-vacuous and build secrets at runtime", () => {
    expect(genBearerKey(1).length).toBeGreaterThan(400);
    expect(genAppCheck(1).length).toBeGreaterThan(100);
  });
});
