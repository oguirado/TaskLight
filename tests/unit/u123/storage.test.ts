// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AgentStore } from "../../../src/app/agent_store";
import { bytes, beat, event, fixture, makeStore } from "./oracle";
import { retainedEnvelopes, storageGate } from "./retained-heap";

function prepare(room: string, count: number, mode: "nonop" | "mixed" | "bytes"): { store: AgentStore; sizes: Map<string, number> } {
  const store = makeStore(mode === "nonop" ? {} : mode === "bytes" ? { maxPerRoom: 2, maxBytesPerRoom: 1 } : { maxPerRoom: 2 });
  const sizes = new Map<string, number>();
  for (const original of fixture().slice(0, 5)) {
    const e = { ...original, room }; sizes.set(e.id, bytes(e));
    if (store.ingestChecked(e) !== "accepted") throw new Error("invalid semantic storage fixture");
  }
  for (let n = 100; n < 100 + count; n++) {
    const e = mode === "mixed" && n % 2 === 0 ? beat(n, { room }) : event(n, { room, text: `raw probe ${n} 😀` });
    sizes.set(e.id, bytes(e));
    if (store.ingestChecked(e) !== "accepted") throw new Error("invalid recent storage fixture");
  }
  // No returned raw event arrays or original fixture objects escape this scope.
  store.plan(room); store.states();
  const holder = { store, sizes, __u123HeapRoot: room, candidate: store };
  return holder;
}

describe("U123 A1/M1/M4/M6: retained raw payloads including warmed caches", () => {
  it("A1 default storage retains at most 5000 recent raw objects after 5001 accepted heartbeats", async () => {
    const room = "u123-default-storage"; const holder = prepare(room, 5001, "nonop");
    const inventory = await retainedEnvelopes(room, holder.sizes);
    expect(inventory.pinned.objects, "storage probe must find pinned semantic envelopes").toBeGreaterThanOrEqual(5);
    console.info("U123 storage", JSON.stringify({ fixture: "default", ...inventory, recent: { ...inventory.recent, ids: undefined } }));
    expect(holder.store.since()[room]).toBe(5100);
    expect(() => storageGate(inventory, 5000, 16 * 1024 * 1024)).not.toThrow();
  }, 30_000);

  it("A1/M6 small combined recent cap also bounds activity.beat objects held by replay caches", async () => {
    const room = "u123-mixed-storage"; const holder = prepare(room, 12, "mixed");
    const inventory = await retainedEnvelopes(room, holder.sizes);
    expect(inventory.pinned.objects).toBeGreaterThanOrEqual(5);
    console.info("U123 storage", JSON.stringify({ fixture: "mixed", ...inventory }));
    expect(holder.store.plan(room)).toBeDefined();
    expect(() => storageGate(inventory, 2, 16 * 1024 * 1024)).not.toThrow();
  }, 30_000);

  it("A4/M6 byte-evicted raw envelopes are absent internally even after projection refresh", async () => {
    const room = "u123-byte-storage"; const holder = prepare(room, 6, "bytes");
    const inventory = await retainedEnvelopes(room, holder.sizes);
    expect(inventory.pinned.objects).toBeGreaterThanOrEqual(5);
    console.info("U123 storage", JSON.stringify({ fixture: "bytes", ...inventory }));
    expect(holder.store.states().find(s => s.room === room)?.lastSeen).toBeDefined();
    expect(() => storageGate(inventory, 2, 1)).not.toThrow();
  }, 30_000);
});
