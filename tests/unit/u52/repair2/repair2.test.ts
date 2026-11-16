import { afterEach, expect, it, vi } from "vitest";
import { createFrameSelectionStore } from "../../../../src/app/model_port";
import { Channel, FakeClock, services, deferred, factory, flush, settled, LOCAL, FakePort } from "../wire/fixtures";
import { track } from "../../u47/fixtures";

afterEach(() => vi.restoreAllMocks());
const frameStore = createFrameSelectionStore;

it("bounds unanswered reads before and after hello with the injected clock", async () => {
  for (const hello of [false, true]) {
    const ch = new Channel(); const clock = new FakeClock();
    const store = frameStore(ch, clock);
    if (hello) ch.hello();
    const read = track(store.get()); await flush();
    await clock.advance(1499); expect(read.done).toBe(false);
    await clock.advance(1); await flush();
    expect(read).toMatchObject({ done: true, val: {} });
    expect(clock.pending).toBe(0); store.dispose();
  }
});

it("reset and disposal settle pre-hello reads and remove owned subscriptions", async () => {
  const ch = new Channel(); const clock = new FakeClock(); const store = frameStore(ch, clock);
  const read = track(store.get()); ch.reset(); await flush();
  expect(read).toMatchObject({ done: true, val: {} });
  const next = track(store.get()); store.dispose(); await flush();
  expect(next).toMatchObject({ done: true, val: {} }); expect(clock.pending).toBe(0);
  const ownedChannel = new Channel(); const { service } = services({ channel: ownedChannel });
  service.dispose(); await flush();
  expect(ownedChannel.frames.size).toBe(0); expect(ownedChannel.resets.size).toBe(0);
});

it("a reset between readiness and its continuation cannot send on the new port", async () => {
  const ch = new Channel(); const store = frameStore(ch, new FakeClock());
  ch.hello(); const read = track(store.get()); ch.reset(); await flush();
  expect(ch.of("model_sel_get")).toEqual([]);
  expect(read).toMatchObject({ done: true, val: {} });
  const fresh = track(store.get()); await flush(); expect(ch.sent).toEqual([]);
  ch.hello(); await flush();
  const rid = ch.of("model_sel_get")[0]!["rid"];
  ch.emit({ t: "model_sel", rid, selection: { all: "firebase-cloud" } }); await flush();
  expect(fresh).toMatchObject({ done: true, val: { all: "firebase-cloud" } }); store.dispose();
});

it("real frame-store initial reads cannot overwrite a newer user choice through either path", async () => {
  const ch = new Channel(); const store = frameStore(ch, new FakeClock());
  const changes = vi.fn(); store.onChange(changes);
  const { service } = services({ selectionStore: store });
  ch.hello(); await flush(); const rid = ch.of("model_sel_get")[0]!["rid"];
  service.sheet().select({ all: "firebase-cloud" });
  ch.emit({ t: "model_sel", rid, selection: { all: "firebase-ondevice" } }); await flush();
  expect(service.sheet().selection()).toEqual({ all: "firebase-cloud" });
  expect(changes).not.toHaveBeenCalled(); service.dispose(); store.dispose();
});

it("publishes delayed selection, registry refresh, device progress and completion", async () => {
  const ch = new Channel(); const sdk = factory(); const done = deferred<void>();
  const progresses: Array<(p: number) => void> = [];
  sdk.init.mockImplementation(p => { if (p) progresses.push(p); return done.promise; });
  const { service } = services({ factory: sdk.f, channel: ch });
  const snapshots: unknown[] = [];
  service.sheet().subscribe(() => snapshots.push({ selection: service.sheet().selection(), device: service.sheet().device(), ids: service.sheet().descriptors().map(d => d.id) }));
  ch.hello(); await flush(); const rid = ch.of("model_sel_get")[0]!["rid"];
  ch.emit({ t: "model_sel", rid, selection: { all: "firebase-cloud" } }); await flush();
  expect(snapshots).toContainEqual(expect.objectContaining({ selection: { all: "firebase-cloud" } }));
  ch.host([LOCAL]); await settled(service.registry.refresh());
  expect(snapshots).toContainEqual(expect.objectContaining({ ids: expect.arrayContaining([LOCAL.id]) }));
  const init = service.registry.initDevice(); await flush(); for (const progress of progresses) progress(0.4); await flush();
  expect(snapshots).toContainEqual(expect.objectContaining({ device: { state: "downloading", progress: 0.4 } }));
  done.resolve(); await settled(init);
  expect(snapshots).toContainEqual(expect.objectContaining({ device: { state: "ready" } })); service.dispose();
});

import type { ModelServices } from "../../../../src/app/model_services";
import { env, fakes } from "../../u22/harness";
import type { ModelSheetSnapshot } from "../../../../src/ui/model_selector";

it("hosted sheet renders late storage and device snapshots without another action", async () => {
  vi.useFakeTimers(); vi.resetModules();
  const modules = ["../../../../src/app/model_services", "../../../../src/app/firebase_ports", "../../../../src/ai/firebase", "../../../../src/app/index", "../../../../src/app/boot", "../../../../src/ui/model_selector"];
  const observers: MutationObserver[] = [];
  const instances: ModelServices[] = [];
  const sdk = factory(); const done = deferred<void>();
  const progressCallbacks: Array<(p: number) => void> = [];
  sdk.init.mockImplementation(p => { if (p) progressCallbacks.push(p); return done.promise; });
  const actualBoot = await vi.importActual<typeof import("../../../../src/app/boot")>("../../../../src/app/boot");
  const model = await vi.importActual<typeof import("../../../../src/app/model_services")>("../../../../src/app/model_services");
  const ui = await vi.importActual<typeof import("../../../../src/ui/model_selector")>("../../../../src/ui/model_selector");
  const snapshots: ModelSheetSnapshot[] = [];
  actualBoot.resetBootStateForTests();
  vi.doMock("../../../../src/ui/model_selector", () => ({ ...ui, createModelSheet: (d: Parameters<typeof ui.createModelSheet>[0]) => {
    const sheet = ui.createModelSheet(d);
    return { ...sheet, render(s: ModelSheetSnapshot) { snapshots.push(structuredClone(s)); sheet.render(s); } };
  } }));
  vi.doMock("../../../../src/app/model_services", () => ({ ...model, createModelServices: (d: Parameters<typeof model.createModelServices>[0]) => {
    const service = model.createModelServices(d); instances.push(service); return service;
  } }));
  const f = fakes({ user: { uid: "sheet-test", isAnonymous: true } });
  vi.doMock("../../../../src/app/firebase_ports", () => ({ createFirebasePorts: () => f.fb }));
  vi.doMock("../../../../src/ai/firebase", () => ({ firebaseFactory: () => sdk.f }));
  vi.doMock("../../../../src/app/index", () => ({ readHostEnv: () => env() }));
  let bootPromise: ReturnType<typeof actualBoot.boot> | undefined;
  vi.doMock("../../../../src/app/boot", () => ({ ...actualBoot, boot: (...args: Parameters<typeof actualBoot.boot>) => {
    bootPromise = actualBoot.boot(...args); return bootPromise;
  } }));
  const ports: FakePort[] = [];
  vi.stubGlobal("__U22_FIREBASE_REAL__", true);
  vi.stubGlobal("chrome", { runtime: { connect: () => { const p = new FakePort(); ports.push(p); return p; } } });
  const NativeObserver = globalThis.MutationObserver;
  vi.stubGlobal("MutationObserver", class extends NativeObserver {
    constructor(cb: MutationCallback) { super(cb); observers.push(this); }
  });
  document.body.innerHTML = '<main id="wall"></main>';
  try {
    await import("../../../../hosting/src/main"); await flush(); await settled(bootPromise!);
    const port = ports.at(-1)!;
    port.emit({ t: "model_hello", v: 1, endpoints: [] }); await flush();
    document.querySelector<HTMLElement>('.rail-status [aria-controls="model-sheet"]')!.click(); await flush();
    snapshots.length = 0;
    const rid = port.ofType("model_sel_get")[0]!["rid"];
    port.emit({ t: "model_sel", rid, selection: { all: "firebase-cloud" } }); await flush();
    expect(snapshots).toContainEqual(expect.objectContaining({ selection: { all: "firebase-cloud" } }));
    snapshots.length = 0;
    const activation = actualBoot.onUserActivation(true); await flush();
    for (const progress of progressCallbacks) progress(0.6);
    await flush();
    expect(snapshots).toContainEqual(expect.objectContaining({ device: { state: "downloading", progress: 0.6 } }));
    done.resolve(); await settled(activation);
    expect(snapshots.at(-1)?.device).toEqual({ state: "ready" });
  } finally {
    done.resolve(); for (const service of instances) service.dispose();
    for (const observer of observers) observer.disconnect();
    actualBoot.resetBootStateForTests(); vi.clearAllTimers();
    for (const id of modules) vi.doUnmock(id);
    vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); document.body.replaceChildren();
  }
});
