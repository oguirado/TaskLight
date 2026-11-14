import { describe, expect, it, vi } from "vitest";
import { createHybrid } from "../../../src/ai/hybrid";
import type { AiConfig } from "../../../src/ai/types";
import { makeFake, OK_ORIGIN, req, TASKS } from "./harness";

vi.mock("../../../src/schema", () => import("./schemaMock"));

const mk = (config: Partial<AiConfig> = {}) => {
  const fake = makeFake();
  const h = createHybrid({ factory: fake, origin: OK_ORIGIN, appCheckReady: true, config });
  return { fake, h };
};
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("initializeDeviceModel only after an explicit gesture call (B12)", () => {
  it("never initialises on createHybrid, run, deviceStatus or applyConfig while not ready", async () => {
    const { fake, h } = mk({ mode_summary: "ONLY_ON_DEVICE" });
    expect(h.deviceStatus()).toEqual({ state: "not_initialised" });
    await h.run(req("summary"));
    await h.run(req("status"));
    h.applyConfig({ max_output_tokens: 150 });
    await flush();
    expect(fake.handles.every((x) => x.inits === 0)).toBe(true);
    expect(h.deviceStatus()).toEqual({ state: "not_initialised" });
  });

  it("initDevice calls initializeDeviceModel on all five instances synchronously (no await in between), then awaits all", async () => {
    const { fake, h } = mk();
    fake.initMode = "manual";
    const p = h.initDevice();
    expect(fake.initLog).toHaveLength(5); // observed before any microtask turn
    expect([...fake.initLog].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(fake.handles.map((x) => x.task).sort()).toEqual([...TASKS].sort());
    let settled = false;
    void p.then(() => { settled = true; });
    fake.initResolves.slice(0, 4).forEach((r) => r());
    await flush();
    expect(settled).toBe(false); // waits for ALL five
    fake.initResolves[4]!();
    await expect(p).resolves.toEqual({ state: "ready" });
    expect(h.deviceStatus()).toEqual({ state: "ready" });
  });

  it("status is 'downloading' with the minimum progress across instances while pending; ready afterwards", async () => {
    const { fake, h } = mk();
    fake.initMode = "manual";
    const seen: number[] = [];
    const p = h.initDevice((x) => seen.push(x));
    const prog = [0.9, 0.5, 0.7, 1, 0.6];
    fake.handles.forEach((hd, i) => hd.initCb?.(prog[i]!));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeCloseTo(0.5, 5);
    for (const v of seen) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    const st = h.deviceStatus();
    expect(st.state).toBe("downloading");
    if (st.state === "downloading") expect(st.progress).toBeCloseTo(0.5, 5);
    fake.handles.forEach((hd) => hd.initCb?.(1));
    expect(seen[seen.length - 1]).toBeCloseTo(1, 5);
    fake.initResolves.forEach((r) => r());
    await p;
    expect(h.deviceStatus()).toEqual({ state: "ready" });
  });

  it("any rejection sets status failed (with detail) and initDevice resolves with it", async () => {
    const { fake, h } = mk();
    fake.initFail = (hd) => hd.task === "digest";
    const st = await h.initDevice();
    expect(st.state).toBe("failed");
    if (st.state === "failed") expect(st.detail).toContain("init failed");
    expect(h.deviceStatus().state).toBe("failed");
  });

  it("a failed or not-initialised device keeps ONLY_ON_DEVICE requests blocked (no SDK call)", async () => {
    const { fake, h } = mk({ mode_status: "ONLY_ON_DEVICE" });
    fake.initFail = () => true;
    await h.initDevice();
    const r = await h.run(req("status"));
    expect(!r.ok && r.code).toBe("DEVICE_NOT_INITIALISED");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("applyConfig rebuild interplay with device state (B3, B12)", () => {
  it("when ready: re-calls initializeDeviceModel on the five NEW instances; status stays ready", async () => {
    const { fake, h } = mk();
    await h.initDevice();
    const before = fake.handles.length;
    h.applyConfig({ max_output_tokens: 99 });
    expect(fake.handles).toHaveLength(before + 5);
    const fresh = fake.handles.slice(before);
    expect(fresh.every((x) => x.inits === 1)).toBe(true);
    expect(fake.handles.slice(0, before).every((x) => x.inits === 1)).toBe(true); // old ones not re-inited
    await flush();
    expect(h.deviceStatus()).toEqual({ state: "ready" });
  });

  it("a rejection of the re-init sets needs_gesture (not failed)", async () => {
    const { fake, h } = mk();
    await h.initDevice();
    fake.initFail = () => true;
    h.applyConfig({ max_output_tokens: 99 });
    await flush(); await flush();
    expect(h.deviceStatus()).toEqual({ state: "needs_gesture" });
  });

  it("when not ready: applyConfig rebuilds but does not initialise anything", async () => {
    const { fake, h } = mk();
    h.applyConfig({ max_output_tokens: 99 });
    await flush();
    expect(fake.handles).toHaveLength(10);
    expect(fake.handles.every((x) => x.inits === 0)).toBe(true);
  });

  it("after needs_gesture an explicit initDevice call can bring the device back to ready", async () => {
    const { fake, h } = mk();
    await h.initDevice();
    fake.initFail = () => true;
    h.applyConfig({ max_output_tokens: 99 });
    await flush(); await flush();
    expect(h.deviceStatus()).toEqual({ state: "needs_gesture" });
    fake.initFail = () => false;
    await expect(h.initDevice()).resolves.toEqual({ state: "ready" });
  });
});
