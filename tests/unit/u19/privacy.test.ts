import { describe, expect, test } from "vitest";
import { AI_DEFAULTS, resolveMode } from "../../../src/ai";
import type { ModeName } from "../../../src/ai";
import type { PrivacyTier, TaskId } from "../../../src/schema";
import { assertModeAllowed, assertSourceAllowed, gateScreenshot, guardSyncWrite, syncProjection } from "../../../src/privacy";
import type { MultimodalState } from "../../../src/privacy";
import { state } from "./helpers";

const MODES: ModeName[] = ["PREFER_ON_DEVICE", "ONLY_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD"];
const TASKS: TaskId[] = ["status", "summary", "next_action", "digest", "plan"];

describe("O1 private_mode_enforced (B1)", () => {
  test("summary/private/PREFER_ON_DEVICE -> PRIVATE_MODE_NOT_ON_DEVICE; private/ONLY_ON_DEVICE ok; standard/PREFER_ON_DEVICE ok", () => {
    expect(assertModeAllowed("summary", "private", "PREFER_ON_DEVICE")).toEqual({ ok: false, violation: "PRIVATE_MODE_NOT_ON_DEVICE" });
    expect(assertModeAllowed("summary", "private", "ONLY_ON_DEVICE")).toEqual({ ok: true });
    expect(assertModeAllowed("summary", "standard", "PREFER_ON_DEVICE")).toEqual({ ok: true });
  });
  test("private: every task with every mode except ONLY_ON_DEVICE is a violation", () => {
    for (const t of [...TASKS, "screenshot" as TaskId]) for (const m of MODES) {
      const r = assertModeAllowed(t, "private", m);
      if (m === "ONLY_ON_DEVICE") expect(r, `${t}/${m}`).toEqual({ ok: true });
      else expect(r, `${t}/${m}`).toEqual({ ok: false, violation: "PRIVATE_MODE_NOT_ON_DEVICE" });
    }
  });
  test("standard and shared may use any mode for non-screenshot tasks (positive control)", () => {
    for (const tier of ["standard", "shared"] as PrivacyTier[]) for (const t of TASKS) for (const m of MODES)
      expect(assertModeAllowed(t, tier, m), `${tier}/${t}/${m}`).toEqual({ ok: true });
  });
  test("an unknown tier fails closed (never allows a cloud mode)", () => {
    for (const bad of ["Private", "priv", "", "admin"]) expect(assertModeAllowed("summary", bad as PrivacyTier, "PREFER_IN_CLOUD").ok, bad).toBe(false);
  });
  test("an unknown mode string is a violation for private", () => {
    expect(assertModeAllowed("summary", "private", "CLOUD" as ModeName).ok).toBe(false);
  });
});

describe("O2 screenshot_mode_pinned", () => {
  test("screenshot/standard/PREFER_IN_CLOUD -> SCREENSHOT_MODE_NOT_ON_DEVICE", () => {
    expect(assertModeAllowed("screenshot", "standard", "PREFER_IN_CLOUD")).toEqual({ ok: false, violation: "SCREENSHOT_MODE_NOT_ON_DEVICE" });
  });
  test("screenshot with any non-ONLY_ON_DEVICE mode is refused for standard and shared; ONLY_ON_DEVICE is ok", () => {
    for (const tier of ["standard", "shared"] as PrivacyTier[]) for (const m of MODES) {
      const r = assertModeAllowed("screenshot", tier, m);
      if (m === "ONLY_ON_DEVICE") expect(r).toEqual({ ok: true });
      else expect(r).toEqual({ ok: false, violation: "SCREENSHOT_MODE_NOT_ON_DEVICE" });
    }
  });
  test("private + screenshot + cloud mode reports the private violation first (B1 order)", () => {
    expect(assertModeAllowed("screenshot", "private", "PREFER_IN_CLOUD")).toEqual({ ok: false, violation: "PRIVATE_MODE_NOT_ON_DEVICE" });
  });
});

describe("agreement with U06 resolveMode (B1 'must agree')", () => {
  test("whatever U06 resolves is always allowed by U19; private and screenshot resolve to ONLY_ON_DEVICE", () => {
    for (const t of [...TASKS.filter((x) => x !== "plan"), "screenshot" as TaskId]) for (const tier of ["private", "standard", "shared"] as PrivacyTier[]) for (const m of MODES) for (const kill of [false, true]) {
      const cfg = { ...AI_DEFAULTS, [`mode_${t}`]: m, kill_switch_cloud: kill };
      const resolved = resolveMode(t, tier, cfg);
      expect(assertModeAllowed(t, tier, resolved), `${t}/${tier}/${m}/${kill}`).toEqual({ ok: true });
      if (tier === "private" || t === "screenshot") expect(resolved).toBe("ONLY_ON_DEVICE");
    }
  });
});

describe("assertSourceAllowed (B2)", () => {
  test("ONLY_ON_DEVICE with IN_CLOUD -> CLOUD_SOURCE_FOR_ON_DEVICE_ONLY; ON_DEVICE ok", () => {
    expect(assertSourceAllowed("ONLY_ON_DEVICE", "IN_CLOUD")).toEqual({ ok: false, violation: "CLOUD_SOURCE_FOR_ON_DEVICE_ONLY" });
    expect(assertSourceAllowed("ONLY_ON_DEVICE", "ON_DEVICE")).toEqual({ ok: true });
  });
  test("other modes accept both sources (fallbacks are legal)", () => {
    for (const m of ["PREFER_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD"] as ModeName[]) for (const s of ["ON_DEVICE", "IN_CLOUD"] as const)
      expect(assertSourceAllowed(m, s), `${m}/${s}`).toEqual({ ok: true });
  });
});

describe("O3 sync_projection_private (B3, B4)", () => {
  const TEXT = ["headline", "summary", "next_action"];
  test("private projection has none of the text keys, and guardSyncWrite accepts it", () => {
    const p = syncProjection(state(), "private") as unknown as Record<string, unknown>;
    for (const k of TEXT) expect(k in p, k).toBe(false);
    expect(JSON.stringify(p)).not.toMatch(/HL-TEXT|SUM-TEXT|NEXT-TEXT/);
    for (const k of ["rev", "observed_rev", "status", "attention", "inference_source", "updated_at", "writer_uid"]) expect(p[k], k).toBeDefined();
    const g = guardSyncWrite(p, "private");
    expect(g.ok).toBe(true);
  });
  test("the raw state under the guard gives PRIVATE_TEXT (the guard rejects, never strips) and is not mutated", () => {
    const raw = state(); const snap = JSON.stringify(raw);
    const g = guardSyncWrite(raw, "private");
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.rejects.some((r) => r.code === "PRIVATE_TEXT" && r.path === "headline")).toBe(true);
      expect(g.rejects.filter((r) => r.code === "PRIVATE_TEXT").map((r) => r.path).sort()).toEqual(["headline", "next_action", "summary"]);
    }
    expect(JSON.stringify(raw)).toBe(snap);
  });
  test("neg: the standard projection keeps all 3 text keys and guard accepts the raw state", () => {
    const p = syncProjection(state(), "standard");
    expect(p.headline).toBe("HL-TEXT"); expect(p.summary).toBe("SUM-TEXT"); expect(p.next_action).toBe("NEXT-TEXT");
    expect(syncProjection(state(), "shared").headline).toBe("HL-TEXT");
    expect(guardSyncWrite(state(), "standard").ok).toBe(true);
  });
  test("private projection drops steps (text) and unknown extra keys, never aliases the input", () => {
    const s = state({ steps: [{ text: "STEP-TEXT", state: "todo" }], progress: 40, pack_hash: "deadbeef", extra_secret: "XTRA" });
    const p = syncProjection(s, "private");
    expect(JSON.stringify(p)).not.toMatch(/STEP-TEXT|XTRA|deadbeef/);
    expect(p).not.toBe(s);
  });
  test("U05 v2: private projection keeps lens_id and progress (non-text) so a study capsule round-trips through the guard", () => {
    const s = state({ lens_id: "study", status: "reading", progress: 40 });
    const p = syncProjection(s, "private") as unknown as Record<string, unknown>;
    expect(p["lens_id"]).toBe("study");
    expect(p["progress"]).toBe(40);
    expect(guardSyncWrite(p, "private").ok).toBe(true);
  });
  test("standard projection copies every CapsuleState field, deep-copies steps, drops unknown keys", () => {
    const s = state({ steps: [{ text: "S1", state: "doing" }], progress: 10, extra_secret: "XTRA" });
    const p = syncProjection(s, "standard") as unknown as Record<string, unknown>;
    expect(JSON.stringify(p)).not.toContain("XTRA");
    expect(p["steps"]).toEqual([{ text: "S1", state: "doing" }]);
    expect(p["steps"]).not.toBe(s.steps);
    (p["steps"] as Array<{ text: string }>)[0]!.text = "CHANGED";
    expect(s.steps![0]!.text).toBe("S1");
  });
  test("an unknown tier is projected like private (fail closed)", () => {
    const p = syncProjection(state(), "bogus" as PrivacyTier);
    expect(JSON.stringify(p)).not.toMatch(/HL-TEXT|SUM-TEXT|NEXT-TEXT/);
  });
  test("guardSyncWrite passes through other U05 rejects (BAD_INT, NOT_OBJECT, enum)", () => {
    const bad = guardSyncWrite(state({ rev: -1 }), "standard");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.rejects.some((r) => r.code === "BAD_INT")).toBe(true);
    for (const junk of [null, "x", 5, [], undefined]) {
      const g = guardSyncWrite(junk, "standard");
      expect(g.ok, String(junk)).toBe(false);
    }
    expect(guardSyncWrite(state({ status: "exploding" }), "standard").ok).toBe(false);
  });
  test("guardSyncWrite on a private projection that was tampered with text afterwards is rejected", () => {
    const p = { ...(syncProjection(state(), "private") as object), headline: "LATE-TEXT" };
    expect(guardSyncWrite(p, "private").ok).toBe(false);
  });
});

describe("O4 screenshot_gate_order (B5)", () => {
  const png = "image/png";
  test("the four spec rows", () => {
    expect(gateScreenshot({ multimodal: "unavailable", deviceReady: true, mimeType: png })).toEqual({ allow: false, reason: "MULTIMODAL_UNAVAILABLE" });
    expect(gateScreenshot({ multimodal: "available", deviceReady: false, mimeType: png })).toEqual({ allow: false, reason: "DEVICE_NOT_READY" });
    expect(gateScreenshot({ multimodal: "available", deviceReady: true, mimeType: "image/webp" })).toEqual({ allow: false, reason: "INPUT_REJECTED" });
    expect(gateScreenshot({ multimodal: "available", deviceReady: true, mimeType: "image/jpeg" })).toEqual({ allow: true, mode: "ONLY_ON_DEVICE" });
  });
  test("png is allowed; the check order is multimodal, device, then mime", () => {
    expect(gateScreenshot({ multimodal: "available", deviceReady: true, mimeType: png })).toEqual({ allow: true, mode: "ONLY_ON_DEVICE" });
    expect(gateScreenshot({ multimodal: "unavailable", deviceReady: false, mimeType: "image/webp" })).toEqual({ allow: false, reason: "MULTIMODAL_UNAVAILABLE" });
    expect(gateScreenshot({ multimodal: "available", deviceReady: false, mimeType: "image/webp" })).toEqual({ allow: false, reason: "DEVICE_NOT_READY" });
  });
  test("downloadable and downloading are not available", () => {
    for (const m of ["downloadable", "downloading"] as MultimodalState[]) expect(gateScreenshot({ multimodal: m, deviceReady: true, mimeType: png })).toEqual({ allow: false, reason: "MULTIMODAL_UNAVAILABLE" });
  });
  test("missing, empty and non-image mime types are INPUT_REJECTED", () => {
    for (const mt of [undefined, "", "image/gif", "application/pdf", "text/html", "image/svg+xml", "png"]) {
      const g = gateScreenshot({ multimodal: "available", deviceReady: true, ...(mt === undefined ? {} : { mimeType: mt }) });
      expect(g, String(mt)).toEqual({ allow: false, reason: "INPUT_REJECTED" });
    }
  });
  test("an unknown multimodal value fails closed", () => {
    expect(gateScreenshot({ multimodal: "yes" as MultimodalState, deviceReady: true, mimeType: png }).allow).toBe(false);
  });
  test("any allow carries ONLY_ON_DEVICE and nothing else (B5.4)", () => {
    for (const mm of ["available", "downloadable", "downloading", "unavailable"] as MultimodalState[]) for (const rdy of [true, false]) for (const mt of ["image/png", "image/jpeg", "image/webp", undefined]) {
      const g = gateScreenshot({ multimodal: mm, deviceReady: rdy, ...(mt === undefined ? {} : { mimeType: mt }) });
      if (g.allow) { expect(g).toEqual({ allow: true, mode: "ONLY_ON_DEVICE" }); expect(mm).toBe("available"); expect(rdy).toBe(true); }
    }
  });
});
