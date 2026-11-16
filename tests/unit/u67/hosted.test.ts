import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStore, AgentStoreOptions } from "../../../src/app/agent_store";
import type { Resolver } from "./helpers";
import { env, fakes } from "../u22/harness";
import { factory } from "../u52/wire/fixtures";
import { flush } from "../u64/helpers";
import { history, template, wall } from "./helpers";

const modules = ["../../../src/app/firebase_ports", "../../../src/ai/firebase", "../../../src/app/index", "../../../src/app/boot", "../../../src/app/agent_link", "../../../src/app/agent_wall", "../../../src/app/agent_store", "../../../src/app/plan_wiring"];
const observers: MutationObserver[] = [];
afterEach(() => {
  for (const observer of observers.splice(0)) observer.disconnect();
  for (const id of modules) vi.doUnmock(id);
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules();
  document.body.replaceChildren();
});

describe("U67 hosted wiring", () => {
  it("M2 hosted entry passes a working pinned starter resolver to its actual store", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_700_000_900_000); vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is forbidden in this oracle"); }));
    const fb = fakes({ user: { uid: "oracle-user", isAnonymous: true } }); const sdk = factory();
    const actualBoot = await vi.importActual<typeof import("../../../src/app/boot")>("../../../src/app/boot");
    actualBoot.resetBootStateForTests();
    const actualStore = await vi.importActual<typeof import("../../../src/app/agent_store")>("../../../src/app/agent_store");
    let store: AgentStore | undefined;
    let captured: (AgentStoreOptions & { templates?: Resolver }) | undefined;
    const construct = vi.fn((options?: AgentStoreOptions & { templates?: Resolver }) => {
      captured = options; store = actualStore.createAgentStore(options); return store;
    });
    vi.doMock("../../../src/app/agent_store", () => ({ ...actualStore, createAgentStore: construct }));
    vi.doMock("../../../src/app/firebase_ports", () => ({ createFirebasePorts: () => fb.fb }));
    vi.doMock("../../../src/ai/firebase", () => ({ firebaseFactory: () => sdk.f }));
    vi.doMock("../../../src/app/index", () => ({ readHostEnv: () => env() }));
    vi.doMock("../../../src/app/agent_link", () => ({ createAgentLink: () => ({ start: vi.fn(), stop: vi.fn(), post: vi.fn(), state: () => ({ kind: "connecting", attempt: 0 }) }) }));
    vi.doMock("../../../src/app/agent_wall", () => ({ startAgentWall: () => ({ refresh: vi.fn(), destroy: vi.fn() }) }));
    vi.doMock("../../../src/app/plan_wiring", () => ({ createPlanWiring: () => ({ notifyChange: vi.fn(), taskVerdicts: () => new Map(), planBriefs: () => new Map(), dispose: vi.fn() }) }));
    vi.stubGlobal("__U22_FIREBASE_REAL__", true);
    const NativeObserver = globalThis.MutationObserver;
    vi.stubGlobal("MutationObserver", class extends NativeObserver {
      constructor(cb: MutationCallback) { super(cb); observers.push(this); }
    });
    document.body.innerHTML = '<main id="wall"></main>';
    await import("../../../hosting/src/main"); await flush();
    expect(construct).toHaveBeenCalled();
    expect(captured?.templates, "M2 hosted store receives the starter resolver").toBeTypeOf("function");
    const t = template();
    expect(captured!.templates!(t.id, t.hash!)).toEqual(t);
    expect(captured!.templates!(t.id, "0".repeat(64))).toBeUndefined();
    for (const e of history()) expect(store!.ingest(e)).toBe(true);
    expect(store!.plan("oracle")?.projection.plan?.phase).toBe("discovery");
    expect(wall(store!).plan?.phases).toEqual(t.phases.map(p => ({ ...p, active: p.id === "discovery" })));
  });
});
