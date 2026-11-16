// Test support for U49 (no assertions except where noted). Fakes only; no chrome global.
import { FakePort, FakeClock, settle } from "../u13/harness";
import { createModelRelay } from "../../../extension/src/model_relay";
import type { ModelRelay, ModelRelayNative } from "../../../extension/src/model_relay";
import type { SessionStore } from "../../../extension/src/types";

export { FakePort, FakeClock, settle };
export type Rec = Record<string, unknown>;

export const SEL_KEY = "u49.model_selection";
export const CANARY_URL = "http://canary-host.invalid:4242/v1";
export const CANARY_KEY = "sk-CANARY-0123456789"; // gitleaks:allow (planted canary, not a credential)

export const EP_LOCAL = { id: "local1", kind: "local-openai-compatible", label: "Local one", model: "llama", loopback: true, has_key: false, allow_private: false } as const;
export const EP_PRIV = { id: "priv1", kind: "local-openai-compatible", label: "Local private", model: "qwen", loopback: true, has_key: false, allow_private: true } as const;
export const EP_CLOUD = { id: "cloud1", kind: "remote-openai-compatible", label: "Cloud one", model: "gpt", loopback: false, has_key: true, allow_private: false } as const;
export const ENDPOINTS = [EP_LOCAL, EP_PRIV, EP_CLOUD];

export class FakeNative implements ModelRelayNative {
  sent: Rec[] = [];
  up = true;
  private ls: Array<(f: unknown) => void> = [];
  send(frame: unknown): boolean { if (!this.up) return false; this.sent.push(structuredClone(frame) as Rec); return true; }
  onFrame(cb: (f: unknown) => void): () => void { this.ls.push(cb); return () => { this.ls = this.ls.filter((x) => x !== cb); }; }
  connected(): boolean { return this.up; }
  /** host -> extension */
  emit(frame: unknown): void { for (const f of [...this.ls]) f(structuredClone(frame)); }
  last(): Rec { return this.sent[this.sent.length - 1] as Rec; }
  ofType(t: string): Rec[] { return this.sent.filter((f) => f["t"] === t); }
}

export class FakeStore implements SessionStore {
  data = new Map<string, unknown>();
  writes: Array<{ key: string; value: unknown }> = [];
  failGet = false;
  failSet = false;
  async get(k: string): Promise<unknown> { if (this.failGet) throw new Error("get failed"); return this.data.has(k) ? structuredClone(this.data.get(k)) : undefined; }
  async set(k: string, v: unknown): Promise<void> {
    if (this.failSet) throw new Error("quota");
    this.writes.push({ key: k, value: structuredClone(v) }); this.data.set(k, structuredClone(v));
  }
}

export interface H { relay: ModelRelay; native: FakeNative; clock: FakeClock; store: FakeStore }
export function boot(store: FakeStore = new FakeStore()): H {
  const native = new FakeNative(); const clock = new FakeClock();
  const relay = createModelRelay({ native, clock, store });
  return { relay, native, clock, store };
}
/** Boot and deliver a valid host model_hello (relay ready, endpoints cached). */
export function bootReady(endpoints: readonly unknown[] = ENDPOINTS): H {
  const h = boot(); h.native.emit({ t: "model_hello", v: 1, endpoints }); return h;
}
export const mkPort = (origin = "https://site.test"): FakePort => new FakePort({ origin });
export const post = (h: H, port: FakePort, msg: unknown): void => { h.relay.onPortMessage(port, msg); };

// ---- page frame builders ----
export const list = (rid: string): Rec => ({ t: "model_list", v: 1, rid });
export const probe = (rid: string, id = "local1"): Rec => ({ t: "model_probe", v: 1, rid, id });
export const cancel = (rid: string): Rec => ({ t: "model_cancel", v: 1, rid });
export const selGet = (rid: string): Rec => ({ t: "model_sel_get", v: 1, rid });
export const selSet = (rid: string, selection: unknown): Rec => ({ t: "model_sel_set", v: 1, rid, selection });
export const gen = (rid: string, over: Rec = {}): Rec => ({
  t: "model_generate", v: 1, rid, id: "local1", tier: "standard", messages: [{ role: "user", content: "hi" }], max_tokens: 64, rung: 3, ...over,
});

// ---- host reply builders ----
export const hResult = (rid: unknown, text = "ok"): Rec => ({ t: "model_result", v: 1, rid, text });
export const hHealth = (rid: unknown, id = "local1", state = "available", rung: unknown = 2): Rec => ({ t: "model_health", v: 1, rid, id, state, rung });
export const hNack = (rid: unknown, code: string): Rec => ({ t: "model_nack", v: 1, rid, code });

export const RELAY_RID = /^m\d+$/;
/** relay rid of the n-th (0-based) frame of type t sent to the host */
export function hostRid(h: H, t: string, n = 0): string {
  const f = h.native.ofType(t)[n]; return String(f?.["rid"]);
}
export const frames = (p: FakePort): Rec[] => p.sent as Rec[];
export const nacks = (p: FakePort): Rec[] => p.ofType("model_nack");
export const nackOf = (rid: string, code: string): Rec => ({ t: "model_nack", v: 1, rid, code });
export const helloPush = (endpoints: unknown[]): Rec => ({ t: "model_hello", v: 1, endpoints });
/** All page-bound frames of a set of ports, serialized. */
export const wire = (...ps: FakePort[]): string => JSON.stringify(ps.map((p) => p.sent));
