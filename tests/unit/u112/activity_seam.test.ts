import { expect, it, vi } from "vitest";
vi.mock("../../../src/app/activity", async original => {
  const actual = await original<typeof import("../../../src/app/activity")>();
  return { ...actual, deriveActivity: vi.fn(actual.deriveActivity) };
});
import { deriveActivity } from "../../../src/app/activity";
import { deriveSwarmViewModel } from "../../../src/app/swarm_vm";
import { beat, deterministic, freeze, input, micro, NOW, projection, task } from "./fixtures";

deterministic();
it.each([true, false])("M5 delegates activity with undefined micro, injected clock and connected=%s", connected => {
  const spy = vi.mocked(deriveActivity); spy.mockClear();
  const vm = deriveSwarmViewModel(freeze(input({ connected })));
  expect(vm.agents).toHaveLength(1);
  expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: "T01" }), undefined, NOW, { connected });
});
it.each([
  { name: "stale", live: beat({ beat_ts: NOW - 90_001 }) },
  { name: "future", live: beat({ beat_ts: NOW + 1 }) },
  { name: "foreign owner", live: beat({ agent: "other" }) },
  { name: "zero Lamport", live: beat({ beat_lamport: 0 }) },
])("Amendment B removes $name live before calling deriveActivity without mutating input", ({ live }) => {
  const spy = vi.mocked(deriveActivity); spy.mockClear();
  const i = freeze(input({ projection: projection([task("T01", { microtasks: [micro("T01.M01", { live })] })]) }));
  const before = structuredClone(i); deriveSwarmViewModel(i);
  const calls = spy.mock.calls.filter(call => call[0].id === "T01");
  expect(calls.length).toBeGreaterThan(0);
  for (const [sanitized, selectedMicro, now, options] of calls) {
    expect(sanitized.microtasks.find(m => m.id === "T01.M01")?.live).toBeUndefined();
    expect(selectedMicro).toBeUndefined(); expect(now).toBe(NOW); expect(options).toEqual({ connected: true });
  }
  expect(i).toEqual(before);
});
it("M5 unselected registered agent is idle without fabricating a task for deriveActivity", () => {
  const spy = vi.mocked(deriveActivity); spy.mockClear();
  const vm = deriveSwarmViewModel(input({ projection: null, agents: { registered: {} } }));
  expect(vm.agents[0]?.activity).toBe("idle"); expect(spy).not.toHaveBeenCalled();
});
