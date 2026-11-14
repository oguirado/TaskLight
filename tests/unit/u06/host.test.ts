import { describe, expect, it, vi } from "vitest";
import { createHybrid } from "../../../src/ai/hybrid";
import { HostForbiddenError } from "../../../src/ai/types";
import { makeFake, OK_ORIGIN } from "./harness";

vi.mock("../../../src/schema", () => import("./schemaMock"));

describe("O13 host guard (B1, DISP_01)", () => {
  it("chrome-extension origin throws HostForbiddenError before touching the factory", () => {
    const fake = makeFake();
    expect(() => createHybrid({ factory: fake, origin: "chrome-extension://abc", appCheckReady: true })).toThrow(HostForbiddenError);
    expect(fake.createdParams).toHaveLength(0);
    expect(fake.modeConstCalls).toBe(0);
  });
  it("appCheckReady false throws HostForbiddenError before touching the factory", () => {
    const fake = makeFake();
    expect(() => createHybrid({ factory: fake, origin: OK_ORIGIN, appCheckReady: false })).toThrow(HostForbiddenError);
    expect(fake.createdParams).toHaveLength(0);
    expect(fake.modeConstCalls).toBe(0);
  });
  it("appCheckReady must be strictly true (truthy non-booleans and undefined are refused)", () => {
    for (const bad of [1, "true", undefined, null]) {
      const fake = makeFake();
      expect(() => createHybrid({ factory: fake, origin: OK_ORIGIN, appCheckReady: bad as never })).toThrow(HostForbiddenError);
      expect(fake.createdParams).toHaveLength(0);
    }
  });
  it("both violations together still throw HostForbiddenError (an Error subclass)", () => {
    const fake = makeFake();
    try { createHybrid({ factory: fake, origin: "chrome-extension://zzz", appCheckReady: false }); expect.unreachable(); }
    catch (e) { expect(e).toBeInstanceOf(HostForbiddenError); expect(e).toBeInstanceOf(Error); }
  });
  it("a Hosting-page https origin and localhost http origin are allowed and build 5 instances", () => {
    for (const origin of [OK_ORIGIN, "http://localhost:5000"]) {
      const fake = makeFake();
      expect(() => createHybrid({ factory: fake, origin, appCheckReady: true })).not.toThrow();
      expect(fake.createdParams).toHaveLength(5);
    }
  });
});
