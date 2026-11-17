import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNarratorController } from "../../../src/app/narrator";
import { renderNarrator } from "../../../src/views/narrator";
import type { HybridParamsShape, ModelFactory, ModelHandle, ModeName } from "../../../src/ai/types";
import type { Clock } from "../../../src/providers/types";
import { viewModel } from "../u136/fixtures";
import { normalized, requireAnnouncement, watchLiveUpdates } from "./live";

type Controller = ReturnType<typeof createNarratorController>;
type Snapshot = ReturnType<Controller["snapshot"]>;
type Input = Parameters<Controller["update"]>[0];
const DEVICE = Object.freeze({ source: "device" });
const CLOUD = Object.freeze({ source: "cloud" });
const controllers: Controller[] = [];
let live: ReturnType<typeof watchLiveUpdates>;

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  document.body.replaceChildren(); live = watchLiveUpdates(document);
  const network = vi.fn((): never => { throw new Error("Network is forbidden in this oracle"); });
  vi.stubGlobal("fetch", network); vi.stubGlobal("WebSocket", network);
});
afterEach(() => {
  controllers.splice(0).forEach(controller => controller.dispose()); live.stop();
  vi.clearAllTimers(); document.body.replaceChildren();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
async function settle(): Promise<void> {
  for (let n = 0; n < 48; n++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(1_000);
  for (let n = 0; n < 48; n++) await Promise.resolve();
  live.healthy();
}
function context(extra: Partial<Input> = {}): Input {
  return { vm: viewModel(), policyRoom: "demo", tier: "standard", head: 1,
    binding: { providerId: "firebase-hybrid", generation: 1 }, cloudAllowed: true, ...extra };
}
function rig(source: unknown = DEVICE, error?: Error) {
  const readText = vi.fn(() => JSON.stringify({ items: [
    { kind: "working", agent: "executor-a", task: "T01", blocked_on: null, owner: null },
  ] }));
  const generate = vi.fn<ModelHandle["generateContent"]>(async () => {
    if (error) throw error;
    return { response: { text: readText, inferenceSource: source } };
  });
  const create = vi.fn((_params: HybridParamsShape): ModelHandle => ({
    generateContent: generate, initializeDeviceModel: async () => undefined,
  }));
  const factory: ModelFactory = { create, modeConst: (mode: ModeName) => mode,
    sourceConst: { ON_DEVICE: DEVICE, IN_CLOUD: CLOUD } };
  const clock: Clock = { now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  const controller = createNarratorController({ factory, origin: window.location.origin, clock });
  controllers.push(controller);
  return { controller, create, generate, readText };
}
function mount(snapshot: Snapshot) {
  const host = document.createElement("div"); document.body.append(host);
  const render = (next: Snapshot): void => { host.replaceChildren(renderNarrator(document, next, () => undefined)); };
  render(snapshot); return { host, render };
}
function noNetwork(): void {
  expect(globalThis.fetch).not.toHaveBeenCalled(); expect(globalThis.WebSocket).not.toHaveBeenCalled();
}

describe("U147 A2 narration changes use live text updates", () => {
  it.each([
    ["ON_DEVICE", DEVICE], ["IN_CLOUD", CLOUD],
  ] as const)("A2 a real %s model outcome announces changed narration after mounting", async (source, sdkSource) => {
    const r = rig(sdkSource), view = mount(r.controller.snapshot());
    r.controller.subscribe(() => view.render(r.controller.snapshot()));
    await settle(); live.clear();
    r.controller.update(context()); await settle();
    const outcome = r.controller.snapshot();
    expect(outcome.kind).toBe("generated"); expect(outcome.source).toBe(source);
    expect(normalized(view.host)).toContain(outcome.text);
    requireAnnouncement(live.messages, outcome.text); noNetwork();
  });
  it("A2 changed rules narration announces after the previous narration was mounted", async () => {
    const view = mount({ kind: "rules", source: null, text: "No agents deployed" });
    await settle(); live.clear();
    const text = "executor-a failed while working on T01.";
    view.render({ kind: "rules", source: null, text }); await settle();
    expect(normalized(view.host)).toContain(text);
    requireAnnouncement(live.messages, text);
  });
});

describe("U147 A3 inference-source attribution stays truthful", () => {
  it.each([
    ["ON_DEVICE", DEVICE, /ON_DEVICE.*Gemini Nano/],
    ["IN_CLOUD", CLOUD, /IN_CLOUD.*gemini-4-hydrogen.*fallback/],
  ] as const)("A3 displays the actual %s outcome rather than the requested preference", async (source, sdkSource, label) => {
    const r = rig(sdkSource); r.controller.update(context()); await settle();
    const snapshot = r.controller.snapshot(); expect(snapshot.source).toBe(source);
    const view = mount(snapshot); await settle();
    expect(normalized(view.host)).toMatch(label);
    expect(normalized(view.host)).not.toMatch(source === "ON_DEVICE" ? /IN_CLOUD/ : /ON_DEVICE/);
    noNetwork();
  });
  it.each(["rules", "generating"] as const)("A3 %s replaces old generated attribution with Rules summary", async kind => {
    const view = mount({ kind: "generated", source: "IN_CLOUD", text: "executor-a is working on T01." });
    await settle();
    view.render({ kind, source: null, text: "executor-a: Liveness unknown." }); await settle();
    expect(normalized(view.host)).toContain("Rules summary");
    expect(normalized(view.host)).toContain("executor-a: Liveness unknown.");
    expect(normalized(view.host)).not.toMatch(/ON_DEVICE|IN_CLOUD|Gemini Nano|gemini-4-hydrogen/);
  });
  it("A3 unknown SDK source fails closed without reading or attributing generated text", async () => {
    const r = rig(Object.freeze({ source: "unknown" })); r.controller.update(context()); await settle();
    const snapshot = r.controller.snapshot();
    expect(snapshot.kind).toBe("rules"); expect(snapshot.source).toBeNull();
    expect(r.readText).not.toHaveBeenCalled();
    const view = mount(snapshot); await settle();
    expect(normalized(view.host)).not.toMatch(/ON_DEVICE|IN_CLOUD|Gemini Nano|gemini-4-hydrogen/);
    noNetwork();
  });
});

describe("U147 A4 private-room hostile inputs and privacy stop rule", () => {
  it("A4 unavailable on-device model makes no cloud-capable request and explains the fallback", async () => {
    const r = rig(DEVICE, new Error("ON_DEVICE_UNAVAILABLE"));
    r.controller.update(context({ tier: "private" })); await settle();
    expect(r.generate).toHaveBeenCalledTimes(1); expect(r.create).toHaveBeenCalledTimes(1);
    for (const [params] of r.create.mock.calls) {
      expect(params.mode).toBe("ONLY_ON_DEVICE"); expect(params).not.toHaveProperty("inCloudParams");
    }
    const snapshot = r.controller.snapshot();
    expect(snapshot.kind).toBe("rules"); expect(snapshot.source).toBeNull(); expect(snapshot.reason).toBeDefined();
    const view = mount(snapshot); await settle();
    expect(normalized(view.host)).toMatch(/Rules summary/i);
    // Human wording stays open; the device/setup failure must be intelligible.
    expect(normalized(view.host)).toMatch(/on.device|device setup|NEEDS_SETUP|unavailable|not available/i);
    expect(normalized(view.host)).not.toMatch(/IN_CLOUD|ON_DEVICE|Gemini Nano|gemini-4-hydrogen/);
    noNetwork();
  });
  it("A4 a private request reporting a forbidden cloud source never publishes or labels generated narration", async () => {
    const r = rig(CLOUD), seen: Snapshot[] = [];
    r.controller.subscribe(() => seen.push(r.controller.snapshot()));
    r.controller.update(context({ tier: "private" })); await settle();
    expect(r.create).toHaveBeenCalledTimes(1);
    for (const [params] of r.create.mock.calls) {
      expect(params.mode).toBe("ONLY_ON_DEVICE"); expect(params).not.toHaveProperty("inCloudParams");
    }
    expect(seen.some(snapshot => snapshot.kind === "generated")).toBe(false);
    expect(r.readText).not.toHaveBeenCalled();
    const snapshot = r.controller.snapshot(); expect(snapshot.kind).toBe("rules"); expect(snapshot.source).toBeNull();
    const view = mount(snapshot); await settle();
    expect(normalized(view.host)).not.toMatch(/IN_CLOUD|ON_DEVICE|Gemini Nano|gemini-4-hydrogen/);
    noNetwork();
  });
});

describe("U147 A5 negative-control calibration of the DOM announcement gate", () => {
  it("A5 accepts a text mutation in an already connected live region", async () => {
    const status = document.createElement("p"); status.setAttribute("role", "status");
    status.textContent = "Before"; document.body.append(status); await settle(); live.clear();
    status.textContent = "Model ready"; await settle();
    requireAnnouncement(live.messages, "Model ready");
  });
  it("A5 rejects insertion-only populated live regions", async () => {
    const status = document.createElement("p"); status.setAttribute("role", "status");
    status.textContent = "Model ready"; document.body.append(status); await settle();
    expect(() => requireAnnouncement(live.messages, "Model ready")).toThrow();
  });
  it("A5 rejects the no-op announcer with the same announcement gate", () => {
    const noOp = { say: (_key: string, _text: string): void => undefined };
    noOp.say("models.outcome", "Model ready");
    expect(() => requireAnnouncement(live.messages, "Model ready")).toThrow();
  });
});
