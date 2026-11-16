import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { expect } from "vitest";
import { createAgentStore, toWallVM } from "../../../src/app/agent_store";
import type { AgentStoreOptions, PlanProjectionResult } from "../../../src/app/agent_store";
import * as Starters from "../../../src/app/starter_templates";
import type { PlanningTemplate, PlanProjection } from "../../../src/plan";

export const IDS = ["blank", "web-app", "cli-library", "mobile-app", "data-ml"] as const;
export const NOW = 1_700_000_900_000;
export type Resolver = (id: string, hash: string) => PlanningTemplate | undefined;
export const opts = { nowMs: NOW, model: { state: "ready" as const, label: "Test" }, network: "online" as const };

// Python's canonical_template_json: remove only the root hash; sort keys,
// compact separators, preserve UTF-8. Starter data contains no floating numbers.
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sorted(v)]));
  }
  return value;
}
export function hash(raw: PlanningTemplate): string {
  const { hash: _ignored, ...body } = raw;
  return createHash("sha256").update(JSON.stringify(sorted(body)), "utf8").digest("hex");
}
export function template(id = "web-app"): PlanningTemplate {
  const raw = JSON.parse(readFileSync(resolve(__dirname, `../../../templates/planning/${id}.json`), "utf8")) as PlanningTemplate;
  return { ...raw, hash: hash(raw) };
}
export function starterResolver(): Resolver {
  // Namespace probe keeps a missing additive export an assertion failure.
  const candidate = (Starters as unknown as Record<string, unknown>)["resolveStarterTemplate"];
  expect(candidate, "M2 resolveStarterTemplate must be exported").toBeTypeOf("function");
  return candidate as Resolver;
}
export function storeWith(templates?: Resolver) {
  // Structural typing admits the additive option before the implementation exists.
  const options: AgentStoreOptions & { templates?: Resolver } = templates ? { templates } : {};
  return createAgentStore(options);
}
export function event(n: number, op: Record<string, unknown>, room = "oracle") {
  return { id: `e-${n.toString(16).padStart(16, "0")}`, lamport: n, ts: NOW - 1000 + n, room, agent: "alice", act: "op", text: "", op };
}
export function opening(t = template()): Record<string, unknown> {
  return { kind: "plan.open", title: "Developer plan", template_id: t.id, template_hash: t.hash, brief: { goal: "Deliver", users: "Developers", stack: "TypeScript" } };
}
export function history(t = template()) {
  const phases = t.phases;
  // plan_create: open + three additions + two dependency-setting operations.
  return [event(1, opening(t)), ...[0, 1, 2].map(i => event(i + 2, {
    kind: "task.add", title: `Task ${i + 1}`, type: t.task_types[0]!.id,
    phase: phases[i]!.id, accept: "Verified", microtasks: [{ text: "Implement", accept: "Verified" }, { text: "Check", accept: "Verified" }],
  })), event(5, { kind: "task.set", task_id: "T02", base_rev: 3, deps: ["T01"] }),
  event(6, { kind: "task.set", task_id: "T03", base_rev: 4, deps: ["T02"] })];
}
export function feed(s: ReturnType<typeof storeWith>, events = history()) {
  for (const e of events) expect(s.ingest(e), `fixture event ${e.id} accepted`).toBe(true);
  return s;
}
export function wall(s: ReturnType<typeof storeWith>) {
  return toWallVM(s.states(), new Map(), opts, s.plans());
}
export function result(projection: PlanProjection): PlanProjectionResult {
  return { room: "oracle", source: "v2", projection, invalidOps: 0 };
}
export function python<T>(script: string, input: unknown): T {
  const p = spawnSync("python3", ["-B", "-c", script], {
    input: JSON.stringify(input), encoding: "utf8", timeout: 5000, maxBuffer: 256 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  expect(p.error, "Python reference process starts and completes within its bound").toBeUndefined();
  expect(p.status, p.stderr).toBe(0);
  return JSON.parse(p.stdout) as T;
}
