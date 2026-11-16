import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlanPortResolver, createPlanWiring } from "../../../src/app/plan_wiring";
import { createPlanAi } from "../../../src/planai/reviewer";
import type { ModeName, ModelFactory } from "../../../src/ai/types";
import type { ModelServices } from "../../../src/app/model_services";
import { harness, task } from "./helpers";
afterEach(() => vi.restoreAllMocks());
const signal = () => new AbortController().signal;
describe("U64 provider boundary", () => {
  it("A2 services win over factory and the binding preserves standard permission", () => {
    const h = harness(); const factory = {} as ModelFactory;
    h.deps = { ...h.deps, getDriftFactory: () => factory };
    const resolve = createPlanPortResolver(h.deps); const result = resolve("PREFER_ON_DEVICE");
    expect(result).toEqual({ port: h.port, allowExternal: true });
    expect(h.driftPortFor).toHaveBeenCalledWith("PREFER_ON_DEVICE"); expect(h.deps.driftPortFromFactory).not.toHaveBeenCalled();
  });
  it("A2 lazy resolver observes services becoming available after construction", () => {
    const h = harness(); let services: ModelServices | null = null;
    const resolve = createPlanPortResolver({ ...h.deps, getServices: () => services });
    expect(h.driftPortFor).not.toHaveBeenCalled(); services = { driftPortFor: h.driftPortFor } as unknown as ModelServices;
    expect(resolve("PREFER_ON_DEVICE").allowExternal).toBe(true); expect(h.driftPortFor).toHaveBeenCalledOnce();
  });
  it("A2 legacy factory fallback has explicit external denial", () => {
    const h = harness(); const factory = {} as ModelFactory;
    const resolve = createPlanPortResolver({ ...h.deps, getServices: () => null, getDriftFactory: () => factory });
    expect(resolve("PREFER_ON_DEVICE")).toEqual({ port: h.port, allowExternal: false });
    expect(h.deps.driftPortFromFactory).toHaveBeenCalledWith(factory, "PREFER_ON_DEVICE");
  });
  it("A2 unavailable providers produce deterministic rules fallback", async () => {
    const h = harness(); const resolve = createPlanPortResolver({ ...h.deps, getServices: () => null });
    const binding = resolve("PREFER_ON_DEVICE"); expect(binding.allowExternal).toBe(false);
    const ai = createPlanAi({ port: () => binding, clock: h.clock });
    expect((await ai.reviewTask(task())).source).toBe("rules"); expect(h.generate).not.toHaveBeenCalled();
  });
  it("A4 device mode denies external even when a hostile service grants it", () => {
    const h = harness(); h.driftPortFor.mockReturnValue({ port: h.port, allowExternal: true });
    const resolve = createPlanPortResolver(h.deps);
    expect(resolve("ONLY_ON_DEVICE").allowExternal).toBe(false);
    expect(h.driftPortFor).toHaveBeenCalledWith("ONLY_ON_DEVICE");
  });
  it.each(["PREFER_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD"] as ModeName[])("A4 kill switch rejects %s without obtaining a provider", async mode => {
    const h = harness(); const resolve = createPlanPortResolver({ ...h.deps, getKillSwitchCloud: () => true });
    const binding = resolve(mode); expect(binding.allowExternal).toBe(false);
    await expect(binding.port.generate("private", {}, signal())).rejects.toBeDefined();
    expect(h.driftPortFor).not.toHaveBeenCalled(); expect(h.generate).not.toHaveBeenCalled(); expect(h.deps.driftPortFromFactory).not.toHaveBeenCalled();
  });
  it.each(["service", "factory", "adapter", "getter"])("A8 %s throws become a failing binding rather than escape", async fault => {
    const h = harness(); const fail = (): never => { throw new Error("provider failed"); };
    if (fault === "service") h.driftPortFor.mockImplementation(fail);
    if (fault === "factory") h.deps = { ...h.deps, getServices: () => null, getDriftFactory: () => ({} as ModelFactory), driftPortFromFactory: fail };
    if (fault === "adapter") h.deps = { ...h.deps, adaptDriftPort: fail };
    if (fault === "getter") h.deps = { ...h.deps, getServices: fail };
    const resolve = createPlanPortResolver(h.deps); const binding = resolve("PREFER_ON_DEVICE");
    expect(binding.allowExternal).toBe(false); await expect(binding.port.generate("input", {}, signal())).rejects.toBeDefined();
  });
  it("A8 rejected generation is contained by wiring and rules fallback", async () => {
    const h = harness(); h.generate.mockRejectedValue(new Error("provider rejected"));
    h.deps = { ...h.deps, createPlanAi: opts => createPlanAi(opts) };
    const w = createPlanWiring(h.deps);
    try { expect(() => w.notifyChange()).not.toThrow(); await h.advance(); expect(w.taskVerdicts().get("room:T01")?.source).toBe("rules"); }
    finally { w.dispose(); }
  });
});
