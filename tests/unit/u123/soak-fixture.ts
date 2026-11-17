// Shared deterministic fixture; its independent golden hash is pinned in hardening.test.ts.
import { BASE, beat, event, fixture, op } from "./oracle";
import type { RoomEvent } from "../../../src/agents/types";

export const SOAK_COUNT = 100_000;
export const SOAK_SEED = 0x1235eed;
export const SOAK_ROOM = "u123-soak";
export function* soakHistory(): Generator<RoomEvent> {
  let random = SOAK_SEED;
  for (let i = 0; i < SOAK_COUNT; i++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    let e: RoomEvent;
    if (i < 5) e = { ...fixture()[i]! };
    else if (i % 20_000 === 0) e = op(i + 1, { kind: "memory.set", section: "notes", text: `soak-${random}`,
      base_rev: i === 20_000 ? 0 : i - 20_000 + 1 });
    else if (i % 128 === 0) e = beat(i + 1, { ts: BASE + i }, `run_${Math.floor(i / 4096)}`);
    else e = event(i + 1, { ts: BASE + i, agent: random % 4 === 0 ? "bob" : "alice", text: `soak ${random} é😀` });
    yield { ...e, room: SOAK_ROOM };
  }
}
