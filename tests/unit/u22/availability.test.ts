import { afterEach, describe, expect, it, vi } from "vitest";
import { probeAvailability } from "../../../src/app/availability";

const g = globalThis as Record<string, unknown>;
afterEach(() => { delete g["LanguageModel"]; });
const withLM = (availability: () => unknown) => {
  const create = vi.fn(); g["LanguageModel"] = { availability, create }; return create;
};

describe("B25 probeAvailability", () => {
  it.each(["available", "downloadable", "unavailable"] as const)("maps %s", async (v) => {
    withLM(() => Promise.resolve(v));
    expect(await probeAvailability()).toBe(v);
  });
  it("unrecognised value -> unknown", async () => { withLM(() => Promise.resolve("weird")); expect(await probeAvailability()).toBe("unknown"); });
  it("rejection -> unknown", async () => { withLM(() => Promise.reject(new Error("x"))); expect(await probeAvailability()).toBe("unknown"); });
  it("synchronous throw -> unknown", async () => { withLM(() => { throw new Error("x"); }); expect(await probeAvailability()).toBe("unknown"); });
  it("API absent (no LanguageModel global) -> unavailable, not a throw", async () => { expect(await probeAvailability()).toBe("unavailable"); });
  it("never calls create() (probe is free; S4 measured availability only)", async () => {
    const create = withLM(() => Promise.resolve("available")); await probeAvailability();
    expect(create).not.toHaveBeenCalled();
  });
});
