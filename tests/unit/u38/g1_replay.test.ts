// U38 G1: agent_link seeds room_sync.since from the rooms listed in room_hello (0 for unseen rooms).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentLink, type AgentLink } from "../../../src/app/agent_link";
import { createAgentStore } from "../../../src/app/agent_store";
import { EXT_ID, FakeAppClock, pageRuntime, type PagePort } from "../u37c/harness";
import { ev } from "./helpers";

const FLOOR = "ONLY_ON_DEVICE" as const;
const hello = (...rooms: unknown[]) => ({ t: "room_hello", v: 1, rooms, agent: "wall-user" });
const R = (room: string) => ({ room, floor: FLOOR });
let link: AgentLink | undefined;
afterEach(() => { link?.stop(); link = undefined; });

function rig(since: () => Record<string, number>) {
  const clock = new FakeAppClock(); const rt = pageRuntime();
  link = createAgentLink({ extId: EXT_ID, connect: rt.connect, clock, nonce: () => "n1", since, onRoomEvent: vi.fn(), onRoomHello: vi.fn() });
  link.start();
  const p: PagePort = rt.last();
  p.emit({ t: "snapshot", v: 1, nonce: "n1", items: [] });
  clock.advance(1);
  const lastSince = (): Record<string, number> => (p.ofType("room_sync").at(-1) as { since: Record<string, number> }).since;
  return { p, clock, lastSince };
}

describe("G1 history replay", () => {
  it("the first sync (snapshot, before any hello) still sends the store's since() unchanged", () => {
    const { p } = rig(() => ({ demo: 3 }));
    expect(p.ofType("room_sync")).toHaveLength(1);
    expect((p.ofType("room_sync")[0] as { since: unknown }).since).toEqual({ demo: 3 });
  });
  it("room_hello with rooms the store has not seen: since lists every hello room, 0 for the unseen ones", () => {
    const { p, lastSince } = rig(() => ({}));
    p.emit(hello(R("demo")));
    expect(lastSince()).toEqual({ demo: 0 });
  });
  it("seen rooms keep the store's lamport, unseen hello rooms get 0", () => {
    const { p, lastSince } = rig(() => ({ demo: 3 }));
    p.emit(hello(R("demo"), R("other")));
    expect(lastSince()).toEqual({ demo: 3, other: 0 });
  });
  it("since() is read at hello time (a later hello reflects the store's newer lamport)", () => {
    let cur: Record<string, number> = { demo: 3 };
    const { p, lastSince } = rig(() => cur);
    p.emit(hello(R("demo")));
    expect(lastSince()).toEqual({ demo: 3 });
    cur = { demo: 9 };
    p.emit(hello(R("demo")));
    expect(lastSince()).toEqual({ demo: 9 });
  });
  it("the LATEST room_hello decides which rooms are asked for", () => {
    const { p, lastSince } = rig(() => ({}));
    p.emit(hello(R("alpha")));
    p.emit(hello(R("beta")));
    expect(lastSince()["beta"]).toBe(0);
    expect("alpha" in lastSince()).toBe(false);
  });
  it("malformed hello entries (non-object, invalid slug) are skipped without throwing; valid ones still sync", () => {
    const { p, lastSince } = rig(() => ({}));
    expect(() => { p.emit(hello(null, "x", { room: "BAD ROOM", floor: FLOOR }, { room: 7 }, R("ok"))); }).not.toThrow();
    expect(lastSince()).toEqual({ ok: 0 });
  });
  it("a hello with no rooms still produces a sync frame (never throws)", () => {
    const { p } = rig(() => ({}));
    expect(() => { p.emit(hello()); }).not.toThrow();
    expect(p.ofType("room_sync").length).toBeGreaterThanOrEqual(2);
  });
  it("with the real store: events already ingested give their max lamport, a brand-new hello room gets 0", () => {
    const store = createAgentStore();
    for (const l of [1, 2, 5]) store.ingest(ev(l, "demo", "worker-1", "open", `t${l}`, 1_700_000_000_000 + l));
    const { p, lastSince } = rig(() => store.since());
    p.emit(hello(R("demo"), R("fresh")));
    expect(lastSince()).toEqual({ demo: 5, fresh: 0 });
  });
});
