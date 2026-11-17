// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { admission, comparable, finalStatus, timingStatus } from "./soak-policy";
import type { ComparisonRun } from "./soak-policy";
import { SOAK_COUNT, SOAK_SEED, soakHistory } from "./soak-fixture";

describe("U123 hardening: frozen fixture and fail-closed stop rules", () => {
  it("wall-history-soak freezes the 100000-event seed, fixture hash and mixed operation categories", () => {
    const digest = createHash("sha256"); let count = 0, semantic = 0, nonops = 0, beats = 0;
    const runs = new Set<unknown>();
    for (const e of soakHistory()) {
      count++; digest.update(JSON.stringify(e) + "\n");
      if (e.act !== "op") nonops++;
      else if (e.op?.["kind"] === "activity.beat") { beats++; runs.add(e.op["run_id"]); }
      else semantic++;
    }
    expect(count).toBe(100_000); expect(SOAK_COUNT).toBe(count); expect(SOAK_SEED).toBe(19095277);
    expect(digest.digest("hex")).toBe("f2781bacb8ea18a7ede6c70a402c466e439a1a8e6ba3ba0de79c7951b6545918");
    expect(semantic).toBe(9); expect(beats).toBe(780); expect(nonops).toBe(99_211); expect(runs.size).toBeGreaterThan(1);
  });
  it.each([18, 18.01, NaN, Infinity, -1])("wall-history-soak refuses timing at unsafe or missing load5=%s", load => {
    expect(admission(load, true)).toMatch(/^INCONCLUSIVE: quiet-window/);
  });
  it("wall-history-soak requires explicit GC and admits a quiet measurement only with GC", () => {
    expect(admission(17.99, false)).toMatch(/^INCONCLUSIVE: explicit GC/);
    expect(admission(17.99, true)).toBeUndefined();
  });
  it("wall-history-soak marks missing or contaminated timing INCONCLUSIVE", () => {
    expect(timingStatus([])).toBe("INCONCLUSIVE");
    expect(timingStatus([1, 17, 18, 1])).toBe("INCONCLUSIVE");
    expect(timingStatus([1, NaN])).toBe("INCONCLUSIVE");
    expect(timingStatus([0, 17.99, 1])).toBe("MEASURED");
    expect(finalStatus("PASS", "PASS", false, true)).toBe("INCONCLUSIVE");
    expect(finalStatus("PASS", "PASS", true, false)).toBe("INCONCLUSIVE");
    expect(finalStatus("PASS", "INCONCLUSIVE", true, true)).toBe("INCONCLUSIVE");
    expect(finalStatus("PASS", "PASS", true, true)).toBe("PASS");
  });
  it("wall-history-soak semantic divergence and raw retention violations are BLOCK even with missing timing", () => {
    expect(finalStatus("BLOCK", "PASS", false, false)).toBe("BLOCK");
    expect(finalStatus("PASS", "BLOCK", false, false)).toBe("BLOCK");
  });
  it("wall-history-soak comparisons require measured baseline/candidate with identical fixture/runtime", () => {
    const baseline: ComparisonRun = { label: "baseline", count: 100000, seed: 19095277,
      fixtureSha256: "a".repeat(64), timing: "MEASURED", runtime: { node: "fixture", arch: "fixture", platform: "fixture" },
      measurements: { postGcRetainedHeapBytes: 1, heapSlopeBytesPerAcceptedEvent: -1,
        peakRssBytes: 1, updateLatencyNs: { p50: 1, p95: 1, max: 1 }, readLatencyNs: { p50: 1, p95: 1, max: 1 } } };
    const candidate = { ...baseline, label: "candidate" };
    expect(comparable(baseline, candidate)).toBe(true);
    for (const changed of [
      { fixtureSha256: "b".repeat(64) }, { count: 99999 }, { seed: 1 },
      { runtime: { ...baseline.runtime, node: "different" } }, { runtime: undefined },
      { timing: "INCONCLUSIVE" }, { measurements: undefined }, { label: "baseline" },
      { measurements: { ...baseline.measurements, updateLatencyNs: null } },
      { measurements: { ...baseline.measurements, readLatencyNs: { p50: NaN, p95: 1, max: 1 } } },
    ]) expect(comparable(baseline, { ...candidate, ...changed })).toBe(false);
    expect(comparable({}, {})).toBe(false);
  });
});
