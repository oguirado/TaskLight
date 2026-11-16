import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlanWiring } from "../../../src/app/plan_wiring";
import type { PlanWiring } from "../../../src/app/plan_wiring";
import { deferred, flush, harness, snapshot, task, verdict } from "./helpers";

const live: PlanWiring[] = [];
const mount = (h: ReturnType<typeof harness>): PlanWiring => {
  const w = createPlanWiring(h.deps);
  live.push(w);
  return w;
};
afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  vi.restoreAllMocks();
});

describe("U64 repair3 blocking defects", () => {
  it("fractional concurrency below 1 still executes", async () => {
    const h = harness();
    h.deps = { ...h.deps, concurrency: 0.5 };
    const w = mount(h);
    w.notifyChange();
    await h.advance();
    await flush();
    expect(h.reviewTask).toHaveBeenCalled();
    expect(w.taskVerdicts().has("room:T01")).toBe(true);
  });

  it("plan replacement with identical revisions re-reviews and replaces results", async () => {
    const h = harness();
    h.reviewTask.mockResolvedValueOnce(verdict("device", "plan-a")).mockResolvedValue(verdict("device", "plan-b"));
    h.briefPlan.mockResolvedValueOnce({ brief: "brief-a", source: "device" }).mockResolvedValue({ brief: "brief-b", source: "device" });
    const w = mount(h);
    w.notifyChange();
    await h.advance();
    await flush();
    expect(w.taskVerdicts().get("room:T01")?.reason).toBe("plan-a");
    const base = snapshot([task("T01", 1)]);
    h.setSnapshots([{ ...base, planId: "p-other", rev: 1 }]);
    w.notifyChange();
    await h.advance();
    await flush();
    expect(h.reviewTask.mock.calls.length).toBeGreaterThan(1);
    expect(w.taskVerdicts().get("room:T01")?.reason).toBe("plan-b");
    expect(w.planBriefs().get("room")?.brief).toBe("brief-b");
  });

  it("stale in-flight result from previous plan never commits after replacement", async () => {
    const h = harness();
    const old = deferred<ReturnType<typeof verdict>>();
    h.reviewTask.mockReturnValueOnce(old.promise).mockResolvedValue(verdict("device", "plan-b"));
    h.briefPlan.mockResolvedValue({ brief: "fresh", source: "device" });
    const w = mount(h);
    w.notifyChange();
    await h.advance();
    expect(h.reviewTask).toHaveBeenCalledTimes(1);
    const base = snapshot([task("T01", 1)]);
    h.setSnapshots([{ ...base, planId: "p-other", rev: 1 }]);
    w.notifyChange();
    const signal = h.reviewTask.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(true);
    await h.advance();
    await flush();
    expect(w.taskVerdicts().get("room:T01")?.reason).toBe("plan-b");
    old.resolve(verdict("device", "plan-a-late"));
    await flush();
    expect(w.taskVerdicts().get("room:T01")?.reason).toBe("plan-b");
  });

  it("disappeared tasks free every slot so replacement work runs despite non-settling calls", async () => {
    const h = harness();
    h.reviewTask.mockImplementation(() => new Promise<ReturnType<typeof verdict>>(() => undefined));
    h.briefPlan.mockImplementation(() => new Promise<{ brief: string; source: "device" }>(() => undefined));
    const w = mount(h);
    w.notifyChange();
    await h.advance();
    await flush();
    expect(h.reviewTask).toHaveBeenCalledTimes(1);
    expect(h.briefPlan).toHaveBeenCalledTimes(1);
    h.setSnapshots([]);
    w.notifyChange();
    h.reviewTask.mockImplementation(() => Promise.resolve(verdict("device", "replacement")));
    h.briefPlan.mockImplementation(() => Promise.resolve({ brief: "replacement-brief", source: "device" }));
    h.setSnapshots([snapshot([task("T09", 1)])]);
    w.notifyChange();
    await h.advance();
    await flush();
    expect(h.reviewTask).toHaveBeenCalledTimes(2);
    expect(w.taskVerdicts().get("room:T09")?.reason).toBe("replacement");
  });
});
