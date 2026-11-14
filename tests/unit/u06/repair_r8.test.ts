import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHybrid } from "../../../src/ai/hybrid";
import { makeFake, OK_ORIGIN, req } from "./harness";

vi.mock("../../../src/schema", () => import("./schemaMock"));

// r8: an initialisation rejection must set the status immediately, not after every sibling settles.
const mk = () => {
  const fake = makeFake();
  const h = createHybrid({ factory: fake, origin: OK_ORIGIN, appCheckReady: true, config: {} });
  return { fake, h };
};
const tick = () => vi.advanceTimersByTimeAsync(1000);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("r8 explicit initDevice: failed without waiting for siblings", () => {
  for (const idx of [0, 1, 4]) {
    it(`rejection of handle ${idx} with 4 never-settling siblings -> failed`, async () => {
      const { fake, h } = mk();
      fake.initMode = "manual";
      void h.initDevice();
      fake.initRejects[idx]!(new Error("device unavailable"));
      await tick();
      const st = h.deviceStatus();
      expect(st.state).toBe("failed");
      if (st.state === "failed") expect(st.detail).toContain("device unavailable");
    });
  }

  it("rejection + one never-settling sibling + others resolved -> failed", async () => {
    const { fake, h } = mk();
    fake.initMode = "manual";
    void h.initDevice();
    fake.initRejects[0]!(new Error("device unavailable"));
    [2, 3, 4].forEach((i) => fake.initResolves[i]!());
    await tick();
    expect(h.deviceStatus().state).toBe("failed");
  });

  it("late settlement of siblings does not revert failed; ONLY_ON_DEVICE stays blocked", async () => {
    const { fake, h } = mk();
    fake.initMode = "manual";
    const p = h.initDevice();
    fake.initRejects[1]!(new Error("boom"));
    await tick();
    fake.initResolves.forEach((r) => r());
    await tick();
    expect(h.deviceStatus().state).toBe("failed");
    await expect(p).resolves.toMatchObject({ state: "failed" });
  });

  it("a later initDevice after a prompt failure can still reach ready", async () => {
    const { fake, h } = mk();
    fake.initMode = "manual";
    void h.initDevice();
    fake.initRejects[0]!(new Error("boom"));
    await tick();
    expect(h.deviceStatus().state).toBe("failed");
    fake.initMode = "auto";
    await expect(h.initDevice()).resolves.toEqual({ state: "ready" });
    expect(h.deviceStatus()).toEqual({ state: "ready" });
  });

  it("a stale attempt's late rejection does not override a newer attempt", async () => {
    const { fake, h } = mk();
    fake.initMode = "manual";
    void h.initDevice();
    const staleRejects = [...fake.initRejects];
    fake.initMode = "auto";
    const p2 = h.initDevice();
    await expect(p2).resolves.toEqual({ state: "ready" });
    staleRejects[0]!(new Error("stale"));
    await tick();
    expect(h.deviceStatus()).toEqual({ state: "ready" });
  });

  it("success still waits for every handle", async () => {
    const { fake, h } = mk();
    fake.initMode = "manual";
    void h.initDevice();
    fake.initResolves.slice(0, 4).forEach((r) => r());
    await tick();
    expect(h.deviceStatus().state).toBe("downloading");
    fake.initResolves[4]!();
    await tick();
    expect(h.deviceStatus()).toEqual({ state: "ready" });
  });

  it("failed state blocks ONLY_ON_DEVICE without SDK call while a sibling never settles", async () => {
    const fake = makeFake();
    const h = createHybrid({ factory: fake, origin: OK_ORIGIN, appCheckReady: true, config: { mode_status: "ONLY_ON_DEVICE" } });
    fake.initMode = "manual";
    void h.initDevice();
    fake.initRejects[0]!(new Error("boom"));
    await tick();
    const r = await h.run(req("status"));
    expect(!r.ok && r.code).toBe("DEVICE_NOT_INITIALISED");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("r8 automatic reinit after applyConfig: needs_gesture without waiting for siblings", () => {
  const ready = async () => {
    const t = mk();
    await t.h.initDevice(); // auto mode, resolves
    expect(t.h.deviceStatus()).toEqual({ state: "ready" });
    t.fake.initMode = "manual";
    return t;
  };

  for (const idx of [0, 2, 4]) {
    it(`rejection of replacement ${idx} with never-settling siblings -> needs_gesture`, async () => {
      const { fake, h } = await ready();
      h.applyConfig({ max_output_tokens: 99 });
      expect(fake.initRejects).toHaveLength(5);
      expect(h.deviceStatus().state).toBe("downloading");
      fake.initRejects[idx]!(new Error("device unavailable"));
      await tick();
      expect(h.deviceStatus()).toEqual({ state: "needs_gesture" });
    });
  }

  it("rejection + others resolved + one never-settling -> needs_gesture", async () => {
    const { fake, h } = await ready();
    h.applyConfig({ max_output_tokens: 99 });
    fake.initRejects[1]!(new Error("x"));
    [0, 2, 3].forEach((i) => fake.initResolves[i]!());
    await tick();
    expect(h.deviceStatus()).toEqual({ state: "needs_gesture" });
  });

  it("late sibling resolution does not flip needs_gesture to ready", async () => {
    const { fake, h } = await ready();
    h.applyConfig({ max_output_tokens: 99 });
    fake.initRejects[3]!(new Error("x"));
    await tick();
    fake.initResolves.forEach((r) => r());
    await tick();
    expect(h.deviceStatus()).toEqual({ state: "needs_gesture" });
  });

  it("a second applyConfig supersedes: stale rejection of the first replacement set is ignored", async () => {
    const { fake, h } = await ready();
    h.applyConfig({ max_output_tokens: 99 });
    const firstRejects = [...fake.initRejects];
    fake.initMode = "auto";
    h.applyConfig({ max_output_tokens: 98 });
    await tick();
    expect(h.deviceStatus()).toEqual({ state: "ready" });
    firstRejects[0]!(new Error("stale"));
    await tick();
    expect(h.deviceStatus()).toEqual({ state: "ready" });
  });

  it("success of all replacements still yields ready only after every handle", async () => {
    const { fake, h } = await ready();
    h.applyConfig({ max_output_tokens: 99 });
    fake.initResolves.slice(0, 4).forEach((r) => r());
    await tick();
    expect(h.deviceStatus().state).toBe("downloading");
    fake.initResolves[4]!();
    await tick();
    expect(h.deviceStatus()).toEqual({ state: "ready" });
  });
});
