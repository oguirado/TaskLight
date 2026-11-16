// R1 regression tests for REVIEW.md blocking items 2-5 (fail-first).
import { describe, expect, it } from "vitest";
import { createAgentStore } from "../../../src/app/agent_store";
import type { AgentState } from "../../../src/agents/types";
import type { PlanProjection, PlanTask } from "../../../src/plan";
import { event, legacyEvents, NOW, options, projection, result, wallVM } from "./helpers";
import { formatUserTime } from "../../../src/agents";

function projectionWithMemory(text: string, room = "oracle"): PlanProjection {
  const p = projection("memory_set");
  return { ...p, memory: { notes: { id: "notes", text, rev: 1, by: "alice", ts: NOW } } };
}

describe("R1 memory workspace scoping (review item 2)", () => {
  it("same section id in two rooms selects the chosen workspace", () => {
    const vm = wallVM([], new Map(), { ...options, workspace: "second" }, [
      result(projectionWithMemory("first-text"), "first"),
      result(projectionWithMemory("second-text"), "second"),
    ]);
    expect(vm.memory?.sections).toHaveLength(1);
    expect(vm.memory?.sections[0]?.text).toBe("second-text");
  });
  it("distinct section ids do not leak across workspaces", () => {
    const p1 = projectionWithMemory("first-text");
    const p2 = projectionWithMemory("second-text");
    const p2only = { ...p2, memory: { diary: { id: "diary", text: "second-only", rev: 1, by: "alice", ts: NOW } } };
    const vm = wallVM([], new Map(), { ...options, workspace: "second" }, [
      result(p1, "first"), result(p2only, "second"),
    ]);
    expect(vm.memory?.sections.map((s) => s.text)).toEqual(["second-only"]);
  });
});

describe("R1 Agenda parent eligibility gate (review item 3)", () => {
  function base(): PlanTask {
    return projection().tasks[0]!;
  }
  function mkTask(id: string, state: PlanTask["state"], microState: PlanTask["microtasks"][number]["state"], extra: Partial<PlanTask> = {}): PlanTask {
    const b = base();
    return { ...b, id, title: id, assignee: "alice", state, microtasks: [{ ...b.microtasks[0]!, id: `${id}.M01`, text: `${id}-micro`, state: microState }], ...extra };
  }
  it("blocked, cancelled, done and dep-blocked parents keep active micros out of Now", () => {
    const p = projection();
    const dep = mkTask("T02", "pending", "pending");
    const tasks: PlanTask[] = [
      mkTask("T01", "blocked", "active", { explicit_state: "blocked", blocked_reason: "Review" }),
      dep,
      mkTask("T03", "pending", "active", { deps: ["T02"] }),
      mkTask("T04", "cancelled", "active"),
      mkTask("T05", "done", "active"),
      mkTask("T06", "active", "active"),
    ];
    const vm = wallVM([], new Map(), { ...options, view: "agenda" }, [result({ ...p, tasks })]);
    const now = vm.agenda.find((g) => g.group === "Now")?.items.map((i) => i.microId ?? i.taskId) ?? [];
    expect(now).toContain("T06.M01");
    expect(now).not.toContain("T01.M01");
    expect(now).not.toContain("T03.M01");
    expect(now).not.toContain("T04.M01");
    expect(now).not.toContain("T05.M01");
  });
});

describe("R1 Archive lifecycle timestamps (review item 4)", () => {
  it("current closed plan without archive entry never fabricates time or duration", () => {
    const p = projection("plan_close");
    const currentOnly = { ...p, archived_plans: [] };
    const a = wallVM([], new Map(), { ...options, view: "archive" }, [result(currentOnly)]);
    const b = wallVM([], new Map(), { ...options, nowMs: NOW + 86_400_000, view: "archive" }, [result(currentOnly)]);
    expect(a.archive).toHaveLength(1);
    expect(b.archive).toHaveLength(1);
    const first = a.archive[0]!;
    const second = b.archive[0]!;
    expect(first.archived).toBe("unavailable");
    expect(first.took).toBe("unavailable");
    expect(second.archived).toBe(first.archived);
    expect(second.took).toBe(first.took);
  });
  it("archived_plans timestamps derive from canonical closed_ts/opened_ts", () => {
    const p = projection("plan_close");
    const entry = p.archived_plans[0]!;
    const vm = wallVM([], new Map(), { ...options, view: "archive" }, [result(p)]);
    const archived = vm.archive.find((x) => x.id === entry.id)!;
    // Archive instant is the canonical closed_ts, not the render clock.
    expect(archived.archived).toBe(formatUserTime(entry.closed_ts, NOW));
    expect(archived.took).toBe("0s");
  });
  it("archived entry with missing timestamps shows unavailable", () => {
    const p = projection("plan_close");
    const broken = { ...p, archived_plans: [{ ...p.archived_plans[0]!, closed_ts: NaN as unknown as number }] };
    const vm = wallVM([], new Map(), { ...options, view: "archive" }, [result(broken)]);
    const archived = vm.archive.find((x) => x.id === "p1")!;
    expect(archived.archived).toBe("unavailable");
    expect(archived.took).toBe("unavailable");
  });
});

describe("R1 closed legacy archive (review item 5)", () => {
  it("closed legacy contract archives without plans; open and human states stay out", () => {
    const store = createAgentStore();
    legacyEvents("legacy", "alice").forEach((e) => store.ingest(e));
    store.ingest(event(150, { room: "legacy", agent: "alice", act: "close", text: "done" }));
    store.ingest(event(151, { room: "legacy", agent: "human", act: "plan", text: "human", plan: { title: "Human plan", steps: [{ text: "Human step" }] } }));
    store.ingest(event(152, { room: "legacy", agent: "human", act: "close", text: "done" }));
    const states = store.states();
    const vm = wallVM(states, new Map(), options);
    expect(vm.archive).toHaveLength(1);
    expect(vm.archive[0]).toMatchObject({ workspace: "legacy", title: "Legacy twelve" });
    // Preservation: legacy task list still contains the closed agent card.
    expect(vm.tasks.some((t) => t.project === "alice")).toBe(true);
  });
  it("open legacy contract produces no archive entry", () => {
    const store = createAgentStore();
    legacyEvents("legacy", "alice").forEach((e) => store.ingest(e));
    const vm = wallVM(store.states(), new Map(), options);
    expect(vm.archive).toHaveLength(0);
  });
  it("closed legacy archive fields are stable and carry agent identity", () => {
    const states: AgentState[] = [{ room: "legacy", agent: "bob", contract: { title: "Legacy title", steps: [{ text: "One step" }], hash: "01234567", version: 1, lamport: 3 }, stepStates: ["done"], outcomes: ["OK"], took: ["1m"], lastSeen: NOW, openQuestions: [], closed: true }];
    const vm = wallVM(states, new Map(), options);
    expect(vm.archive).toHaveLength(1);
    const item = vm.archive[0]!;
    expect(item).toMatchObject({ workspace: "legacy", steps: 1, outcome: "" });
    expect(item.archived).toBeTypeOf("string");
    expect(item.took).toBe("unavailable");
  });
});
