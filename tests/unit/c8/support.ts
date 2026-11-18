import { spawnSync } from "node:child_process";
import { expect } from "vitest";
import type { RoomEvent } from "../../../src/agents/types";
import { foldPlan } from "../../../src/plan/reducer";
import type { PlanningTemplate, PlanProjection } from "../../../src/plan/types";

type Mark = "pending" | "bound" | "finished" | "accepted" | "failed" | "held"
  | "complete" | "repaired" | "reworked";

export interface Trace {
  readonly events: readonly RoomEvent[];
  readonly relayed: readonly RoomEvent[];
  readonly template: PlanningTemplate;
  readonly title: string;
  readonly steps: readonly string[];
  readonly marks: Record<Mark, number>;
  readonly checkpoints: Record<Mark, PlanProjection>;
}

let result: ReturnType<typeof runProbe> | undefined;

function runProbe() {
  return spawnSync("python3", ["-B", "-m", "bridge.tests.room.c8.probe"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 5000, maxBuffer: 512 * 1024,
  });
}

export function trace(): Trace {
  const child = result ??= runProbe();
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(child.stderr.trim() || `Python probe exited ${child.status}`);
  return JSON.parse(child.stdout) as Trace;
}

export function replay(data: Trace, mark: Mark, relayed = false) {
  const events = (relayed ? data.relayed : data.events).slice(0, data.marks[mark]);
  const { projection } = foldPlan(events, data.template);
  expect(projection.rejected).toEqual([]);
  return { events, projection };
}

export function attempts(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(attempts);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === "attempts" && Array.isArray(child) ? child : attempts(child));
}
