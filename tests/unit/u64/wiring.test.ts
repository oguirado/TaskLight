import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlanWiring, PLAN_AI_CONCURRENCY, PLAN_REVIEW_DEBOUNCE_MS } from "../../../src/app/plan_wiring";
import { createPlanAi as realPlanAi } from "../../../src/planai/reviewer";
import type { DriftVerdict } from "../../../src/agents/types";
import type { PlanAi, PlanAiPortBinding } from "../../../src/planai/types";
import type { PlanWiring } from "../../../src/app/plan_wiring";
import { deferred, flush, harness, snapshot, task, verdict } from "./helpers";
const live: PlanWiring[] = [];
const mount = (h: ReturnType<typeof harness>) => { const w = createPlanWiring(h.deps); live.push(w); return w; };
afterEach(() => { for (const w of live.splice(0)) w.dispose(); vi.restoreAllMocks(); });

describe("U64 wiring public contract", () => {
  it("A1 zero plans has no timers, providers, AI or updates", () => {
    const h = harness([]); const w = mount(h);
    for (let i = 0; i < 10; i++) expect(w.notifyChange()).toBeUndefined();
    for (const spy of [h.clock.setTimeout, h.clock.setInterval, h.deps.getServices, h.deps.getDriftFactory, h.deps.driftPortFromFactory, h.deps.adaptDriftPort, h.createPlanAi, h.deps.onUpdate]) expect(spy).not.toHaveBeenCalled();
    expect(w.taskVerdicts().size).toBe(0); expect(w.planBriefs().size).toBe(0);
  });
  it("A2 standard context delegates services, commits both feeds and refreshes", async () => {
    const h = harness([snapshot([task(), task("T02")])]);
    h.deps = { ...h.deps, getTier: () => "standard" }; // A-U64a: tier is fail-closed private unless the room floor says standard
    h.createPlanAi.mockImplementation(opts => {
      expect(typeof opts.port).toBe("function");
      const binding = (opts.port as (mode: "PREFER_ON_DEVICE") => PlanAiPortBinding)("PREFER_ON_DEVICE");
      expect(binding.allowExternal).toBe(true);
      return { reviewTask: h.reviewTask, briefPlan: h.briefPlan };
    });
    const w = mount(h); expect(w.notifyChange()).toBeUndefined();
    expect(h.reviewTask).not.toHaveBeenCalled(); expect(h.pending.size).toBe(1);
    await h.advance();
    expect(h.createPlanAi.mock.calls[0]?.[0]?.clock?.setTimeout).toBeTypeOf("function");
    expect(h.driftPortFor).toHaveBeenCalledWith("PREFER_ON_DEVICE");
    expect(h.deps.driftPortFromFactory).not.toHaveBeenCalled();
    expect(h.reviewTask).toHaveBeenCalledTimes(2); expect(h.briefPlan).toHaveBeenCalledTimes(1);
    for (const [, ctx] of h.reviewTask.mock.calls) expect(ctx?.floor).toBe("PREFER_ON_DEVICE");
    expect(h.briefPlan.mock.calls[0]?.[1]?.floor).toBe("PREFER_ON_DEVICE");
    expect(w.taskVerdicts().get("room:T01")).toEqual(verdict());
    expect(w.planBriefs().get("room")).toEqual({ brief: "Continue", source: "device" });
    expect(h.deps.onUpdate).toHaveBeenCalled();
  });
  it.each(["device", "cloud", "local", "remote", "rules"] as const)("A3 preserves %s source without relabeling", async source => {
    const h = harness(); h.reviewTask.mockResolvedValue(verdict(source));
    const w = mount(h); w.notifyChange(); await h.advance();
    expect(w.taskVerdicts().get("room:T01")?.source).toBe(source);
  });
  it("A2 placeholder build uses the default U63 rules implementation", async () => {
    const h = harness(); const { createPlanAi: _injected, ...deps } = h.deps;
    h.deps = { ...deps, getServices: () => null, getDriftFactory: () => null };
    const w = mount(h); w.notifyChange(); await h.advance();
    expect(w.taskVerdicts().get("room:T01")?.source).toBe("rules");
    expect(w.planBriefs().get("room")?.source).toBe("rules");
    expect(h.generate).not.toHaveBeenCalled(); expect(h.deps.driftPortFromFactory).not.toHaveBeenCalled();
  });
  it.each(["schema_reject", "timeout"] as const)("A3 real U63 %s fallback stays rules", async reason => {
    const h = harness();
    if (reason === "timeout") h.generate.mockImplementation(() => new Promise(() => {}));
    else h.generate.mockResolvedValue({ text: "{}", source: "device" });
    h.deps = { ...h.deps, createPlanAi: opts => realPlanAi({ ...opts, timeoutMs: 10 }) };
    const w = mount(h); w.notifyChange(); await h.advance(300);
    expect(w.taskVerdicts().get("room:T01")?.source).toBe("rules");
  });
  it.each(["private", "kill-switch"] as const)("A4 %s uses only device context and binding", async privacy => {
    const h = harness();
    h.deps = { ...h.deps, getTier: () => privacy === "private" ? "private" : "standard", getKillSwitchCloud: () => privacy === "kill-switch" };
    h.createPlanAi.mockImplementation(opts => realPlanAi(opts));
    const w = mount(h); w.notifyChange(); await h.advance();
    expect(h.driftPortFor).toHaveBeenCalled();
    expect(h.driftPortFor.mock.calls.every(([mode]) => mode === "ONLY_ON_DEVICE")).toBe(true);
    expect(h.deps.driftPortFromFactory).not.toHaveBeenCalled();
    expect(w.taskVerdicts().has("room:T01")).toBe(true);
  });
  it.each(["private", "kill-switch"] as const)("A4 %s passes floor to tasks and briefs", async privacy => {
    const h = harness(); h.deps = { ...h.deps, getTier: () => privacy === "private" ? "private" : "standard", getKillSwitchCloud: () => privacy === "kill-switch" };
    const w = mount(h); w.notifyChange(); await h.advance();
    for (const [, ctx] of [...h.reviewTask.mock.calls, ...h.briefPlan.mock.calls]) {
      expect(ctx?.floor).toBe("ONLY_ON_DEVICE");
      if (privacy === "private") expect(ctx?.tier).toBe("private");
    }
    expect(h.reviewTask).toHaveBeenCalled(); expect(h.briefPlan).toHaveBeenCalled();
  });
  it("A5 private canaries never reach logs, storage or external modes", async () => {
    const canaries = ["CANARY_TITLE_U64", "CANARY_OUTCOME_U64", "CANARY_MEMORY_U64"];
    const t = task(); t.title = canaries[0]!; t.microtasks = [{ id: "M1", text: "Check", state: "done", outcome: canaries[1]! }];
    const s = { ...snapshot([t]), memorySection: { id: "goal", label: "Goal", text: canaries[2]!, rev: 1 } };
    const h = harness([s]); const external = vi.fn();
    h.driftPortFor.mockImplementation(mode => { if (mode !== "ONLY_ON_DEVICE") { external(mode); throw new Error("External prohibited"); } return { port: h.port, allowExternal: false }; });
    h.deps = { ...h.deps, getTier: () => "private", createPlanAi: opts => realPlanAi(opts) };
    const logs = (["log", "info", "warn", "error", "debug", "trace", "dir", "table"] as const).map(key => vi.spyOn(console, key).mockImplementation(() => {}));
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {});
    const w = mount(h); w.notifyChange(); await h.advance();
    expect(w.taskVerdicts().has("room:T01")).toBe(true); expect(external).not.toHaveBeenCalled();
    const captured = JSON.stringify([...logs.flatMap(spy => spy.mock.calls), ...storage.mock.calls]);
    for (const canary of canaries) expect(captured).not.toContain(canary);
  });
  it("A6 bursts retain one timer, stay synchronous and bound all jobs across rooms", async () => {
    const h = harness([snapshot([task(), task("T02"), task("T03")]), snapshot([task(), task("T02"), task("T03")], "other")]);
    let active = 0, peak = 0;
    const pending: (() => void)[] = [];
    const hold = <T>(value: T): Promise<T> => { active++; peak = Math.max(peak, active); return new Promise(resolve => pending.push(() => { active--; resolve(value); })); };
    h.reviewTask.mockImplementation(() => hold(verdict())); h.briefPlan.mockImplementation(() => hold({ brief: "Brief", source: "device" }));
    const w = mount(h);
    for (let i = 0; i < 5; i++) { expect(w.notifyChange()).toBeUndefined(); expect(h.pending.size).toBe(1); }
    expect(h.reviewTask).not.toHaveBeenCalled(); await h.advance(249); expect(active).toBe(0);
    await h.advance(1); expect(active).toBeGreaterThan(0); expect(peak).toBeLessThanOrEqual(2);
    for (let budget = 0; budget < 12; budget++) { pending.splice(0).forEach(resolve => resolve()); await flush(); }
    expect(h.reviewTask).toHaveBeenCalledTimes(6); expect(h.briefPlan).toHaveBeenCalledTimes(2); expect(peak).toBeLessThanOrEqual(PLAN_AI_CONCURRENCY); expect(active).toBe(0);
    expect(w.taskVerdicts().size).toBe(6); expect(PLAN_REVIEW_DEBOUNCE_MS).toBe(250);
  });
  it("A6 respects injected debounce and concurrency", async () => {
    const h = harness([snapshot([task(), task("T02")])]); h.deps = { ...h.deps, debounceMs: 20, concurrency: 1 };
    const pending = deferred<DriftVerdict>(); h.reviewTask.mockReturnValue(pending.promise);
    const w = mount(h); w.notifyChange(); await h.advance(19); expect(h.reviewTask).not.toHaveBeenCalled(); expect(h.briefPlan).not.toHaveBeenCalled();
    await h.advance(1); expect(h.reviewTask.mock.calls.length).toBeLessThanOrEqual(1);
    pending.resolve(verdict()); await flush(); expect(w.taskVerdicts().size).toBe(2);
  });
  it("A6 only changed task, memory and plan revisions are reviewed", async () => {
    const s = snapshot([task(), task("T02")]); const h = harness([s]); const w = mount(h);
    w.notifyChange(); await h.advance(); const tasks = h.reviewTask.mock.calls.length, briefs = h.briefPlan.mock.calls.length;
    w.notifyChange(); await h.advance(); expect(h.reviewTask).toHaveBeenCalledTimes(tasks); expect(h.briefPlan).toHaveBeenCalledTimes(briefs);
    h.setSnapshots([{ ...s, tasks: [task("T01", 2), task("T02")] }]); w.notifyChange(); await h.advance();
    expect(h.reviewTask).toHaveBeenCalledTimes(tasks + 1); expect(h.briefPlan).toHaveBeenCalledTimes(briefs);
    h.setSnapshots([{ ...s, tasks: [task("T01", 2), task("T02")], memorySection: { id: "goal", label: "Goal", text: "Changed", rev: 2 }, rev: 2 }]);
    w.notifyChange(); await h.advance(); expect(h.reviewTask).toHaveBeenCalledTimes(tasks + 3); expect(h.briefPlan).toHaveBeenCalledTimes(briefs + 1);
  });
  it("A7 newer task revision aborts old signal and rejects late overwrite", async () => {
    const h = harness(); const old = deferred<DriftVerdict>();
    h.reviewTask.mockImplementation(t => t.rev === 1 ? old.promise : Promise.resolve(verdict("cloud", "new")));
    const w = mount(h); w.notifyChange(); await h.advance();
    const signal = h.reviewTask.mock.calls[0]?.[1]?.signal; expect(signal).toBeInstanceOf(AbortSignal);
    h.setSnapshots([snapshot([task("T01", 2)])]); w.notifyChange(); expect(signal?.aborted).toBe(true);
    await h.advance(); old.resolve(verdict("remote", "old")); await flush();
    expect(w.taskVerdicts().get("room:T01")).toEqual(verdict("cloud", "new"));
  });
  it("A7 memory revision supersedes in-flight task review", async () => {
    const h = harness([{ ...snapshot(), memorySection: { id: "goal", label: "Goal", text: "Old", rev: 1 } }]);
    const old = deferred<DriftVerdict>(); h.reviewTask.mockReturnValueOnce(old.promise).mockResolvedValue(verdict("device", "new memory"));
    const w = mount(h); w.notifyChange(); await h.advance(); const signal = h.reviewTask.mock.calls[0]?.[1]?.signal;
    h.setSnapshots([{ ...snapshot(), memorySection: { id: "goal", label: "Goal", text: "New", rev: 2 } }]); w.notifyChange();
    expect(signal?.aborted).toBe(true); await h.advance(); old.resolve(verdict("remote", "stale memory")); await flush();
    expect(w.taskVerdicts().get("room:T01")?.reason).toBe("new memory");
  });
  it("A7 newer plan revision rejects a late brief", async () => {
    const h = harness(); const old = deferred<{ brief: string; source: "device" }>();
    h.briefPlan.mockImplementation(p => p.rev === 1 ? old.promise : Promise.resolve({ brief: "new brief", source: "device" }));
    const w = mount(h); w.notifyChange(); await h.advance(); const signal = h.briefPlan.mock.calls[0]?.[1]?.signal;
    h.setSnapshots([{ ...snapshot(), rev: 2 }]); w.notifyChange(); expect(signal?.aborted).toBe(true); await h.advance();
    old.resolve({ brief: "old brief", source: "device" }); await flush(); expect(w.planBriefs().get("room")?.brief).toBe("new brief");
  });
  it.each(["disappearance", "dispose"] as const)("A7/A10 %s discards late task and brief settlements", async action => {
    const h = harness(); const taskResult = deferred<DriftVerdict>(), briefResult = deferred<{ brief: string; source: "device" }>();
    h.reviewTask.mockReturnValue(taskResult.promise); h.briefPlan.mockReturnValue(briefResult.promise);
    const w = mount(h); w.notifyChange(); await h.advance();
    const signals = [...h.reviewTask.mock.calls.map(c => c[1]?.signal), ...h.briefPlan.mock.calls.map(c => c[1]?.signal)];
    expect(signals.length).toBeGreaterThan(0);
    if (action === "dispose") w.dispose(); else { h.setSnapshots([]); w.notifyChange(); }
    expect(signals.every(s => s?.aborted)).toBe(true);
    const updates = vi.mocked(h.deps.onUpdate).mock.calls.length;
    taskResult.resolve(verdict()); briefResult.resolve({ brief: "late", source: "device" }); await flush();
    expect(w.taskVerdicts().size).toBe(0); expect(w.planBriefs().size).toBe(0); expect(h.deps.onUpdate).toHaveBeenCalledTimes(updates);
  });
  it("A10 disposal cancels pending debounce and is idempotent", async () => {
    const h = harness(); const w = mount(h); w.notifyChange(); expect(h.pending.size).toBe(1);
    w.dispose(); w.dispose(); expect(h.pending.size).toBe(0); w.notifyChange(); await h.advance();
    expect(h.createPlanAi).not.toHaveBeenCalled(); expect(h.reviewTask).not.toHaveBeenCalled(); expect(h.deps.onUpdate).not.toHaveBeenCalled();
  });
  it("A10 disposal clears queued work as in-flight calls settle", async () => {
    const h = harness([snapshot(Array.from({ length: 6 }, (_, i) => task(`T0${i + 1}`)))]);
    const result = deferred<DriftVerdict>(); h.reviewTask.mockReturnValue(result.promise);
    const w = mount(h); w.notifyChange(); await h.advance();
    const started = h.reviewTask.mock.calls.length; expect(started).toBeGreaterThan(0); expect(started).toBeLessThanOrEqual(2);
    w.dispose(); result.resolve(verdict()); await flush();
    expect(h.reviewTask).toHaveBeenCalledTimes(started); expect(w.taskVerdicts().size).toBe(0); expect(h.pending.size).toBe(0);
  });
  it.each(["factory throw", "review throw", "review reject", "brief reject", "snapshot throw", "update throw"])("A8 isolates %s and remains callable", async fault => {
    const h = harness();
    if (fault === "factory throw") h.createPlanAi.mockImplementation(() => { throw new Error("hostile factory"); });
    if (fault === "review throw") h.reviewTask.mockImplementation(() => { throw new Error("hostile review"); });
    if (fault === "review reject") h.reviewTask.mockRejectedValue(new Error("hostile review"));
    if (fault === "brief reject") h.briefPlan.mockRejectedValue(new Error("hostile brief"));
    if (fault === "snapshot throw") h.deps = { ...h.deps, getSnapshots: () => { throw new Error("hostile snapshot"); } };
    if (fault === "update throw") h.deps = { ...h.deps, onUpdate: () => { throw new Error("hostile update"); } };
    const w = mount(h); expect(() => w.notifyChange()).not.toThrow(); await h.advance(); expect(() => w.notifyChange()).not.toThrow(); await h.advance();
  });
});
