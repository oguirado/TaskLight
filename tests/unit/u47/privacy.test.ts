// Acceptance 4, 5, 6: private/shared never reach a remote provider; screenshot never leaves Firebase on-device.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetPolicy } from "./policyRef";
import { ALL_ON, CALL_TASKS, LOC, LOCP, REM, failResult, world } from "./fixtures";
import type { WorldOpts } from "./fixtures";
import type { CallTask, ProviderGates } from "../../../src/providers";
import type { PrivacyTier } from "../../../src/schema";

vi.mock("../../../src/privacy/policy", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  const ref = await import("./policyRef");
  return { ...orig, assertProviderAllowed: ref.policyProxy };
});
beforeEach(() => { resetPolicy(); });

const GATES: (ProviderGates | null)[] = [];
for (const e of [true, false]) for (const r of [true, false]) for (const k of [true, false]) GATES.push({ externalEnabled: e, remoteEnabled: r, killSwitchCloud: k });
GATES.push(null, {});
const GROUP: Record<string, "capsule" | "digest" | "routing" | "drift"> = { status: "capsule", summary: "capsule", next_action: "capsule", plan: "capsule", digest: "digest", route: "routing", drift: "drift" };
const CANDIDATES = ["loc", "locp", "rem", "firebase-cloud", "firebase-hybrid", "firebase-ondevice", "ghost"];
const EPS = [LOC, LOCP, REM];

function selections(task: CallTask, id: string): WorldOpts["selection"][] {
  const g = GROUP[task];
  return [{ all: id }, ...(g ? [{ groups: { [g]: id } }] : [])];
}

describe.each(["private", "shared"] as PrivacyTier[])("%s tier never reaches a remote provider (acceptance 4/5)", (tier) => {
  it.each(CALL_TASKS)("%s: sweep over every gate combination x candidate x selection form", async (task) => {
    let worlds = 0;
    for (const gates of GATES) for (const id of CANDIDATES) for (const selection of selections(task, id)) {
      const w = await world({ endpoints: EPS, gates, ...(selection ? { selection } : {}) });
      const r = await w.call(task, tier);
      worlds++;
      const tag = `${task}/${tier}/${JSON.stringify(gates)}/${id}/${JSON.stringify(selection)}`;
      expect(w.tr.callsFor("rem").length, `remote called: ${tag}`).toBe(0);
      if (tier === "private") {
        expect(w.tr.callsFor("loc").length, `local without allow_private called: ${tag}`).toBe(0);
        expect(w.hybrid.runs.length, `cloud-capable default used for private: ${tag}`).toBe(0);
        expect(w.overlays.cloud?.runs.length ?? 0, `cloud overlay used for private: ${tag}`).toBe(0);
      }
      if (task === "screenshot") expect(w.tr.genCalls.length, `transport used for screenshot: ${tag}`).toBe(0);
      expect(r.ok, `terminal must still answer: ${tag}`).toBe(true);
    }
    expect(worlds).toBeGreaterThan(50);
  });
  it("non-vacuity: the same sweep fixture does reach the allowed endpoints", async () => {
    const wl = await world({ endpoints: EPS, selection: { all: "locp" } });
    await wl.call("summary", tier);
    expect(wl.tr.callsFor("locp")).toHaveLength(1);
    const ws = await world({ endpoints: EPS, selection: { all: "rem" } });
    await ws.call("summary", "standard");
    expect(ws.tr.callsFor("rem")).toHaveLength(1);
  });
  it("the terminal for this tier answered: " + tier, async () => {
    const w = await world({ endpoints: EPS, selection: { all: "rem" } });
    const r = await w.call("summary", tier);
    expect(r).toMatchObject({ ok: true, fallback: true });
    if (tier === "private") expect(r).toMatchObject({ providerId: "firebase-ondevice", source: "ON_DEVICE" });
    else expect(r).toMatchObject({ providerId: "firebase-hybrid" });
  });
});

describe("local endpoint without allow_private is never called for private; allowed for standard/shared", () => {
  it("private x (loc) -> zero; standard/shared x (loc) -> one", async () => {
    for (const tier of ["private", "standard", "shared"] as PrivacyTier[]) {
      const w = await world({ endpoints: [LOC], selection: { all: "loc" } });
      await w.call("summary", tier);
      expect(w.tr.callsFor("loc")).toHaveLength(tier === "private" ? 0 : 1);
    }
  });
});

describe("screenshot never leaves Firebase on-device (acceptance 6)", () => {
  it.each(["private", "standard", "shared"] as PrivacyTier[])("tier %s: any selection, any gate -> zero transport, only the on-device overlay runs", async (tier) => {
    for (const gates of GATES) for (const id of CANDIDATES) for (const selection of [{ all: id }, { groups: { capsule: id, digest: id, routing: id, drift: id } }]) {
      const w = await world({ endpoints: EPS, gates, selection });
      const r = await w.call("screenshot", tier);
      const tag = `${tier}/${JSON.stringify(gates)}/${id}`;
      expect(w.tr.genCalls.length, tag).toBe(0);
      expect(w.hybrid.runs.length, tag).toBe(0);
      expect(w.overlays.cloud, tag).toBeUndefined();
      expect(w.overlays.ondevice?.runs.length, tag).toBe(1);
      expect(w.overlays.ondevice?.runs[0]?.task).toBe("screenshot");
      expect(r, tag).toMatchObject({ ok: true, source: "ON_DEVICE", providerId: "firebase-ondevice" });
    }
  });
  it("screenshot failing on-device has no hop at all (no cloud-capable instance, no transport)", async () => {
    const w = await world({ endpoints: EPS, selection: { all: "rem" }, ondevice: () => failResult("screenshot", "ON_DEVICE_UNAVAILABLE") });
    const r = await w.call("screenshot", "standard");
    expect(r.ok).toBe(false);
    expect(w.log.filter((l) => l.startsWith("hybrid:") || l.startsWith("transport:generate"))).toEqual(["hybrid:ondevice:screenshot"]);
  });
  it("resolve(screenshot) is on-device for any selection/tier, gates ignored", async () => {
    for (const gates of GATES) {
      const w = await world({ endpoints: EPS, gates, selection: { all: "rem" } });
      for (const tier of ["private", "standard", "shared"] as PrivacyTier[]) expect(w.reg.resolve("screenshot", tier)).toMatchObject({ primary: "firebase-ondevice", hop: null });
    }
  });
});

describe("gates default closed", () => {
  it("ALL_ON is the only gate set under which a remote is reachable (standard)", async () => {
    const reached: string[] = [];
    for (const gates of GATES) {
      const w = await world({ endpoints: [REM], selection: { all: "rem" }, gates });
      await w.call("summary", "standard");
      if (w.tr.callsFor("rem").length > 0) reached.push(JSON.stringify(gates));
    }
    expect(reached.length).toBeGreaterThan(0);
    for (const g of reached) expect(JSON.parse(g)).toMatchObject({ externalEnabled: true, remoteEnabled: true });
    expect(reached).toContain(JSON.stringify(ALL_ON));
  });
});
