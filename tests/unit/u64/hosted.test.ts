import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlanWiring } from "../../../src/app/plan_wiring";
import type { PlanWiringDeps } from "../../../src/app/plan_wiring";
import type { AgentLinkDeps } from "../../../src/app/agent_link";
import type { AgentWallDeps } from "../../../src/app/agent_wall";
import { env, fakes } from "../u22/harness";
import { factory } from "../u52/wire/fixtures";
import { harness, flush } from "./helpers";
const modules = ["../../../src/app/plan_wiring", "../../../src/app/firebase_ports", "../../../src/ai/firebase", "../../../src/app/index", "../../../src/app/boot", "../../../src/app/agent_link", "../../../src/app/agent_wall", "../../../src/app/agent_store"];
const observers: MutationObserver[] = [];
afterEach(() => {
  for (const observer of observers.splice(0)) observer.disconnect();
  for (const id of modules) vi.doUnmock(id);
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); document.body.replaceChildren();
});
async function page(fault: "none" | "construction" | "notification") {
  // Exercise the required public composition before testing its hosted caller.
  const prerequisite = createPlanWiring(harness([]).deps); prerequisite.dispose();
  vi.useFakeTimers(); vi.resetModules();
  const fb = fakes({ user: { uid: "oracle-user", isAnonymous: true } }); const sdk = factory();
  const actualBoot = await vi.importActual<typeof import("../../../src/app/boot")>("../../../src/app/boot");
  actualBoot.resetBootStateForTests();
  const storeModule = await vi.importActual<typeof import("../../../src/app/agent_store")>("../../../src/app/agent_store");
  const store = storeModule.createAgentStore(); // A-U85c: observe checked ingestion used by hosting, M2/M5.
  const ingest = vi.spyOn(store, "ingestChecked");
  let linkDeps: AgentLinkDeps | undefined, wallDeps: AgentWallDeps | undefined, wiringDeps: PlanWiringDeps | undefined;
  const refresh = vi.fn(), start = vi.fn();
  const notifications: number[] = [];
  const notify = vi.fn(() => { notifications.push(ingest.mock.calls.length); if (fault === "notification") throw new Error("plan notification failed"); });
  const construct = vi.fn((d: PlanWiringDeps) => {
    wiringDeps = d;
    if (fault === "construction") throw new Error("plan construction failed");
    return { notifyChange: notify, taskVerdicts: () => new Map(), planBriefs: () => new Map(), dispose: vi.fn() };
  });
  vi.doMock("../../../src/app/plan_wiring", async () => ({ ...await vi.importActual<object>("../../../src/app/plan_wiring"), createPlanWiring: construct }));
  vi.doMock("../../../src/app/firebase_ports", () => ({ createFirebasePorts: () => fb.fb }));
  vi.doMock("../../../src/ai/firebase", () => ({ firebaseFactory: () => sdk.f }));
  vi.doMock("../../../src/app/index", () => ({ readHostEnv: () => env() }));
  vi.doMock("../../../src/app/agent_store", () => ({ ...storeModule, createAgentStore: () => store }));
  vi.doMock("../../../src/app/agent_link", () => ({ createAgentLink: (d: AgentLinkDeps) => { linkDeps = d; return { start, stop: vi.fn(), post: vi.fn(), state: () => ({ kind: "connecting", attempt: 0 }) }; } }));
  vi.doMock("../../../src/app/agent_wall", () => ({ startAgentWall: (d: AgentWallDeps) => { wallDeps = d; return { refresh, destroy: vi.fn() }; } }));
  let bootResult: Awaited<ReturnType<typeof actualBoot.boot>> | undefined;
  vi.doMock("../../../src/app/boot", () => ({ ...actualBoot, boot: async (...args: Parameters<typeof actualBoot.boot>) => { bootResult = await actualBoot.boot(...args); return bootResult; } }));
  vi.stubGlobal("__U22_FIREBASE_REAL__", true);
  const NativeObserver = globalThis.MutationObserver;
  vi.stubGlobal("MutationObserver", class extends NativeObserver { constructor(cb: MutationCallback) { super(cb); observers.push(this); } });
  document.body.innerHTML = '<main id="wall"></main>';
  await import("../../../hosting/src/main"); await flush();
  expect(bootResult?.kind).toBe("ready"); expect(start).toHaveBeenCalledOnce(); expect(wallDeps).toBeDefined(); expect(linkDeps).toBeDefined();
  return { construct, wiring: () => wiringDeps, wall: () => wallDeps!, link: () => linkDeps!, refresh, notify, notifications, ingest };
}
describe("U64 hosted entry isolation", () => {
  it("A2 hosted entry wires lazy dependencies, template lookup and both feeds", async () => {
    const p = await page("none"); expect(p.construct).toHaveBeenCalled();
    const d = p.wiring()!; expect(d.clock).toBeDefined(); expect(d.getSnapshots()).toEqual([]);
    expect(d.getServices()).not.toBeNull(); expect(d.getDriftFactory()).not.toBeNull();
    expect(p.wall().templateMemorySections).toBeTypeOf("function");
    expect(p.wall().planVerdicts).toBeDefined(); expect(p.wall().planBriefs).toBeDefined();
    const before = p.refresh.mock.calls.length; d.onUpdate(); expect(p.refresh).toHaveBeenCalledTimes(before + 1);
  });
  it.each(["construction", "notification"] as const)("A8 %s failures leave boot, wall and room callbacks alive", async fault => {
    const p = await page(fault); expect(p.construct).toHaveBeenCalled();
    const event = { id: "e-0000000000000001", lamport: 1, ts: 1, room: "room", agent: "alice", act: "open", text: "Hello" };
    // A-U85c: announce room membership before exercising event failure isolation, M5.
    expect(() => p.link().onRoomHello({ t: "room_hello", v: 1, rooms: [{ room: "room", floor: "PREFER_ON_DEVICE" }], agent: "alice" })).not.toThrow();
    expect(() => p.link().onRoomEvent({ t: "room_event", v: 1, room: "room", floor: "PREFER_ON_DEVICE", event })).not.toThrow();
    expect(p.ingest).toHaveBeenCalledWith(event);
    expect(() => p.link().onRoomHello({ t: "room_hello", v: 1, rooms: [], agent: "alice" })).not.toThrow();
    expect(p.refresh).toHaveBeenCalled();
    if (fault === "notification") {
      expect(p.notify.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(p.notifications.slice(-2)).toEqual([1, 1]);
    }
  });
});
