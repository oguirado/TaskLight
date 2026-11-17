import { expect } from "vitest";
import type { RoomEvent } from "../../../src/agents/types";
import type { AgentStore, PlanProjectionResult, TemplateResolver } from "../../../src/app/agent_store";
import { applyOp, emptyProjection } from "../../../src/plan";
import type { PlanningTemplate, PlanProjection } from "../../../src/plan";
import { canonicalStarterTemplateHash, resolveStarterTemplate } from "../../../src/app/starter_templates";
import autonomous from "../../../templates/planning/autonomous-software.json";
import blank from "../../../templates/planning/blank.json";

export const CLOCK = 1_700_000_100_000;
export const A = resolveStarterTemplate(autonomous.id, canonicalStarterTemplateHash(autonomous))!;
export const B = resolveStarterTemplate(blank.id, canonicalStarterTemplateHash(blank))!;
export const resolver: TemplateResolver = resolveStarterTemplate;
export const FIRST_TITLE = "Swarm fixture";
export const SECOND_TITLE = "Second plan";
export const MISSION = "Preserve each plan generation and its archive";

export function event(n: number, op: Record<string, unknown>, extra: Partial<RoomEvent> = {}): RoomEvent {
  return { id: `e-${n.toString(16).padStart(16, "0")}`, room: "demo", agent: "harness",
    act: "op", text: "", ts: CLOCK - 1000 + n, lamport: n,
    op: { ...op, op_id: typeof op["op_id"] === "string" ? op["op_id"] : `u161-operation-${n}` } as NonNullable<RoomEvent["op"]>, ...extra };
}
export function opening(template: PlanningTemplate, title: string): Record<string, unknown> {
  return { kind: "plan.open", template_id: template.id, template_hash: template.hash,
    title, brief: { goal: "Preserve archive continuity" } };
}
export function task(template: PlanningTemplate): Record<string, unknown> {
  return { kind: "task.add", title: `${template.id} work`, type: template.task_types[0]!.id,
    phase: template.phases[0]!.id, accept: "Verified archive continuity",
    microtasks: [{ text: "Prepare the check" }, { text: "Verify the check" }] };
}
export function history(): RoomEvent[] {
  return [
    event(1, opening(A, FIRST_TITLE)),
    event(2, { kind: "memory.set", section: "mission", text: MISSION, base_rev: 0 }),
    event(3, task(A)),
    event(4, { kind: "task.set", task_id: "T01", base_rev: 3, state: "cancelled" }),
    event(5, { kind: "plan.phase", phase: "design", base_rev: 1 }),
    event(6, { kind: "plan.close", base_rev: 5, outcome: "Retired to verify archive continuity" }),
    event(7, opening(B, SECOND_TITLE)),
    event(8, { kind: "memory.set", section: "goal", text: "Check the second plan", base_rev: 0 }),
    event(9, task(B)),
    event(10, { kind: "plan.phase", phase: "execute", base_rev: 7 }),
  ];
}
export function admit(store: AgentStore, events: readonly RoomEvent[]): void {
  for (const item of events) expect(store.ingestChecked(item), `shape admission at ${item.lamport}`).toBe("accepted");
}
// Existing applyOp is used only to construct a known-valid expectation. No proposed
// foldPlan signature, cache representation or resolver call count is prescribed.
export function expectedProjection(events: readonly RoomEvent[], resolve: TemplateResolver = resolver): PlanProjection {
  let projection = emptyProjection();
  let active: PlanningTemplate | undefined;
  const sorted = [...events].sort((a, b) => a.lamport - b.lamport || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const item of sorted) {
    const op = item.op!;
    const candidate = op["kind"] === "plan.open"
      ? resolve(String(op["template_id"]), String(op["template_hash"])) : active;
    const result = applyOp(projection, item, candidate);
    expect(result.ok, `known-valid reference event ${item.lamport}`).toBe(true);
    if (result.ok && !result.replayed && op["kind"] === "plan.open") active = candidate;
    projection = result.projection;
  }
  return projection;
}
export function expectClean(result: PlanProjectionResult | undefined, expected: PlanProjection): void {
  expect(result, "a v2 plan projection must exist").toBeDefined();
  expect(result!.invalidOps, "valid operation shapes").toBe(0);
  expect(result!.rejectedOps ?? 0, "each generation must use its own template").toBe(0);
  expect(result!.errors ?? [], "valid template transitions produce no domain diagnostics").toEqual([]);
  expect(result!.projection.rejected).toEqual([]);
  expect(result!.projection).toEqual(expected);
}
