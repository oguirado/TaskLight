// U162 (persona v5 finding): the Wall plan band showed 17% while Swarm and MCP showed 16% for 1 of 6
// microtasks. The band must use the same truncation as the plan rollup (bridge/plan/fold.py int(), reducer intPct).
import { describe, expect, it } from "vitest";
import { computeProgressPct } from "../../../src/views/plan";

describe("U162 Wall progress agrees with the plan rollup", () => {
  it("1 of 6 microtasks reads 16%, as MCP plan_get reports", () => {
    expect(computeProgressPct(1, 6)).toBe(16);
  });
  it("matches truncation for every done/total pair up to 12", () => {
    for (let t = 1; t <= 12; t++) for (let d = 0; d <= t; d++) {
      expect(computeProgressPct(d, t), `${d}/${t}`).toBe(Math.trunc((d / t) * 100));
    }
  });
  it("never shows 100% before every microtask is done", () => {
    expect(computeProgressPct(199, 200)).toBe(99);
  });
});
