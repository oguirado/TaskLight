import { describe, expect, it } from "vitest";
import { deriveSwarmViewModel } from "../../../src/app/swarm_vm";
import { beat, deterministic, event, fixedInput, freeze, input, micro, NOW, projection, row, task } from "./fixtures";

deterministic();
describe("A1 / M1-M3 frozen projection and membership", () => {
  it("A1 fixed fixture selects T01, retains T04, reports 1/2, and exposes its upstream owner", () => {
    const i = freeze(fixedInput()), before = structuredClone(i);
    const vm = deriveSwarmViewModel(i);
    expect(vm.room).toBe("demo");
    expect(vm.agents.map(a => a.agent)).toEqual(["executor-a", "executor-b", "executor-c"]);
    expect(vm.agents.map(a => a.activity)).toEqual(["working", "working", "unknown"]);
    expect(row(vm)).toMatchObject({ current_task_id: "T01", active_micro_id: "T01.M02", micro_done: 1, micro_total: 2,
      waiting_on: [{ task_id: "T04", upstream_id: "T03", owner: "executor-c", missing: false }] });
    expect(row(vm).tasks.map(t => t.id)).toEqual(["T01", "T04"]);
    expect(vm.progress).toEqual(i.projection!.rollup);
    expect(i).toEqual(before); expect(deriveSwarmViewModel(i)).toEqual(vm);
  });
  it("M1 uses the supplied projection without replaying contradictory history", () => {
    const i = input({ events: [event(1, { act: "op", agent: "phantom", op: {
      kind: "task.claim", task_id: "T01" } }), event(2, { act: "op", op: {
      kind: "micro.set", micro_id: "T01.M01", state: "done" } })] });
    const vm = deriveSwarmViewModel(freeze(i));
    expect(vm.agents.map(a => a.agent)).toEqual(["executor-a"]);
    expect(row(vm)).toMatchObject({ activity: "working", micro_done: 0, micro_total: 1 });
    expect(row(vm).tasks).toEqual(i.projection!.tasks);
  });
  it("M3 membership never comes from authors, recipients, claims, or beats", () => {
    const vm = deriveSwarmViewModel(input({ projection: null, events: [
      event(1, { agent: "author-phantom", to: "recipient-phantom" }),
      event(2, { act: "heartbeat", agent: "beat-phantom" }),
      event(3, { act: "op", agent: "claim-phantom", op: { kind: "task.claim", task_id: "T99" } }),
      event(4, { room: "other", agent: "foreign-phantom" }),
    ] }));
    expect(vm.agents).toEqual([]); expect(vm.progress).toBeNull(); expect(vm.refresh_at_ms).toBeNull();
  });
  it("M3 deduplicates assignees and registration keys with UTF-16 agent and task ordering", () => {
    const ids = ["é", "a", "Z", "A", "😀", "\uE000"];
    const tasks = ids.map(id => task(`T${id}`, { assignee: id }));
    tasks.push(task("Tz", { assignee: "A" }), task("Ta", { assignee: "A" }), task("TZ", { assignee: "A" }));
    const vm = deriveSwarmViewModel(input({ projection: projection(tasks), agents: { A: { harness: "fixture" } } }));
    expect(vm.agents.map(a => a.agent)).toEqual(["A", "Z", "a", "é", "😀", "\uE000"]);
    expect(row(vm, "A").tasks.map(t => t.id)).toEqual(["TA", "TZ", "Ta", "Tz"]);
  });
  it.each([
    { name: "active microtask outranks an earlier unfinished task", tasks: [task("T01", { state: "pending", microtasks: [] }), task("T02")], selected: "T02" },
    { name: "first unfinished when no active microtask exists", tasks: [task("T00", { state: "done", microtasks: [] }), task("T02", { state: "pending", microtasks: [] }), task("T01", { state: "pending", microtasks: [] })], selected: "T01" },
    { name: "first owned when all tasks are finished", tasks: [task("T02", { state: "cancelled", microtasks: [] }), task("T01", { state: "done", microtasks: [] })], selected: "T01" },
    { name: "finished active children never outrank unfinished work", tasks: [task("T00", { state: "cancelled" }), task("T01", { state: "pending", microtasks: [] })], selected: "T01" },
  ])("M3 selection: $name", ({ tasks, selected }) => {
    const vm = deriveSwarmViewModel(input({ projection: projection(tasks) }));
    expect(row(vm).current_task_id).toBe(selected); expect(row(vm).tasks).toHaveLength(tasks.length);
  });
  it("M3 selects the first active microtask by UTF-16 ID, not array position", () => {
    const vm = deriveSwarmViewModel(input({ projection: projection([task("T01", { microtasks: [
      micro("T01.a"), micro("T01.Z"), micro("T01.A", { state: "done" }), micro("T01.b", { state: "pending" }),
    ] })]) }));
    expect(row(vm)).toMatchObject({ active_micro_id: "T01.Z", micro_done: 1, micro_total: 4 });
  });
  it("M3 no active child means null micro selection and selected-task counts only", () => {
    const vm = deriveSwarmViewModel(input({ projection: projection([
      task("T01", { state: "pending", microtasks: [] }),
      task("T02", { state: "done", microtasks: [micro("T02.M01", { state: "done" })] }),
    ]) }));
    expect(row(vm)).toMatchObject({ current_task_id: "T01", active_micro_id: null, micro_done: 0, micro_total: 0 });
  });
  it("M3 preserves rollup values rather than reconstructing progress from visible agents", () => {
    const p = projection([task("T01", { assignee: null })]);
    const vm = deriveSwarmViewModel(input({ projection: p }));
    expect(vm.agents).toEqual([]); expect(vm.progress).toEqual(p.rollup);
  });
});

describe("A3 / M5-M6 dependencies and activity precedence", () => {
  it.each(["pending", "active", "blocked"] as const)("A3 %s upstream remains an unsatisfied dependency", state => {
    const vm = deriveSwarmViewModel(input({ projection: projection([
      task("T01", { deps: ["T02"], ready: false }), task("T02", { state, assignee: "executor-b" }),
    ]) }));
    expect(row(vm).activity).toBe("waiting");
    expect(row(vm).waiting_on).toEqual([{ task_id: "T01", upstream_id: "T02", owner: "executor-b", missing: false }]);
    expect(row(vm).tasks[0]?.state).toBe("active");
  });
  it.each(["done", "cancelled"] as const)("A3 %s upstream satisfies dependency without inventing completion", state => {
    const vm = deriveSwarmViewModel(input({ projection: projection([
      task("T01", { deps: ["T02"] }), task("T02", { state, assignee: "executor-b" }),
    ]) }));
    expect(row(vm).waiting_on).toEqual([]); expect(row(vm).activity).toBe("working");
    expect(row(vm).tasks[0]?.state).toBe("active");
  });
  it("A3 distinguishes missing and unassigned upstreams across all unfinished owned tasks", () => {
    const vm = deriveSwarmViewModel(input({ projection: projection([
      task("T01", { deps: ["missing"], ready: false }),
      task("T02", { deps: ["T03"], ready: false }), task("T03", { assignee: null, state: "pending" }),
    ]) }));
    expect(row(vm).waiting_on).toHaveLength(2);
    expect(row(vm).waiting_on).toEqual(expect.arrayContaining([
      { task_id: "T01", upstream_id: "missing", owner: null, missing: true },
      { task_id: "T02", upstream_id: "T03", owner: null, missing: false },
    ]));
  });
  it.each(["done", "cancelled"] as const)("Amendment B excludes %s owned tasks from waiting_on", state => {
    const vm = deriveSwarmViewModel(input({ projection: projection([task("T01", {
      state, ready: false, deps: ["missing"], microtasks: state === "done" ? [micro("T01.M01", { state: "done" })] : [],
    })]) }));
    expect(row(vm).waiting_on).toEqual([]); expect(row(vm).activity).toBe(state);
  });
  it.each([
    { name: "cancelled precedes done, block and wait", extra: { state: "cancelled", explicit_state: "blocked", ready: false, microtasks: [micro("T01.M01", { state: "done" })] } as const, expected: "cancelled" },
    { name: "explicit cancellation precedes fresh work", extra: { explicit_state: "cancelled" } as const, expected: "cancelled" },
    { name: "done precedes blocked and waiting", extra: { state: "done", explicit_state: "blocked", ready: false } as const, expected: "done" },
    { name: "all done children precede waiting", extra: { ready: false, microtasks: [micro("T01.M01", { state: "done" })] }, expected: "done" },
    { name: "explicit block precedes waiting and fresh work", extra: { explicit_state: "blocked", blocked_reason: "Literal upstream failure", ready: false } as const, expected: "blocked" },
    { name: "blocked child precedes waiting and fresh siblings", extra: { ready: false, microtasks: [micro("T01.M01", { state: "blocked" }), micro("T01.M02", { live: beat() })] }, expected: "blocked" },
    { name: "waiting precedes fresh work", extra: { ready: false }, expected: "waiting" },
    { name: "no active child is idle", extra: { state: "pending", microtasks: [micro("T01.M01", { state: "pending" })] } as const, expected: "idle" },
  ])("M5 $name", ({ extra, expected }) => {
    const vm = deriveSwarmViewModel(input({ projection: projection([task("T01", extra)]) }));
    expect(row(vm).activity).toBe(expected); expect(vm.refresh_at_ms).toBeNull();
  });
});

describe("A5 / M4 registration", () => {
  it("A5 empty inputs yield empty agents, null progress and no refresh", () => {
    const vm = deriveSwarmViewModel(input({ projection: null, events: [], agents: {} }));
    expect(vm).toEqual({ room: "demo", agents: [], progress: null, refresh_at_ms: null });
  });
  it.each([null, projection(), projection([task()])])("A5 registration-only rows have no work regardless of projection %#", p => {
    const vm = deriveSwarmViewModel(input({ projection: p, agents: { registered: { harness: "Fixture Harness" } } }));
    expect(row(vm, "registered")).toMatchObject({ tasks: [], current_task_id: null, active_micro_id: null,
      micro_done: null, micro_total: null, activity: "idle", last_beat_ts: null, last_beat_age_ms: null,
      waiting_on: [], unanswered_questions: 0, harness: "Fixture Harness" });
    expect(vm.progress).toEqual(p?.rollup ?? null);
  });
  it.each(["deployed", "alive", "finished", "failed"] as const)("A5 lifecycle %s survives independently of task activity", lifecycle => {
    const registration = { lifecycle, run_id: "harness_run", swarm: "fixture-swarm", harness: "Fixture Harness" };
    const i = freeze(input({ agents: { "executor-a": registration } })), before = structuredClone(i);
    const vm = deriveSwarmViewModel(i);
    // A-U136a: U136 M4/M5 - terminal lifecycle and non-current run_id cannot restore Working; registration fields still survive
    expect(row(vm)).toMatchObject({ ...registration }); expect(i).toEqual(before);
  });
  it.each([{ lifecycle: "alive" } as const, { run_id: "run_only" }, { swarm: "swarm_only" }, { harness: "harness_only" }, {}])(
    "M4 preserves each optional registration field without synthesizing the others %#", registration => {
      const vm = deriveSwarmViewModel(input({ agents: { "executor-a": registration } }));
      for (const key of ["lifecycle", "run_id", "swarm", "harness"] as const) {
        expect(row(vm)[key]).toEqual((registration as Partial<Record<typeof key, string>>)[key]);
      }
    });
  it("A5 W1 task owners have no invented registration", () => {
    const vm = deriveSwarmViewModel(input());
    for (const key of ["lifecycle", "run_id", "swarm", "harness"] as const) expect(row(vm)[key]).toBeUndefined();
  });
  it("Amendment B treats __proto__ and constructor as own identifiers without prototype pollution", () => {
    const agents = JSON.parse('{"__proto__":{"harness":"Proto harness"},"constructor":{"swarm":"Own swarm"}}') as Record<string, { harness?: string; swarm?: string }>;
    const before = Object.getOwnPropertyDescriptors(Object.prototype);
    const vm = deriveSwarmViewModel(input({ projection: projection([task("__proto__", { assignee: "__proto__" })]), agents }));
    expect(vm.agents.map(a => a.agent)).toEqual(["__proto__", "constructor"]);
    expect(row(vm, "__proto__")).toMatchObject({ harness: "Proto harness", current_task_id: "__proto__" });
    expect(row(vm, "constructor").swarm).toBe("Own swarm");
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(before);
  });
});
