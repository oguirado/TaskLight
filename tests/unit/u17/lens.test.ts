// SPEC_AMEND_C B29: cross-lens inputs over derived states only. Oracle A11.
import { describe, expect, test } from "vitest";
import { buildDigestInputs } from "../../../src/digest";
import { validateTaskOutput } from "../../../src/schema";
import { cap } from "./helpers";

const lc = (id: string, o: Parameters<typeof cap>[1] = {}) => { const c = cap(id, o); return { projectId: id, state: c.state, tier: c.tier, lens_id: o.lens ?? "dev" }; };

describe("A11 digest_cross_lens", () => {
  test("dev p1 blocked + study s1 reading -> ok, 2 inputs with lens ids", () => {
    const r = buildDigestInputs([lc("p1", { status: "blocked", headline: "H1" }), lc("s1", { lens: "study", status: "reading", headline: "Ch3" })]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(2);
    expect(r.value.map((x) => [x.projectId, x.lens_id, x.status]).sort()).toEqual([["p1", "dev", "blocked"], ["s1", "study", "reading"]]);
    expect(r.value.find((x) => x.projectId === "p1")!.headline).toBe("H1");
  });
  test("study s2 with status 'blocked' (not a study status) is rejected", () => {
    const r = buildDigestInputs([lc("s2", { lens: "study", status: "blocked" })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });
  test("one bad capsule rejects the whole set (all-or-nothing Validated)", () => {
    const r = buildDigestInputs([lc("p1"), lc("s2", { lens: "study", status: "blocked" })]);
    expect(r.ok).toBe(false);
  });
  test("private input carrying a headline -> PRIVATE_TEXT; clean private input is ok without headline", () => {
    const bad = buildDigestInputs([lc("p1", { tier: "private", headline: "PRIV-HL" })]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.some((e) => e.code === "PRIVATE_TEXT")).toBe(true);
    const good = buildDigestInputs([lc("p1", { tier: "private", status: "blocked" })]);
    expect(good.ok).toBe(true);
    if (good.ok) { expect(good.value[0]!.headline).toBeUndefined(); expect("headline" in good.value[0]!).toBe(false); }
  });
  test("output naming p9 -> UNKNOWN_PROJECT with the knownProjectIds of the inputs", () => {
    const r = buildDigestInputs([lc("p1", { status: "blocked" }), lc("s1", { lens: "study", status: "reading" })]);
    if (!r.ok) throw new Error("inputs should be ok");
    const known = new Set(r.value.map((x) => x.projectId));
    const raw = JSON.stringify({ needs_you: [{ projectId: "p9", reason: "x", attention: "high" }], brief: "b" });
    const v = validateTaskOutput("digest", raw, { knownProjectIds: known });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.some((e) => e.code === "UNKNOWN_PROJECT")).toBe(true);
    const good = validateTaskOutput("digest", JSON.stringify({ needs_you: [{ projectId: "p1", reason: "x", attention: "high" }], brief: "b" }), { knownProjectIds: known });
    expect(good.ok).toBe(true);
  });
  test("inputs carry only projectId, lens_id, status, attention and headline", () => {
    const c = lc("p1", { headline: "H", summary: "S", next_action: "N" });
    Object.assign(c.state, { steps: [{ text: "STEP", state: "todo" }], progress: 40 });
    const r = buildDigestInputs([c]);
    if (!r.ok) throw new Error("ok expected");
    expect(Object.keys(r.value[0]!).sort()).toEqual(["attention", "headline", "lens_id", "projectId", "status"]);
    expect(JSON.stringify(r.value)).not.toMatch(/"S"|"N"|STEP|pack_hash|progress/);
  });
  test("input array is capped at NEEDS_YOU_MAX 12: 13 capsules -> TOO_MANY_ITEMS, 12 ok", () => {
    const mk = (n: number) => Array.from({ length: n }, (_, k) => lc("p" + k));
    expect(buildDigestInputs(mk(12)).ok).toBe(true);
    const r = buildDigestInputs(mk(13));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === "TOO_MANY_ITEMS")).toBe(true);
  });
  test("duplicate project ids are rejected (DUPLICATE_PROJECT); unknown lens and lens mismatch are rejected", () => {
    const d = buildDigestInputs([lc("p1"), lc("p1")]);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.errors.some((e) => e.code === "DUPLICATE_PROJECT")).toBe(true);
    expect(buildDigestInputs([lc("x1", { lens: "astro" })]).ok).toBe(false);
    const mism = lc("p1"); mism.lens_id = "study";
    expect(buildDigestInputs([mism]).ok).toBe(false);
  });
  test("empty input array is ok and empty", () => {
    const r = buildDigestInputs([]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });
});
