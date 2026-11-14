import { describe, expect, it } from "vitest";
import {
  EVENT_KIND, INGEST_LIMITS, canonicalJson, digestHex, normalise, redact,
} from "../../../src/ingest/index";
import type { IngestReject } from "../../../src/ingest/index";
import { GROUP, HIGH_ENTROPY_TOKEN, PLANTED, mkReg, rawEnv } from "./helpers";

const errs = (raw: string, reg = mkReg()): IngestReject[] => {
  const r = normalise(raw, reg);
  return r.ok ? [] : r.errors;
};
const codes = (raw: string, reg = mkReg()): string[] => errs(raw, reg).map((e) => e.code);
const ok = (raw: string, reg = mkReg()) => {
  const r = normalise(raw, reg);
  if (!r.ok) throw new Error("expected ok, got " + JSON.stringify(r.errors));
  return r.value;
};

describe("I1 valid_agent_event (positive control)", () => {
  it("accepts and stamps", () => {
    const v = ok(rawEnv());
    expect(v.kind).toBe("waiting_input");
    expect(v.redactions).toBe(0);
    expect(v.truncated).toBe(false);
    expect(v.tier).toBe("standard");
    expect(v.text).toBe("Approve migration?");
    expect(v.eventId).toMatch(/^[0-9a-f]{64}$/);
  });
  it("eventId = digestHex(canonicalJson(event without id)) and is not constant", () => {
    const v = ok(rawEnv());
    const { eventId, ...rest } = v;
    expect(eventId).toBe(digestHex(canonicalJson(rest)));
    expect(ok(rawEnv({ ts: 1001 })).eventId).not.toBe(eventId);
    expect(ok(rawEnv({ text: "other" })).eventId).not.toBe(eventId);
  });
  it("every valid (source, kind) pair is accepted; kinds cover the vocabulary", () => {
    for (const [source, kinds] of Object.entries(GROUP)) for (const kind of kinds) expect(ok(rawEnv({ source, kind })).kind).toBe(kind);
    expect(Object.values(GROUP).flat().sort()).toEqual([...EVENT_KIND].sort());
  });
  it("B10 tier comes from the registry; text redacted identically for all tiers", () => {
    const a = ok(rawEnv({ projectId: "p1", text: "mail a@example.test" }));
    const b = ok(rawEnv({ projectId: "p2", text: "mail a@example.test" }));
    expect(a.tier).toBe("standard");
    expect(b.tier).toBe("private");
    expect(a.text).toBe(b.text);
    expect(a.text).not.toContain("a@example.test");
  });
});

describe("I2 planted secrets never survive (negative control)", () => {
  for (const c of PLANTED) {
    it(`${c.cls}: ${c.text.slice(0, 28).replace(/\n/g, " ")}`, () => {
      const v = ok(rawEnv({ text: c.text }));
      for (const s of c.secrets) expect(v.text).not.toContain(s);
      expect(v.text).toContain("[REDACTED:");
      if (c.exactClass) expect(v.text).toContain(`[REDACTED:${c.cls}]`);
      expect(v.redactions).toBeGreaterThanOrEqual(1);
    });
    it(`redact() alone removes ${c.cls}`, () => {
      const r = redact(c.text);
      for (const s of c.secrets) expect(r.text).not.toContain(s);
      expect(r.redactions).toBeGreaterThanOrEqual(1);
      expect(r.classes.length).toBeGreaterThanOrEqual(1);
    });
  }
  it("all planted lines combined: no secret survives, redactions counts spans", () => {
    const text = PLANTED.map((c) => c.text).join("\n");
    const v = ok(rawEnv({ text }));
    for (const c of PLANTED) for (const s of c.secrets) expect(v.text).not.toContain(s);
    expect(v.redactions).toBeGreaterThanOrEqual(PLANTED.length);
  });
  it("PEM block removed through the END marker, surrounding text kept", () => {
    const v = ok(rawEnv({ text: PLANTED[0]!.text }));
    expect(v.text).toContain("key follows");
    expect(v.text).toContain("end");
    expect(v.text).not.toMatch(/PRIVATE KEY/);
  });
  it("KEY_ASSIGN replaces only the value, keeping the name", () => {
    const v = ok(rawEnv({ text: "OPENAI_API_KEY=sk-FAKE-0000-not-real" }));
    expect(v.text.startsWith("OPENAI_API_KEY=")).toBe(true);
    expect(v.text).toBe("OPENAI_API_KEY=[REDACTED:KEY_ASSIGN]");
  });
  it("count of replaced spans and fixed class order", () => {
    const r = redact("a@example.test b@example.test");
    expect(r.redactions).toBe(2);
    expect(r.classes).toEqual(["EMAIL"]);
    const m = redact(`${PLANTED[0]!.text}\nmail dev@example.com`);
    expect(m.classes.indexOf("PRIVATE_KEY")).toBeGreaterThanOrEqual(0);
    expect(m.classes.indexOf("PRIVATE_KEY")).toBeLessThan(m.classes.indexOf("EMAIL"));
  });
  it("benign text is untouched (no over-redaction)", () => {
    for (const t of ["Approve migration?", "build passed in 12s\nnext step", "a".repeat(40), "tab\tseparated", "Zk3Qm9xT7vLp2RwYc8NfH5dJb1GsA6u"]) {
      const r = redact(t);
      expect(r.text).toBe(t);
      expect(r.redactions).toBe(0);
    }
  });
  it("HIGH_ENTROPY threshold: low-entropy 40-char run is kept, high-entropy 40-char run is redacted", () => {
    expect(INGEST_LIMITS.ENTROPY_MIN_LEN).toBe(32);
    expect(redact("x " + "ab".repeat(20)).redactions).toBe(0);
    expect(redact("x " + HIGH_ENTROPY_TOKEN).text).toContain("[REDACTED:HIGH_ENTROPY]");
  });
});

describe("I3 redact idempotent", () => {
  it("second pass is identical with zero redactions; marker does not re-match", () => {
    for (const c of PLANTED) {
      const once = redact(c.text);
      const twice = redact(once.text);
      expect(twice.text).toBe(once.text);
      expect(twice.redactions).toBe(0);
    }
    for (const cls of ["PRIVATE_KEY", "BEARER", "JWT", "KEY_ASSIGN", "URL_CREDS", "APPCHECK_DEBUG", "EMAIL", "HIGH_ENTROPY"]) {
      const m = redact(`x [REDACTED:${cls}] y`);
      expect(m.redactions).toBe(0);
      expect(m.text).toBe(`x [REDACTED:${cls}] y`);
    }
  });
  it("redact is deterministic", () => {
    const t = PLANTED.map((c) => c.text).join("\n");
    expect(redact(t)).toEqual(redact(t));
  });
});

describe("I4 residue fail-closed", () => {
  const weak = (text: string) => ({ text, redactions: 0, classes: [] as never[] });
  it("weakened redactor leaves a 40-char token -> REDACT_RESIDUE, detail never echoes it", () => {
    const r = normalise(rawEnv({ text: `tok ${HIGH_ENTROPY_TOKEN}` }), mkReg(), { redactFn: weak });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.code)).toContain("REDACT_RESIDUE");
    expect(JSON.stringify(r.errors)).not.toContain(HIGH_ENTROPY_TOKEN);
  });
  it("weakened redactor leaving an email also fails closed", () => {
    const r = normalise(rawEnv({ text: "x dev@example.com" }), mkReg(), { redactFn: weak });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.errors)).not.toContain("dev@example.com");
  });
  it("default path with the same token succeeds because the real redactor catches it", () => {
    expect(ok(rawEnv({ text: `tok ${HIGH_ENTROPY_TOKEN}` })).text).not.toContain(HIGH_ENTROPY_TOKEN);
  });
});

describe("I5 malformed_envelope", () => {
  it("truncated JSON -> PARSE_ERROR", () => expect(codes('{"source":"agent","projectId":"p1"')).toEqual(["PARSE_ERROR"]));
  it("non-object roots -> NOT_OBJECT", () => {
    for (const raw of ["[]", "null", "123", '"str"', "true"]) expect(codes(raw)).toEqual(["NOT_OBJECT"]);
  });
  it("extra key -> UNKNOWN_FIELD at html", () => {
    const e = errs(rawEnv({ html: "<b>x</b>" }));
    expect(e.some((x) => x.code === "UNKNOWN_FIELD" && x.path === "html")).toBe(true);
  });
  it("missing keys -> MISSING_FIELD per key", () => {
    const e = errs("{}");
    expect(e.filter((x) => x.code === "MISSING_FIELD").map((x) => x.path).sort()).toEqual(["kind", "projectId", "source", "sourceSeq", "text", "ts"]);
    const o = JSON.parse(rawEnv()) as Record<string, unknown>;
    delete o["text"];
    expect(errs(JSON.stringify(o)).some((x) => x.code === "MISSING_FIELD" && x.path === "text")).toBe(true);
  });
  it("wrong JS types -> WRONG_TYPE", () => {
    for (const k of ["text", "sourceSeq", "ts", "projectId", "kind", "source"]) {
      const e = errs(rawEnv({ [k]: { a: 1 } }));
      expect(e.some((x) => x.code === "WRONG_TYPE" && x.path === k), k).toBe(true);
    }
    expect(codes(rawEnv({ sourceSeq: "1" }))).toContain("WRONG_TYPE");
    expect(codes(rawEnv({ text: 5 }))).toContain("WRONG_TYPE");
  });
  it("never throws on hostile input and always rejects with a reason", () => {
    for (const raw of ["", " ", "undefined", "{", "}", "[[[[[[", "\u0000", "{\"__proto__\":{\"x\":1}}", "{\"constructor\":1}", "9".repeat(5000), "{".repeat(5000)]) {
      const r = normalise(raw, mkReg());
      expect(r.ok, raw.slice(0, 10)).toBe(false);
      if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
    }
  });
});

describe("I6 bad enums and ids", () => {
  it("BAD_SOURCE", () => expect(codes(rawEnv({ source: "slack" }))).toContain("BAD_SOURCE"));
  it("BAD_KIND: unknown kind and kind from another source group", () => {
    expect(codes(rawEnv({ source: "agent", kind: "commit" }))).toContain("BAD_KIND");
    expect(codes(rawEnv({ source: "ci", kind: "output" }))).toContain("BAD_KIND");
    expect(codes(rawEnv({ source: "git", kind: "ci_passed" }))).toContain("BAD_KIND");
    expect(codes(rawEnv({ kind: "nope" }))).toContain("BAD_KIND");
  });
  it("BAD_PROJECT_ID", () => {
    for (const id of ["P 1", "", "-a", "A", "a".repeat(33), "a/b", "a_b"]) expect(codes(rawEnv({ projectId: id })), id).toContain("BAD_PROJECT_ID");
    expect(codes(rawEnv({ projectId: "a".repeat(32) }), mkReg({ ["a".repeat(32)]: "standard" }))).toEqual([]);
  });
  it("UNKNOWN_PROJECT", () => expect(codes(rawEnv({ projectId: "p9" }))).toContain("UNKNOWN_PROJECT"));
  it("BAD_INT for negative, fractional, unsafe, NaN-like", () => {
    for (const k of ["ts", "sourceSeq"]) {
      for (const v of [-1, 1.5, 9007199254740993, 1e300]) expect(codes(rawEnv({ [k]: v })), `${k}=${v}`).toContain("BAD_INT");
    }
    expect(ok(rawEnv({ ts: 0 })).ts).toBe(0);
  });
  it("errors are sorted by path then code and deterministic", () => {
    const raw = rawEnv({ source: "slack", projectId: "P 1", html: 1, ts: -1 });
    const e = errs(raw);
    expect(e.length).toBeGreaterThanOrEqual(4);
    const keys = e.map((x) => x.path + "\u0000" + x.code);
    expect(keys).toEqual([...keys].sort());
    expect(errs(raw)).toEqual(e);
  });
});

describe("I7 seq_regression", () => {
  const reg = mkReg({ p1: "standard" }, { "p1:agent": 5 });
  it("equal and lower -> SEQ_REGRESSION", () => {
    expect(codes(rawEnv({ sourceSeq: 5 }), reg)).toContain("SEQ_REGRESSION");
    expect(codes(rawEnv({ sourceSeq: 2 }), reg)).toContain("SEQ_REGRESSION");
  });
  it("6 -> ok; scoped per (project, source)", () => {
    expect(ok(rawEnv({ sourceSeq: 6 }), reg).sourceSeq).toBe(6);
    expect(ok(rawEnv({ source: "git", kind: "push", sourceSeq: 1 }), reg).source).toBe("git");
  });
});

describe("I8 oversize and cap", () => {
  it("16385 chars -> TOO_LARGE_RAW, 16384 is not too large", () => {
    expect(codes("x".repeat(16385))).toEqual(["TOO_LARGE_RAW"]);
    expect(codes("x".repeat(16384))).not.toContain("TOO_LARGE_RAW");
  });
  it("2500 chars with a marker near char 1999 -> truncated, <= 2000, ends with ellipsis, no partial marker", () => {
    const text = "word ".repeat(398) + "TOKEN=fakevalue123 " + "b".repeat(500);
    const v = ok(rawEnv({ text }));
    expect(v.truncated).toBe(true);
    expect(v.text.length).toBeLessThanOrEqual(2000);
    expect(v.text.length).toBeGreaterThan(1900);
    expect(v.text.endsWith("\u2026")).toBe(true);
    expect(v.text.replace(/\[REDACTED:[A-Z_]+\]/g, "")).not.toContain("[REDACTED");
    expect(v.text).not.toContain("fakevalue123");
  });
  it("exactly at the cap is not truncated; one over is", () => {
    expect(ok(rawEnv({ text: "a ".repeat(1000) })).truncated).toBe(false);
    expect(ok(rawEnv({ text: "a ".repeat(1000) })).text.length).toBe(2000);
    expect(ok(rawEnv({ text: "a ".repeat(1000) + "b" })).truncated).toBe(true);
  });
  it("cut never splits a surrogate pair", () => {
    for (const pad of [1997, 1998, 1999, 2000]) {
      const v = ok(rawEnv({ text: "a".repeat(pad) + "\u{1F600}".repeat(5) }));
      expect(v.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      expect(v.text.length).toBeLessThanOrEqual(2000);
    }
  });
});

describe("I14 control_char", () => {
  it("BEL, NUL, DEL, ESC rejected; \\n and \\t allowed", () => {
    for (const c of ["\u0007", "\u0000", "\u007f", "\u001b", "\r"]) expect(codes(rawEnv({ text: "done" + c })), JSON.stringify(c)).toContain("CONTROL_CHAR");
    expect(ok(rawEnv({ text: "a\nb\tc" })).text).toBe("a\nb\tc");
  });
  it("rejection never echoes the text", () => {
    const e = errs(rawEnv({ text: "Bearer abcDEF123fakeTok \u0007" }));
    expect(e.length).toBeGreaterThan(0);
    expect(JSON.stringify(e)).not.toContain("abcDEF123fakeTok");
  });
});

describe("B1/B8 totality, determinism, no echo", () => {
  it("deterministic across calls and does not mutate the registry", () => {
    const reg = mkReg();
    const raw = rawEnv({ text: "x a@example.test" });
    expect(normalise(raw, reg)).toEqual(normalise(raw, reg));
  });
  it("no rejection ever echoes planted text", () => {
    for (const c of PLANTED) {
      const bad = [rawEnv({ text: c.text, projectId: "p9" }), rawEnv({ text: c.text, source: "slack" }), rawEnv({ text: c.text, ts: -1 }), rawEnv({ text: c.text, sourceSeq: "1" })];
      for (const raw of bad) {
        const r = normalise(raw, mkReg());
        expect(r.ok).toBe(false);
        for (const s of c.secrets) expect(JSON.stringify(r)).not.toContain(s);
      }
    }
  });
  it("ok value has exactly the CapsuleEvent keys", () => {
    expect(Object.keys(ok(rawEnv())).sort()).toEqual(["eventId", "projectId", "kind", "redactions", "source", "sourceSeq", "text", "tier", "truncated", "ts"].sort());
  });
});
