import { describe, expect, it } from "vitest";
import { assertModeAllowed, assertSourceAllowed } from "../../../src/privacy";
import { INFERENCE_SOURCE, PRIVACY_TIER } from "../../../src/schema/enums";
import { validateInferenceSource } from "../../../src/schema/index";
import { FOUR_SOURCES, MODES, NEW_SOURCES, TASKS, TIERS, expectedMode } from "./fixtures";

type M = Parameters<typeof assertSourceAllowed>[0];
type S = Parameters<typeof assertSourceAllowed>[1];
const src = (m: string, s: unknown) => assertSourceAllowed(m as M, s as S);
const DENY = { ok: false, violation: "CLOUD_SOURCE_FOR_ON_DEVICE_ONLY" };

describe("O1 enum", () => {
  it("INFERENCE_SOURCE equals the 4-value list in order, frozen", () => {
    expect([...INFERENCE_SOURCE]).toEqual([...FOUR_SOURCES]);
    expect(Object.isFrozen(INFERENCE_SOURCE)).toBe(true);
  });
  it("PRIVACY_TIER unchanged (regression)", () => { expect([...PRIVACY_TIER]).toEqual(["private", "standard", "shared"]); });
  it("validateInferenceSource accepts all 4 values, still rejects wrong case and junk (BAD_SOURCE)", () => {
    for (const v of FOUR_SOURCES) expect(validateInferenceSource(v), v).toEqual({ ok: true, value: v });
    for (const v of ["on_device", "slack", "local_server", "remote_provider", "REMOTE", "", " LOCAL_SERVER", null, undefined, 5, {}]) {
      const r = validateInferenceSource(v);
      expect(r.ok, String(v)).toBe(false);
    }
  });
});

describe("O6 regression: old (mode, source) pairs byte-identical (GREEN by design)", () => {
  it("ONLY_ON_DEVICE: ON_DEVICE ok, IN_CLOUD denied", () => {
    expect(src("ONLY_ON_DEVICE", "ON_DEVICE")).toStrictEqual({ ok: true });
    expect(src("ONLY_ON_DEVICE", "IN_CLOUD")).toStrictEqual(DENY);
  });
  it("other 3 modes accept both old sources", () => {
    for (const m of ["PREFER_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD"]) for (const s of ["ON_DEVICE", "IN_CLOUD"]) expect(src(m, s), `${m}/${s}`).toStrictEqual({ ok: true });
  });
  it("unknown mode denied for every source (old and new)", () => {
    for (const m of ["", "prefer_on_device", "BOGUS", "ONLY_ON_DEVICE "]) for (const s of FOUR_SOURCES) expect(src(m, s), `${m}/${s}`).toStrictEqual(DENY);
    expect(src(undefined as never, "ON_DEVICE")).toStrictEqual(DENY);
  });
  it("unknown source denied for every mode", () => {
    for (const m of MODES) for (const s of ["OTHER", "on_device", "", undefined, null, 1, "local_server", "LOCAL"]) expect(src(m, s), `${m}/${String(s)}`).toStrictEqual(DENY);
  });
  it("assertModeAllowed: 6 tasks x 3 tiers x 4 modes + unknown mode equals pre-U46 table", () => {
    for (const t of TASKS) for (const ti of [...TIERS, "public", ""]) for (const m of [...MODES, "BOGUS", ""]) {
      expect(assertModeAllowed(t, ti as never, m as never), `${t}/${ti}/${m}`).toStrictEqual(expectedMode(t, ti, m));
    }
  });
});

describe("O7 new sources", () => {
  it.each([...NEW_SOURCES])("ONLY_ON_DEVICE denies %s", (s) => { expect(src("ONLY_ON_DEVICE", s)).toStrictEqual(DENY); });
  it.each([...NEW_SOURCES])("%s ok under PREFER_ON_DEVICE, PREFER_IN_CLOUD, ONLY_IN_CLOUD", (s) => {
    for (const m of ["PREFER_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD"]) expect(src(m, s), `${m}/${s}`).toStrictEqual({ ok: true });
  });
  it("lowercase / unknown spellings denied under all modes", () => {
    for (const m of MODES) for (const s of ["local_server", "remote_provider", "OTHER", "Local_Server", "LOCAL_SERVER ", "REMOTE"]) expect(src(m, s), `${m}/${s}`).toStrictEqual(DENY);
  });
  it("full 4 modes x 4 sources matrix: only ONLY_ON_DEVICE x non-ON_DEVICE is denied", () => {
    for (const m of MODES) for (const s of FOUR_SOURCES) {
      const want = m === "ONLY_ON_DEVICE" && s !== "ON_DEVICE" ? DENY : { ok: true };
      expect(src(m, s), `${m}/${s}`).toStrictEqual(want);
    }
  });
});
