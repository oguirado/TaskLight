import { vi } from "vitest";
import type { Clock, FirebasePorts, HostEnv, HostState, HybridPort, RuntimePort } from "../../../src/app/types";

export const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
export const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
export const REAL_CFG: Readonly<Record<string, string>> = {
  apiKey: "test-api-key-123", authDomain: "demo.example.test", projectId: "demo-proj", appId: "1:123:web:abc",
};
export const FIXTURE_TOKEN = "3f2b9c1e-7a44-4d0e-9b61-5c8d2e1f0a77"; // test-only; lives under tests/, never under src/app or hosting

export function env(o: Partial<HostEnv> = {}): HostEnv {
  return { mode: "dev", origin: "http://localhost:5173", firebaseConfig: REAL_CFG, extensionOrigins: [EXT_ORIGIN],
    useLimitedUseTokens: false, ...o };
}

export interface Fakes {
  log: string[]; fb: FirebasePorts; hy: HybridPort; states: HostState[]; onState: (s: HostState) => void;
  app: object; fire(name: string): number;
  setUser(u: { uid: string; isAnonymous: boolean } | null): void;
  fb_spies: Record<string, ReturnType<typeof vi.fn>>; hy_spies: Record<string, ReturnType<typeof vi.fn>>;
}
export function fakes(opts: {
  user?: { uid: string; isAnonymous: boolean } | null;
  appCheckThrows?: boolean; anonFails?: boolean; deviceInit?: () => Promise<void>;
} = {}): Fakes {
  const log: string[] = [];
  const app = { name: "fake-app" };
  let user: { uid: string; isAnonymous: boolean } | null = opts.user ?? null;
  const rec = <T>(name: string, impl: (...a: never[]) => T) =>
    vi.fn((...a: unknown[]) => { log.push(name); return (impl as (...x: unknown[]) => T)(...a); });
  const fb_spies = {
    initializeApp: rec("initializeApp", () => app),
    setDebugFlag: rec("setDebugFlag", () => undefined),
    newRecaptchaEnterpriseProvider: rec("newRecaptchaEnterpriseProvider", () => ({ kind: "recaptcha" })),
    newDebugCompatibleProvider: rec("newDebugCompatibleProvider", () => ({ kind: "debug" })),
    initializeAppCheck: rec("initializeAppCheck", () => { if (opts.appCheckThrows) throw new Error("appcheck boom"); return {}; }),
    getAuth: rec("getAuth", () => ({ auth: true })),
    signInAnonymously: rec("signInAnonymously", () => {
      if (opts.anonFails) return Promise.reject(new Error("auth boom"));
      user = { uid: "anon-1", isAnonymous: true }; return Promise.resolve({ uid: "anon-1" });
    }),
    onAuthStateChanged: rec("onAuthStateChanged", (_a: unknown, cb: (u: typeof user) => void) => {
      queueMicrotask(() => cb(user)); return () => undefined;
    }),
    signInWithGooglePopup: rec("signInWithGooglePopup", () => Promise.resolve({ uid: "g-1" })),
  };
  const hy_spies = {
    create: rec("HybridPort.create", () => undefined),
    initializeDeviceModel: rec("HybridPort.initializeDeviceModel", (p: (v: number) => void) => {
      p(0.5); return opts.deviceInit ? opts.deviceInit() : Promise.resolve();
    }),
  };
  const states: HostState[] = [];
  return {
    log, app, states, onState: (s) => { states.push(s); },
    fb: fb_spies as unknown as FirebasePorts, hy: hy_spies as unknown as HybridPort,
    fb_spies, hy_spies, fire: (n) => log.filter((x) => x === n).length, setUser: (u) => { user = u; },
  };
}
export const ORDER_KEYS = ["initializeApp", "setDebugFlag", "initializeAppCheck", "signInAnonymously", "HybridPort.create"];

// ---- fake clock + fake chrome.runtime ----
export class FakeClock implements Clock {
  t = 0; private seq = 1;
  private timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = this.seq++; this.timers.set(id, { at: this.t + ms, fn }); return id; }
  clearTimeout(id: number) { this.timers.delete(id); }
  setInterval(fn: () => void, ms: number) { const id = this.seq++; this.timers.set(id, { at: this.t + ms, fn, every: ms }); return id; }
  clearInterval(id: number) { this.timers.delete(id); }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      let nextId = -1; let nextAt = Infinity;
      for (const [id, x] of this.timers) if (x.at <= end && (x.at < nextAt || (x.at === nextAt && id < nextId))) { nextAt = x.at; nextId = id; }
      if (nextId < 0) break;
      const x = this.timers.get(nextId)!; this.t = x.at;
      if (x.every) x.at += x.every; else this.timers.delete(nextId);
      x.fn();
    }
    this.t = end;
  }
}
export class FakePort implements RuntimePort {
  sent: Array<Record<string, unknown>> = []; disconnected = false;
  private ml: Array<(m: unknown) => void> = []; private dl: Array<() => void> = [];
  onMessage = { addListener: (cb: (m: unknown) => void) => { this.ml.push(cb); } };
  onDisconnect = { addListener: (cb: () => void) => { this.dl.push(cb); } };
  postMessage(m: unknown) { this.sent.push(m as Record<string, unknown>); }
  disconnect() { this.disconnected = true; }
  emit(m: unknown) { for (const l of this.ml) l(m); }
  drop() { for (const l of this.dl) l(); }
  ofType(t: string) { return this.sent.filter((m) => m["t"] === t); }
}
export function fakeRuntime(behaviour: { throwOnConnect?: boolean; autoDrop?: boolean } = {}) {
  const ports: FakePort[] = []; const ids: string[] = [];
  const connect = (id: string): RuntimePort => {
    ids.push(id);
    if (behaviour.throwOnConnect) throw new Error("Could not establish connection. Receiving end does not exist.");
    const p = new FakePort(); ports.push(p);
    if (behaviour.autoDrop) queueMicrotask(() => p.drop());
    return p;
  };
  return { ports, ids, connect, last: () => ports[ports.length - 1]! };
}
