import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelServices } from "../../../../src/app/model_services";
import type { ModelSelection } from "../../../../src/providers/types";
import { services, factory, settled, flush, FakePort, LOCAL } from "../wire/fixtures";
import { env, fakes } from "../../u22/harness";
import { resetBootStateForTests } from "../../../../src/app/boot";

const ROOT = process.cwd();
const MODULES = ["../../../../src/app/model_services", "../../../../src/app/firebase_ports", "../../../../src/ai/firebase", "../../../../src/app/index", "../../../../src/app/boot"];
beforeEach(() => { vi.useFakeTimers(); resetBootStateForTests(); });
afterEach(async () => {
  for (const id of MODULES) vi.doUnmock(id);
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers();
  document.body.replaceChildren();
});

async function page() {
  vi.resetModules();
  const f = fakes({ user: { uid: "u52-page", isAnonymous: true } }); const sdk = factory();
  const model = await vi.importActual<typeof import("../../../../src/app/model_services")>("../../../../src/app/model_services");
  const actualBoot = await vi.importActual<typeof import("../../../../src/app/boot")>("../../../../src/app/boot");
  actualBoot.resetBootStateForTests();
  const instances: ModelServices[] = [];
  const created = vi.fn((d: Parameters<typeof model.createModelServices>[0]) => {
    const service = model.createModelServices(d); instances.push(service); return service;
  });
  vi.doMock("../../../../src/app/model_services", () => ({ ...model, createModelServices: created }));
  vi.doMock("../../../../src/app/firebase_ports", () => ({ createFirebasePorts: () => f.fb }));
  vi.doMock("../../../../src/ai/firebase", () => ({ firebaseFactory: () => sdk.f }));
  vi.doMock("../../../../src/app/index", () => ({ readHostEnv: () => env() }));
  let bootPromise: ReturnType<typeof actualBoot.boot> | undefined;
  vi.doMock("../../../../src/app/boot", () => ({ ...actualBoot,
    boot: (...args: Parameters<typeof actualBoot.boot>) => { bootPromise = actualBoot.boot(...args); return bootPromise; },
  }));
  vi.stubGlobal("__U22_FIREBASE_REAL__", true);
  const ports: FakePort[] = [];
  vi.stubGlobal("chrome", { runtime: { connect: () => { const p = new FakePort(); ports.push(p); return p; } } });
  const NativeObserver = globalThis.MutationObserver;
  const observers: MutationObserver[] = [];
  vi.stubGlobal("MutationObserver", class extends NativeObserver {
    constructor(cb: MutationCallback) { super(cb); observers.push(this); }
  });
  document.body.innerHTML = '<main id="wall"></main>';
  await import("../../../../hosting/src/main"); await flush();
  expect(bootPromise, "the actual hosted page must boot").toBeDefined();
  const result = await settled(bootPromise!);
  return { result, created, sdk, ports, instances, async cleanup() {
    for (const service of instances) service.dispose();
    for (const o of observers) o.disconnect();
    actualBoot.resetBootStateForTests(); vi.clearAllTimers();
  } };
}

describe("U52 repair R5 channel replacement", () => {
  it("R5 stale port frames after rebinding do not enable sending on the new port", async () => {
    const w = services(); expect(w.service.registry.list()).toHaveLength(3); w.service.dispose();
    const p = await page();
    try {
      expect(p.ports.length).toBeGreaterThan(0);
      const portA = p.ports[0]!;
      const instance = p.instances[0]!;
      let selection: ModelSelection = {};
      const sendA = portA.postMessage.bind(portA);
      portA.postMessage = (raw: unknown) => {
        sendA(raw); const f = raw as Record<string, unknown>; const rid = f["rid"];
        Promise.resolve().then(() => {
          if (f["t"] === "model_list") portA.emit({ t: "model_hello", v: 1, rid, endpoints: [LOCAL] });
          if (f["t"] === "model_probe") portA.emit({ t: "model_health", v: 1, rid, id: LOCAL.id, state: "available", rung: 1 });
          if (f["t"] === "model_sel_set") selection = f["selection"] as ModelSelection;
          if (f["t"] === "model_sel_get" || f["t"] === "model_sel_set") portA.emit({ t: "model_sel", v: 1, rid, selection });
        });
      };
      portA.emit({ t: "model_hello", v: 1, endpoints: [LOCAL] }); await flush();
      await settled(instance.registry.refresh());
      instance.registry.select({ all: LOCAL.id });

      portA.drop(); await vi.advanceTimersByTimeAsync(100); await flush();
      expect(p.ports.length).toBeGreaterThan(1);
      const portB = p.ports.at(-1)!;
      expect(portB).not.toBe(portA);

      portA.emit({ t: "model_hello", v: 1, endpoints: [LOCAL] }); await flush();
      const before = portB.ofType("model_list").length;
      await settled(instance.registry.refresh());
      expect(portB.ofType("model_list").length).toBe(before);
      expect(portB.sent.filter((f) => String(f["t"]).startsWith("model_"))).toEqual([]);
    } finally { await p.cleanup(); }
  });
});
