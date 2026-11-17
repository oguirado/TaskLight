import { describe, expect, it, vi } from "vitest";
import { deriveSwarmViewModel } from "../../../src/app/swarm_vm";
import { renderSwarmView } from "../../../src/views/swarm";
import { agent, card, deterministic, freeze, frozenFixture, HOSTILE, identityOrder, input, micro, mount, NOW,
  projection, registration, task, text, viewModel } from "./fixtures";
import type { Agent } from "./fixtures";

deterministic();
function empty(extra: Partial<Agent> = {}): Agent {
  return agent({ tasks: [], current_task_id: null, active_micro_id: null, micro_done: null, micro_total: null,
    activity: "idle", last_beat_ts: null, last_beat_age_ms: null, ...extra });
}
function a1Rows(): Agent[] {
  const tasks = frozenFixture().projection!.tasks;
  return [
    agent({ tasks: [tasks[0]!], active_micro_id: "T01.M02", micro_done: 1, micro_total: 2 }),
    agent({ agent: "executor-b", tasks: [tasks[1]!], current_task_id: "T02", active_micro_id: null, activity: "waiting",
      last_beat_ts: null, last_beat_age_ms: null, waiting_on: [{ task_id: "T02", upstream_id: "T01", owner: "executor-a", missing: false }] }),
    agent({ agent: "executor-c", tasks: [tasks[2]!], current_task_id: "T03", active_micro_id: "T03.M01", activity: "unknown",
      last_beat_ts: 9_999, last_beat_age_ms: 90_001 }),
    empty({ agent: "executor-d", lifecycle: "failed", swarm: "beta" }),
    empty({ agent: "executor-e", lifecycle: "finished", swarm: "beta" }),
  ];
}
function safe(root: HTMLElement): void {
  expect(root.querySelector("img, script, iframe, object, embed, [onerror], [onload], [onclick]")).toBeNull();
}

describe("A1 / M2-M3 independent frozen rendering", () => {
  it("A1 renders five cards grouped as alpha (3) and beta (2), with c,b,a then d,e", () => {
    const rows = a1Rows(), root = mount(viewModel(rows));
    expect(text(root)).toContain("alpha (3)"); expect(text(root)).toContain("beta (2)");
    expect(identityOrder(root, rows.map(a => a.agent))).toEqual(["executor-c", "executor-b", "executor-a", "executor-d", "executor-e"]);
    expect(text(card(root, "executor-a"))).toMatch(/1\s*\/\s*2/);
    expect(text(card(root, "executor-a"))).toContain("T01.M02");
    for (const s of ["T02", "T01", "executor-a", "Waiting"]) expect(text(card(root, "executor-b", "T02"))).toContain(s);
    expect(text(card(root, "executor-c", "T03"))).toContain("Liveness unknown");
    expect(text(card(root, "executor-d", null))).toContain("Failed · tasks released");
    expect(text(card(root, "executor-e", null))).toContain("Finished");
  });
  it("A1 shuffling frozen renderer rows preserves visible content and group order without mutation", () => {
    const rows = freeze(a1Rows()), before = structuredClone(rows);
    const first = renderSwarmView(document, freeze(viewModel(rows)));
    const second = renderSwarmView(document, freeze(viewModel([...rows].reverse())));
    expect(text(second)).toBe(text(first)); expect(rows).toEqual(before);
  });
  it("M2 displays cached plan rollup exactly instead of recomputing it from displayed tasks", () => {
    const progress = { tasks_total: 8, tasks_done: 3, tasks_blocked: 2, tasks_ready: 4,
      micro_total: 20, micro_done: 7, progress: 0.35, progress_pct: 35 };
    const root = mount({ ...viewModel(), progress });
    expect(text(root)).toMatch(/3\s+of\s+8\s+tasks done/); expect(text(root)).toMatch(/7\s+of\s+20\s+microtasks done/);
    expect(text(root)).toContain("35%");
  });
});

describe("A3 / M3 exact group keys and full bucket order", () => {
  it("A3 frozen renderer rows span every bucket with terminal lifecycle precedence and deterministic ties", () => {
    const rows = [empty({ agent: "row-finished", lifecycle: "finished", activity: "blocked" }),
      empty({ agent: "row-done", activity: "done" }), empty({ agent: "row-cancelled", activity: "cancelled" }),
      empty({ agent: "row-working", activity: "working" }), empty({ agent: "row-waiting", activity: "waiting" }),
      empty({ agent: "row-idle", lifecycle: "deployed" }), empty({ agent: "row-unknown", activity: "unknown" }),
      empty({ agent: "row-blocked", activity: "blocked" }), empty({ agent: "row-failed", lifecycle: "failed", activity: "needs_you" }),
      empty({ agent: "row-needs", activity: "needs_you" })];
    const root = mount(viewModel(freeze(rows)));
    expect(identityOrder(root, rows.map(a => a.agent))).toEqual([
      "row-needs", "row-failed", "row-blocked", "row-unknown", "row-idle", "row-waiting", "row-working", "row-cancelled", "row-done", "row-finished",
    ]);
    expect(text(root)).toContain("alpha (10)");
  });
  it("M3 orders named groups and tied slugs by code units, with missing swarm last", () => {
    const { swarm: _swarm, ...ungrouped } = empty({ agent: "missing" });
    const rows = [ungrouped, empty({ agent: "lower", swarm: "alpha" }), empty({ agent: "accent", swarm: "ä" }),
      empty({ agent: "z-tie", swarm: "Z" }), empty({ agent: "Z-tie", swarm: "Z" })];
    const root = mount(viewModel(rows));
    expect(identityOrder(root, rows.map(a => a.agent))).toEqual(["Z-tie", "z-tie", "lower", "accent", "missing"]);
    for (const label of ["Z (2)", "alpha (1)", "ä (1)", "Ungrouped (1)"]) expect(text(root)).toContain(label);
  });
  it("Amendment B literal Ungrouped and missing swarm are distinct buckets", () => {
    const { swarm: _swarm, ...missing } = empty({ agent: "missing" });
    const rows = [missing, empty({ agent: "literal", swarm: "Ungrouped" })];
    const root = mount(viewModel(rows));
    expect(text(root).match(/Ungrouped\s*\(1\)/g) ?? []).toHaveLength(2);
    expect(identityOrder(root, ["missing", "literal"])).toEqual(["literal", "missing"]);
  });
  it("M2-M3 group counts deduplicate the same lifecycle-registration and task-owner slug", () => {
    const i = input({ agents: { "executor-a": registration() }, projection: projection([task(), task("T02")], { "executor-a": registration() }) });
    const vm = deriveSwarmViewModel(freeze(i)); expect(vm.agents).toHaveLength(1);
    expect(text(mount(vm))).toContain("alpha (1)");
  });
  it("M3 unanswered question counts alone never promote a Working card into Needs you", () => {
    const a = agent({ unanswered_questions: 99 }), b = agent({ agent: "executor-b", activity: "needs_you" });
    const root = mount(viewModel([a, b]));
    expect(identityOrder(root, [a.agent, b.agent])).toEqual([b.agent, a.agent]);
    expect(text(card(root, a.agent))).not.toContain("Needs you");
  });
  it.each([["working", "Working"], ["unknown", "Liveness unknown"], ["waiting", "Waiting"], ["blocked", "Blocked"],
    ["needs_you", "Needs you"], ["idle", "Idle"], ["done", "Done"], ["cancelled", "Cancelled"]] as const)(
    "M3 preserves U112 activity vocabulary %s -> %s for a nonterminal row", (activity, label) => {
      expect(text(mount(viewModel([agent({ activity })])))).toContain(label);
    });
});

describe("A2-A3 / M4 terminal status, deployment and missing values", () => {
  it.each(["failed", "finished"] as const)("A2 %s status overrides a fresh Working renderer row", lifecycle => {
    const root = mount(viewModel([agent({ lifecycle })]));
    expect(text(card(root, "executor-a"))).toContain(lifecycle === "failed" ? "Failed · open work" : "Finished · open work");
    expect(text(card(root, "executor-a"))).not.toContain("Working");
  });
  it("A2 failed with retained T03 says Failed · open work, without releasing ownership", () => {
    const t = task("T03"), vm = freeze(viewModel([agent({ lifecycle: "failed", tasks: [t], current_task_id: "T03", active_micro_id: "T03.M01" })]));
    const before = structuredClone(vm), root = renderSwarmView(document, vm);
    expect(text(root)).toContain("Failed · open work"); expect(text(root)).toContain("T03"); expect(vm).toEqual(before);
  });
  it.each(["done", "cancelled"] as const)("Amendment B failed owning only %s work says Failed · tasks released", state => {
    const t = task("T01", { state, microtasks: [micro("T01.M01", { state: state === "done" ? "done" : "pending" })] });
    const root = mount(viewModel([agent({ lifecycle: "failed", tasks: [t], activity: state, active_micro_id: null })]));
    expect(text(root)).toContain("Failed · tasks released"); expect(text(root)).not.toContain("Failed · open work");
  });
  it("A3 finished with pending work says Finished · open work", () => {
    const root = mount(viewModel([agent({ lifecycle: "finished", activity: "idle", tasks: [task("T01", {
      state: "pending", microtasks: [micro("T01.M01", { state: "pending" })] })], active_micro_id: null })]));
    expect(text(root)).toContain("Finished · open work");
  });
  it.each(["done", "cancelled"] as const)("M4 finished owning only %s work does not claim open work or process termination", state => {
    const root = mount(viewModel([agent({ lifecycle: "finished", activity: state, tasks: [task("T01", { state })] })]));
    expect(text(root)).toContain("Finished"); expect(text(root)).not.toContain("Finished · open work");
    expect(text(root)).not.toMatch(/\b(process (?:terminated|exited)|killed)\b/i);
  });
  it("A3 deployed registration with projection null says Deployed · no plan yet", () => {
    const vm = deriveSwarmViewModel(input({ projection: null, agents: { "executor-a": registration({ lifecycle: "deployed" }) } }));
    const root = mount(vm); expect(text(root)).toContain("Deployed · no plan yet");
    for (const s of ["No current task", "No active microtask", "No task progress", "No beat observed", "Fixture harness"]) expect(text(root)).toContain(s);
    expect(text(root)).not.toMatch(/0\s*\/\s*0/); expect(root.querySelector("progress")).toBeNull();
  });
  it("A3 empty membership renders both exact guidance strings", () => {
    const root = mount({ room: "demo", agents: [], progress: null, refresh_at_ms: null });
    expect(text(root)).toContain("No agents in this room"); expect(text(root)).toContain("Connect your harness and assign work");
  });
  it("Amendment B unregistered Working owner has the explicit combined status", () => {
    const vm = deriveSwarmViewModel(input()); expect(rowUnregistered(vm)).toBeTruthy();
    expect(text(mount(vm))).toContain("Working · not registered by a harness");
  });
  it("M2 missing task and registration data remain absent, with all literal absence labels", () => {
    const { lifecycle: _l, run_id: _r, swarm: _s, harness: _h, ...a } = empty();
    const root = mount({ ...viewModel([a]), progress: null });
    for (const s of ["No current task", "No active microtask", "No task progress", "No beat observed", "Not registered by a harness"]) expect(text(root)).toContain(s);
    expect(text(root)).not.toMatch(/0\s*\/\s*0/);
  });
  it("M5 lifecycle alive and Liveness unknown stay separately visible", () => {
    const root = mount(viewModel([agent({ lifecycle: "alive", activity: "unknown", last_beat_age_ms: null, last_beat_ts: null })]));
    expect(text(root)).toContain("alive"); expect(text(root)).toContain("Liveness unknown");
  });
  it.each([[0, "0s"], [999, "0s"], [1_999, "1s"], [61_999, "61s"], [90_001, "90s"]] as const)(
    "Amendment B observed age %s ms is floored to %s", (age, expected) => {
      expect(text(mount(viewModel([agent({ last_beat_ts: NOW - age, last_beat_age_ms: age })])))).toContain(expected);
    });
});
function rowUnregistered(vm: ReturnType<typeof deriveSwarmViewModel>): boolean {
  return vm.agents.length === 1 && vm.agents[0]!.lifecycle === undefined && vm.agents[0]!.activity === "working";
}

describe("A3-A4 / M6 literal blockers, provenance and hostile strings", () => {
  it("A3 shows every blocker with its downstream ID and upstream current owner, Unassigned or Missing task", () => {
    const root = mount(viewModel([agent({ activity: "waiting", waiting_on: [
      { task_id: "T01", upstream_id: "T02", owner: "executor-b", missing: false },
      { task_id: "T01", upstream_id: "T-missing", owner: null, missing: true },
      { task_id: "T04", upstream_id: "T-unassigned", owner: null, missing: false },
    ] })]));
    for (const s of ["T01", "T02", "executor-b", "T04", "T-missing", "Missing task", "T-unassigned", "Unassigned"]) expect(text(root)).toContain(s);
  });
  it.each(["harness", "swarm", "title", "blocked_reason", "reason", "agent"] as const)(
    "A4 hostile %s is literal text with no executable nodes or handlers", field => {
      const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
      const a = field === "title" || field === "blocked_reason"
        ? agent({ tasks: [task("T01", { [field]: HOSTILE })] }) : agent({ [field]: HOSTILE });
      const root = mount(viewModel([a])); expect(text(root)).toContain(HOSTILE); safe(root); expect(alert).not.toHaveBeenCalled();
    });
  it("Amendment B __proto__ slug and swarm are literal and cannot pollute group objects", () => {
    const root = mount(viewModel([agent({ agent: "__proto__", swarm: "__proto__" })]));
    expect(text(root)).toContain("__proto__ (1)"); expect(identityOrder(root, ["__proto__"])).toEqual(["__proto__"]);
    safe(root); expect(Object.prototype).not.toHaveProperty("lifecycle");
  });
  it("M2 optional lifecycle reason is visible verbatim alongside lifecycle and harness", () => {
    const root = mount(viewModel([agent({ lifecycle: "failed", reason: "Runner stopped <literal> & pending review" })]));
    for (const s of ["Failed", "Fixture harness", "Runner stopped <literal> & pending review"]) expect(text(root)).toContain(s); safe(root);
  });
});
