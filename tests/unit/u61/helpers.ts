// Test data and contract probes only; no product implementation.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";
import * as Store from "../../../src/app/agent_store";
import type { AgentStore, WallOpts } from "../../../src/app/agent_store";
import type { AgentState, DriftVerdict, RoomEvent } from "../../../src/agents/types";
import type { PlanProjection, PlanningTemplate } from "../../../src/plan";
import type { WallVM } from "../../../src/views/types";
import type { PlanVM, MemoryVM, DiaryEntryVM, TaskVM } from "../../../src/views/plan";

export const NOW = 1_700_000_900_000;
export const id = (n: number): string => `e-${n.toString(16).padStart(16, "0")}`;
export const event = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: id(n), lamport: n, ts: 1_700_000_000_000 + n, room: "oracle", agent: "alice", act: "open", text: "", ...extra,
});
export const opEvent = (n: number, op: Record<string, unknown>, extra: Record<string, unknown> = {}) => event(n, { act: "op", op, ...extra });
export interface Vector { id: string; templates: Record<string, PlanningTemplate>; events: Record<string, unknown>[];
  expected_projection: PlanProjection; expected_rejected: PlanProjection["rejected"] }
export const vectors = (JSON.parse(readFileSync(resolve(__dirname, "../../../fixtures/plan/vectors.v1.json"), "utf8")) as { cases: Vector[] }).cases;
export function vector(name: string): Vector {
  const found = vectors.find(v => v.id === name);
  expect(found, `shared fixture ${name}`).toBeDefined();
  return structuredClone(found!);
}
export const projection = (name = "task_add"): PlanProjection => vector(name).expected_projection;
export const openOp = (): Record<string, unknown> => structuredClone(vector("plan_open").events[0]!["op"] as Record<string, unknown>);
export const options: WallOpts = { nowMs: NOW, model: { state: "ready", label: "Test model" }, network: "online", userAgent: "human" };
export interface ProjectionResult { room: string; source: "v2" | "legacy"; projection: PlanProjection; invalidOps: number }
export interface PlanStore extends AgentStore { plan(room: string): ProjectionResult | undefined; plans(): ProjectionResult[] }
export function planStore(store = Store.createAgentStore()): PlanStore {
  const candidate = store as PlanStore;
  expect(candidate.plan, "U61 AgentStore.plan must be exposed").toBeTypeOf("function");
  expect(candidate.plans, "U61 AgentStore.plans must be exposed").toBeTypeOf("function");
  return candidate;
}
export function adapter(): (s: AgentState, nowMs: number, userAgent?: string) => PlanProjection | undefined {
  const fn = (Store as unknown as Record<string, unknown>)["adaptLegacyAgentToPlan"];
  expect(fn, "U61 view-only legacy adapter must be exported").toBeTypeOf("function");
  return fn as (s: AgentState, nowMs: number, userAgent?: string) => PlanProjection | undefined;
}
export interface PlanOpts extends WallOpts { view?: "wall" | "agenda" | "diary" | "archive" | "memory";
  workspace?: string; archiveScope?: "workspace" | "all"; planVerdicts?: ReadonlyMap<string, DriftVerdict> }
export type ExtendedVM = Omit<WallVM, "view" | "tasks"> & { view: PlanOpts["view"]; tasks: readonly TaskVM[];
  plan?: PlanVM; memory?: MemoryVM; diary?: readonly DiaryEntryVM[] };
// Structural casts let missing additive APIs fail as assertions, not import/type errors.
export const wallVM = Store.toWallVM as unknown as (states: readonly AgentState[], verdicts: ReadonlyMap<string, DriftVerdict>, opts: PlanOpts, plans?: readonly ProjectionResult[]) => ExtendedVM;
export const result = (p: PlanProjection, room = "oracle"): ProjectionResult => ({ room, source: "v2", projection: p, invalidOps: 0 });
export function legacyEvents(room = "legacy", agent = "alice"): RoomEvent[] {
  return [event(101, { room, agent, act: "plan", plan: { title: "Legacy twelve", steps: Array.from({ length: 12 }, (_, i) => ({ text: `Step ${i + 1}`, accept: `Accept ${i + 1}` })) } }),
    event(102, { room, agent, act: "step", step: { index: 0, state: "done", outcome: "Verified", took: "2m" } }),
    event(103, { room, agent, act: "step", step: { index: 1, state: "active" } })] as unknown as RoomEvent[];
}
export function legacyState(): AgentState {
  const s = Store.createAgentStore(); legacyEvents().forEach(e => s.ingest(e));
  return s.states()[0]!;
}
export const order = (a: Record<string, unknown>, b: Record<string, unknown>): number =>
  Number(a["lamport"]) - Number(b["lamport"]) || (String(a["id"]) < String(b["id"]) ? -1 : String(a["id"]) > String(b["id"]) ? 1 : 0);
