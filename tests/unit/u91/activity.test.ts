import { describe, expect, it } from "vitest";
import { groupTasksByPhase, renderPhaseTaskCards } from "../../../src/views/plan";
import { activityNode, canonical, expectActivity as legacyExpectActivity, hostile, map, micro, mount, phases, plan, projection,
  setup, source, states, step, task, text, wall } from "./fixtures";


import type { ActivityState, Task } from "./fixtures";
import { expectStationary, hasAnimation, icon, visualSignature } from "./css_probe";

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
function fixture(state: ActivityState): Task {
  const committed = state === "done" ? "done" : state === "blocked" ? "blocked" : state === "working" || state === "unknown" ? "active" : "pending";
  return task({ status: state === "done" ? "done" : committed === "active" ? "running" : state === "blocked" ? "blocked" : "idle",
    activity: { state }, steps: [step({ state: committed, activity: { state } })],
    ...(state === "blocked" ? { blockedReason: "CSV source unavailable" } : {}),
    ...(state === "waiting" ? { waitsFor: ["T00"] } : {}),
    ...(state === "needs_you" ? { operatorQuestion: { eventId: "question-1", text: "Which CSV format?" } } : {}),
  });
}
describe("A1 activity vocabulary", () => {
  it.each(states)("A1 task and microtask render %s with hidden symbol and state text", state => {
    const root = renderPhaseTaskCards(document, groupTasksByPhase([fixture(state)], phases));
    const owner = card(root), row = owner.querySelector<HTMLElement>("li.step");
    expectActivity(owner, state); expect(row).not.toBeNull(); expectActivity(row!, state);
    for (const scope of [owner.querySelector<HTMLElement>(".task-head") ?? owner, row!]) {
      const symbol = icon(scope); expect(symbol.getAttribute("aria-hidden")).toBe("true");
      expect(visualSignature(symbol)).not.toBe(visualSignature(document.createElement("span")));
    }
    if (state === "working") {
      const symbols = [...owner.querySelectorAll<HTMLElement>("[aria-hidden='true']")];
      expect(symbols.some(n => (["", "before", "after"] as const).some(p => hasAnimation(n, p)))).toBe(true);
    } else expectStationary(owner);
  });
  it("A1 accepted all-done has a distinct static completion symbol; cancellation never uses it", () => {
    const completed = fixture("done"), cancelled = fixture("cancelled");
    const root = renderPhaseTaskCards(document, groupTasksByPhase([completed, { ...cancelled, taskId: "T02", id: "plan:room-a:T02" }], phases));
    expectActivity(card(root), "done"); expectActivity(card(root, "T02"), "cancelled");
    expect(visualSignature(icon(card(root).querySelector<HTMLElement>(".task-head")!)))
      .not.toBe(visualSignature(icon(card(root, "T02").querySelector<HTMLElement>(".task-head")!)));
    expectStationary(root);
  });
  it.each([{ evidence: [] as string[] }, { evidence: ["reports/check.txt"] }])("A1 completion evidence copy is truthful for $evidence", ({ evidence }) => {
    const t = fixture("done"); t.steps = [step({ state: "done", activity: { state: "done" },
      detail: { outcome: "CSV import completed", evidence, source } })];
    const { host } = mount(wall({ tasks: [t] }));
    const contents = text(card(host));
    expect(contents).toContain(evidence.length ? "Evidence recorded" : "No evidence recorded");
    if (!evidence.length) { expect(contents).not.toContain("Evidence recorded"); expect(contents).not.toMatch(/verified/i); }
    else expect(contents).toContain(evidence[0]);
  });
  it("A1 blocked reason and missing upstream identity remain available", () => {
    const { host } = mount(wall({ tasks: [fixture("blocked"), { ...fixture("waiting"), taskId: "T02" }] }));
    expect(text(card(host))).toContain("CSV source unavailable");
    expectActivity(card(host, "T02"), "waiting"); expect(text(card(host, "T02"))).toContain("T00");
  });
});

describe("A2/A3 canonical activity mapping", () => {
  it.each([[189999, "working"], [190000, "working"], [190001, "unknown"]] as const)(
    "A2 freshness at %i maps to %s without changing canonical progress", (now, expected) => {
      const input = canonical(), before = structuredClone(input); const vm = map([input], now);
      expect(vm.tasks[0]?.steps[0]?.activity?.state).toBe(expected);
      expect(vm.tasks[0]?.activity?.state).toBe(expected);
      if (expected === "working") expect(vm.tasks[0]?.steps[0]?.activity?.expiresAt).toBe(190000);
      expect(vm.plan?.agents.find(a => a.agent === "owner")?.active).toBe(expected === "working");
      expect(vm.tasks[0]?.status).toBe("running"); expect(vm.tasks[0]?.steps[0]?.state).toBe("active");
      expect(vm.plan?.progressPct).toBe(0); expect(input).toEqual(before);
    });
  it("A3 active child without live maps to unknown and an inactive dot", () => {
    const m = micro(); delete m.live;
    const vm = map([canonical({ microtasks: [m] })]);
    expect(vm.tasks[0]?.steps[0]?.activity?.state).toBe("unknown");
    expect(vm.tasks[0]?.activity?.state).toBe("unknown"); expect(vm.plan?.agents[0]?.active).toBe(false);
  });
  it.each(["idle", "blocked", "waiting", "done"] as const)("A1/M1 canonical %s maps through the frozen activity seam", state => {
    const pending = micro({ state: "pending" }); delete pending.live;
    const input = canonical({ state: state === "idle" || state === "waiting" ? "pending" : state,
      explicit_state: state === "blocked" ? "blocked" : null, blocked_reason: state === "blocked" ? "CSV source missing" : null,
      deps: state === "waiting" ? ["T00"] : [], ready: state !== "waiting",
      microtasks: [state === "done" ? micro({ state: "done", outcome: "Recorded" }) : pending] });
    const vm = map([input]); expect(vm.tasks[0]?.activity?.state).toBe(state);
    expect(vm.tasks[0]?.steps[0]?.activity?.state).toBe(state);
    expect(vm.plan?.agents[0]?.active).toBe(false);
  });
  it("A3 done-plus-pending is idle execution with recorded partial progress", () => {
    const done = micro({ id: "T01.M01", state: "done", outcome: "Headers retained", evidence: [{ path: "reports/check.txt", sha256: "a".repeat(64) }] });
    const pending = micro({ state: "pending" }); delete pending.live;
    const input = canonical({ microtasks: [done, pending] }); const before = structuredClone(input);
    const vm = map([input]);
    expect(vm.tasks[0]?.activity?.state).toBe("idle"); expect(vm.plan?.agents[0]?.active).toBe(false);
    expect(vm.plan).toMatchObject({ doneCount: 1, totalCount: 2, progressPct: 50 });
    expect(vm.tasks[0]).toMatchObject({ id: "plan:room-a:T01", taskId: "T01", status: "running", assignee: "owner" });
    expect(vm.tasks[0]?.steps[0]).toMatchObject({ microId: "T01.M01", state: "done", detail: { outcome: "Headers retained", evidence: ["reports/check.txt"] } });
    expect(input).toEqual(before);
  });
  it("A3 a done task with no microtasks cannot establish done activity", () => {
    const vm = map([canonical({ state: "done", microtasks: [] })]);
    expect(vm.tasks[0]?.activity?.state).toBeDefined(); expect(vm.tasks[0]?.activity?.state).not.toBe("done");
    const { host } = mount(vm); expect(activityNode(card(host))?.dataset.activity).not.toBe("done");
  });
  it.each([200000, NaN])("A3 invalid or future beat timestamp %s cannot establish working", beat_ts => {
    const m = micro(); m.live = { ...m.live!, beat_ts };
    const vm = map([canonical({ microtasks: [m] })], 190001);
    expect(vm.tasks[0]?.steps[0]?.activity?.state).toBe("unknown");
    expect(vm.tasks[0]?.activity?.state).not.toBe("working"); expect(vm.plan?.agents[0]?.active).toBe(false);
  });
  it("A3 another assignee's beat cannot activate the owner's ring or dot", () => {
    const m = micro(); m.live = { ...m.live!, agent: "other" };
    const vm = map([canonical({ microtasks: [m] })]);
    expect(vm.tasks[0]?.steps[0]?.activity?.state).toBe("unknown"); expect(vm.plan?.agents[0]?.active).toBe(false);
  });
  it("A3 another room's working assignment does not activate the displayed-room dot", () => {
    const local = micro({ state: "pending" }); delete local.live;
    const vm = map([canonical({ microtasks: [local] })], 189999, {}, [projection([canonical()], "room-b")]);
    expect(vm.workspace).toBe("room-a"); expect(vm.plan?.agents.find(a => a.agent === "owner")?.active).toBe(false);
    expect(vm.tasks.find(t => t.workspace === "room-b")?.activity?.state).toBe("working");
  });
  it("A3 cancelled canonical tasks preserve status without a completion tick", () => {
    const vm = map([canonical({ state: "cancelled", explicit_state: "cancelled" })]);
    expect(vm.tasks[0]?.status).toBe("failed"); expect(vm.tasks[0]?.activity?.state).toBe("cancelled");
    expect(vm.plan?.agents[0]?.active).toBe(false);
  });
  it("A1/M1 preserved legacy mapping never invents evidence", () => {
    const m = micro({ state: "done", outcome: "Recorded", took: "2m", evidence: [] }); delete m.live;
    const vm = map([canonical({ state: "done", microtasks: [m] })]);
    expect(vm.tasks[0]).toMatchObject({ id: "plan:room-a:T01", workspace: "room-a", taskId: "T01", status: "done" });
    expect(vm.tasks[0]?.steps[0]).toMatchObject({ microId: "T01.M02", accept: "CSV preserves headers", took: "2m",
      detail: { outcome: "Recorded", evidence: [] } });
  });
  it("A8 evidence and blocked reasons stay literal in mapped values", () => {
    const vm = map([canonical({ state: "blocked", explicit_state: "blocked", blocked_reason: hostile,
      microtasks: [micro({ state: "done", outcome: "Recorded", evidence: [{ path: hostile, sha256: "b".repeat(64) }] })] })]);
    expect(vm.tasks[0]?.blockedReason).toBe(hostile); expect(vm.tasks[0]?.steps[0]?.detail?.evidence).toEqual([hostile]);
  });
});
