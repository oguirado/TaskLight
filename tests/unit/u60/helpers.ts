import { readFileSync } from "node:fs";
import { applyOp, foldPlan } from "../../../src/plan";
import type { PlanningTemplate, PlanProjection, PlanTask } from "../../../src/plan";
export interface Vector {
  id: string; templates: Record<string, PlanningTemplate>; events: unknown[];
  expected_projection: PlanProjection; expected_rejected: PlanProjection["rejected"];
}
export const vectors = (JSON.parse(readFileSync(new URL("../../../fixtures/plan/vectors.v1.json", import.meta.url), "utf8")) as {v: number; cases: Vector[]}).cases;
export const templates = (JSON.parse(readFileSync(new URL("../../../fixtures/plan/templates.v1.json", import.meta.url), "utf8")) as {v: number; templates: PlanningTemplate[]}).templates;
export const template = templates[0]!;
export function vector(id: string): Vector {
  const value = vectors.find(x => x.id === id);
  if (!value) throw new Error(`Missing shared vector: ${id}`);
  return value;
}
export const clone = <T>(x: T): T => structuredClone(x);
export function projection(id = "task_add"): PlanProjection { return clone(vector(id).expected_projection); }
export function event(n: number, op: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { id: `e-${n.toString(16).padStart(16, "0")}`, lamport: n, ts: 1_700_000_000_000 + n,
    room: "oracle", agent: "alice", act: "op", text: "", op, ...extra };
}
export function open() { return { kind: "plan.open", title: "Plan", template_id: template.id, template_hash: template.hash!, brief: {goal: "Deliver"}, phase: "start" }; }
export function add(extra: Record<string, unknown> = {}) {
  return { kind: "task.add", title: "Action", type: "action", phase: "start", accept: "Verified",
    microtasks: [{text: "Step", accept: "Verified"}], ...extra };
}
export function task(): PlanTask { return projection().tasks[0]!; }
export function accepted(p: PlanProjection, e: unknown): PlanProjection {
  const result = applyOp(p, e, template);
  if (!result.ok) throw new Error(`Expected acceptance; got ${result.code}`);
  return result.projection;
}
export function folded(events: unknown): PlanProjection { return foldPlan(events, template).projection; }
export function freeze<T>(x: T): T {
  if (x && typeof x === "object" && !Object.isFrozen(x)) {
    Object.freeze(x); for (const v of Object.values(x)) freeze(v);
  }
  return x;
}
