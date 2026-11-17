import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentLinkDeps } from "../../../src/app/agent_link";
import type { AgentWall, AgentWallDeps } from "../../../src/app/agent_wall";
import type { WallPortState } from "../../../src/app/types";
import type { ModelServices } from "../../../src/app/model_services";
import type { ProviderDescriptor } from "../../../src/providers/types";
import { NOW, STATE_COPY, assertState, assertSuppressed, control, dataFixture, flush,
  name, selectRoom, text, type Data, type ObservedDeps } from "./fixtures";

const H = vi.hoisted(() => ({
  data: undefined as Data | undefined,
  link: undefined as AgentLinkDeps | undefined,
  wall: undefined as AgentWall | undefined,
  deps: undefined as AgentWallDeps | undefined,
  services: undefined as ModelServices | undefined,
  state: { kind: "connecting", attempt: 1 } as WallPortState,
  stateReads: vi.fn(), review: vi.fn(async () => undefined),
  post: vi.fn(async () => ({ ok: true as const, id: "e-000000000000ffff", lamport: 65535 })),
  generate: vi.fn(), providerAccess: vi.fn(), rawPosts: vi.fn(), notifyPlan: vi.fn(), stopped: vi.fn(),
}));
vi.mock("../../../src/app/index", () => ({ readHostEnv: () => ({ extensionOrigins: [`chrome-extension://${"a".repeat(32)}`], firebaseConfig: {} }) }));
vi.mock("../../../src/app/firebase-config.public", () => ({ isPlaceholderConfig: () => false }));
vi.mock("../../../src/app/firebase_ports", () => ({ createFirebasePorts: () => ({}) }));
vi.mock("../../../src/ai/firebase", () => ({ firebaseFactory: () => ({}) }));
vi.mock("../../../src/ai/hybrid", () => ({ createHybrid: () => ({}) }));
vi.mock("../../../src/app/boot", () => ({
  boot: (_env: unknown, _fb: unknown, hybrid: { create(app: unknown): void }) => { hybrid.create({}); return Promise.resolve(); },
  onGoogleSignIn: vi.fn(), onUserActivation: vi.fn(),
}));
vi.mock("../../../src/app/connector", () => ({ createConnector: () => ({ onMessage() {} }) }));
vi.mock("../../../src/app/agent_drift", () => ({ createDriftReviewer: () => ({ review: H.review }), driftPortFromFactory: vi.fn() }));
vi.mock("../../../src/app/plan_wiring", () => ({ createPlanWiring: () => ({ notifyChange: H.notifyPlan,
  taskVerdicts: () => new Map(), planBriefs: () => new Map(), dispose() {} }) }));
vi.mock("../../../src/app/model_services", () => ({ createModelServices: () => H.services }));
vi.mock("../../../src/app/agent_store", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/app/agent_store")>();
  return { ...real, createAgentStore: (...args: Parameters<typeof real.createAgentStore>) => H.data?.store ?? real.createAgentStore(...args) };
});
vi.mock("../../../src/app/agent_link", () => ({ createAgentLink: (deps: AgentLinkDeps) => {
  H.link = deps;
  return { start: () => { deps.connect("a".repeat(32)); }, stop: H.stopped, post: H.post,
    state: () => { H.stateReads(); return H.state; } };
} }));
vi.mock("../../../src/app/agent_wall", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/app/agent_wall")>();
  return { ...real, startAgentWall: (deps: AgentWallDeps) => {
    H.deps = deps; H.wall = real.startAgentWall(deps); return H.wall;
  } };
});

let observers: MutationObserver[];
let observerOverflow: boolean;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(NOW);
  // The hosted clock models browser timer handles; Node fake timers return objects.
  const timeout = globalThis.setTimeout, interval = globalThis.setInterval;
  vi.stubGlobal("setTimeout", (fn: () => void, ms?: number) => Number(timeout(fn, ms)));
  vi.stubGlobal("setInterval", (fn: () => void, ms?: number) => Number(interval(fn, ms)));
  H.data = undefined; H.link = undefined; H.wall = undefined; H.deps = undefined;
  H.state = { kind: "connecting", attempt: 1 };
  H.stateReads.mockClear(); H.review.mockClear(); H.post.mockClear(); H.generate.mockClear(); H.providerAccess.mockClear(); H.rawPosts.mockClear(); H.notifyPlan.mockClear(); H.stopped.mockClear();
  document.body.replaceChildren(Object.assign(document.createElement("div"), { id: "wall" }));
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is forbidden in this oracle"); }));
  vi.stubGlobal("chrome", { runtime: { connect: () => ({ postMessage: H.rawPosts, disconnect() {},
    onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }) } });
  observers = []; observerOverflow = false;
  const Native = globalThis.MutationObserver; let callbacks = 0;
  vi.stubGlobal("MutationObserver", class extends Native {
    constructor(cb: MutationCallback) {
      super((records, observer) => {
        if (++callbacks > 300) { observerOverflow = true; observer.disconnect(); return; }
        cb(records, observer);
      }); observers.push(this);
    }
  });
  const descriptors: ProviderDescriptor[] = [{ id: "firebase-ondevice", kind: "firebase-ondevice", label: "Device fixture", health: "needs_setup" }];
  const forbidden = () => { H.providerAccess(); throw new Error("Inference is outside workspace guidance"); };
  const feed = { descriptors: () => descriptors, selection: () => ({ all: "firebase-ondevice" }),
    device: () => ({ state: "not_initialised" }), onOpen() {}, select() {}, reset() {}, subscribe: () => () => undefined };
  H.services = {
    registry: { list: () => descriptors, resolve: () => ({ primary: "firebase-ondevice", hop: null }),
      refresh: async () => descriptors, select() {}, applyRemoteConfig() {},
      initDevice: async () => ({ state: "not_initialised" }), generate: H.generate,
      asHybrid: forbidden, asClassifierPort: forbidden, asDriftPort: forbidden },
    sheet: () => feed, refreshFlags() {}, dispose() {}, hybrid: forbidden,
    aiSink: forbidden, classifier: forbidden, driftPortFor: forbidden, ledger: forbidden, externalCounts: forbidden,
  } as unknown as ModelServices;
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide")); H.wall?.destroy();
  for (const observer of observers) observer.disconnect();
  vi.clearAllTimers(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
async function boot(data?: Data) {
  // dataFixture falls through to the real store factory while H.data is unset.
  H.data = data ?? dataFixture();
  await import("../../../hosting/src/main"); await flush();
  expect(H.wall, "The hosted fixture mounts the real controller and renderer").toBeDefined();
  expect(observerOverflow, "Bounded host DOM observation").toBe(false);
}
async function tick() { await vi.advanceTimersByTimeAsync(1000); await flush(); }
async function hello(rooms = ["demo", "work"]) {
  H.link!.onRoomHello({ t: "room_hello", v: 1, agent: "wall-user", rooms: rooms.map(room => ({ room, floor: "ONLY_ON_DEVICE" })) });
  await flush();
}
async function synced(room = "demo", more = false) {
  expect(H.link?.onRoomSynced).toBeTypeOf("function");
  H.link!.onRoomSynced!({ t: "room_synced", v: 1, rid: "fixture-replay", room, upto: 100, more });
  await flush();
}

describe("U125 hosted wiring and epoch-sensitive replay", () => {
  it("A1 hosted connecting to linked to hello to terminal replay follows the required headings", async () => {
    await boot(); assertState(document.body, "Connecting to bridge", "Check workspace connection setup");
    H.state = { kind: "linked", nonce: "session-a" }; await tick();
    assertState(document.body, "Syncing workspace", "Wait for room replay");
    await hello(); assertState(document.body, "Syncing workspace", "Wait for room replay");
    await synced(); assertState(document.body, "Empty workspace", "Open workspace help");
  });
  it("M1 hosting supplies current link state and hello rooms through the optional observation seam", async () => {
    await boot(); H.state = { kind: "linked", nonce: "session-a" }; await hello();
    const read = (H.deps as ObservedDeps).workspaceStatus;
    expect(read, "The hosted wall must receive workspaceStatus").toBeTypeOf("function");
    expect(read!().link).toEqual(H.state); expect(read!().rooms).toEqual(expect.arrayContaining(["demo", "work"]));
    expect(read!().synced).not.toContain("demo");
    await synced(); expect(read!().synced).toContain("demo");
  });
  it("A1 hosted hello exposes rooms with no events and selecting an unsynced peer stays syncing", async () => {
    await boot(dataFixture([])); H.state = { kind: "linked", nonce: "session-a" }; await hello(); await synced();
    selectRoom(document.body, "work"); assertState(document.body, "Syncing workspace", "Wait for room replay");
    await synced("work"); assertState(document.body, "Empty workspace", "Open workspace help");
  });
  it("A1 more:true never completes replay and more:false does even without a recovery fault", async () => {
    await boot(); H.state = { kind: "linked", nonce: "session-a" }; await hello(); await synced("demo", true);
    assertState(document.body, "Syncing workspace", "Wait for room replay"); assertSuppressed(document.body);
    await synced(); assertState(document.body, "Empty workspace", "Open workspace help");
  });
  it("A5 a gap-held refreshWall cannot hide a link-only disconnect or delete saved progress", async () => {
    const data = dataFixture(); data.open(); data.legacy(); await boot(data);
    // A-V1: saved plan-title assertions below inspect the secondary Wall.
    document.querySelector<HTMLButtonElement>('button[data-nav="wall"]')!.click();
    H.state = { kind: "linked", nonce: "session-a" }; await hello(); await synced();
    H.link!.onRoomGap!({ t: "room_gap", v: 1, room: "demo", from_lamport: 20, to_lamport: 21, reason: "sanitize_failed" });
    await flush(); expect(H.review.mock.calls.length).toBeGreaterThan(0);
    const reviews = H.review.mock.calls.length, calls = H.generate.mock.calls.length;
    H.state = { kind: "unreachable", reason: "RETRIES_EXHAUSTED" }; await tick();
    assertState(document.body, "Bridge disconnected", "Open workspace help");
    expect(text(document.body)).toContain("Saved progress; connection unavailable");
    expect(text(document.body)).toContain("Scratch verification"); expect(text(document.body)).not.toContain("Bridge connected");
    expect(navigator.onLine).toBe(true); expect(H.review).toHaveBeenCalledTimes(reviews);
    expect(H.generate).toHaveBeenCalledTimes(calls); expect(H.post).not.toHaveBeenCalled();
  });
  it.each(["reconnect", "resync"])("A5 A7 %s cannot reuse a prior session's completed replay", async transition => {
    await boot(); H.state = { kind: "linked", nonce: "session-a" }; await hello(); await synced();
    H.state = transition === "reconnect" ? { kind: "unreachable", reason: "RETRIES_EXHAUSTED" }
      : { kind: "resyncing", nonce: "session-a" };
    await tick();
    H.state = { kind: "linked", nonce: transition === "reconnect" ? "session-b" : "session-a" }; await tick();
    assertState(document.body, "Syncing workspace", "Wait for room replay"); assertSuppressed(document.body);
    await hello(); await synced("demo", true);
    assertState(document.body, "Syncing workspace", "Wait for room replay");
    await synced(); assertState(document.body, "Empty workspace", "Open workspace help");
  });
  it("M4 pagehide cancels status observation without a late review or provider call", async () => {
    await boot(); await tick(); window.dispatchEvent(new Event("pagehide")); await flush();
    const reads = H.stateReads.mock.calls.length, reviews = H.review.mock.calls.length, calls = H.generate.mock.calls.length;
    await vi.advanceTimersByTimeAsync(31_000); await flush();
    expect(H.stateReads).toHaveBeenCalledTimes(reads); expect(H.review).toHaveBeenCalledTimes(reviews);
    expect(H.generate).toHaveBeenCalledTimes(calls); expect(H.post).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["unknown", "connecting", "unreachable", "syncing", "empty", "legacy", "memory", "no tasks", "unavailable"])(
    "A6 %s guidance actions never write or invoke a provider", async kind => {
      const data = dataFixture();
      if (kind === "legacy") data.real.ingestChecked({ id: "e-0000000000000030", lamport: 48, ts: NOW - 500,
        room: "demo", agent: "alpha", act: "heartbeat", text: "Legacy heartbeat" });
      if (kind === "memory" || kind === "unavailable") data.memory();
      if (kind === "no tasks") data.open("demo", "Scratch verification", false);
      if (kind === "unavailable") data.store.plan.mockImplementation(() => { throw new Error("javascript:alert(1)"); });
      await boot(data);
      H.state = kind === "connecting" ? { kind: "connecting", attempt: 1 }
        : kind === "unreachable" ? { kind: "unreachable", reason: "NOT_LISTED" } : { kind: "linked", nonce: "session-a" };
      if (kind === "unknown") {
        const deps = H.deps as ObservedDeps;
        if (deps.workspaceStatus) vi.spyOn(deps, "workspaceStatus").mockImplementation(() => { throw new Error("Observation unavailable"); });
      } else { await hello(); if (kind !== "syncing") await synced(); }
      H.wall!.refresh(); await tick();
      const pair = kind === "unknown" ? STATE_COPY[0] : kind === "connecting" ? STATE_COPY[1]
        : kind === "unreachable" ? STATE_COPY[2] : kind === "syncing" ? STATE_COPY[3]
        : kind === "unavailable" ? STATE_COPY[4] : kind === "empty" ? STATE_COPY[5]
        : kind === "legacy" ? STATE_COPY[6] : kind === "memory" ? STATE_COPY[7] : STATE_COPY[8];
      assertState(document.body, pair[0], pair[1]);
      const before = JSON.stringify(data.store.since());
      const reviews = H.review.mock.calls.length, calls = H.generate.mock.calls.length, posts = H.post.mock.calls.length;
      const adapters = H.providerAccess.mock.calls.length, rawPosts = H.rawPosts.mock.calls.length;
      // Only help is specified to be a control; waiting/planning/deployment copy may be passive.
      const actions = [...document.body.querySelectorAll<HTMLElement>('button,a[href],[role="button"]')]
        .filter(node => [pair[1], "No active deployment recorded; ask your harness to deploy agents",
          "No harness registration recorded here; live MCP connection status is unknown"].includes(name(node)));
      if (pair[1] === "Open workspace help") control(document.body, pair[1]);
      for (const action of actions) { action.click(); await flush(); }
      expect(JSON.stringify(data.store.since())).toBe(before);
      expect(H.review).toHaveBeenCalledTimes(reviews); expect(H.generate).toHaveBeenCalledTimes(calls);
      expect(H.post).toHaveBeenCalledTimes(posts);
      expect(H.providerAccess).toHaveBeenCalledTimes(adapters); expect(H.rawPosts).toHaveBeenCalledTimes(rawPosts);
    });
});
