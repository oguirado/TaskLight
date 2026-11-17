import { describe, expect, it, vi } from "vitest";
import { canonical, expectActivity as legacyExpectActivity, map, micro, mount, plan, q, setup, step, task, wall, workingWall } from "./fixtures";


import { cssText, expectStationary } from "./css_probe";

// A-Q1: U148 keeps task and microtask state distinct; exclude children from task text checks.
function expectActivity(scope: HTMLElement, state: Parameters<typeof legacyExpectActivity>[1]): void {
  const own = scope.cloneNode(true) as HTMLElement;
  if (scope.matches(".task[data-task-id]")) own.querySelectorAll(".steps").forEach(n => n.remove());
  legacyExpectActivity(own, state);
}

// A-Q1: U148 non-article task roots retain .task/data-task-id; keep identity checks.
function card(root: ParentNode, id = "T01"): HTMLElement {
  const matches = [...root.querySelectorAll<HTMLElement>(".task[data-task-id]")].filter(n => n.dataset.taskId === id);
  expect(matches, `Required unique task card: ${id}`).toHaveLength(1);
  return matches[0]!;
}

setup();
function dot(host: ParentNode) { return q(host, '.agent-dot[data-agent="owner"]'); }

describe("A2 expiry owned by the view", () => {
  it("A2 inclusive boundary expires without another event and clears the related dot", () => {
    const vm = workingWall(); const snapshot = structuredClone(vm); const { host } = mount(vm);
    expectActivity(card(host), "working"); expect(dot(host).dataset.active).toBe("true");
    vi.advanceTimersByTime(1);
    expect(Date.now()).toBe(190000); expectActivity(card(host), "working");
    vi.advanceTimersByTime(1);
    expectActivity(card(host), "unknown"); expectActivity(q(host, "li.step"), "unknown");
    expect(dot(host).dataset.active).toBe("false"); expectStationary(card(host));
    expect(vm).toEqual(snapshot);
  });
  it("A2 expiry preserves recorded partial completion, evidence, and committed step status", () => {
    const vm = workingWall();
    vm.tasks = [task({ status: "running", activity: { state: "working", expiresAt: 190000 }, steps: [
      step({ microId: "T01.M01", state: "done", activity: { state: "done" },
        detail: { outcome: "Headers retained", evidence: ["reports/headers.txt"], source: { kind: "rules", ms: 0 } } }),
      step({ state: "active", activity: { state: "working", expiresAt: 190000 } }),
    ] })];
    vm.plan = plan({ doneCount: 1, totalCount: 2, progressPct: 50, agents: [{ agent: "owner", active: true }] });
    const { host } = mount(vm); vi.advanceTimersByTime(2);
    expectActivity(card(host), "unknown"); expect(q(host, '[role="progressbar"]').getAttribute("aria-valuenow")).toBe("50");
    expect(host.textContent).toContain("Headers retained"); expect(host.textContent).toContain("reports/headers.txt");
    expect(vm.tasks[0]?.steps.map(s => s.state)).toEqual(["done", "active"]);
  });
  it.each(["online", "offline"] as const)("A2 published syncStale suppresses work with network=%s", network => {
    const vm = workingWall(); vm.syncStale = true; vm.network = network;
    const before = structuredClone(vm); const { host } = mount(vm);
    expectActivity(card(host), "unknown"); expectActivity(q(host, "li.step"), "unknown");
    expectStationary(card(host)); expect(dot(host).dataset.active).toBe("false"); expect(vm).toEqual(before);
  });
  it("A2 a synchronization-outcome update immediately stops existing animation and dots", () => {
    const vm = workingWall(); const { host, handle } = mount(vm);
    const stale = { ...vm, syncStale: true }; handle.update(stale);
    expectActivity(card(host), "unknown"); expectStationary(card(host)); expect(dot(host).dataset.active).toBe("false");
  });
  it("A2 browser offline alone does not establish a stale host outcome", () => {
    const vm = map([canonical()], 189999, { network: "offline" });
    vi.stubGlobal("navigator", { onLine: false });
    expect(vm.tasks[0]?.activity?.state).toBe("working");
    const { host } = mount(vm); expectActivity(card(host), "working");
  });
  it("A2 a newer beat replaces the expiry deadline instead of expiring the current run early", () => {
    const { host, handle } = mount(workingWall());
    vi.advanceTimersByTime(1); handle.update(workingWall(190010));
    vi.advanceTimersByTime(1); expectActivity(card(host), "working");
    vi.advanceTimersByTime(10); expectActivity(card(host), "unknown"); expect(dot(host).dataset.active).toBe("false");
  });
  it("A2 repeated updates do not accumulate expiry callbacks and destroy releases them", () => {
    const { host, handle } = mount(workingWall());
    const timers = vi.getTimerCount(); expect(timers, "Working activity owns a pending expiry").toBeGreaterThan(0);
    for (let i = 0; i < 12; i++) handle.update(workingWall());
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timers);
    handle.destroy(); expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(90001); expect(host.childElementCount).toBe(0);
    handle.update(workingWall()); expect(host.childElementCount).toBe(0);
  });
  it("A2 leaving a workspace releases its expiry and animation", () => {
    const vm = workingWall(); const { host, handle } = mount(vm);
    handle.update({ ...vm, workspace: "room-b", tasks: [], plan: plan({ agents: [] }) });
    expect(vi.getTimerCount()).toBe(0); vi.advanceTimersByTime(2);
    expect(host.querySelector("[data-activity='working']")).toBeNull();
  });
});

describe("A3 stale-animation negative controls", () => {
  it("A3 stale active work cannot animate even when its committed state remains active", () => {
    const { host } = mount(wall({ tasks: [task({ status: "running", activity: { state: "unknown" },
      steps: [step({ state: "active", activity: { state: "unknown" } })] })] }));
    expectStationary(card(host));
  });
  it("A3 the oracle rejects the M9 stale-animation mutant", () => {
    // Add the deliberately broken legacy rule in memory; never alter product CSS.
    const { host } = mount(wall({ tasks: [task({ status: "running", activity: { state: "unknown" },
      steps: [step({ state: "active", activity: { state: "unknown" } })] })] }));
    const stationary = cssText() + '\n.step[data-state="active"] .step-indicator::before { animation: none !important; }';
    expect(() => expectStationary(card(host), false, stationary)).not.toThrow();
    const mutant = stationary + '\n.step[data-state="active"] .step-indicator::before { content: ""; animation: stale-spin 1s linear infinite !important; }';
    expect(() => expectStationary(card(host), false, mutant)).toThrow(/Unexpected activity animation/);
  });
  it("A3 a mixed done-and-pending task never spins or enables an assignee dot", () => {
    const done = micro({ id: "T01.M01", state: "done" }), pending = micro({ state: "pending" }); delete pending.live;
    const vm = map([canonical({ microtasks: [done, pending] })]); const { host } = mount(vm);
    expectStationary(card(host)); expect(dot(host).dataset.active).toBe("false");
  });
});
