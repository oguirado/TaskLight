import { describe, expect, it } from "vitest";
import { foldRoomWithStats, formatUserTime, toTaskVM } from "../../../src/agents";
import { createAgentStore, toChatVM, toWallVM } from "../../../src/app/agent_store";
import type { AgentState, DriftVerdict, RoomEvent } from "../../../src/agents/types";
import type { PlanProjection, PlanTask } from "../../../src/plan";
import { adapter, event, legacyEvents, legacyState, NOW, options, projection, result, wallVM } from "./helpers";

function viewsProjection(): PlanProjection {
  const p = projection(); const base = p.tasks[0]!;
  const mk = (id: string, title: string, state: PlanTask["state"], microState: PlanTask["microtasks"][number]["state"], extra: Partial<PlanTask> = {}): PlanTask => ({
    ...base, id, title, assignee: "alice", state, microtasks: [{ ...base.microtasks[0]!, id: `${id}.M01`, text: title, state: microState }], ...extra,
  });
  return { ...p, tasks: [mk("T01", "Working now", "active", "active"), mk("T02", "Ready next", "pending", "pending"),
    mk("T03", "Dependency unfinished", "pending", "pending"),
    mk("T04", "Waiting dependent", "pending", "pending", { deps: ["T03"], ready: false }),
    mk("T05", "Blocked review", "blocked", "pending", { explicit_state: "blocked", blocked_reason: "Needs review", ready: true }),
    mk("T06", "Blocked micro", "active", "blocked")],
    rollup: { tasks_total: 6, tasks_done: 0, tasks_blocked: 1, tasks_ready: 5, micro_total: 6, micro_done: 0, progress: 0, progress_pct: 0 } };
}

describe("O7 view-only legacy adapter", () => {
  it("O7 maps twelve steps and completion detail to one canonical T01", () => {
    const s = createAgentStore(); legacyEvents().forEach(e => s.ingest(e)); const before = s.events("legacy");
    const state = s.states()[0]!; const p = adapter()(state, NOW, "human");
    expect(p).toBeDefined(); expect(p!.tasks).toHaveLength(1);
    const task = p!.tasks[0]!;
    expect(task).toMatchObject({ id: "T01", title: "Legacy twelve", assignee: "alice", rev: state.contract!.lamport, deps: [] });
    expect(task.phase).toBeTypeOf("string"); expect(task.phase.length).toBeGreaterThan(0);
    expect(task.microtasks).toHaveLength(12);
    task.microtasks.forEach((m, i) => {
      expect(m).toMatchObject({ id: `T01.M${String(i + 1).padStart(2, "0")}`, text: `Step ${i + 1}`, accept: `Accept ${i + 1}`, state: state.stepStates[i] ?? "pending" });
    });
    expect(task.microtasks[0]).toMatchObject({ outcome: "Verified", took: "2m" });
    expect(p!.rollup.progress).toBeCloseTo(1 / 12); expect(p!.rollup.micro_done).toBe(1);
    expect(s.events("legacy")).toEqual(before); expect(s.events("legacy").some(e => String(e.act) === "op")).toBe(false);
  });
  it("O7 missing step states default to pending, without mutating inputs", () => {
    const state = { ...legacyState(), stepStates: [], outcomes: [], took: [] }; const before = structuredClone(state);
    const p = adapter()(state, NOW);
    expect(p!.tasks[0]!.microtasks.every(m => m.state === "pending")).toBe(true);
    expect(p!.rollup.progress).toBe(0); expect(state).toEqual(before);
  });
  it("O7 empty legacy steps have zero progress; steps beyond twelve are bounded", () => {
    const state = legacyState(); const adapt = adapter();
    expect(adapt({ ...state, contract: { ...state.contract!, steps: [] } }, NOW)!.rollup.progress).toBe(0);
    const long = { ...state, contract: { ...state.contract!, steps: Array.from({ length: 15 }, () => ({ text: "Step" })) } };
    expect(adapt(long, NOW)!.tasks[0]!.microtasks).toHaveLength(12);
  });
  it("O7 no contract means no synthetic plan", () => {
    const state = legacyState(); delete state.contract;
    expect(adapter()(state, NOW, "human")).toBeUndefined();
  });
});

describe("O8 coexistence and legacy compatibility", () => {
  it.each(["oracle", "legacy"])("O8 v2 and legacy tasks coexist when v2 room is %s", room => {
    const state = legacyState(); const p = projection(); const before = structuredClone(p);
    const vm = wallVM([state], new Map(), options, [result(p, room)]);
    expect(vm.tasks.some(t => t.title === "Action")).toBe(true);
    expect(vm.tasks.some(t => t.title === "Legacy twelve")).toBe(true);
    expect(vm.plan?.title).toBe(p.plan!.title); expect(p).toEqual(before);
  });
  it("O8 mixed op history leaves legacy folding bit-for-bit unchanged", () => {
    const store = createAgentStore(); const history = legacyEvents("oracle");
    history.forEach(e => store.ingest(e));
    store.ingest(event(201, { act: "op", op: { kind: "memory.set", section: "notes", base_rev: 0, text: "Decision" } }));
    expect(store.states()).toEqual(foldRoomWithStats(history).states);
  });
  it("O8 legacy WallVM fields retain the established mapping exactly", () => {
    const state = legacyState(); const verdict: DriftVerdict = { verdict: "drift", reason: "Review", source: "rules" };
    const vm = toWallVM([state], new Map([["agent:legacy:alice", verdict]]), options);
    expect(vm.tasks).toEqual([toTaskVM(state, { workspace: "legacy", nowMs: NOW, accent: "rose", verdict })]);
    expect(vm).toMatchObject({ now: formatUserTime(NOW, NOW), model: options.model, network: "online", workspace: "legacy", view: "wall", archiveScope: "workspace",
      workspaces: [{ id: "legacy", name: "legacy", lens: "dev", accent: "rose" }] });
  });
});

describe("O9 human exclusion without losing chat or projection history", () => {
  it.each(["open", "question", "plan"] as const)("O9 legacy human %s never produces a task", act => {
    const store = createAgentStore(); legacyEvents("legacy", "alice").forEach(e => store.ingest(e));
    store.ingest(event(200, { agent: "human", room: "legacy", act, text: "Human message", to: "alice",
      ...(act === "plan" ? { plan: { title: "Human plan", steps: [{ text: "Human step" }] } } : {}) }));
    const vm = wallVM(store.states(), new Map(), options);
    expect(vm.tasks).toHaveLength(1); expect(vm.tasks[0]!.project).toBe("alice");
    if (act === "question") expect(toChatVM(store.states().find(s => s.agent === "alice")!, store.events("legacy"), { userAgent: "human", nowMs: NOW, sending: false }).messages.map(m => m.text)).toContain("Human message");
  });
  it("O9 adapter excludes the configured user even with a contract", () => {
    expect(adapter()({ ...legacyState(), agent: "human" }, NOW, "human")).toBeUndefined();
  });
  it("O9 human-assigned v2 task is excluded while other tasks remain", () => {
    const p = viewsProjection(); const hidden = { ...p.tasks[0]!, assignee: "human", title: "Human-only work" };
    const vm = wallVM([], new Map(), options, [result({ ...p, tasks: [hidden, p.tasks[1]!] })]);
    expect(vm.tasks.some(t => t.title === "Ready next")).toBe(true);
    expect(vm.tasks.some(t => t.title === "Human-only work" || t.assignee === "human")).toBe(false);
    expect(p.tasks).toHaveLength(6);
  });
});

describe("O10 Plan, Agenda, Diary, Archive and Memory", () => {
  it("O10 Plan band maps title, phases, progress and assigned-agent dots", () => {
    const p = projection("memory_set"); const vm = wallVM([], new Map(), options, [result(p)]);
    expect(vm.plan).toMatchObject({ id: "p1", title: p.plan!.title, phaseId: p.plan!.phase, templateId: p.plan!.template_id,
      templateHash: p.plan!.template_hash, progressPct: 50 });
    expect(vm.plan!.phases.some(f => f.id === p.plan!.phase && f.active)).toBe(true);
    expect(vm.plan!.agents.some(a => a.agent === "alice")).toBe(true);
  });
  it.each(["Now", "Next", "Blocked"])("O10 Agenda maps %s and excludes blocked-ready tasks from Next", group => {
    const vm = wallVM([], new Map(), { ...options, view: "agenda" }, [result(viewsProjection())]);
    const bucket = vm.agenda.find(g => g.group === group); expect(bucket).toBeDefined();
    const contents = JSON.stringify(bucket!.items);
    if (group === "Now") expect(contents).toContain("Working now");
    if (group === "Next") { expect(contents).toContain("Ready next"); expect(contents).not.toContain("Blocked review"); expect(contents).not.toContain("Blocked micro"); expect(contents).not.toContain("Waiting dependent"); }
    if (group === "Blocked") { expect(contents).toContain("Waiting dependent"); expect(contents).toContain("Blocked review"); expect(contents).toContain("Blocked micro"); }
    expect(vm.view).toBe("agenda");
  });
  it("O10 dependency wait and explicit blocked reason reach TaskVM", () => {
    const vm = wallVM([], new Map(), options, [result(viewsProjection())]);
    expect(vm.tasks.find(t => t.title === "Waiting dependent")?.waitsFor).toEqual(["T03"]);
    expect(vm.tasks.find(t => t.title === "Blocked review")?.blockedReason).toBe("Needs review");
    // U62 owns formatting waitsFor as 'Waits for T03'.
  });
  it("O10 done microtask detail and memory changes enter Diary with day buckets", () => {
    const vm = wallVM([], new Map(), { ...options, view: "diary" }, [result(projection("memory_set"))]);
    expect(vm.diary).toBeDefined();
    const done = vm.diary!.find(e => e.kind === "microtask"); const memory = vm.diary!.find(e => e.kind === "memory");
    expect(done).toMatchObject({ outcome: "OK", took: "1m", evidence: ["proof"] });
    expect(done!.day).toBeTypeOf("string"); expect(done!.day.length).toBeGreaterThan(0);
    expect(memory).toBeDefined(); expect(memory!.author).toBe("alice"); expect(memory!.day).toBe(done!.day);
    expect(vm.tasks[0]!.steps.find(s => s.state === "done")?.detail).toMatchObject({ outcome: "OK", evidence: ["proof"] });
  });
  it.each(["plan_close", "reopen_preserves_memory"])("O10 Archive maps closed plans from %s", name => {
    const p = projection(name); const vm = wallVM([], new Map(), { ...options, view: "archive", archiveScope: "all" }, [result(p)]);
    expect(vm.archive.length).toBeGreaterThan(0); const archived = vm.archive.find(a => a.title === "Plan");
    expect(archived).toBeDefined(); expect(archived!.outcome).toBe(p.plan?.state === "closed" ? p.plan.closed_outcome : p.archived_plans[0]!.outcome);
    expect(archived!.took).toBeTypeOf("string"); expect(archived!.took.length).toBeGreaterThan(0);
    expect((archived as unknown as { taskCount: number }).taskCount).toBe(1);
    expect(vm.archiveScope).toBe("all");
  });
  it("O10 Memory maps ts to changedAt, author, text and template metadata", () => {
    const p = projection("memory_set"); const vm = wallVM([], new Map(), { ...options, view: "memory" }, [result(p)]);
    expect(vm.memory).toBeDefined(); const section = vm.memory!.sections.find(s => s.id === "notes");
    expect(section).toMatchObject({ label: "Notes", by: "alice", text: "Decision", required: true, empty: false, maxChars: 100 });
    expect(section!.changedAt).toBe(formatUserTime(p.memory["notes"]!.ts, NOW)); expect(vm.view).toBe("memory");
  });
  it("O10 Memory flags a required empty section and works without an active plan", () => {
    const p = projection("memory_set"); const notes = p.memory["notes"]!;
    const empty = { ...p, memory: { notes: { ...notes, text: "   " } } };
    const vm = wallVM([], new Map(), { ...options, view: "memory" }, [result(empty)]);
    expect(vm.memory?.sections.find(s => s.id === "notes")).toMatchObject({ required: true, empty: true });
    const noPlan = wallVM([], new Map(), { ...options, view: "memory" }, [result(projection("memory_before_plan"))]);
    expect(noPlan.memory!.sections.some(s => s.id === "notes")).toBe(true);
  });
  it("O10 plan verdict reason/source map to nanoVerdict without inventing latency", () => {
    const verdict: DriftVerdict = { verdict: "drift", reason: "Review result", source: "device" };
    const vm = wallVM([], new Map(), { ...options, planVerdicts: new Map([["plan:oracle:T01", verdict]]) }, [result(projection())]);
    expect(vm.tasks[0]?.nanoVerdict).toMatchObject({ verdict: "drift", reason: "Review result", source: { kind: "device" } });
  });
  it("O10 op strings stay literal plain strings in VM fields", () => {
    const hostile = '<img src=x onerror="throw 1">'; const p = projection();
    const vm = wallVM([], new Map(), options, [result({ ...p, plan: { ...p.plan!, title: hostile }, tasks: [{ ...p.tasks[0]!, title: hostile,
      microtasks: [{ ...p.tasks[0]!.microtasks[0]!, text: hostile }] }] })]);
    expect(vm.plan?.title).toBe(hostile); expect(vm.tasks[0]?.title).toBe(hostile); expect(vm.tasks[0]?.steps[0]?.label).toBe(hostile);
  });
  it("O10 view/workspace/archive selections are honored", () => {
    const vm = wallVM([], new Map(), { ...options, workspace: "second", view: "archive", archiveScope: "all" }, [result(projection(), "first"), result(projection(), "second")]);
    expect(vm).toMatchObject({ workspace: "second", view: "archive", archiveScope: "all" });
  });
});

describe("O4 projection boundaries never throw on hostile values", () => {
  it.each(([null, {}, { contract: null }, { contract: { steps: null } }, { constructor: {} }] as unknown[]).map(value => [value] as const))("O4 adapter contains %j", value => {
    const adapt = adapter(); expect(() => adapt(value as unknown as AgentState, NaN, "human")).not.toThrow();
  });
  it.each(([null, {}, [null], [{ constructor: {}, contract: null }]] as unknown[]).map(value => [value] as const))("O4 toWallVM contains malformed states %j", value => {
    expect(() => wallVM(value as unknown as AgentState[], new Map(), options)).not.toThrow();
  });
  it("O4 toWallVM contains malformed projections and invalid timestamps", () => {
    const p = projection("memory_set");
    expect(() => wallVM([], new Map(), { ...options, nowMs: Infinity }, [result({ ...p, memory: { notes: { ...p.memory["notes"]!, ts: NaN } } })])).not.toThrow();
  });
});
