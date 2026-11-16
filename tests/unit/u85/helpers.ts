import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect } from "vitest";
import type { RoomEvent } from "../../../src/agents/types";
import type { PlanningTemplate, PlanProjection } from "../../../src/plan";
import type { AgentStore } from "../../../src/app/agent_store";
export { EXT_ID, FakeAppClock, FakeExtClock, FakeNative, PagePort, pageRuntime, idOf } from "../u37c/harness";

export const ROOT = process.cwd();
export const CURRENT_HASH = "2b504639f69d0f5ced71cbee6bd4363d838aa6536b37d69b6cf21154060fbe65";
export const HISTORICAL_HASH = "19e0b7d9f2aebc331061f4d9199343ef28b2f2f1302395319f52b2394574bf1f";
export const FLOOR = "ONLY_ON_DEVICE" as const;
export const HELLO = { t: "room_hello", v: 1, rooms: [{ room: "demo", floor: FLOOR }], agent: "alice" };
export interface Frame { t: string; [key: string]: unknown }
const raw = JSON.parse(readFileSync(resolve(ROOT, "tests/unit/u85/fixture.json"), "utf8")) as {
  template: PlanningTemplate; events: RoomEvent[];
};
export const template = raw.template;
export const fixture = (): RoomEvent[] => structuredClone(raw.events);
export const event = (n: number, extra: Record<string, unknown> = {}): RoomEvent => ({
  id: `e-${n.toString(16).padStart(16, "0")}`, room: "demo", agent: "alice", act: "heartbeat",
  text: "", ts: 1_700_000_000_000 + n, lamport: n, ...extra,
}) as RoomEvent;
export const opEvent = (n: number, op: Record<string, unknown>): RoomEvent => event(n, { act: "op", op });
export const eventFrame = (ev: RoomEvent, rid?: string): Frame => ({
  t: "room_event", v: 1, room: ev.room, floor: FLOOR, event: ev,
  ...(rid === undefined ? {} : { rid }),
});
export const gapFrame = (over: Record<string, unknown> = {}): Frame => ({
  t: "room_gap", v: 1, room: "demo", from_lamport: 8, to_lamport: 8,
  reason: "sanitize_failed", ...over,
});
export const synced = (rid: unknown, upto = 9, more = false): Frame => ({
  t: "room_synced", v: 1, room: "demo", rid, upto, more,
});
export function pythonRelay(request: Record<string, unknown> = {}): { frames: Frame[]; projection: PlanProjection } {
  const r = spawnSync("python3", ["-B", "-m", "bridge.tests.wall.u85.relay_fixture"], {
    cwd: ROOT, input: JSON.stringify(request), encoding: "utf8", timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (r.error !== undefined) throw r.error;
  if (r.status !== 0) throw new Error(`Fixture driver failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as { frames: Frame[]; projection: PlanProjection };
}
// Only the explicitly specified additive API is described here. No fallback implementation.
export function checked(store: AgentStore, ev: unknown): "accepted" | "duplicate" | "invalid" {
  const amended = store as AgentStore & {
    ingestChecked(ev: unknown): "accepted" | "duplicate" | "invalid";
  };
  expect(amended.ingestChecked, "M2 requires ingestChecked").toBeTypeOf("function");
  return amended.ingestChecked(ev);
}
