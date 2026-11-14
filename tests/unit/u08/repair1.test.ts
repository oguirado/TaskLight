import { describe, expect, it } from "vitest";
import { loadFixture, normalise, redact, replayDigest, canonicalJson, digestHex } from "../../../src/ingest/index";
import type { CapsuleEvent, ProjectRegistry } from "../../../src/ingest/index";
import { mkEvent, mkReg, rawEnv } from "./helpers";

// Repair loop 1. Every fake secret below is obviously fake and assembled at runtime
// so secret scanners do not flag this source.
const j = (...p: string[]): string => p.join("");

/** Output must either be rejected, or contain none of the secrets and be a redaction fixed point. */
function expectSafe(text: string, secrets: string[], reg: ProjectRegistry = mkReg()): void {
  const r = normalise(rawEnv({ text }), reg);
  if (!r.ok) return; // fail-closed rejection is acceptable (B8)
  for (const s of secrets) expect(r.value.text, `leaked ${s}`).not.toContain(s);
  const again = redact(r.value.text);
  expect(again.redactions, "output is not a redaction fixed point").toBe(0);
  expect(again.text).toBe(r.value.text);
}

describe("R1 KEY_ASSIGN must not exempt values that merely start with a marker prefix (B6/B8)", () => {
  it("PASSWORD=[REDACTED:X]<secret>", () => {
    const tail = j("realSecret", "123", "FAKE");
    expectSafe(j("PASSWORD", "=[REDACTED:X]", tail), [tail]);
  });
  it("quoted prefix variants", () => {
    const tail = j("notReal", "Tail", "987");
    expectSafe(j("api_", "token: \"[REDACTED:KEY_ASSIGN]", tail, "\""), [tail]);
    expectSafe(j("my_", "secret='[REDACTED:KEY_ASSIGN]", tail, "'"), [tail]);
  });
  it("redact() itself leaves no tail behind a marker prefix", () => {
    const tail = j("fakeTail", "ABC", "123");
    const out = redact(j("PASS", "WORD=[REDACTED:X]", tail)).text;
    expect(out).not.toContain(tail);
  });
  it("B7 still holds: a genuine standalone marker value is left alone", () => {
    const first = redact(j("PASS", "WORD=hunter2", "fake")).text;
    const second = redact(first);
    expect(second.text).toBe(first);
    expect(second.redactions).toBe(0);
  });
});

describe("R2 BEARER scheme is case-insensitive (B8: secret survives)", () => {
  it.each(["bearer", "BEARER", "BeArEr"])("%s token is redacted", (scheme) => {
    const tok = j("tok_short", "_123");
    expectSafe(j("authorization: ", scheme, " ", tok), [tok]);
    expect(redact(j("authorization: ", scheme, " ", tok)).text).not.toContain(tok);
  });
});

describe("R3 URL_CREDS password may contain ':' (B6)", () => {
  it("colon in password", () => {
    const text = j("https://", "admin:pa:ss", "@10.0.0.1/hook");
    expectSafe(text, ["pa:ss", "admin:pa", "ss@"]);
    expect(redact(text).text).not.toContain("pa:ss");
  });
  it("several colons, ftp scheme", () => {
    const text = j("ftp://", "bob:a:b:c", "@files.example/x");
    const out = redact(text).text;
    expect(out).not.toContain("bob");
    expect(out).not.toMatch(/a:b/);
  });
});

describe("R4 truncation must not reveal an entropy run (B8 + B9)", () => {
  it("secret that only becomes high-entropy after the cap cut", () => {
    const tok = j("A1b2C3d4E5f6", "G7h8I9j0K1l2", "M3n4O5p6");
    const text = j("a ".repeat(982), tok, "a".repeat(40));
    expect(text.length).toBe(2036);
    expectSafe(text, [tok]);
    const r = normalise(rawEnv({ text }), mkReg());
    if (r.ok) expect(r.value.text.length).toBeLessThanOrEqual(2000);
  });
});

describe("R5 multi-line quoted KEY_ASSIGN value (B6: only the value is replaced)", () => {
  it("newline inside a double-quoted value", () => {
    const text = j("SECRET", "=\"part1", "\n", "part2", "\"");
    expectSafe(text, ["part1", "part2"]);
  });
  it("newline inside a single-quoted value", () => {
    const text = j("DB_PASS", "WORD='alpha", "\n", "bravo", "'");
    expectSafe(text, ["alpha", "bravo"]);
  });
});

describe("R6 registry handling (B4, B10)", () => {
  it("lastSeq is not consulted for a malformed or unknown projectId", () => {
    const calls: string[] = [];
    const reg: ProjectRegistry = {
      tierOf: (p) => (p === "p1" ? "standard" : undefined),
      lastSeq: (p) => { calls.push(p); return 100; },
    };
    const bad = normalise(rawEnv({ projectId: "P 1" }), reg);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.map((e) => e.code)).toEqual(["BAD_PROJECT_ID"]);
    const unk = normalise(rawEnv({ projectId: "p9" }), reg);
    expect(unk.ok).toBe(false);
    if (!unk.ok) expect(unk.errors.map((e) => e.code)).toEqual(["UNKNOWN_PROJECT"]);
    expect(calls).toEqual([]);
  });
  it("a tier outside PRIVACY_TIER from the registry is never stamped on an event", () => {
    const reg = { tierOf: () => "bogus", lastSeq: () => undefined } as unknown as ProjectRegistry;
    const r = normalise(rawEnv(), reg);
    expect(r.ok).toBe(false);
  });
  it("registry tier 'private' and 'standard' still accepted (positive control)", () => {
    expect(normalise(rawEnv(), mkReg()).ok).toBe(true);
    expect(normalise(rawEnv({ projectId: "p2" }), mkReg()).ok).toBe(true);
  });
});

describe("R7 loadFixture rejects non-integer / negative numbers even when self-consistent (B14 shape checks)", () => {
  const mk = (over: Partial<CapsuleEvent>): { manifest: string; events: string } => {
    const base = mkEvent({ projectId: "p1", ...over });
    const { eventId: _unused, ...rest } = base;
    void _unused;
    const ev: CapsuleEvent = { ...rest, eventId: digestHex(canonicalJson(rest)) };
    const manifest = {
      version: "v1", projects: [{ projectId: "p1", tier: "standard", label: "P1" }],
      eventCount: 1, digest: replayDigest([ev]),
    };
    return { manifest: JSON.stringify(manifest), events: JSON.stringify(ev) + "\n" };
  };
  it("fractional ts", () => {
    const f = mk({ ts: 1000.5 });
    expect(loadFixture(f.manifest, f.events).ok).toBe(false);
  });
  it("negative sourceSeq", () => {
    const f = mk({ sourceSeq: -1 });
    expect(loadFixture(f.manifest, f.events).ok).toBe(false);
  });
});
