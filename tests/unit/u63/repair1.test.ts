import { describe, expect, it, vi } from "vitest";
import { createPlanAi } from "../../../src/planai/reviewer";
import { buildPlanBriefInput, buildTaskReviewInput } from "../../../src/planai/prompt";
import { briefPlanRules } from "../../../src/planai/rules";
import type { PlanAi, ReviewContext } from "../../../src/planai/types";
import { task, plan, fakePort, fakeClock, deferred, response, flush, tracked, records } from "./helpers";

describe("repair1 review regressions", () => {
 it("accepts ReviewContext including memory", async () => {
  const ai: PlanAi = createPlanAi();
  const ctx: ReviewContext = { memory: { id: "m1", label: "L", text: "T", rev: 1 } };
  expect((await ai.reviewTask(task(), ctx)).source).toBe("rules");
 });
 it.each(["review", "brief"] as const)("rechecks current binding permissions for cached %s", async job => {
  let allowExternal = true;
  const { port, generate } = fakePort(async () => response("remote"));
  const onFallback = vi.fn();
  const ai = createPlanAi({ port: () => ({ port, allowExternal }), onFallback });
  const run = () => job === "review" ? ai.reviewTask(task()) : ai.briefPlan(plan());
  expect((await run()).source).toBe("remote");
  allowExternal = false;
  expect((await run()).source).toBe("rules");
  expect(onFallback).toHaveBeenLastCalledWith(job === "review" ? "task_review" : "plan_brief", "source_rejected");
  expect(generate).toHaveBeenCalledTimes(2);
 });
 it.each(["review", "brief"] as const)("immediately cancels queued %s without invoking it later", async job => {
  const pending = deferred<ReturnType<typeof response>>();
  const { port, generate } = fakePort(() => pending.promise);
  const clock = fakeClock();
  const onFallback = vi.fn();
  const ai = createPlanAi({ port, clock: clock.clock, onFallback });
  const first = ai.reviewTask(task());
  await flush();
  const controller = new AbortController();
  const second = job === "review" ? ai.reviewTask(task({ id: "T02" }), { signal: controller.signal })
   : ai.briefPlan(plan(), { signal: controller.signal });
  const state = tracked<{ source: string }>(second);
  controller.abort();
  await flush();
  expect(state.settled).toBe(true);
  expect(state.value?.source).toBe("rules");
  expect(onFallback).toHaveBeenLastCalledWith(job === "review" ? "task_review" : "plan_brief", "aborted");
  pending.resolve(response());
  await first;
  await flush();
  expect(generate).toHaveBeenCalledTimes(1);
 });
 it.each([{}, null, [], { id: "T01", microtasks: [] }])("rejects malformed inputs before resolving a successful port: %j", async malformed => {
  const { port, generate } = fakePort();
  const resolver = vi.fn(() => port);
  const ai = createPlanAi({ port: resolver });
  expect((await ai.reviewTask(malformed as never)).source).toBe("rules");
  expect((await ai.briefPlan(malformed as never)).source).toBe("rules");
  expect(resolver).not.toHaveBeenCalled();
  expect(generate).not.toHaveBeenCalled();
 });
 it("rejects invalid nested shapes and scalars before resolving", async () => {
  const resolver = vi.fn(() => fakePort().port);
  const ai = createPlanAi({ port: resolver });
  for (const input of [task({ rev: NaN }), task({ status: "invalid" as never }), task({ microtasks: [null as never] }), task({ deps: [2 as never] })])
   expect((await ai.reviewTask(input)).source).toBe("rules");
  for (const input of [plan({ totalMicrotasks: Infinity }), plan({ tasks: [null as never] }), plan({ tasks: [{ ...plan().tasks[0]!, ready: "yes" as never }] })])
   expect((await ai.briefPlan(input)).source).toBe("rules");
  expect(resolver).not.toHaveBeenCalled();
 });
 it("reports dependency-waiting pending tasks with blocker IDs", () => {
  const input = plan({ tasks: [{ id: "T02", title: "Ship", state: "pending", ready: false, waitsFor: ["T01"] }] });
  const result = briefPlanRules(input);
  expect(result.brief).toContain("T02 waits for T01");
  expect(result.brief).not.toContain("0 blocked");
 });
 it.each(["done-first", "active-first"] as const)("retains next and representative blockers for %s large rollups", order => {
  const tasks = Array.from({ length: 40 }, (_, i) => ({ id: `T${String(i + 1).padStart(2, "0")}`, title: "t".repeat(120),
   state: (order === "done-first" ? i === 35 ? "active" : i >= 36 ? "blocked" : "done" : i < 20 ? "active" : "blocked") as "active" | "blocked" | "done",
   ready: order === "done-first" ? i === 35 : i < 20, waitsFor: i >= (order === "done-first" ? 36 : 20) ? ["T01", "T02", "T03"] : [] }));
  const input = plan({ tasks });
  const packed = buildPlanBriefInput(input);
  expect(packed.length).toBeLessThanOrEqual(1500);
  const all = records(JSON.parse(packed));
  expect(all.some(r => r["state"] === "active")).toBe(true);
  expect(all.some(r => r["state"] === "blocked" && (r["waitsFor"] as string[]).includes("T01"))).toBe(true);
  expect(buildPlanBriefInput(input)).toBe(packed);
 });
 it("caps hostile status fields and always emits complete JSON", () => {
  for (const status of ["x".repeat(1500), '\n"\\'.repeat(1500)]) {
   const packedTask = buildTaskReviewInput(task({ status: status as never }));
   const packedPlan = buildPlanBriefInput(plan({ status: status as never }));
   for (const packed of [packedTask, packedPlan]) {
    expect(packed.length).toBeLessThanOrEqual(1500);
    expect(() => JSON.parse(packed)).not.toThrow();
   }
   expect(JSON.parse(packedTask).task.status.length).toBeLessThanOrEqual(32);
   expect(JSON.parse(packedPlan).status.length).toBeLessThanOrEqual(32);
  }
 });
});
