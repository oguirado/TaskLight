// A-Q1: U148/U150 named non-article task roots retain their classes and identity hooks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { AgentWall, AgentWallDeps } from "../../../src/app/agent_wall";
import type { AgentLinkDeps } from "../../../src/app/agent_link";
import type { ModelServices, ModelSheetFeed } from "../../../src/app/model_services";
import type { ModelSelection, ProviderDescriptor, ProviderRegistry, ResolvedChain } from "../../../src/providers/types";
import { DEFAULT_PROVIDER } from "../../../src/providers/types";
import { effectiveId } from "../../../src/ui/model_selector";
import { assertProviderAllowed } from "../../../src/privacy/policy";
import type { WallHandlers } from "../../../src/views/types";
import { NOW, HOSTILE, accessibleName, control, flush, models, noExecutableLabels, roomFixture, text, visible, visibleText } from "./fixtures";

const H = vi.hoisted(() => ({
  services: null as ModelServices | null, store: undefined as ReturnType<typeof roomFixture>["store"] | undefined,
  link: undefined as AgentLinkDeps | undefined, wall: undefined as AgentWall | undefined,
  wallDeps: undefined as AgentWallDeps | undefined, handlers: undefined as WallHandlers | undefined,
  onMessage: [] as ((frame: unknown) => void)[],
  post: vi.fn(async () => ({ ok: true as const, id: "e-000000000000ffff", lamport: 65535 })),
  sheetOpen: vi.fn(),
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
vi.mock("../../../src/app/agent_drift", () => ({ createDriftReviewer: () => ({ review: async () => undefined }), driftPortFromFactory: vi.fn() }));
vi.mock("../../../src/app/plan_wiring", () => ({ createPlanWiring: () => ({ notifyChange() {}, taskVerdicts: () => new Map(), planBriefs: () => new Map(), dispose() {} }) }));
vi.mock("../../../src/app/model_services", () => ({ createModelServices: () => {
  if (!H.services) throw new Error("Services unavailable"); return H.services;
} }));
vi.mock("../../../src/app/agent_store", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/app/agent_store")>();
  return { ...real, createAgentStore: () => H.store };
});
vi.mock("../../../src/app/agent_link", () => ({ createAgentLink: (deps: AgentLinkDeps) => {
  H.link = deps; return { start: () => { deps.connect("a".repeat(32)); }, stop() {}, post: H.post, state: () => ({ kind: "linked", nonce: "fixture" }) };
} }));
vi.mock("../../../src/app/agent_wall", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/app/agent_wall")>();
  return { ...real, startAgentWall: (deps: AgentWallDeps) => { H.wallDeps = deps; H.wall = real.startAgentWall(deps); return H.wall; } };
});
vi.mock("../../../src/views", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/views")>();
  return { ...real, mountWall: (...args: Parameters<typeof real.mountWall>) => { H.handlers = args[2]; return real.mountWall(...args); } };
});
// Observe the real sheet while preserving its DOM, keyboard and focus behavior.
vi.mock("../../../src/ui/model_selector", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/ui/model_selector")>();
  return { ...real, createModelSheet: (...args: Parameters<typeof real.createModelSheet>) => {
    const sheet = real.createModelSheet(...args);
    return { ...sheet, open: (trigger: HTMLElement | null) => { H.sheetOpen(trigger); sheet.open(trigger); } };
  } };
});

let data: ReturnType<typeof roomFixture>;
let providers: ProviderDescriptor[];
let selection: ModelSelection;
let forcedBlock: ProviderDescriptor["blockedReason"];
let listeners: Set<() => void>;
let service: ModelServices;
let onOpen: Mock<() => void>;
let generate: Mock<ProviderRegistry["generate"]>;
let observers: MutationObserver[];
let observerCalls: number;
let guardTripped: boolean;
let observedMutations: number;
let observerReattachments: number;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(NOW);
  document.body.replaceChildren(Object.assign(document.createElement("div"), { id: "wall" }));
  data = roomFixture(); H.store = data.store; H.link = undefined; H.wall = undefined; H.handlers = undefined; H.wallDeps = undefined;
  H.onMessage = []; H.post.mockClear(); H.sheetOpen.mockClear();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden in this oracle"); }));
  vi.stubGlobal("chrome", { runtime: { connect: () => ({ postMessage: vi.fn(), disconnect() {},
    onMessage: { addListener: (cb: (frame: unknown) => void) => { H.onMessage.push(cb); } }, onDisconnect: { addListener() {} } }) } });
  observers = []; observerCalls = 0; guardTripped = false; observedMutations = 0; observerReattachments = 0;
  const Native = globalThis.MutationObserver;
  vi.stubGlobal("MutationObserver", class extends Native {
    constructor(cb: MutationCallback) {
      super((records, observer) => {
        observerCalls++; observedMutations += records.length;
        // Test-runner safety bound only; this is not a product performance budget.
        if (observerCalls > 500) { guardTripped = true; observer.disconnect(); return; }
        const before = new Set(document.querySelectorAll('button[aria-controls="model-sheet"]'));
        cb(records, observer);
        for (const node of document.querySelectorAll('button[aria-controls="model-sheet"]')) if (!before.has(node)) observerReattachments++;

      }); observers.push(this);
    }
  });
  providers = [
    { id: "firebase-hybrid", kind: "firebase-hybrid", label: "Hybrid fixture", health: "available" },
    { id: "firebase-ondevice", kind: "firebase-ondevice", label: "Device fixture", health: "needs_setup" },
    { id: "firebase-cloud", kind: "firebase-cloud", label: "Cloud fixture", health: "available" },
  ];
  selection = { all: "firebase-cloud" }; forcedBlock = undefined; listeners = new Set();
  onOpen = vi.fn<() => void>(); generate = vi.fn<ProviderRegistry["generate"]>(async () => ({ ok: false as const, code: "BLOCKED" as const, providerId: DEFAULT_PROVIDER, fallback: false }));
  const forbidden = vi.fn((): never => { throw new Error("Inference is outside availability rendering"); });
  const resolve: ProviderRegistry["resolve"] = vi.fn((task, tier): ResolvedChain => {
    const group = task === "drift" ? "drift" : task === "route" ? "routing" : task === "digest" ? "digest" : "capsule";
    const id = selection.groups?.[group] ?? selection.all ?? DEFAULT_PROVIDER;
    const descriptor = providers.find(p => p.id === id);
    const fallback = tier === "private" ? "firebase-ondevice" : DEFAULT_PROVIDER;
    if (!descriptor) return { primary: fallback, hop: null, blocked: "unknown_id" };
    if (forcedBlock) return { primary: fallback, hop: null, blocked: forcedBlock };
    const policy = assertProviderAllowed(task === "route" || task === "drift" ? "status" : task, tier, descriptor.kind,
      { loopback: true, allowPrivate: true, endpointEnabled: true });
    return policy.ok ? { primary: id, hop: null, blocked: descriptor.blockedReason }
      : { primary: fallback, hop: null, blocked: "policy" };
  });
  const publish = () => { for (const cb of [...listeners]) cb(); };
  const registry: ProviderRegistry = {
    list: vi.fn(() => providers), resolve, refresh: vi.fn(async () => providers),
    select: vi.fn(next => { selection = next; }), applyRemoteConfig: vi.fn(), initDevice: vi.fn(async () => ({ state: "not_initialised" as const })),
    generate, asHybrid: forbidden, asClassifierPort: forbidden, asDriftPort: forbidden,
  };
  const feed: ModelSheetFeed = {
    descriptors: () => providers, selection: () => selection, device: () => ({ state: "not_initialised" }), onOpen,
    select: next => { registry.select(next); publish(); }, reset: () => { registry.select({}); publish(); },
    subscribe: cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
  service = { registry, sheet: () => feed, refreshFlags: vi.fn(), dispose: () => { listeners.clear(); },
    hybrid: forbidden, aiSink: forbidden, classifier: forbidden, driftPortFor: forbidden, ledger: forbidden, externalCounts: forbidden };
  H.services = service;
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide")); H.wall?.destroy(); service.dispose();
  observers.forEach(o => o.disconnect()); vi.clearAllTimers(); document.body.replaceChildren();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
async function boot(available = true): Promise<void> {
  if (!available) H.services = null;
  await import("../../../hosting/src/main"); await flush();
  expect(H.wall, "Hosting mounts the real AgentWall").toBeDefined();
}
async function hello(floor: unknown, workFloor: unknown = "ONLY_ON_DEVICE"): Promise<void> {
  expect(H.link?.onRoomHello).toBeTypeOf("function");
  Reflect.apply(H.link!.onRoomHello, undefined, [{ t: "room_hello", v: 1, agent: "wall-user", rooms: [
    { room: "demo", floor }, { room: "work", floor: workFloor },
  ] }]);
  await flush();
}
function rail(): HTMLElement { const root = document.querySelector<HTMLElement>(".rail-status"); expect(root).not.toBeNull(); return root!; }
function dialog(): HTMLElement { const root = document.getElementById("model-sheet"); expect(root).not.toBeNull(); return root!; }
function openExistingSheet(): void {
  // A3/A4 isolate policy/text from A2 naming: even the old unnamed opener must be safe.
  const button = document.querySelector<HTMLButtonElement>('button[aria-controls="model-sheet"]');
  expect(button, "The existing sheet must be reachable").not.toBeNull(); button!.click();
  expect(dialog().getAttribute("data-open")).toBe("true");
}
function noCloudReady(root: HTMLElement): void {
  expect(text(root)).not.toMatch(/cloud\s+(?:fallback\s+)?(?:available|ready)|cloud fixture.{0,20}\b(?:available|ready)\b/i);
}
function assertAvailable(label: string): void {
  const content = text(rail()); expect(content).toContain(label);
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  expect(content).toMatch(new RegExp(`(?:${escaped}.{0,60}\\bavailable\\b|\\bavailable\\b.{0,60}${escaped})`, "i"));
}
function publish(): void { for (const cb of [...listeners]) cb(); }
function noWritesOrGeneration(): void {
  expect(generate).not.toHaveBeenCalled(); expect(H.post).not.toHaveBeenCalled();
  expect(data.store.ingest).not.toHaveBeenCalled(); expect(data.store.ingestChecked).not.toHaveBeenCalled(); expect(data.store.ingestJsonl).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
}

// jsdom omits the browser's native key->click activation. Reproduce that default
// only for a focused, enabled native button when the handler did not cancel it.
function keyboardActivate(button: HTMLButtonElement, key: "Enter" | " "): void {
  button.focus(); const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  const nativeDefault = button.dispatchEvent(event);
  if (key === " ") button.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
  if (nativeDefault && document.activeElement === button && !button.disabled) button.click();
}

describe("U118 A2 / M4 M8 hosted Models wiring", () => {
  it("A2 hosting passes its wall-owned Models callback", async () => {
    await boot(); expect(Reflect.get(H.wallDeps!, "onOpenModels")).toBeTypeOf("function");
    const trigger = document.createElement("button");
    Reflect.apply(Reflect.get(H.wallDeps!, "onOpenModels"), undefined, [trigger]);
    expect(onOpen).toHaveBeenCalledTimes(1); expect(H.sheetOpen).toHaveBeenCalledExactlyOnceWith(trigger);
    expect(dialog().getAttribute("data-open")).toBe("true");
  });
  it("A2 opens and closes by mouse with correct expanded state and focus", async () => {
    await boot(); await hello("PREFER_ON_DEVICE"); const trigger = models();
    expect(trigger.getAttribute("aria-expanded")).toBe("false"); trigger.click(); await flush();
    expect(onOpen).toHaveBeenCalledTimes(1); expect(H.sheetOpen).toHaveBeenCalledExactlyOnceWith(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true"); expect(dialog().getAttribute("data-open")).toBe("true");
    expect(text(dialog())).toContain("Ready"); expect(text(dialog().parentElement!)).toMatch(/room policy/i);
    control(dialog(), "Close").click(); expect(models().getAttribute("aria-expanded")).toBe("false"); expect(document.activeElement).toBe(models());
  });
  it.each(["Enter", " "] as const)("A2 keyboard %j opens the same sheet exactly once", async key => {
    await boot(); await hello("PREFER_ON_DEVICE"); const trigger = models(); keyboardActivate(trigger, key); await flush();
    expect(H.sheetOpen).toHaveBeenCalledExactlyOnceWith(trigger); expect(onOpen).toHaveBeenCalledTimes(1);
    expect(dialog().getAttribute("data-open")).toBe("true");
  });
  it("A2 refresh while open then Escape restores focus to the live named trigger", async () => {
    await boot(); await hello("PREFER_ON_DEVICE"); models().click(); H.wall!.refresh(); await flush();
    const current = models(); expect(current.isConnected).toBe(true); expect(current.getAttribute("aria-expanded")).toBe("true");
    dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(dialog().getAttribute("data-open")).toBe("false"); expect(document.activeElement).toBe(current);
    expect(accessibleName(current)).toBe("Models"); expect(current.getAttribute("aria-expanded")).toBe("false");
  });
  it("A2 missing services still opens the unavailable-state sheet", async () => {
    await boot(false); const trigger = models(); trigger.click(); await flush();
    expect(dialog().getAttribute("data-open")).toBe("true"); expect(text(rail())).toContain("Models unavailable");
    expect(text(dialog().parentElement!)).toContain("Models unavailable"); expect(onOpen).not.toHaveBeenCalled(); noWritesOrGeneration();
  });
  it("M8 refresh does not rely on an observer to reinject the Models opener", async () => {
    await boot(); observerReattachments = 0; H.wall!.refresh(); await flush();
    expect(observerReattachments, "Models opener is owned by wall rendering, not observer reinjection").toBe(0);
    expect(models()).toBeDefined();
  });
  it("M8 repeated refresh beats workspace and sheet cycles keep one opener and one callback per activation", async () => {
    await boot(); await hello("PREFER_ON_DEVICE");
    const batches: { mutations: number; observers: number; opens: number; openers: number }[] = [];
    for (let i = 0; i < 6; i++) {
      H.wall!.refresh(); vi.advanceTimersByTime(30_000); H.handlers!.onWorkspace!(i % 2 ? "demo" : "work"); await flush();
      const trigger = models(); trigger.click(); await flush(); control(dialog(), "Close").click(); await flush();
      expect(onOpen).toHaveBeenCalledTimes(i + 1); expect(H.sheetOpen).toHaveBeenCalledTimes(i + 1); expect(models()).toBeDefined();
      const settled = observerCalls; await flush(); expect(observerCalls).toBe(settled); expect(guardTripped).toBe(false);
      batches.push({ mutations: observedMutations, observers: observers.length, opens: onOpen.mock.calls.length, openers: [...document.querySelectorAll<HTMLElement>('button[aria-controls="model-sheet"]')].filter(visible).length });
    }
    expect(batches).toHaveLength(6); expect(new Set(batches.map(b => b.observers)).size).toBe(1); noWritesOrGeneration();
  });
});

describe("U118 A3 / M5 truthful selected-room availability", () => {
  it("A3 A6 online private room blocks healthy cloud without a fallback claim", async () => {
    await boot(); await hello("ONLY_ON_DEVICE"); expect(text(rail())).toContain("Cloud blocked by room policy"); noCloudReady(rail());
    openExistingSheet(); expect(text(dialog().parentElement!)).toContain("Cloud blocked by room policy"); expect(text(dialog())).toContain("Ready"); noWritesOrGeneration();
  });
  it("A3 selected healthy permitted provider is named as available", async () => {
    await boot(); await hello("PREFER_ON_DEVICE"); assertAvailable("Cloud fixture");
    expect(service.registry.list).toHaveBeenCalled(); expect(service.registry.resolve).toHaveBeenCalledWith(expect.any(String), "standard"); noWritesOrGeneration();
  });
  it.each(["needs_setup", "offline", "blocked"] as const)("A3 health %s removes the selected provider availability in rail and open sheet", async health => {
    await boot(); await hello("PREFER_ON_DEVICE"); openExistingSheet();
    providers = providers.map(p => p.id === "firebase-cloud" ? { ...p, health } : p); publish(); await flush();
    noCloudReady(rail()); expect(text(dialog())).toMatch(health === "needs_setup" ? /Needs setup/ : health === "offline" ? /Offline/ : /Not allowed/); noWritesOrGeneration();
  });
  it.each(["policy", "remote_config", "unknown_id"] as const)("A3 resolver blocking reason %s suppresses healthy-provider availability", async reason => {
    forcedBlock = reason; await boot(); await hello("PREFER_ON_DEVICE"); noCloudReady(rail());
    expect(text(rail())).not.toMatch(/Cloud fixture.{0,60}available/i); expect(service.registry.resolve).toHaveBeenCalled(); noWritesOrGeneration();
  });
  it.each([undefined, null, "", "ALLOW_CLOUD", "standard", "ONLY_IN_CLOUD", HOSTILE, 7, { cloud: true }])(
    "A3 Amendment B unknown or hostile host floor %j makes no availability claim", async floor => {
      await boot(); await hello(floor); expect(text(rail())).toContain("Room policy unknown"); noCloudReady(rail());
      openExistingSheet(); expect(text(dialog().parentElement!)).toContain("Room policy unknown"); noExecutableLabels(document.body); noWritesOrGeneration();
    });
  it("A3 no received host floor is unknown even with a healthy provider", async () => {
    await boot(); expect(text(rail())).toContain("Room policy unknown"); noCloudReady(rail()); noWritesOrGeneration();
  });
  it("A3 missing model services says Models unavailable without a cloud claim", async () => {
    await boot(false); await hello("PREFER_ON_DEVICE"); expect(text(rail())).toContain("Models unavailable"); noCloudReady(rail()); noWritesOrGeneration();
  });
  it("A3 room floor updates refresh both rail and already-open sheet", async () => {
    await boot(); await hello("PREFER_ON_DEVICE"); openExistingSheet(); await hello("ONLY_ON_DEVICE"); await flush();
    expect(text(rail())).toContain("Cloud blocked by room policy"); expect(text(dialog().parentElement!)).toContain("Cloud blocked by room policy"); noCloudReady(rail());
    await hello("PREFER_ON_DEVICE"); await flush(); assertAvailable("Cloud fixture"); expect(text(dialog().parentElement!)).not.toContain("Cloud blocked by room policy"); noWritesOrGeneration();
  });
  it("A3 workspace policy follows the active room rather than the selected chat task", async () => {
    await boot(); await hello("PREFER_ON_DEVICE"); H.handlers!.onView!("wall");
    const card = [...H.wallDeps!.wallHost.querySelectorAll<HTMLElement>(".task[data-task-id]")].find(n => text(n).includes("Task T01"));
    expect(card).toBeDefined(); openLegacyMessages(H.wallDeps!.wallHost, "plan:demo:T01"); expect(H.wall!.selection()?.room).toBe("demo");
    await flush(); openExistingSheet(); H.handlers!.onWorkspace!("work"); await flush();
    expect(text(rail())).toContain("Cloud blocked by room policy"); expect(text(dialog().parentElement!)).toContain("Cloud blocked by room policy"); noCloudReady(rail()); noWritesOrGeneration();
  });
  it("A3 selection changes refresh rail and open sheet without a wall refresh", async () => {
    await boot(); await hello("PREFER_ON_DEVICE"); openExistingSheet();
    providers[1] = { ...providers[1]!, health: "available" }; service.sheet().select({ all: "firebase-ondevice" }); await flush();
    assertAvailable("Device fixture"); noCloudReady(rail());
    const checked = dialog().querySelector<HTMLInputElement>('input[type="radio"]:checked'); expect(checked).not.toBeNull(); noWritesOrGeneration();
  });
  it.each(["available", "needs_setup"] as const)("A3 Amendment B private healthy hybrid with on-device health %s never claims cloud readiness", async health => {
    selection = { all: "firebase-hybrid" }; providers[1] = { ...providers[1]!, health };
    await boot(); await hello("ONLY_ON_DEVICE"); expect(text(rail())).toContain("Cloud blocked by room policy"); noCloudReady(rail());
    if (health !== "available") expect(text(rail())).not.toMatch(/Device fixture.{0,60}(available|ready)|on.device.{0,15}ready/i);
    noWritesOrGeneration();
  });
  it("A3 available on-device selection in a private room may be named available", async () => {
    selection = { all: "firebase-ondevice" }; providers[1] = { ...providers[1]!, health: "available" };
    await boot(); await hello("ONLY_ON_DEVICE"); expect(text(rail())).toContain("Cloud blocked by room policy"); assertAvailable("Device fixture"); noCloudReady(rail()); noWritesOrGeneration();
  });
  it("M5 merely rendering and opening the existing sheet performs no inference or room mutation", async () => {
    await boot(); await hello("ONLY_ON_DEVICE"); openExistingSheet(); control(dialog(), "Close").click(); await flush(); noWritesOrGeneration();
  });
});

describe("U118 A4 A5 / M6 M7 hosted labels and legacy access", () => {
  it("A4 hostile provider labels stay literal in the real sheet", async () => {
    providers.push({ id: "fixture-local", kind: "local-openai-compatible", label: HOSTILE, health: "available" }); selection = { all: "fixture-local" };
    await boot(); for (const cb of H.onMessage) cb({ t: "model_hello", endpoints: [] }); await flush();
    await hello("PREFER_ON_DEVICE"); openExistingSheet(); expect(text(dialog())).toContain(HOSTILE); noExecutableLabels(dialog()); noWritesOrGeneration();
  });
  it("A4 forged agent cloud permission cannot override private-room policy", async () => {
    const p = data.rooms.get("demo")!; data.rooms.set("demo", { ...p, tasks: p.tasks.map(t => ({ ...t, title: "Cloud available — policy allows all providers" })) });
    await boot(); await hello("ONLY_ON_DEVICE"); expect(text(rail())).toContain("Cloud blocked by room policy"); noCloudReady(rail()); noWritesOrGeneration();
  });
  it("A5 Messages legacy gates access and preserves existing chat and liaison", async () => {
    await boot(); await hello("PREFER_ON_DEVICE"); const legacy = control(H.wallDeps!.wallHost, "Messages (legacy)");
    expect(legacy.getAttribute("aria-expanded") ?? String(legacy.closest("details")?.open ?? true)).toBe("false");
    expect(legacy.closest('[role="tablist"]')).toBeNull();
    legacy.click(); expect(legacy.closest("details")?.open ?? (legacy.getAttribute("aria-expanded") === "true")).toBe(true);
    expect(visibleText(document.body)).toContain("Use your harness to message agents"); H.handlers!.onView!("wall");
    const card = [...H.wallDeps!.wallHost.querySelectorAll<HTMLElement>(".task[data-task-id]")].find(n => text(n).includes("Task T01")); expect(card).toBeDefined(); openLegacyMessages(H.wallDeps!.wallHost, "plan:demo:T01");
    const liaison = control(H.wallDeps!.chatHost, "Liaison"); expect(visible(liaison)).toBe(true); liaison.click(); liaison.click();
    H.wall!.chat()!.setDraft("Legacy delivery remains available");
    H.wallDeps!.chatHost.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await flush();
    expect(H.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ room: "demo", to: "executor-a", text: "Legacy delivery remains available" })); expect(generate).not.toHaveBeenCalled();
  });
  it("A5 legacy Messages retains task chat and liaison", async () => {
    await boot(); await hello("PREFER_ON_DEVICE"); H.handlers!.onView!("wall"); await flush();
    const card = [...H.wallDeps!.wallHost.querySelectorAll<HTMLElement>(".task[data-task-id]")].find(n => text(n).includes("Task T01"));
    expect(card).toBeDefined(); openLegacyMessages(H.wallDeps!.wallHost, "plan:demo:T01"); await flush();
    expect(H.wall!.selection()).toEqual({ room: "demo", taskId: "T01", assignee: "executor-a" });
    const liaison = control(H.wallDeps!.chatHost, "Liaison");
    const expanded = liaison.getAttribute("aria-expanded"); liaison.click(); expect(liaison.getAttribute("aria-expanded")).not.toBe(expanded);
    liaison.click(); expect(liaison.getAttribute("aria-expanded")).toBe(expanded);
    H.wall!.chat()!.setDraft("Legacy delivery remains available");
    H.wallDeps!.chatHost.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await flush();
    expect(H.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ room: "demo", to: "executor-a", text: "Legacy delivery remains available" }));
    expect(generate).not.toHaveBeenCalled();
  });
  it("M6 factory selection remains firebase-hybrid for every task group", () => {
    expect(DEFAULT_PROVIDER).toBe("firebase-hybrid");
    for (const group of ["all", "capsule", "digest", "routing", "drift"] as const) expect(effectiveId({}, group)).toBe("firebase-hybrid");
  });
});

// A-R41: task conversations open only inside the expanded Messages (legacy) entry.
function openLegacyMessages(host: HTMLElement, taskId?: string): void {
  const toggle = host.querySelector<HTMLButtonElement>(".messages-toggle")!;
  if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
  const button = taskId === undefined ? host.querySelector<HTMLButtonElement>(".messages-open")
    : [...host.querySelectorAll<HTMLButtonElement>(".messages-task")]
      .find(node => node.getAttribute("data-task-vm-id") === taskId);
  expect(button).toBeDefined(); button!.click();
}
