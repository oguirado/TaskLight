import { afterEach, beforeEach, expect, vi } from "vitest";
import { createProviderRegistry } from "../../../src/providers/registry";
import { createLiaisonController } from "../../../src/app/liaison";
import type {
  DraftStorage, LiaisonController, LiaisonDeps, LiaisonGenerateRequest, LiaisonInput,
  LiaisonOutput, LiaisonProviderPort, LiaisonProviderResult, LiaisonSelection,
} from "../../../src/app/liaison";
import type { EndpointInfo, FirebaseTextFn, ProviderDeps, ProviderGates, ProviderRegistry } from "../../../src/providers/types";
import type { LiaisonPanelHandle } from "../../../src/agentsui/liaison_panel";
import { FakeClock, FakeHybrid } from "../u47/fixtures";

export const HOSTILE = "<img src=x onerror=alert(1)>";
export const OUTPUT: LiaisonOutput = { kind: "draft", text: "A careful draft", refs: ["event-1"] };
export const ALL_ON: ProviderGates = { externalEnabled: true, remoteEnabled: true, killSwitchCloud: false };
export const REMOTE: EndpointInfo = { id: "remote-test", kind: "remote-openai-compatible", label: "Remote test",
  model: "reported-remote-model", loopback: false, has_key: true, allow_private: false };
export const LOCAL: EndpointInfo = { id: "local-test", kind: "local-openai-compatible", label: "Local test",
  model: "reported-local-model", loopback: true, has_key: false, allow_private: true };

export function input(overrides: Partial<LiaisonInput> = {}): LiaisonInput {
  return { room: "demo", task_id: "T01", micro_id: "M01", human: { id: "human-1", text: "  Original human draft\n" },
    tier: "standard", rules: "Preserve these rules verbatim.\nNo automatic delivery.", projection: { title: "Work plan" },
    history: [{ id: "event-1", text: "Executor conversation" }], cursor: 7, ...overrides };
}
export function answer(overrides: Partial<Extract<LiaisonProviderResult, { ok: true }>> = {}): LiaisonProviderResult {
  return { ok: true, text: JSON.stringify(OUTPUT), providerId: REMOTE.id, modelLabel: "Reported answer model",
    source: "REMOTE_PROVIDER", fallback: false, ...overrides };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function flush(): Promise<void> { for (let n = 0; n < 40; n += 1) await Promise.resolve(); }

const controllers: LiaisonController[] = [];
const panels: LiaisonPanelHandle[] = [];
export function keepPanel(panel: LiaisonPanelHandle): LiaisonPanelHandle { panels.push(panel); return panel; }
export function boot(deps: LiaisonDeps): LiaisonController {
  const controller = createLiaisonController(deps);
  controllers.push(controller);
  return controller;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden in U93 oracle"); }));
});
afterEach(() => {
  for (const panel of panels.splice(0)) panel.destroy();
  for (const controller of controllers.splice(0)) controller.destroy();
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

export function fakeDeps() {
  const trace: string[] = [];
  const writes: { key: string; value: { human: LiaisonInput["human"]; cursor: number } }[] = [];
  const storage: DraftStorage = { setItem: vi.fn((key: string, value: string) => {
    trace.push("persist"); writes.push({ key, value: JSON.parse(value) });
  }) };
  const generate = vi.fn(async (_req: LiaisonGenerateRequest): Promise<LiaisonProviderResult> => {
    trace.push("infer"); return answer();
  });
  const registry: LiaisonProviderPort = {
    generate, select: vi.fn(), resolve: vi.fn(() => ({ primary: REMOTE.id, hop: "firebase-hybrid", blocked: undefined })),
  };
  return { registry, generate, storage, trace, writes };
}

interface ExtendedRegistry extends Omit<ProviderRegistry, "select" | "generate" | "resolve">, LiaisonProviderPort {
  select(selection: LiaisonSelection): void;
}
export async function providerWorld(options: { endpoints?: EndpointInfo[]; gates?: ProviderGates;
  selection?: LiaisonSelection; disabled?: boolean } = {}) {
  const trace: string[] = [];
  const hybrid = new FakeHybrid("default", trace, undefined, "ON_DEVICE");
  const external = vi.fn(async (_req: Parameters<NonNullable<ProviderDeps["transport"]>["generate"]>[0]) =>
    ({ ok: true as const, text: JSON.stringify(OUTPUT) }));
  const firebaseText = vi.fn(async (req: Parameters<FirebaseTextFn>[0]) => ({ text: JSON.stringify(OUTPUT),
    source: (req.mode === "ONLY_ON_DEVICE" ? "ON_DEVICE" : "IN_CLOUD") as "ON_DEVICE" | "IN_CLOUD" }));
  const deps: ProviderDeps = {
    hybrid, clock: new FakeClock(), firebaseText,
    makeHybrid: () => new FakeHybrid("overlay", trace, undefined, "ON_DEVICE"),
    gates: options.gates ?? ALL_ON,
    transport: { list: async () => options.endpoints ?? [REMOTE, LOCAL],
      probe: async () => ({ state: options.disabled ? "needs_setup" : "available", rung: 1 }),
      generate: external, cancel: vi.fn() },
  };
  const registry = createProviderRegistry(deps) as unknown as ExtendedRegistry;
  if (options.selection !== undefined) registry.select(options.selection);
  await registry.refresh();
  const storage: DraftStorage = { setItem: vi.fn() };
  return { registry, external, firebaseText, hybrid, storage, trace,
    make: () => boot({ registry, storage }) };
}

export function expectSuccess(result: Awaited<ReturnType<LiaisonController["generate"]>>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected success, got ${result.code}`);
  return result;
}
export function expectRejected(result: Awaited<ReturnType<LiaisonController["generate"]>>, code: string): void {
  expect(result).toMatchObject({ ok: false, code });
  if (result.ok) throw new Error("Expected a rejected result");
  expect(result.reason?.trim()).toBeTruthy();
}

export function text(root: Node): string {
  if (root instanceof HTMLElement && (root.hidden || root.getAttribute("aria-hidden") === "true")) return "";
  return root.nodeType === Node.TEXT_NODE ? root.textContent ?? "" : [...root.childNodes].map(text).join(" ");
}
export function control(root: HTMLElement, name: RegExp): HTMLButtonElement {
  const matches = [...root.querySelectorAll("button")].filter(b => name.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));
  expect(matches, `One accessible control ${name}`).toHaveLength(1);
  return matches[0]!;
}
