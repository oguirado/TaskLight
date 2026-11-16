import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlanWiring } from "../../../src/app/plan_wiring";
import type { PlanWiring } from "../../../src/app/plan_wiring";
import type { PlanAiTier } from "../../../src/planai/types";
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

describe("U64 repair2 blocking defects", () => {
  it("BLOCKING#1 floor downgrade aborts in-flight cloud job and discards its late verdict", async () => {
    const h = harness();
    let tier: PlanAiTier = "standard";
    h.deps = { ...h.deps, getTier: () => tier };
    const old = deferred<ReturnType<typeof verdict>>();
    let calls = 0;
    h.reviewTask.mockImplementation(() => {
      calls += 1;
      return calls === 1 ? old.promise : Promise.resolve(verdict("device", "private-new"));
    });
    h.briefPlan.mockResolvedValue({ brief: "fresh", source: "device" });
    const w = mount(h);
    w.notifyChange();
    await h.advance();
    expect(h.reviewTask).toHaveBeenCalledTimes(1);
    expect(h.reviewTask.mock.calls[0]?.[1]?.floor).toBe("PREFER_ON_DEVICE");
    const signal = h.reviewTask.mock.calls[0]?.[1]?.signal;
    tier = "private";
    w.notifyChange();
    expect(signal?.aborted).toBe(true);
    await h.advance();
    expect(h.reviewTask).toHaveBeenCalledTimes(2);
    expect(h.reviewTask.mock.calls.at(-1)?.[1]?.floor).toBe("ONLY_ON_DEVICE");
    old.resolve(verdict("cloud", "stale-cloud"));
    await flush();
    expect(w.taskVerdicts().get("room:T01")?.reason).toBe("private-new");
    expect(w.taskVerdicts().get("room:T01")?.source).toBe("device");
  });

  it("BLOCKING#2 transient empty snapshot re-queues on return", async () => {
    const h = harness();
    const pending = deferred<ReturnType<typeof verdict>>();
    h.reviewTask.mockReturnValueOnce(pending.promise).mockResolvedValue(verdict("device", "second"));
    const w = mount(h);
    w.notifyChange();
    await h.advance();
    expect(h.reviewTask).toHaveBeenCalledTimes(1);
    h.setSnapshots([]);
    w.notifyChange();
    h.setSnapshots([snapshot()]);
    w.notifyChange();
    await h.advance();
    await flush();
    expect(h.reviewTask).toHaveBeenCalledTimes(2);
    expect(w.taskVerdicts().get("room:T01")?.reason).toBe("second");
  });

  it("BLOCKING#2 omitted task drops from seen and is re-queued when it returns", async () => {
    const h = harness([snapshot([task(), task("T02")])]);
    const held = deferred<ReturnType<typeof verdict>>();
    h.reviewTask.mockReturnValueOnce(held.promise);
    const w = mount(h);
    w.notifyChange();
    await h.advance();
    const started = h.reviewTask.mock.calls.length;
    expect(started).toBeGreaterThan(0);
    h.setSnapshots([snapshot([task()])]);
    w.notifyChange();
    h.setSnapshots([snapshot([task(), task("T02")])]);
    w.notifyChange();
    await h.advance();
    await flush();
    expect(h.reviewTask.mock.calls.length).toBeGreaterThan(started);
  });

  it("BLOCKING#3 no-op notify neither starves queue nor arms idle timers", async () => {
    const h = harness([snapshot(Array.from({ length: 6 }, (_, i) => task(`T0${i + 1}`)) )]);
    const held = deferred<ReturnType<typeof verdict>>();
    h.reviewTask.mockImplementation(() => held.promise);
    h.briefPlan.mockResolvedValue({ brief: "b", source: "device" });
    const w = mount(h);
    w.notifyChange();
    expect(h.pending.size).toBe(1);
    await h.advance(100);
    const callsBeforeNoop = vi.mocked(h.clock.setTimeout).mock.calls.length;
    w.notifyChange();
    expect(vi.mocked(h.clock.setTimeout).mock.calls.length).toBe(callsBeforeNoop);
    expect(h.pending.size).toBe(1);
    await h.advance(150);
    expect(h.reviewTask).toHaveBeenCalled();
    const afterDrain = vi.mocked(h.clock.setTimeout).mock.calls.length;
    held.resolve(verdict());
    await flush();
    w.notifyChange();
    expect(vi.mocked(h.clock.setTimeout).mock.calls.length).toBe(afterDrain);
    expect(h.pending.size).toBe(0);
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])("BLOCKING#4 invalid debounceMs %s falls back to default", async (value) => {
    const h = harness();
    h.deps = { ...h.deps, debounceMs: value };
    const w = mount(h);
    w.notifyChange();
    await h.advance(249);
    expect(h.reviewTask).not.toHaveBeenCalled();
    await h.advance(1);
    expect(h.reviewTask).toHaveBeenCalled();
  });
});
