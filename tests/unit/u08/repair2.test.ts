import { describe, expect, it } from "vitest";
import { normalise, redact, replayDigest } from "../../../src/ingest/index";
import type { ProjectRegistry } from "../../../src/ingest/index";
import { mkEvent, mkReg, rawEnv } from "./helpers";

// Repair loop 2. Every fake secret below is obviously fake and assembled at runtime
// (string concatenation) so secret scanners do not flag this source.
const j = (...p: string[]): string => p.join("");

/** Output must either be rejected (B8 fail-closed), or contain none of the secrets and be a redaction fixed point. */
function expectSafe(text: string, secrets: string[], reg: ProjectRegistry = mkReg()): void {
  const r = normalise(rawEnv({ text }), reg);
  if (!r.ok) return;
  for (const s of secrets) expect(r.value.text, `leaked ${s}`).not.toContain(s);
  const again = redact(r.value.text);
  expect(again.redactions, "output is not a redaction fixed point").toBe(0);
  expect(again.text).toBe(r.value.text);
}
function expectRedactNoLeak(text: string, secrets: string[]): void {
  const out = redact(text).text;
  for (const s of secrets) expect(out, `redact() leaked ${s}`).not.toContain(s);
}

describe("R2-1 KEY_ASSIGN with a quoted key (JSON / structured logs) (B6/B8)", () => {
  it("{\"api_key\":\"<secret>\"}", () => {
    const sec = j("sk-live-", "secret", "123");
    const text = j("{\"api_", "key\":\"", sec, "\"}");
    expectRedactNoLeak(text, [sec]);
    expectSafe(text, [sec]);
  });
  it("{\"password\": \"<secret>\"} (space after the colon)", () => {
    const sec = j("hunt", "er2", "fake");
    const text = j("{\"pass", "word\": \"", sec, "\"}");
    expectRedactNoLeak(text, [sec]);
    expectSafe(text, [sec]);
  });
  it("single-quoted key", () => {
    const sec = j("fakeTok", "Value", "42");
    const text = j("{'my_", "token': '", sec, "'}");
    expectRedactNoLeak(text, [sec]);
    expectSafe(text, [sec]);
  });
});

describe("R2-2 KEY_ASSIGN: escaped quote inside a quoted value (B6: the value is replaced as a whole)", () => {
  it("PASSWORD=\"abc\\\"def_secret\"", () => {
    const tail = j("def_", "sec", "ret");
    const text = j("PASS", "WORD=\"abc\\\"", tail, "\"");
    expectRedactNoLeak(text, [tail]);
    expectSafe(text, [tail]);
  });
  it("single-quoted value with an escaped quote", () => {
    const tail = j("tail_", "fake", "xyz");
    const text = j("api_", "key='ab\\'", tail, "'");
    expectRedactNoLeak(text, [tail]);
    expectSafe(text, [tail]);
  });
});

describe("R2-3 URL_CREDS with ] in user or password (B6/B8)", () => {
  it("https://admin:sec]ret@10.0.0.1/hook", () => {
    const text = j("https://admin:", "sec]", "ret@10.0.0.1/hook");
    expectRedactNoLeak(text, [j("sec]", "ret")]);
    expectSafe(text, [j("sec]", "ret"), "admin:"]);
  });
  it("] in the user part", () => {
    const text = j("ftp://us]", "er:pw0fake@host.example/x");
    expectRedactNoLeak(text, [j("pw0", "fake")]);
    expectSafe(text, [j("pw0", "fake")]);
  });
});

describe("R2-4 BEARER with a quoted token (B6/B8)", () => {
  it("Authorization: Bearer \"tok_secret_123\"", () => {
    const sec = j("tok_", "secret", "_123");
    const text = j("Authorization: Bearer \"", sec, "\"");
    expectRedactNoLeak(text, [sec]);
    expectSafe(text, [sec]);
  });
  it("single-quoted token", () => {
    const sec = j("tok_", "other", "_456");
    const text = j("Authorization: Bearer '", sec, "'");
    expectRedactNoLeak(text, [sec]);
    expectSafe(text, [sec]);
  });
});

describe("R2-5 negative zero is not a distinct value (B11 integers, B4 non-negative ints)", () => {
  const rawNegZero = (field: "ts" | "sourceSeq"): string =>
    `{"source":"agent","projectId":"p1","sourceSeq":${field === "sourceSeq" ? "-0" : "1"},"ts":${field === "ts" ? "-0" : "1000"},"kind":"output","text":"ok"}`;
  it("ts: -0 is rejected or normalised to +0, and yields the same eventId as ts: 0", () => {
    const r = normalise(rawNegZero("ts"), mkReg());
    if (!r.ok) return;
    expect(Object.is(r.value.ts, -0)).toBe(false);
    expect(Object.is(r.value.ts, 0)).toBe(true);
    const plain = normalise(rawNegZero("ts").replace('"ts":-0', '"ts":0'), mkReg());
    expect(plain.ok).toBe(true);
    if (plain.ok) expect(r.value).toEqual(plain.value);
  });
  it("sourceSeq: -0 is rejected or normalised to +0", () => {
    const r = normalise(rawNegZero("sourceSeq"), mkReg());
    if (!r.ok) return;
    expect(Object.is(r.value.sourceSeq, -0)).toBe(false);
    expect(Object.is(r.value.sourceSeq, 0)).toBe(true);
  });
});

describe("R2-6 replayDigest is invariant to input order even for equal (ts, projectId, source, sourceSeq) (B12)", () => {
  it("two distinct events sharing the sort tuple: [a, b] and [b, a] give the same digest", () => {
    const a = mkEvent({ eventId: "a".repeat(64), text: "first" });
    const b = mkEvent({ eventId: "b".repeat(64), text: "second" });
    expect(replayDigest([a, b])).toBe(replayDigest([b, a]));
  });
  it("same with three tied events in every rotation", () => {
    const evs = ["x", "y", "z"].map((c, i) => mkEvent({ eventId: c.repeat(64), text: "t" + i }));
    const base = replayDigest(evs);
    expect(replayDigest([evs[1]!, evs[2]!, evs[0]!])).toBe(base);
    expect(replayDigest([evs[2]!, evs[1]!, evs[0]!])).toBe(base);
  });
  it("control: still sensitive to a field change", () => {
    const a = mkEvent({ text: "first" });
    expect(replayDigest([a])).not.toBe(replayDigest([{ ...a, text: "other" }]));
  });
});

// HOME_PATH redaction STAYS: spec amendment by orchestrator (privacy-first default). Extra coverage beyond pii_home_paths.test.ts.
describe("R2-7 HOME_PATH (spec amendment by orchestrator): usernames in home paths never survive", () => {
  const cases: Array<[string, string]> = [
    ["C:/Users/jdoe42/code/app.js", "jdoe42"],
    ["path is /home/jdoe42", "jdoe42"],
    ["see /Users/jdoe.smith-7/Library/x", "jdoe.smith-7"],
    ["two: /home/aliceq9/a and C:\\Users\\bobq9\\b", "aliceq9"],
  ];
  for (const [text, user] of cases) {
    it(text, () => {
      const r = normalise(rawEnv({ text }), mkReg());
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.text).not.toContain(user);
      expect(r.value.redactions).toBeGreaterThan(0);
      expect(redact(r.value.text).redactions).toBe(0);
    });
  }
  it("both usernames in the mixed case are gone", () => {
    const r = normalise(rawEnv({ text: "two: /home/aliceq9/a and C:\\Users\\bobq9\\b" }), mkReg());
    expect(r.ok && r.value.text.includes("bobq9")).toBe(false);
  });
});
