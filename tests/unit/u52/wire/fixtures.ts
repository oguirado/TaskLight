import { expect, vi } from "vitest";
import { createModelServices } from "../../../../src/app/model_services";
import type { ModelServicesDeps } from "../../../../src/app/model_services";
import type { ModelChannel, SelectionStore } from "../../../../src/app/model_port";
import type { EndpointInfo, ModelSelection } from "../../../../src/providers/types";
import type { HybridParamsShape, ModelFactory, ModelHandle } from "../../../../src/ai/types";
import type { RemoteConfigPort } from "../../../../src/config/types";
import type { AgentState } from "../../../../src/agents/types";
import { FakeClock, flush } from "../../u47/fixtures";
export { FakeClock, flush };
export { FakePort } from "../../u22/harness";
export const ORIGIN = "http://localhost:5173";
export const LOCAL: EndpointInfo = { id: "u52-local", kind: "local-openai-compatible", label: "Local", model: "fixture", loopback: true, has_key: false, allow_private: false };
export const REMOTE: EndpointInfo = { ...LOCAL, id: "u52-remote", kind: "remote-openai-compatible", loopback: false, has_key: true };
export const DRIFT_TEXT = '{"verdict":"on_track","reason":"fixture answer"}';
export const signal = () => new AbortController().signal;
export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
/** Settlement observation with a finite microtask budget: never waits on a real timer. */
export async function settled<T>(p: Promise<T>): Promise<T> {
  let result: { value: T } | { error: unknown } | undefined;
  p.then(value => { result = { value }; }, error => { result = { error }; });
  await flush();
  expect(result, "promise must settle within bounded microtasks").toBeDefined();
  if (result === undefined) throw new Error("oracle: pending promise");
  if ("error" in result) throw result.error;
  return result.value;
}
export function factory(text = DRIFT_TEXT) {
  const calls: HybridParamsShape[] = [];
  const prompts: unknown[] = [];
  const init = vi.fn(async (_p?: (n: number) => void): Promise<void> => undefined);
  const f: ModelFactory = {
    modeConst: mode => mode,
    sourceConst: { ON_DEVICE: "fixture-device", IN_CLOUD: "fixture-cloud" },
    create(params): ModelHandle {
      calls.push(structuredClone(params));
      return {
        initializeDeviceModel: init,
        async generateContent(prompt) {
          prompts.push(prompt);
          return { response: { text: () => text, inferenceSource: f.sourceConst.ON_DEVICE } };
        },
      };
    },
  };
  return { f, calls, prompts, init };
}
export class Channel implements ModelChannel {
  sent: Record<string, unknown>[] = [];
  frames = new Set<(f: unknown) => void>();
  resets = new Set<() => void>();
  reply: ((f: Record<string, unknown>) => void) | undefined;
  send(frame: object): boolean {
    const f = structuredClone(frame) as Record<string, unknown>;
    this.sent.push(f);
    // Real extension replies asynchronously; callbacks may register after send().
    Promise.resolve().then(() => this.reply?.(f));
    return true;
  }
  onFrame(cb: (f: unknown) => void) { this.frames.add(cb); return () => { this.frames.delete(cb); }; }
  onReset(cb: () => void) { this.resets.add(cb); return () => { this.resets.delete(cb); }; }
  emit(f: unknown) { for (const cb of [...this.frames]) cb(f); }
  reset() { for (const cb of [...this.resets]) cb(); }
  hello(endpoints: EndpointInfo[] = [LOCAL]) { this.emit({ t: "model_hello", v: 1, endpoints }); }
  of(t: string) { return this.sent.filter(f => f["t"] === t); }
  host(endpoints: EndpointInfo[], outcome: "ok" | "offline" = "ok", text = '{"headline":"h","summary":"s"}') {
    this.reply = f => {
      const rid = f["rid"];
      switch (f["t"]) {
        case "model_list": this.emit({ t: "model_hello", v: 1, rid, endpoints }); break;
        case "model_probe": this.emit({ t: "model_health", v: 1, rid, id: f["id"], state: "available", rung: 1 }); break;
        case "model_generate": this.emit(outcome === "offline"
          ? { t: "model_nack", v: 1, rid, code: "offline" }
          : { t: "model_result", v: 1, rid, text }); break;
        case "model_sel_get": this.emit({ t: "model_sel", v: 1, rid, selection: {} }); break;
      }
    };
    this.hello(endpoints);
  }
}
export function store(selection: ModelSelection = {}) {
  const callbacks = new Set<(s: ModelSelection) => void>();
  const writes: ModelSelection[] = [];
  const value: SelectionStore = {
    get: async () => selection,
    set: async s => { writes.push(structuredClone(s)); selection = s; },
    onChange: cb => { callbacks.add(cb); return () => { callbacks.delete(cb); }; },
  };
  return { value, writes, push(s: ModelSelection) { selection = s; for (const cb of callbacks) cb(s); } };
}
export function remoteConfig(initial: Record<string, string> = {}) {
  const values = { ...initial };
  let observer: Parameters<RemoteConfigPort["onConfigUpdate"]>[0] | undefined;
  const activate = vi.fn(async () => true);
  const getString = vi.fn((k: string) => values[k] ?? "");
  const unsubscribe = vi.fn();
  const rc: RemoteConfigPort = {
    setDefaults: () => undefined, setMinimumFetchIntervalMillis: () => undefined,
    fetchAndActivate: async () => true, activate, getString,
    onConfigUpdate(o) { observer = o; return unsubscribe; },
  };
  return { rc, values, activate, getString, unsubscribe,
    update(...keys: string[]) { expect(observer).toBeDefined(); observer!.next(new Set(keys)); } };
}
export function services(extra: Partial<ModelServicesDeps> = {}, text = DRIFT_TEXT) {
  const sdk = factory(text);
  const clock = new FakeClock();
  const service = createModelServices({ factory: sdk.f, origin: ORIGIN, clock, ...extra });
  return { service, sdk, clock };
}
export async function hosted(endpoint = LOCAL, outcome: "ok" | "offline" = "ok", text?: string) {
  const ch = new Channel();
  const w = services({ channel: ch }, '{"headline":"h","summary":"s"}');
  ch.host([endpoint], outcome, text);
  await flush();
  await settled(w.service.registry.refresh());
  await settled(w.service.registry.initDevice());
  w.service.registry.select({ all: endpoint.id });
  return { ...w, ch };
}
export function state(): AgentState {
  return {
    room: "oracle", agent: "worker", lastSeen: 0, closed: false, openQuestions: [],
    stepStates: ["pending"], outcomes: [], took: [],
    previous: { title: "Original", steps: [{ text: "old step" }], hash: "old", version: 1, lamport: 1 },
    contract: { title: "Changed", steps: [{ text: "new step" }], hash: "new", version: 2, lamport: 2 },
  };
}
