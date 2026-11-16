import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlanWiring } from "../../../src/app/plan_wiring";
import type { PlanWiringDeps } from "../../../src/app/plan_wiring";
import type { ModeName } from "../../../src/ai/types";
import type { PlanAiTier } from "../../../src/planai/types";
import { createPlanAi } from "../../../src/planai/reviewer";
import type { AgentLinkDeps } from "../../../src/app/agent_link";
import { env, fakes } from "../u22/harness";
import { factory } from "../u52/wire/fixtures";
import { flush, harness } from "./helpers";

const modules = ["../../../src/app/plan_wiring", "../../../src/app/firebase_ports", "../../../src/ai/firebase", "../../../src/app/index", "../../../src/app/boot", "../../../src/app/agent_link", "../../../src/app/agent_wall"];
const observers: MutationObserver[] = [];
afterEach(() => {
  for (const observer of observers.splice(0)) observer.disconnect();
  for (const id of modules) vi.doUnmock(id);
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); document.body.replaceChildren();
});

async function checkTier(getTier: PlanWiringDeps["getTier"], expected: "ONLY_ON_DEVICE" | "PREFER_ON_DEVICE", kill = false) {
  const h = harness();
  const bindings: boolean[] = [];
  h.deps = { ...h.deps, ...(getTier ? { getTier } : {}), getKillSwitchCloud: () => kill,
    createPlanAi: opts => createPlanAi({ ...opts, port: mode => {
      expect(typeof opts.port).toBe("function");
      const binding = (opts.port as (mode: ModeName) => import("../../../src/planai/types").PlanAiPortBinding)(mode);
      bindings.push(binding.allowExternal);
      return binding;
    } }),
  };
  const wiring = createPlanWiring(h.deps);
  try {
    wiring.notifyChange(); await h.advance();
    expect(wiring.taskVerdicts().has("room:T01")).toBe(true);
    expect(wiring.planBriefs().has("room")).toBe(true);
    expect(h.driftPortFor).toHaveBeenCalled();
    expect(h.driftPortFor.mock.calls.every(([mode]) => mode === expected)).toBe(true);
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings.every(value => value === (expected === "PREFER_ON_DEVICE"))).toBe(true);
  } finally { wiring.dispose(); }
}

describe("U64 repair privacy defaults", () => {
  it("unknown room fails closed", () => checkTier(undefined, "ONLY_ON_DEVICE"));
  it("throwing tier lookup fails closed", () => checkTier(() => { throw new Error("Unavailable"); }, "ONLY_ON_DEVICE"));
  it("unrecognised tier fails closed", () => checkTier(() => "unknown" as PlanAiTier, "ONLY_ON_DEVICE"));
  it("standard room retains cloud fallback", () => checkTier(() => "standard", "PREFER_ON_DEVICE"));
  it("kill switch overrides standard room", () => checkTier(() => "standard", "ONLY_ON_DEVICE", true));

  it("hosted room floors govern both hello and event notifications before AI work", async () => {
    vi.useFakeTimers(); vi.resetModules();
    const fb = fakes({ user: { uid: "privacy-user", isAnonymous: true } });
    const sdk = factory();
    const bootModule = await vi.importActual<typeof import("../../../src/app/boot")>("../../../src/app/boot");
    bootModule.resetBootStateForTests();
    let deps: PlanWiringDeps | undefined;
    let link: AgentLinkDeps | undefined;
    const tiers: Array<string | undefined> = [];
    vi.doMock("../../../src/app/plan_wiring", () => ({ createPlanWiring: (d: PlanWiringDeps) => {
      deps = d;
      return { notifyChange: () => tiers.push(d.getTier?.("room")), taskVerdicts: () => new Map(), planBriefs: () => new Map(), dispose: vi.fn() };
    } }));
    vi.doMock("../../../src/app/firebase_ports", () => ({ createFirebasePorts: () => fb.fb }));
    vi.doMock("../../../src/ai/firebase", () => ({ firebaseFactory: () => sdk.f }));
    vi.doMock("../../../src/app/index", () => ({ readHostEnv: () => env() }));
    vi.doMock("../../../src/app/agent_link", () => ({ createAgentLink: (d: AgentLinkDeps) => {
      link = d; return { start: vi.fn(), stop: vi.fn(), post: vi.fn(), state: () => ({ kind: "connecting", attempt: 0 }) };
    } }));
    vi.doMock("../../../src/app/agent_wall", () => ({ startAgentWall: () => ({ refresh: vi.fn(), destroy: vi.fn() }) }));
    vi.stubGlobal("__U22_FIREBASE_REAL__", true);
    const NativeObserver = globalThis.MutationObserver;
    vi.stubGlobal("MutationObserver", class extends NativeObserver { constructor(cb: MutationCallback) { super(cb); observers.push(this); } });
    document.body.innerHTML = '<main id="wall"></main>';
    await import("../../../hosting/src/main"); await flush();
    expect(deps).toBeDefined(); expect(link).toBeDefined();
    expect(deps?.getTier?.("unknown")).toBe("private");
    link!.onRoomHello({ t: "room_hello", v: 1, agent: "alice", rooms: [{ room: "room", floor: "ONLY_ON_DEVICE" }] });
    expect(tiers.at(-1)).toBe("private");
    await checkTier(deps!.getTier, "ONLY_ON_DEVICE");
    link!.onRoomEvent({ t: "room_event", v: 1, room: "room", floor: "PREFER_ON_DEVICE", event: {} });
    expect(tiers.at(-1)).toBe("standard");
    await checkTier(deps!.getTier, "PREFER_ON_DEVICE");
    link!.onRoomEvent({ t: "room_event", v: 1, room: "room", floor: "ONLY_ON_DEVICE", event: {} });
    expect(tiers.at(-1)).toBe("private");
    await checkTier(deps!.getTier, "ONLY_ON_DEVICE");
  });
});
