import { describe, expect, test } from "vitest";
import { projectCapsule } from "../../../src/digest";
import { DIGEST_LINE_KEYS, NOW, cap } from "./helpers";

describe("projectCapsule (B1-B3)", () => {
  test("standard capsule: allowlisted keys in the exact serialization order", () => {
    const l = projectCapsule(cap("p1", { status: "blocked", attention: "high", headline: "H", next_action: "N", summary: "S", waiting: 4200 }), NOW)!;
    expect(l).not.toBeNull();
    expect(Object.keys(l)).toEqual(DIGEST_LINE_KEYS);
    expect(l).toEqual({ projectId: "p1", status: "blocked", attention: "high", waiting_ms: 4200, headline: "H", next_action: "N", summary: "S" });
  });
  test("absent text fields are absent keys, not undefined", () => {
    const l = projectCapsule(cap("p1", { headline: "H" }), NOW)!;
    expect(Object.keys(l)).toEqual(["projectId", "status", "attention", "waiting_ms", "headline"]);
  });
  test("waiting_ms is now - updated_at, floored at 0 (future timestamps, clock skew)", () => {
    expect(projectCapsule(cap("p1", { waiting: 0 }), NOW)!.waiting_ms).toBe(0);
    expect(projectCapsule(cap("p1", { waiting: -5000 }), NOW)!.waiting_ms).toBe(0);
    expect(projectCapsule(cap("p1", { waiting: 123456 }), NOW)!.waiting_ms).toBe(123456);
  });
  test("O1 outer extra key raw_event is ignored: never spread", () => {
    const c = { ...cap("p1", { headline: "H" }), raw_event: "SECRET-RAW" } as unknown as ReturnType<typeof cap>;
    const l = projectCapsule(c, NOW)!;
    expect(l).not.toBeNull();
    expect(JSON.stringify(l)).not.toContain("SECRET-RAW");
    for (const k of Object.keys(l)) expect(DIGEST_LINE_KEYS).toContain(k);
  });
  test("O1 state-level extra key never leaks (capsule may be excluded as invalid or projected without it)", () => {
    const c = cap("p1", { headline: "H" });
    (c.state as unknown as Record<string, unknown>)["raw_event"] = "SECRET-RAW";
    const l = projectCapsule(c, NOW);
    expect(JSON.stringify(l)).not.toContain("SECRET-RAW");
    if (l) for (const k of Object.keys(l)) expect(DIGEST_LINE_KEYS).toContain(k);
  });
  test("steps, writer_uid, rev, lens_id and inference_source never appear in a line", () => {
    const c = cap("p1", { headline: "H" });
    Object.assign(c.state, { steps: [{ text: "STEP-TEXT", state: "todo" }], progress: 10 });
    const l = projectCapsule(c, NOW);
    const s = JSON.stringify(l);
    for (const bad of ["STEP-TEXT", "writer_uid", "u1", "inference_source", "observed_rev", "lens_id", "progress"]) expect(s, bad).not.toContain(bad);
  });
  test("O2 private: status and attention only (4 keys) even with text forced in", () => {
    const c = cap("p1", { tier: "private", status: "blocked", attention: "now", headline: "PRIV-HL", summary: "PRIV-SUM", next_action: "PRIV-NEXT" });
    const l = projectCapsule(c, NOW)!;
    expect(l).not.toBeNull();   // PRIVATE_TEXT is still projected (B2)
    expect(Object.keys(l)).toEqual(["projectId", "status", "attention", "waiting_ms"]);
    const s = JSON.stringify(l);
    for (const t of ["PRIV-HL", "PRIV-SUM", "PRIV-NEXT"]) expect(s).not.toContain(t);
    expect(l.status).toBe("blocked"); expect(l.attention).toBe("now");
  });
  test("O2 neg: the same capsule as standard contains the text", () => {
    const l = projectCapsule(cap("p1", { tier: "standard", headline: "PRIV-HL" }), NOW)!;
    expect(l.headline).toBe("PRIV-HL");
    const sh = projectCapsule(cap("p1", { tier: "shared", headline: "PRIV-HL" }), NOW)!;
    expect(sh.headline).toBe("PRIV-HL");
  });
  test("an unknown tier string fails closed like private (no text)", () => {
    const c = cap("p1", { headline: "LEAK-HL", summary: "LEAK-SUM" });
    (c as unknown as { tier: string }).tier = "bogus";
    const l = projectCapsule(c, NOW);
    expect(JSON.stringify(l)).not.toMatch(/LEAK/);
  });
  test("B2 invalid states are excluded (null): bad status, missing rev, bad attention, non-object", () => {
    expect(projectCapsule(cap("p1", { status: "exploding" }), NOW)).toBeNull();
    expect(projectCapsule(cap("p1", { attention: "urgent" as never }), NOW)).toBeNull();
    const noRev = cap("p1"); delete (noRev.state as unknown as Record<string, unknown>)["rev"];
    expect(projectCapsule(noRev, NOW)).toBeNull();
    expect(projectCapsule({ projectId: "p1", tier: "standard", state: null } as never, NOW)).toBeNull();
    expect(projectCapsule({ projectId: "p1", tier: "standard", state: "x" } as never, NOW)).toBeNull();
  });
  test("an over-long text field (U05 limits) makes the capsule invalid rather than truncating silently", () => {
    expect(projectCapsule(cap("p1", { headline: "h".repeat(121) }), NOW)).toBeNull();
  });
  test("study lens capsule with a study status projects (cross-lens, A11)", () => {
    const l = projectCapsule(cap("s1", { lens: "study", status: "reading", headline: "Ch 3" }), NOW)!;
    expect(l).not.toBeNull();
    expect(l.status).toBe("reading");
  });
  test("study status on a dev capsule and a dev status on a study capsule are invalid; unknown lens is not rendered", () => {
    expect(projectCapsule(cap("s2", { lens: "study", status: "blocked" }), NOW)).toBeNull();
    expect(projectCapsule(cap("p1", { lens: "dev", status: "reading" }), NOW)).toBeNull();
    expect(projectCapsule(cap("x1", { lens: "astro", status: "running" }), NOW)).toBeNull();
  });
  test("does not mutate its input", () => {
    const c = cap("p1", { tier: "private", headline: "PRIV-HL" });
    const snap = JSON.stringify(c);
    projectCapsule(c, NOW);
    expect(JSON.stringify(c)).toBe(snap);
  });
});
