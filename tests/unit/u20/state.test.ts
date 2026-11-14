import { describe, it, expect } from "vitest";
import { resolveWallMode, BANNER_TEXT } from "../../../src/ui/state";
import type { WallInputs, WallMode } from "../../../src/ui/types";
import { D } from "./helpers";

const ROWS: [WallMode, WallInputs][] = [
  ["booting", D({ host: { kind: "booting" } })],
  ["blocked", D({ host: { kind: "blocked", reason: "CONFIG_INVALID" } })],
  ["offline", D({ online: false })],
  ["kill_switch", D({ killSwitchCloud: true })],
  ["no_model", D({ device: { state: "not_initialised" }, availability: "downloadable" })],
  ["needs_gesture", D({ device: { state: "needs_gesture" }, availability: "downloadable" })],
  ["downloading", D({ device: { state: "downloading", progress: 0.5 }, availability: "downloading" })],
  ["cloud_fallback", D({ lastRun: { source: "IN_CLOUD", fallback: true } })],
  ["on_device", D({ lastRun: { source: "ON_DEVICE", fallback: false } })],
];

describe("U20 O1 precedence_table (B1)", () => {
  it.each(ROWS)("%s", (mode, i) => { expect(resolveWallMode(i).mode).toBe(mode); });
  it("offline + kill_switch + downloading together -> offline", () => {
    const i = D({ online: false, killSwitchCloud: true, device: { state: "downloading", progress: 0.3 } });
    expect(resolveWallMode(i).mode).toBe("offline");
  });
  it("host beats offline; kill_switch beats downloading and fallback", () => {
    expect(resolveWallMode(D({ host: { kind: "booting" }, online: false })).mode).toBe("booting");
    expect(resolveWallMode(D({ killSwitchCloud: true, device: { state: "downloading", progress: 0.3 } })).mode).toBe("kill_switch");
    expect(resolveWallMode(D({ killSwitchCloud: true, lastRun: { source: "IN_CLOUD", fallback: true } })).mode).toBe("kill_switch");
  });
  it("downloading beats unavailable; unavailable (even if ready) and failed -> no_model", () => {
    expect(resolveWallMode(D({ availability: "unavailable", device: { state: "downloading", progress: 0.1 } })).mode).toBe("downloading");
    expect(resolveWallMode(D({ availability: "unavailable" })).mode).toBe("no_model");
    expect(resolveWallMode(D({ device: { state: "failed", detail: "x" } })).mode).toBe("no_model");
  });
  it("no_model beats cloud_fallback", () => {
    expect(resolveWallMode(D({ device: { state: "not_initialised" }, lastRun: { source: "IN_CLOUD", fallback: true } })).mode).toBe("no_model");
  });
});

describe("U20 O3 progress_rounding (B2)", () => {
  const dl = (p: number) => resolveWallMode(D({ device: { state: "downloading", progress: p } }));
  it("rounds, clamps, NaN -> 0", () => {
    expect(dl(0.1234).progressPct).toBe(12);
    expect(dl(1.5).progressPct).toBe(100);
    expect(dl(-3).progressPct).toBe(0);
    expect(dl(Number.NaN).progressPct).toBe(0);
    expect(dl(Number.POSITIVE_INFINITY).progressPct).toBe(0);
  });
  it("null outside downloading", () => {
    expect(resolveWallMode(D()).progressPct).toBeNull();
    expect(resolveWallMode(D({ device: { state: "needs_gesture" } })).progressPct).toBeNull();
  });
});

describe("U20 O4 cta_visibility (B3) and private availability (B4)", () => {
  it("hidden when unavailable (neg); shown for needs_gesture + downloadable", () => {
    expect(resolveWallMode(D({ device: { state: "not_initialised" }, availability: "unavailable" })).showEnableCta).toBe(false);
    expect(resolveWallMode(D({ device: { state: "needs_gesture" }, availability: "downloadable" })).showEnableCta).toBe(true);
    expect(resolveWallMode(D({ device: { state: "not_initialised" }, availability: "downloadable" })).showEnableCta).toBe(true);
  });
  it("hidden unless host ready; hidden for ready/downloading", () => {
    expect(resolveWallMode(D({ host: { kind: "booting" }, device: { state: "needs_gesture" } })).showEnableCta).toBe(false);
    expect(resolveWallMode(D({ host: { kind: "blocked", reason: "X" }, device: { state: "needs_gesture" } })).showEnableCta).toBe(false);
    expect(resolveWallMode(D()).showEnableCta).toBe(false);
    expect(resolveWallMode(D({ device: { state: "downloading", progress: 0.2 } })).showEnableCta).toBe(false);
  });
  it("privateAvailable iff device ready", () => {
    expect(resolveWallMode(D()).privateAvailable).toBe(true);
    for (const device of [{ state: "not_initialised" }, { state: "needs_gesture" }, { state: "downloading", progress: 0.5 }, { state: "failed", detail: "d" }] as const) {
      expect(resolveWallMode(D({ device })).privateAvailable).toBe(false);
    }
  });
});

describe("U20 B8 banner table", () => {
  it("every mode has non-empty, pairwise distinct fixed text (blocked: prefix only)", () => {
    const vals = (Object.keys(BANNER_TEXT) as WallMode[]).map((m) => BANNER_TEXT[m]);
    expect(vals).toHaveLength(9);
    vals.forEach((v) => expect(v.length).toBeGreaterThan(0));
    expect(new Set(vals).size).toBe(9);
  });
});
