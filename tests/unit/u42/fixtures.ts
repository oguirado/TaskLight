// U42 shared fixtures: room events for ViewPoint-like agents (synthetic, no real runs).
import type { RoomEvent } from "../../../src/agents/types";

export const ROOM = "viewpoint";
export const T0 = 1_700_000_000_000;
let seq = 0;
export const idOf = (n: number): string => `e-${n.toString(16).padStart(16, "0")}`;
export function ev(agent: string, act: RoomEvent["act"], text: string, extra: Partial<RoomEvent> = {}, ts = T0): RoomEvent {
  seq += 1;
  return { id: idOf(seq), lamport: seq, ts, room: ROOM, agent, act, text, ...extra };
}
export const plan = (agent: string, title: string, steps: string[], ts = T0): RoomEvent =>
  ev(agent, "plan", title, { plan: { title, steps: steps.map((text) => ({ text })) } }, ts);
export const step = (agent: string, index: number, state: "done" | "active" | "blocked" | "pending", outcome?: string, ts = T0): RoomEvent =>
  ev(agent, "step", outcome ?? "", { step: outcome === undefined ? { index, state } : { index, state, outcome } }, ts);
export const close = (agent: string, text: string, ts = T0): RoomEvent => ev(agent, "close", text, {}, ts);

/** A finished run: n steps done ("verified"), then close. */
export function finished(agent: string, title: string, n: number, closeText: string, ts = T0): RoomEvent[] {
  const labels = Array.from({ length: n }, (_, i) => `step ${i + 1}`);
  const out: RoomEvent[] = [plan(agent, title, labels, ts)];
  for (let i = 0; i < n; i++) out.push(step(agent, i, "done", "verified", ts));
  out.push(close(agent, closeText, ts));
  return out;
}
