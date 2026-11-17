import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentLinkDeps } from "../../../src/app/agent_link";
import type { AgentWall, AgentWallDeps } from "../../../src/app/agent_wall";
import type { ModelServices, ModelSheetFeed } from "../../../src/app/model_services";
import type { ModelSelection, ProviderDescriptor, ProviderRegistry } from "../../../src/providers/types";
import { roomFixture, NOW } from "../u118/fixtures";
import { normalized, requireAnnouncement, watchLiveUpdates } from "./live";

const H = vi.hoisted(() => ({
  service: null as ModelServices | null,
  store: undefined as ReturnType<typeof roomFixture>["store"] | undefined,
  link: undefined as AgentLinkDeps | undefined,
  wall: undefined as AgentWall | undefined,
  said: [] as string[],
}));
// Boundary fakes prevent Firebase, extension and inference traffic; the hosted
// composition, AgentWall, Models sheet and announcer under test remain real.
vi.mock("../../../src/app/index", () => ({ readHostEnv: () => ({
  extensionOrigins: [`chrome-extension://${"a".repeat(32)}`], firebaseConfig: {},
}) }));
vi.mock("../../../src/app/firebase-config.public", () => ({ isPlaceholderConfig: () => false }));
vi.mock("../../../src/app/firebase_ports", () => ({ createFirebasePorts: () => ({}) }));
vi.mock("../../../src/ai/firebase", () => ({ firebaseFactory: () => ({}) }));
vi.mock("../../../src/ai/hybrid", () => ({ createHybrid: () => ({}) }));
vi.mock("../../../src/app/boot", () => ({
  boot: (_env: unknown, _ports: unknown, hybrid: { create(app: unknown): void }) => {
    hybrid.create({}); return Promise.resolve();
  }, onGoogleSignIn: vi.fn(), onUserActivation: vi.fn(),
}));
vi.mock("../../../src/app/connector", () => ({ createConnector: () => ({ onMessage() {} }) }));
vi.mock("../../../src/app/agent_drift", () => ({
  createDriftReviewer: () => ({ review: async () => undefined }), driftPortFromFactory: vi.fn(),
}));
vi.mock("../../../src/app/plan_wiring", () => ({ createPlanWiring: () => ({
  notifyChange() {}, taskVerdicts: () => new Map(), planBriefs: () => new Map(), dispose() {},
}) }));
vi.mock("../../../src/app/model_services", () => ({ createModelServices: () => H.service }));
vi.mock("../../../src/app/agent_store", async original => ({
  ...await original<typeof import("../../../src/app/agent_store")>(), createAgentStore: () => H.store,
}));
vi.mock("../../../src/app/agent_link", () => ({ createAgentLink: (deps: AgentLinkDeps) => {
  H.link = deps;
  return { start() { deps.connect("a".repeat(32)); }, stop() {},
    state: () => ({ kind: "linked", nonce: "fixture" }), post: vi.fn(),
  };
} }));
vi.mock("../../../src/app/agent_wall", async original => {
  const real = await original<typeof import("../../../src/app/agent_wall")>();
  return { ...real, startAgentWall: (deps: AgentWallDeps) => (H.wall = real.startAgentWall(deps)) };
});
vi.mock("../../../src/ui/model_selector", async original => {
  const real = await original<typeof import("../../../src/ui/model_selector")>();
  return { ...real, createModelSheet: (options: Parameters<typeof real.createModelSheet>[0]) =>
    real.createModelSheet({ ...options, announcer: {
      say: (key, text, politeness) => { H.said.push(text); options.announcer.say(key, text, politeness); },
      flushedCount: () => options.announcer.flushedCount(),
    } }),
  };
});

let providers: ProviderDescriptor[];
let selection: ModelSelection;
let listeners: Set<() => void>;
let live: ReturnType<typeof watchLiveUpdates>;
let observers: MutationObserver[];
let observerOverflow: boolean;
const publish = (): void => { for (const fn of [...listeners]) fn(); };
const settle = async (): Promise<void> => {
  for (let n = 0; n < 24; n++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(1_000);
  live.healthy(); expect(observerOverflow, "Hosted observers must settle").toBe(false);
};
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(NOW);
  document.body.replaceChildren(Object.assign(document.createElement("div"), { id: "wall" }));
  H.store = roomFixture().store; H.wall = undefined; H.link = undefined; H.said.length = 0;
  const network = vi.fn((): never => { throw new Error("Network is forbidden in this oracle"); });
  vi.stubGlobal("fetch", network); vi.stubGlobal("WebSocket", network);
  vi.stubGlobal("chrome", { runtime: { connect: () => ({
    postMessage: vi.fn(), disconnect() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} },
  }) } });
  observers = []; observerOverflow = false;
  const Native = globalThis.MutationObserver;
  vi.stubGlobal("MutationObserver", class extends Native {
    constructor(cb: MutationCallback) {
      let batches = 0;
      super((records, observer) => {
        if (++batches > 1_000) { observerOverflow = true; observer.disconnect(); return; }
        cb(records, observer);
      }); observers.push(this);
    }
  });
  providers = [
    { id: "firebase-hybrid", kind: "firebase-hybrid", label: "Hybrid fixture", health: "available" },
    { id: "firebase-ondevice", kind: "firebase-ondevice", label: "Device fixture", health: "needs_setup" },
    { id: "firebase-cloud", kind: "firebase-cloud", label: "Cloud fixture", health: "available" },
  ];
  selection = {}; listeners = new Set();
  const forbidden = vi.fn((): never => { throw new Error("Models controls must not run inference"); });
  const registry: ProviderRegistry = {
    list: () => providers, refresh: vi.fn(async () => providers),
    resolve: () => ({ primary: selection.all ?? "firebase-hybrid", hop: null, blocked: undefined }),
    select: next => { selection = next; }, applyRemoteConfig() {},
    initDevice: vi.fn(async () => ({ state: "not_initialised" as const })),
    generate: forbidden, asHybrid: forbidden, asClassifierPort: forbidden, asDriftPort: forbidden,
  };
  const feed: ModelSheetFeed = {
    descriptors: () => providers, selection: () => selection,
    device: () => ({ state: "not_initialised" }), onOpen() {},
    select: next => { registry.select(next); publish(); },
    reset: () => { registry.select({}); publish(); },
    subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
  H.service = { registry, sheet: () => feed, refreshFlags() {}, dispose: () => { listeners.clear(); },
    hybrid: forbidden, aiSink: forbidden, classifier: forbidden, driftPortFor: forbidden,
    ledger: forbidden, externalCounts: forbidden,
  };
  live = watchLiveUpdates(document);
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide")); H.wall?.destroy(); H.service?.dispose();
  live.stop(); observers.forEach(observer => observer.disconnect());
  vi.clearAllTimers(); document.body.replaceChildren();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
async function boot(): Promise<void> {
  await import("../../../hosting/src/main"); await settle();
  expect(H.wall, "The real hosted wall must mount").toBeDefined();
}
function control(name: RegExp): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>("button,input,[role=radio]")]
    .find(node => name.test(node.getAttribute("aria-label") ?? (node instanceof HTMLInputElement
      ? [...node.labels ?? []].map(normalized).join(" ") : node.textContent ?? "")));
  expect(found, `Existing Models control ${name}`).toBeDefined(); return found!;
}
async function open(): Promise<void> {
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-controls="model-sheet"]');
  expect(trigger, "Hosted Models opener must exist").not.toBeNull();
  trigger!.click(); await settle();
}
function clearAnnouncements(): void { H.said.length = 0; live.clear(); }
function delivered(): void {
  expect(H.said.length, "The real sheet must emit an outcome through its announcer contract").toBeGreaterThan(0);
  for (const message of H.said) requireAnnouncement(live.messages, message);
  expect(globalThis.fetch).not.toHaveBeenCalled(); expect(globalThis.WebSocket).not.toHaveBeenCalled();
  expect(H.service!.registry.generate).not.toHaveBeenCalled();
}

describe("U147 A1 / A5 hosted model announcements and no-op regression", () => {
  it("A1 opening Models changes connected live status text", async () => {
    await boot(); clearAnnouncements(); await open(); delivered();
  });
  it("A1 a confirmed model selection changes connected live status text", async () => {
    await boot(); await open(); clearAnnouncements();
    control(/^Cloud only$/).click(); await settle();
    expect(selection.all).toBe("firebase-cloud"); delivered();
  });
  it("A1 resetting the model selection announces the confirmed outcome", async () => {
    await boot(); await open(); control(/^Cloud only$/).click(); await settle(); clearAnnouncements();
    control(/^Reset to Firebase hybrid$/).click(); await settle();
    expect(selection.all).toBeUndefined(); delivered();
  });
  it("A1 an unselected provider becoming offline announces its actual outcome", async () => {
    await boot(); await open(); clearAnnouncements();
    providers = providers.map(provider => provider.id === "firebase-cloud" ? { ...provider, health: "offline" } : provider);
    publish(); await settle();
    expect(H.said.join(" ")).toMatch(/offline/i); delivered();
  });
});
