import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { ModelServices } from "../../../../src/app/model_services";
import type { ModelSelection } from "../../../../src/providers/types";
import { services, factory, settled, signal, flush, FakePort, LOCAL } from "./fixtures";
import { env, fakes } from "../../u22/harness";
import { resetBootStateForTests } from "../../../../src/app/boot";

const ROOT = process.cwd(); // vitest runs from the repository root
const MODULES = ["../../../../src/app/model_services", "../../../../src/app/firebase_ports", "../../../../src/ai/firebase", "../../../../src/app/index", "../../../../src/app/boot"];
beforeEach(() => { vi.useFakeTimers(); resetBootStateForTests(); });
afterEach(async () => {
  for (const id of MODULES) vi.doUnmock(id);
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers();
  document.body.replaceChildren();
});

async function page(constructionFails = false) {
  vi.resetModules();
  const f = fakes({ user: { uid: "u52-page", isAnonymous: true } }); const sdk = factory();
  const model = await vi.importActual<typeof import("../../../../src/app/model_services")>("../../../../src/app/model_services");
  const actualBoot = await vi.importActual<typeof import("../../../../src/app/boot")>("../../../../src/app/boot");
  actualBoot.resetBootStateForTests();
  const instances: ModelServices[] = [];
  const created = vi.fn((d: Parameters<typeof model.createModelServices>[0]) => {
    if (constructionFails) throw new Error("injected U52 construction failure");
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
  // Prevent a placeholder production define from defeating the supplied real test config.
  vi.stubGlobal("__U22_FIREBASE_REAL__", true);
  const ports: FakePort[] = [];
  vi.stubGlobal("chrome", { runtime: { connect: () => { const p = new FakePort(); ports.push(p); return p; } } });
  // Capture observers so each page test disconnects them. No polling or real timers.
  const NativeObserver = globalThis.MutationObserver;
  const observers: MutationObserver[] = [];
  vi.stubGlobal("MutationObserver", class extends NativeObserver {
    constructor(cb: MutationCallback) { super(cb); observers.push(this); }
  });
  document.body.innerHTML = '<main id="wall"></main>';
  await import("../../../../hosting/src/main"); await flush();
  expect(bootPromise, "the actual hosted page must boot").toBeDefined();
  const result = await settled(bootPromise!);
  return { result, created, sdk, ports, instances, activate: actualBoot.onUserActivation, async cleanup() {
    for (const service of instances) service.dispose();
    for (const o of observers) o.disconnect();
    actualBoot.resetBootStateForTests(); vi.clearAllTimers();
  } };
}

describe("W2-R hosted composition and W3 containment", () => {
  it("W3 default drift remains live and hosted services-construction failure still boots ready", async () => {
    const w = services(); const n = w.sdk.calls.length;
    await settled(w.service.driftPortFor("PREFER_ON_DEVICE").port.generate("default page drift", {}, signal()));
    expect(w.sdk.calls.length).toBeGreaterThan(n); w.service.dispose();
    const p = await page(true);
    try { expect(p.created).toHaveBeenCalled(); expect(p.result.kind).toBe("ready"); }
    finally { await p.cleanup(); }
  });
  it("W2 W2-R no host: actual rail opens sheet with Firebase defaults and emits no model frames", async () => {
    // The same public composition used by the page is a required prerequisite for this flow.
    const w = services(); expect(w.service.registry.list()).toHaveLength(3); w.service.dispose();
    const p = await page();
    try {
      expect(p.created).toHaveBeenCalled(); expect(p.result.kind).toBe("ready");
      const trigger = document.querySelector<HTMLElement>('.rail-status [aria-controls="model-sheet"]');
      expect(trigger).not.toBeNull(); trigger!.click(); await flush();
      const sheet = document.getElementById("model-sheet");
      expect(sheet?.getAttribute("data-open")).toBe("true");
      expect(sheet?.textContent).toContain("Firebase AI Logic");
      expect(sheet?.querySelector('[data-group="local"]')).toBeNull();
      for (const port of p.ports) expect(port.sent.filter(f => String(f["t"]).startsWith("model_"))).toEqual([]);
    } finally { await p.cleanup(); }
  });
  it("W3 actual page initialization loops downloading until ready through registry", async () => {
    const w = services(); expect(await settled(w.service.registry.initDevice())).toEqual({ state: "ready" }); w.service.dispose();
    const p = await page();
    try {
      expect(p.instances).toHaveLength(1);
      const init = vi.spyOn(p.instances[0]!.registry, "initDevice")
        .mockResolvedValueOnce({ state: "downloading", progress: 0.3 })
        .mockResolvedValueOnce({ state: "downloading", progress: 0.6 })
        .mockResolvedValueOnce({ state: "ready" });
      await settled(p.activate(true)); expect(init).toHaveBeenCalledTimes(3);
      expect(document.getElementById("wall")?.textContent).toMatch(/initialized/i);
    } finally { await p.cleanup(); }
  });
  it("W2-R hello refreshes sheet; all/group selection and reset use ids-only selection frames", async () => {
    const w = services(); expect(w.service.registry.list()).toHaveLength(3); w.service.dispose();
    const p = await page();
    try {
      expect(p.ports.length).toBeGreaterThan(0); const port = p.ports.at(-1)!;
      let selection: ModelSelection = {};
      const send = port.postMessage.bind(port);
      port.postMessage = raw => {
        send(raw); const f = raw as Record<string, unknown>; const rid = f["rid"];
        Promise.resolve().then(() => {
          if (f["t"] === "model_list") port.emit({ t: "model_hello", v: 1, rid, endpoints: [LOCAL] });
          if (f["t"] === "model_probe") port.emit({ t: "model_health", v: 1, rid, id: LOCAL.id, state: "available", rung: 1 });
          if (f["t"] === "model_sel_set") selection = f["selection"] as ModelSelection;
          if (f["t"] === "model_sel_get" || f["t"] === "model_sel_set") port.emit({ t: "model_sel", v: 1, rid, selection });
        });
      };
      port.emit({ t: "model_hello", v: 1, endpoints: [LOCAL] }); await flush();
      const trigger = document.querySelector<HTMLElement>('.rail-status [aria-controls="model-sheet"]');
      expect(trigger).not.toBeNull(); trigger!.click(); await flush();
      const root = document.getElementById("model-sheet")!;
      expect(root.querySelector('[data-group="local"]')?.textContent).toContain("Local");
      const chooseLocal = async () => {
        const label = [...root.querySelectorAll("label")].find(n => n.textContent?.includes("Local"));
        const radio = label?.querySelector<HTMLInputElement>('input[type="radio"]');
        expect(radio).not.toBeNull(); expect(radio).toBeDefined(); radio!.checked = true;
        radio!.dispatchEvent(new Event("change", { bubbles: true })); await flush();
      };
      await chooseLocal(); expect(port.ofType("model_sel_set").at(-1)?.["selection"]).toMatchObject({ all: LOCAL.id });
      const scope = root.querySelector<HTMLSelectElement>("select")!; scope.value = "drift";
      scope.dispatchEvent(new Event("change", { bubbles: true })); await chooseLocal();
      expect(port.ofType("model_sel_set").at(-1)?.["selection"]).toMatchObject({ groups: { drift: LOCAL.id } });
      const reset = [...root.querySelectorAll("button")].find(n => n.textContent === "Reset to Firebase hybrid");
      expect(reset).toBeDefined(); reset!.click(); await flush();
      expect(port.ofType("model_sel_set").at(-1)?.["selection"]).toEqual({});
      for (const frame of port.ofType("model_sel_set")) expect(Object.keys(frame).sort()).toEqual(["rid", "selection", "t", "v"]);
      const count = port.ofType("model_list").length;
      const refresh = [...root.querySelectorAll("button")].find(n => n.textContent === "Check again"); refresh!.click(); await flush();
      expect(port.ofType("model_list").length).toBeGreaterThan(count);
    } finally { await p.cleanup(); }
  });
  it("W10 injected-clock behaviour plus static ban on globals and required hosted sheet/style wiring", async () => {
    const w = services(); await settled(w.service.registry.initDevice()); w.service.dispose();
    for (const file of ["src/app/model_port.ts", "src/app/model_services.ts"]) {
      const source = readFileSync(`${ROOT}/${file}`, "utf8");
      // Strip comments; the prohibition concerns executable global access, not clock methods.
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      expect(code).not.toMatch(/(?<![\w.])(?:setTimeout|setInterval)\s*\(|(?:globalThis|window)\s*\.\s*(?:setTimeout|setInterval)\s*\(|Date\s*\.\s*now\s*\(/);
    }
    const main = readFileSync(`${ROOT}/hosting/src/main.ts`, "utf8");
    expect(main).toContain('import "../../styles/model_selector.css"');
    expect(main).toMatch(/createModelServices/); expect(main).toMatch(/attachModelChannel/);
    expect(main).toMatch(/createModelSheet/);
  });
});
