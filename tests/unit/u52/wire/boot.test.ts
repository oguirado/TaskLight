import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot, onUserActivation, resetBootStateForTests } from "../../../../src/app/boot";
import type { HybridPort } from "../../../../src/app/types";
import { env, fakes } from "../../u22/harness";
import { deferred, factory, services, settled, flush } from "./fixtures";

beforeEach(() => { vi.useFakeTimers(); resetBootStateForTests(); });
afterEach(() => { resetBootStateForTests(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function download() {
  const done = deferred<void>(); const progress = new Set<(n: number) => void>(); const sdk = factory();
  sdk.init.mockImplementation(p => { if (p) progress.add(p); return done.promise; });
  const w = services({ factory: sdk.f }); const f = fakes({ user: { uid: "u52", isAnonymous: true } });
  const hy: HybridPort = {
    create: () => undefined,
    async initializeDeviceModel(onProgress) {
      for (;;) {
        const st = await w.service.registry.initDevice(onProgress);
        if (st.state === "ready") return;
        if (st.state !== "downloading") throw new Error(`device ${st.state}`);
      }
    },
  };
  expect((await settled(boot(env(), f.fb, hy, f.onState))).kind).toBe("ready");
  const activation = onUserActivation(true); await flush();
  const advance = async (ms: number) => { await w.clock.advance(ms); await vi.advanceTimersByTimeAsync(ms); await flush(); };
  return { ...w, f, done, activation, advance, progress(n: number) { for (const cb of progress) cb(n); } };
}

describe("W9 device-model inactivity bound through registry initialization", () => {
  it("W9 progress every 30s for 5min then ready becomes initialized", async () => {
    const w = await download();
    for (let i = 1; i <= 10; i++) {
      await w.advance(30_000); w.progress(i / 11); await flush();
      expect(w.f.states.at(-1)).toMatchObject({ kind: "ready", deviceModel: "initializing" });
    }
    w.done.resolve(); await flush(); await settled(w.activation);
    expect(w.f.states.at(-1)).toMatchObject({ kind: "ready", deviceModel: "initialized" }); w.service.dispose();
  });
  it("W9 no progress remains initializing at 59999ms then failed at 60000ms", async () => {
    const w = await download(); await w.advance(59_999);
    expect(w.f.states.some(s => "deviceModel" in s && s.deviceModel === "failed")).toBe(false);
    await w.advance(1); await settled(w.activation);
    expect(w.f.states.at(-1)).toMatchObject({ kind: "ready", deviceModel: "failed" });
    w.done.resolve(); await flush(); w.service.dispose();
  });
  it("W9 even repeated equal progress re-arms inactivity; silence then fails", async () => {
    const w = await download();
    for (let i = 0; i < 4; i++) { await w.advance(30_000); w.progress(0.25); await flush(); }
    expect(w.f.states.at(-1)).toMatchObject({ deviceModel: "initializing" });
    await w.advance(59_999); expect(w.f.states.at(-1)).toMatchObject({ deviceModel: "initializing" });
    await w.advance(1); await settled(w.activation);
    expect(w.f.states.at(-1)).toMatchObject({ deviceModel: "failed" });
    w.done.resolve(); await flush(); w.service.dispose();
  });
  it.each(["initialized", "failed"] as const)("W9 late progress after %s is ignored", async terminal => {
    const w = await download();
    if (terminal === "initialized") { w.progress(0.3); w.done.resolve(); await flush(); }
    else await w.advance(60_000);
    await settled(w.activation);
    expect(w.f.states.at(-1)).toMatchObject({ deviceModel: terminal });
    const states = structuredClone(w.f.states); w.progress(0.9); await flush();
    expect(w.f.states).toEqual(states); w.done.resolve(); await flush(); w.service.dispose();
  });
});
