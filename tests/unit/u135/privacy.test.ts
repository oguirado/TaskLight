import { describe, expect, it } from "vitest";
import type { HybridParamsShape } from "../../../src/ai/types";
import { boot, CLOUD, MODES, deferred, response, item, input, vm, run, flush,
  rules, params, onlyDevice, registryTrace, FakeClock } from "./fixtures";
import type { SdkResult } from "./fixtures";
import { TIMEOUTS_MS } from "../../../src/providers/types";

describe("A2 privacy and fail-closed stop rules", () => {
  it.each(["firebase-hybrid", "firebase-ondevice"])("A2 private demo resolves %s to ondevice before SDK invocation", async providerId => {
    const r = boot();
    const snapshot = await run(r, input({ vm: vm(undefined, "demo"), policyRoom: "demo", tier: "private",
      binding: { providerId, generation: 1 } }));
    expect(snapshot).toMatchObject({ kind: "generated", source: "ON_DEVICE" });
    onlyDevice(params(r));
    expect(registryTrace.requests[0]).toMatchObject({ task: "liaison", tier: "private", room: "demo" });
    const local = registryTrace.registries[0]!;
    expect(local.resolve("liaison" as Parameters<typeof local.resolve>[0], "private").primary).toBe("firebase-ondevice");
    expect(registryTrace.deps.every(d => d.transport === undefined)).toBe(true);
  });

  it("A2 unavailable private device settles as rules without a cloud retry", async () => {
    const r = boot(() => Promise.reject(new Error("ON_DEVICE_UNAVAILABLE")));
    const snapshot = await run(r, input({ vm: vm(undefined, "demo"), policyRoom: "demo", tier: "private" }));
    rules(snapshot); expect(snapshot.reason).toBeTruthy();
    expect(r.generate).toHaveBeenCalledTimes(1);
    for (const [p] of r.create.mock.calls) onlyDevice(p);
  });

  it.each([
    { name: "private", tier: "private" as const, cloudAllowed: true, providerId: "firebase-hybrid" },
    { name: "cloud disabled", tier: "standard" as const, cloudAllowed: false, providerId: "firebase-hybrid" },
    { name: "explicit ondevice", tier: "standard" as const, cloudAllowed: true, providerId: "firebase-ondevice" },
  ])("A2 rejects rogue IN_CLOUD for $name, without transient generated publication", async options => {
    const r = boot(() => response({ items: [item()] }, CLOUD)); const seen: string[] = [];
    r.controller.subscribe(() => seen.push(r.controller.snapshot().kind));
    const snapshot = await run(r, input({ tier: options.tier, cloudAllowed: options.cloudAllowed,
      binding: { providerId: options.providerId, generation: 1 } }));
    rules(snapshot, "BLOCKED"); onlyDevice(params(r));
    expect(seen).not.toContain("generated"); expect(r.generate).toHaveBeenCalledTimes(1);
  });

  it.each(["standard", "shared"] as const)("C.M3 cloudAllowed false forbids fallback for %s", async tier => {
    const r = boot(); await run(r, input({ tier, cloudAllowed: false }));
    onlyDevice(params(r));
    expect(registryTrace.deps.some(d => d.gates?.killSwitchCloud === true) ||
      registryTrace.gateUpdates.some(g => g.killSwitchCloud === true)).toBe(true);
  });

  it.each(["firebase-cloud", "local-test", "remote-test", "unknown-provider"])("C.M3 unsupported binding %s is BLOCKED pre-call", async providerId => {
    const r = boot();
    rules(await run(r, input({ binding: { providerId, generation: 1 } })), "BLOCKED");
    expect(r.create).not.toHaveBeenCalled(); expect(r.generate).not.toHaveBeenCalled();
  });

  it.each([
    ["policyRoom", null], ["policyRoom", undefined], ["tier", null], ["tier", undefined],
    ["head", null], ["head", undefined], ["cloudAllowed", null], ["cloudAllowed", undefined],
  ] as const)("C.M1 missing %s=%s permits only rules", async (field, value) => {
    const r = boot(); const context = input({ [field]: value });
    rules(await run(r, context));
    expect(r.create).not.toHaveBeenCalled(); expect(r.generate).not.toHaveBeenCalled();
  });

  it("C.M1 mismatched room is BLOCKED and never reaches SDK", async () => {
    const r = boot(); rules(await run(r, input({ policyRoom: "other-room" })), "BLOCKED");
    expect(r.generate).not.toHaveBeenCalled();
  });

  it("C.M1 missing private policy is BLOCKED", async () => {
    const r = boot(); rules(await run(r, input({ tier: "private", policyRoom: null })), "BLOCKED");
    expect(r.generate).not.toHaveBeenCalled();
  });

  it("C.M1 head zero and cloudAllowed false are present values, not missing gates", async () => {
    const r = boot(); const snapshot = await run(r, input({ head: 0, cloudAllowed: false }));
    expect(snapshot.kind).toBe("generated"); onlyDevice(params(r));
  });

  it("M7 unresolved SDK promise is bounded by the injected clock", async () => {
    const pending = deferred<SdkResult>(); const r = boot(() => pending.promise);
    r.controller.update(input()); await flush(r);
    r.clock.advance(TIMEOUTS_MS.ceiling + 1); await flush(r);
    const snapshot = r.controller.snapshot(); rules(snapshot);
    expect(["TIMEOUT", "FIREBASE_FAILED"]).toContain(snapshot.reason);
    const before = { ...snapshot };
    pending.resolve(response()); await flush(r);
    expect(r.controller.snapshot()).toEqual(before);
    expect(r.clock).toBeInstanceOf(FakeClock);
  });

  it("M3 negative control rejects cloud-enabled parameters with the same privacy assertion", async () => {
    const r = boot(); await run(r, input({ tier: "private" }));
    onlyDevice(params(r));
    const unsafe = { ...params(r), mode: MODES.PREFER_ON_DEVICE,
      inCloudParams: { model: "gemini-4-hydrogen", generationConfig: {
        maxOutputTokens: 200, responseMimeType: "application/json", responseSchema: {},
      } } } as HybridParamsShape;
    expect(() => onlyDevice(unsafe)).toThrow();
  });
});
