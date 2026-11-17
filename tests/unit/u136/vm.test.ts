import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { deriveSwarmViewModel } from "../../../src/app/swarm_vm";
import type { SwarmAgentVM, SwarmRegistration, SwarmViewModel } from "../../../src/app/swarm_vm";
import { renderSwarmView } from "../../../src/views/swarm";
import { beat, deterministic, event, freeze, frozenFixture, input, micro, NOW, projection, registration, row, task } from "./fixtures";
import type { Input, Registration } from "./fixtures";

deterministic();

describe("A1 / M1-M2 frozen lifecycle membership and preserved derivation", () => {
  it("A1 includes the five lifecycle slugs exactly once, including released and terminal agents", () => {
    const vm = deriveSwarmViewModel(frozenFixture());
    expect(vm.agents.map(a => a.agent).sort()).toEqual(["executor-a", "executor-b", "executor-c", "executor-d", "executor-e"]);
    expect(row(vm, "executor-d")).toMatchObject({ lifecycle: "failed", tasks: [], current_task_id: null });
    expect(row(vm, "executor-e")).toMatchObject({ lifecycle: "finished", tasks: [] });
  });
  it("A1 preserves current microtask, selected-task done/total, blocker owner and projection rollup", () => {
    const i = frozenFixture(), vm = deriveSwarmViewModel(i);
    expect(row(vm)).toMatchObject({ current_task_id: "T01", active_micro_id: "T01.M02", micro_done: 1, micro_total: 2, activity: "working" });
    expect(row(vm, "executor-b").waiting_on).toEqual([{ task_id: "T02", upstream_id: "T01", owner: "executor-a", missing: false }]);
    expect(row(vm, "executor-c").activity).toBe("unknown");
    expect(vm.progress).toEqual(i.projection!.rollup);
  });
  it("A1 shuffled task, microtask and registration input has identical output without mutation", () => {
    const i = frozenFixture(), p = i.projection as ReturnType<typeof projection>;
    const shuffled = freeze({ ...i, projection: { ...p,
      tasks: [...p.tasks].reverse().map(t => ({ ...t, microtasks: [...t.microtasks].reverse() })),
      agent_lifecycle: Object.fromEntries(Object.entries(p.agent_lifecycle).reverse()) } });
    const before = structuredClone(shuffled);
    // Microtask source order is not a view-model ordering contract; selected fields and rendered order are.
    const summarize = (x: Input) => deriveSwarmViewModel(x).agents.map(a => ({ ...a, tasks: a.tasks.map(t => ({
      ...t, microtasks: [...t.microtasks].sort((u, v) => u.id < v.id ? -1 : u.id > v.id ? 1 : 0) })) }));
    expect(summarize(shuffled)).toEqual(summarize(i)); expect(shuffled).toEqual(before);
  });
  it("M1 committed lifecycle replaces the entire compatibility registration without inheriting harness, swarm or reason", () => {
    const committed: Registration = { lifecycle: "failed", run_id: "r2" };
    const vm = deriveSwarmViewModel(input({ agents: { "executor-a": registration({ harness: "obsolete harness", swarm: "obsolete swarm", reason: "obsolete reason" }) },
      projection: projection([task()], { "executor-a": committed }) }));
    const a = row(vm);
    expect(a.lifecycle).toBe("failed"); expect(a.run_id).toBe("r2");
    expect(a.harness).toBeUndefined(); expect(a.swarm).toBeUndefined(); expect("reason" in a && a.reason).toBeFalsy();
  });
  it("M1 committed lifecycle reason reaches an existing owner row verbatim", () => {
    const vm = deriveSwarmViewModel(input({ projection: projection([task()], {
      "executor-a": registration({ reason: "Hook reason <literal> & caller asserted" }),
    }) }));
    expect(row(vm)).toMatchObject({ lifecycle: "alive", reason: "Hook reason <literal> & caller asserted" });
  });
  it("M1 compatibility-only registrations and non-null owners remain members without inferring registration", () => {
    const vm = deriveSwarmViewModel(input({ agents: { "compat-only": registration({ lifecycle: "deployed" }) } }));
    expect(vm.agents.map(a => a.agent).sort()).toEqual(["compat-only", "executor-a"]);
    expect(row(vm).lifecycle).toBeUndefined(); expect(row(vm).harness).toBeUndefined();
  });
  it("M1 preserves exported types, the input shape, required row fields and two-argument rendering", () => {
    expectTypeOf<typeof deriveSwarmViewModel>().toBeCallableWith(input());
    expectTypeOf<ReturnType<typeof deriveSwarmViewModel>>().toEqualTypeOf<SwarmViewModel>();
    expectTypeOf<SwarmAgentVM>().toExtend<SwarmRegistration>();
    const vm: SwarmViewModel = deriveSwarmViewModel(input());
    const a: SwarmAgentVM = row(vm); const r: SwarmRegistration = registration();
    expect(a).toMatchObject({ current_task_id: "T01", active_micro_id: "T01.M01", micro_done: 0, micro_total: 1,
      activity: "working", last_beat_ts: 99_000, last_beat_age_ms: 1_000, waiting_on: [], unanswered_questions: 0 });
    expect(r.lifecycle).toBe("alive"); expect(renderSwarmView(document, vm).ownerDocument).toBe(document);
  });
  it("M2 prefers an unfinished task with active microtasks, then task and microtask code-unit IDs", () => {
    const vm = deriveSwarmViewModel(input({ projection: projection([
      task("T00", { state: "done", microtasks: [micro("T00.M01", { state: "done" })] }),
      task("T01", { state: "pending", microtasks: [micro("T01.M01", { state: "pending" })] }),
      task("T03"), task("T02", { microtasks: [micro("T02.M02"), micro("T02.M01")] }),
    ]) }));
    expect(row(vm)).toMatchObject({ current_task_id: "T02", active_micro_id: "T02.M01", micro_done: 0, micro_total: 2 });
  });
  it("M2 falls back to unfinished task then terminal task without inventing an active microtask", () => {
    const pending = task("T02", { state: "pending", microtasks: [micro("T02.M01", { state: "pending" })] });
    const done = task("T01", { state: "done", microtasks: [micro("T01.M01", { state: "done" })] });
    expect(row(deriveSwarmViewModel(input({ projection: projection([done, pending]) })))).toMatchObject({ current_task_id: "T02", active_micro_id: null });
    expect(row(deriveSwarmViewModel(input({ projection: projection([done]) })))).toMatchObject({ current_task_id: "T01", active_micro_id: null, micro_done: 1, micro_total: 1 });
  });
});

describe("A2 / M5 current-run liveness and silence expiry", () => {
  it.each([[10_000, "working", 100_001], [9_999, "unknown", null]] as const)(
    "A2 boundary beat %s gives %s with the inclusive freshness deadline", (beat_ts, activity, expiry) => {
      const i = input({ agents: { "executor-a": registration() }, projection: projection([task("T01", {
        microtasks: [micro("T01.M01", { live: beat({ beat_ts }) })] })]) });
      const vm = deriveSwarmViewModel(freeze(i));
      expect(row(vm)).toMatchObject({ activity, last_beat_ts: beat_ts, last_beat_age_ms: NOW - beat_ts });
      expect(vm.refresh_at_ms).toBe(expiry);
    });
  it("A2 reaches refresh_at_ms with a fake clock and no new event, then becomes Liveness unknown", () => {
    const i = freeze(input({ agents: { "executor-a": registration() } }));
    const vm = deriveSwarmViewModel(i); expect(vm.refresh_at_ms).toBe(189_001);
    vi.advanceTimersByTime(vm.refresh_at_ms! - NOW);
    const expired = deriveSwarmViewModel({ ...i, nowMs: Date.now() });
    expect(row(expired).activity).toBe("unknown"); expect(expired.refresh_at_ms).toBeNull(); expect(i.events).toEqual([]);
  });
  it.each([
    ["retired run", { run_id: "r0" }], ["noncurrent run", { run_id: "r2" }],
    ["wrong owner", { agent: "executor-b" }], ["future timestamp", { beat_ts: NOW + 1 }],
    ["negative timestamp", { beat_ts: -1 }], ["invalid timestamp", { beat_ts: Number.NaN }],
    ["infinite timestamp", { beat_ts: Number.POSITIVE_INFINITY }], ["invalid run", { run_id: "invalid/run" }],
    ["empty run", { run_id: "" }], ["invalid lamport", { beat_lamport: Number.NaN }],
  ] as const)("A2 rejects %s for activity, last_beat_ts and expiry", (_label, change) => {
    const vm = deriveSwarmViewModel(input({ agents: { "executor-a": registration() }, projection: projection([task("T01", {
      microtasks: [micro("T01.M01", { live: beat(change) })] })]) }));
    expect(row(vm)).toMatchObject({ activity: "unknown", last_beat_ts: null, last_beat_age_ms: null });
    expect(vm.refresh_at_ms).toBeNull();
  });
  it("M5 registration without a current run cannot accept otherwise fresh evidence", () => {
    const vm = deriveSwarmViewModel(input({ agents: { "executor-a": { harness: "Metadata only" } } }));
    expect(row(vm)).toMatchObject({ activity: "unknown", last_beat_ts: null, last_beat_age_ms: null }); expect(vm.refresh_at_ms).toBeNull();
  });
  it("M5 a fresh retired sibling cannot replace the stale current-run last beat or restore Working", () => {
    const vm = deriveSwarmViewModel(input({ agents: { "executor-a": registration() }, projection: projection([task("T01", {
      microtasks: [micro("T01.M01", { state: "done", live: beat({ run_id: "r0" }) }),
        micro("T01.M02", { live: beat({ beat_ts: 9_999 }) })],
    })]) }));
    expect(row(vm)).toMatchObject({ activity: "unknown", last_beat_ts: 9_999, last_beat_age_ms: 90_001 }); expect(vm.refresh_at_ms).toBeNull();
  });
  it("A2 missing beat evidence cannot become Working or a zero-age observed beat", () => {
    const vm = deriveSwarmViewModel(input({ agents: { "executor-a": registration() },
      projection: projection([task("T01", { microtasks: [micro()] })]) }));
    expect(row(vm)).toMatchObject({ activity: "unknown", last_beat_ts: null, last_beat_age_ms: null }); expect(vm.refresh_at_ms).toBeNull();
  });
  it.each(["failed", "finished"] as const)("A2 %s lifecycle fences a fresh current-run beat and cannot schedule Working expiry", lifecycle => {
    const vm = deriveSwarmViewModel(input({ agents: { "executor-a": registration({ lifecycle }) } }));
    expect(row(vm).activity).not.toBe("working");
    expect(row(vm)).toMatchObject({ lifecycle, last_beat_ts: null, last_beat_age_ms: null }); expect(vm.refresh_at_ms).toBeNull();
  });
  it("A2 disconnected evidence cannot produce Working or refresh_at_ms", () => {
    const vm = deriveSwarmViewModel(input({ connected: false, agents: { "executor-a": registration() } }));
    expect(row(vm).activity).toBe("unknown"); expect(vm.refresh_at_ms).toBeNull();
  });
  it.each(["blocked", "pending", "done", "cancelled"] as const)("M5 %s tasks with a fresh beat cannot schedule Working expiry", state => {
    const t = task("T01", { state, ready: state !== "pending", explicit_state: state === "cancelled" ? "cancelled" : null,
      microtasks: [micro("T01.M01", { state: state === "done" ? "done" : "active", live: beat() })] });
    expect(deriveSwarmViewModel(input({ projection: projection([t]), agents: { "executor-a": registration() } })).refresh_at_ms).toBeNull();
  });
  it("M5 expiry is the earliest eligible Working-card deadline, ignoring earlier blocked and retired beats", () => {
    const p = projection([
      task("T01", { microtasks: [micro("T01.M01", { live: beat({ beat_ts: 30_000 }) })] }),
      task("T02", { assignee: "executor-b", microtasks: [micro("T02.M01", { live: beat({ agent: "executor-b", beat_ts: 20_000 }) })] }),
      task("T03", { assignee: "executor-c", state: "blocked", microtasks: [micro("T03.M01", { live: beat({ agent: "executor-c", beat_ts: 10_000 }) })] }),
      task("T04", { assignee: "executor-d", microtasks: [micro("T04.M01", { live: beat({ agent: "executor-d", run_id: "r0", beat_ts: 10_000 }) })] }),
    ], Object.fromEntries(["a", "b", "c", "d"].map(s => [`executor-${s}`, registration()])));
    expect(deriveSwarmViewModel(input({ projection: p })).refresh_at_ms).toBe(110_001);
  });
});

describe("A3 / M2-M6 nulls, blockers and observational lifecycle", () => {
  it("A3 committed deployment survives a null plan with unknown task progress", () => {
    const p = { ...projection([], { "executor-a": registration({ lifecycle: "deployed" }) }), plan: null };
    const vm = deriveSwarmViewModel(input({ projection: p }));
    expect(row(vm)).toMatchObject({ lifecycle: "deployed", tasks: [], current_task_id: null, active_micro_id: null,
      micro_done: null, micro_total: null, last_beat_ts: null });
  });
  it("A3 compatibility deployment with projection null keeps progress and counts absent", () => {
    const vm = deriveSwarmViewModel(input({ projection: null, agents: { "executor-a": registration({ lifecycle: "deployed" }) } }));
    expect(row(vm)).toMatchObject({ current_task_id: null, active_micro_id: null, micro_done: null, micro_total: null }); expect(vm.progress).toBeNull();
  });
  it("A3 absent registrations, owners and plan mean no agents, not synthetic event-author membership", () => {
    const vm = deriveSwarmViewModel(input({ projection: null, events: [event(1), event(2, { act: "heartbeat", agent: "ghost" })] }));
    expect(vm.agents).toEqual([]); expect(vm.progress).toBeNull(); expect(vm.refresh_at_ms).toBeNull();
  });
  it("A3 every unsatisfied dependency of every unfinished owned task retains current owner and missing flag", () => {
    const p = projection([
      task("T01", { deps: ["T-missing", "T-unassigned", "T-owned", "T-done", "T-cancelled"], ready: false }),
      task("T02", { deps: ["T-owned"], ready: false }),
      task("T-owned", { assignee: "executor-b" }), task("T-unassigned", { assignee: null }),
      task("T-done", { assignee: null, state: "done" }), task("T-cancelled", { assignee: null, state: "cancelled" }),
    ]);
    expect(row(deriveSwarmViewModel(input({ projection: p }))).waiting_on).toEqual([
      { task_id: "T01", upstream_id: "T-missing", owner: null, missing: true },
      { task_id: "T01", upstream_id: "T-owned", owner: "executor-b", missing: false },
      { task_id: "T01", upstream_id: "T-unassigned", owner: null, missing: false },
      { task_id: "T02", upstream_id: "T-owned", owner: "executor-b", missing: false },
    ]);
  });
  it.each(["failed", "finished"] as const)("M4 reporting %s preserves ownership, task state, outcomes, evidence and projection", lifecycle => {
    const i = freeze(input({ projection: projection([task()], { "executor-a": registration({ lifecycle }) }) }));
    const before = structuredClone(i), vm = deriveSwarmViewModel(i);
    expect(row(vm).tasks).toEqual(before.projection!.tasks); expect(i).toEqual(before);
  });
  it("M1-M2 safely treats __proto__ and constructor as own lifecycle and owner keys", () => {
    const regs = Object.fromEntries([["__proto__", registration()], ["constructor", registration({ lifecycle: "finished" })]]);
    const p = projection([task("T01", { assignee: "__proto__", microtasks: [micro("T01.M01", { live: beat({ agent: "__proto__" }) })] })], regs);
    const vm = deriveSwarmViewModel(input({ projection: p }));
    expect(vm.agents.map(a => a.agent).sort()).toEqual(["__proto__", "constructor"]);
    expect(row(vm, "__proto__").lifecycle).toBe("alive"); expect(row(vm, "constructor").lifecycle).toBe("finished");
    expect(Object.prototype).not.toHaveProperty("lifecycle");
  });
});
