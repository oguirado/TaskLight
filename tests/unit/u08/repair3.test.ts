// Repair loop 3: regression tests for cross-family review (fail-closed lastSeq, independent B8 residue barrier,
// host-independent SHA-256, no secrets in error paths). Fake secrets are assembled at runtime.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { normalise, redact } from "../../../src/ingest/index";
import { digestHex } from "../../../src/ingest/digest";
import type { ProjectRegistry } from "../../../src/ingest/index";
import { mkReg, rawEnv } from "./helpers";

const j = (...p: string[]): string => p.join("");
const SEC = j("short", "Fake", "Secret");
const identity = (text: string) => ({ text, redactions: 0, classes: [] as never[] });

describe("R3-1 B4: an unavailable sequence must not authorise forwarding", () => {
  it("lastSeq throwing rejects the event", () => {
    const reg: ProjectRegistry = { tierOf: () => "standard", lastSeq: () => { throw new Error("down"); } };
    expect(normalise(rawEnv({ sourceSeq: 1 }), reg).ok).toBe(false);
  });
  it("control: a healthy registry still accepts", () => {
    expect(normalise(rawEnv({ sourceSeq: 1 }), mkReg()).ok).toBe(true);
  });
});

describe("R3-2 B8: residue check is independent of the replacement (identity redactFn seam)", () => {
  const run = (text: string) => normalise(rawEnv({ text }), mkReg(), { redactFn: identity });
  const rejected = (text: string): void => {
    const r = run(text);
    expect(r.ok, text).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.code)).toContain("REDACT_RESIDUE");
      expect(JSON.stringify(r.errors)).not.toContain(SEC);
    }
  };
  it("quoted assignment key (JSON)", () => rejected(j("{\"pass", "word\":\"", SEC, "\"}")));
  it("quoted assignment key (single quotes, key with underscore)", () => rejected(j("{'my_to", "ken': '", SEC, "'}")));
  it("quoted BEARER token", () => rejected(j("Bear", "er \"", SEC, "\"")));
  it("single-quoted BEARER token", () => rejected(j("Bear", "er '", SEC, "'")));
  it("URL credentials with ] in the user", () => rejected(j("https://us]er", ":", SEC, "@host/")));
  it("URL credentials with ] in the password", () => rejected(j("https://user:", "pa]ss", SEC, "@host/")));
  it("control: marker-exempt text still passes the seam", () => {
    const r = run("password: [REDACTED:KEY_ASSIGN] ok");
    expect(r.ok).toBe(true);
  });
  it("control: default redaction output of the same inputs is accepted or rejected, never leaks", () => {
    for (const t of [j("{\"pass", "word\":\"", SEC, "\"}"), j("Bear", "er \"", SEC, "\""), j("https://us]er", ":", SEC, "@host/")]) {
      expect(redact(t).text).not.toContain(SEC);
    }
  });
});

describe("R3-3 B11/B12: digestHex is host-independent and equals native UTF-8 SHA-256", () => {
  const sha = (s: string): string => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
  const samples = ["\uD800", "a\uD83D", "\uDC00x", "ok\u{1F600}\uD800", "\uD800\uD800", "plain", "héllo€"];
  afterEach(() => { vi.unstubAllGlobals(); });
  it("native TextEncoder path matches node SHA-256", () => {
    for (const s of samples) expect(digestHex(s), JSON.stringify(s)).toBe(sha(s));
  });
  it("fallback path (no TextEncoder) matches node SHA-256, including a terminal unpaired high surrogate", () => {
    vi.stubGlobal("TextEncoder", undefined);
    for (const s of samples) expect(digestHex(s), JSON.stringify(s)).toBe(sha(s));
  });
});

describe("R3-4 B8: errors retain no original text (unknown property names)", () => {
  const withKey = (key: string): string => JSON.stringify({ ...JSON.parse(rawEnv({ text: j("PASS", "WORD=", SEC) })), [key]: 1 });
  it("secret-bearing property name does not appear in the rejection", () => {
    const key = j("PASS", "WORD=", SEC);
    const r = normalise(withKey(key), mkReg());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.code)).toContain("UNKNOWN_FIELD");
      expect(JSON.stringify(r.errors)).not.toContain(SEC);
    }
  });
  it("another secret-shaped property name (bearer / url form)", () => {
    const key = j("https://user:", SEC, "@host/");
    const r = normalise(withKey(key), mkReg());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.errors)).not.toContain(SEC);
  });
  it("safe identifier `html` is still reported at path html", () => {
    const r = normalise(JSON.stringify({ ...JSON.parse(rawEnv()), html: "<b>" }), mkReg());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === "UNKNOWN_FIELD" && e.path === "html")).toBe(true);
  });
});
