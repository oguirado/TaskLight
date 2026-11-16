// Repair loop 1 regressions from the cross-family review of U37b (strategy/flights/U37b/REVIEW_1.md).
import { describe, expect, it } from "vitest";
import { createAgentStore, toChatVM } from "../../../src/app/agent_store";
import { LAUNCH, LAUNCH_EVENTS, foldAll, stateOf } from "./fixture";

describe("R1 invalid maxPerRoom never loses accepted events", () => {
  it.each([-1, 0, Number.NaN, Number.POSITIVE_INFINITY, 1.5])("maxPerRoom %s: an accepted event stays readable", (m) => {
    let store: ReturnType<typeof createAgentStore> | undefined;
    try { store = createAgentStore({ maxPerRoom: m }); } catch { return; } // refusing invalid config is acceptable
    const ev = LAUNCH_EVENTS[0]!;
    const accepted = store.ingest(ev);
    if (accepted) expect(store.events(ev.room).some((e) => e.id === ev.id)).toBe(true);
  });
});

describe("R2 out-of-range timestamps never crash", () => {
  it.each([1e100, -1e100, 8.64e15 + 1])("ts %s: ingest + toChatVM do not throw", (ts) => {
    const store = createAgentStore();
    const q = LAUNCH_EVENTS.find((e) => e.act === "question") ?? LAUNCH_EVENTS[0]!;
    const bad = { ...q, id: "e-ffffffffffffff01", lamport: 9999, ts };
    expect(() => store.ingest(bad)).not.toThrow();
    const st = stateOf(foldAll([...LAUNCH_EVENTS, bad]), LAUNCH, q.agent);
    expect(() => toChatVM(st, [...store.events(q.room), bad], { userAgent: "wall-user", nowMs: Date.now(), sending: false })).not.toThrow();
  });
});
