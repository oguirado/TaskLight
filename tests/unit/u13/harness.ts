// Fakes for U13 (no real browser). Pure test support; no assertions here.
import type { ChromeLike, ChromePortLike, MessageSender, TabLike } from "../../../extension/src/chrome_ports";
import type { Clock, SessionStore } from "../../../extension/src/types";

export const SITE = "https://site.test";
export const EXT_ID = "nnmhdaibaopekhjcpnekgdpeaaojclof";
export const HOST = "com.contextwall.bridge";
export const GATE = { allowedOrigins: ["https://site.test/*"] } as const;

export const settle = async (n = 5): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

export class FakeClock implements Clock {
  private t = 1_000_000;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private seq = 0;
  now(): number { return this.t; }
  setTimer(ms: number, fn: () => void): () => void {
    const id = ++this.seq; this.timers.push({ at: this.t + ms, fn, id });
    return () => { this.timers = this.timers.filter((x) => x.id !== id); };
  }
  pending(): number { return this.timers.length; }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const nxt = this.timers[0];
      if (!nxt || nxt.at > end) break;
      this.timers.shift(); this.t = Math.max(this.t, nxt.at); nxt.fn(); await settle(2);
    }
    this.t = end; await settle(2);
  }
}

export class FakeSessionStore implements SessionStore {
  readonly data = new Map<string, unknown>();
  failSet = false;
  sets = 0;
  async get(k: string): Promise<unknown> { return this.data.has(k) ? structuredClone(this.data.get(k)) : undefined; }
  async set(k: string, v: unknown): Promise<void> {
    if (this.failSet) throw new Error("quota");
    this.sets++; this.data.set(k, structuredClone(v));
  }
}
/** Spy store: any write fails the test (storage.local must never be used for payloads, B6). */
export class FakeLocalStore { writes = 0; async get(): Promise<Record<string, unknown>> { return {}; } async set(): Promise<void> { this.writes++; } }

export class FakePort implements ChromePortLike {
  sent: unknown[] = [];
  disconnected = false;
  private msgL: Array<(m: unknown) => void> = [];
  private discL: Array<() => void> = [];
  constructor(public sender?: { origin?: string; url?: string; id?: string }, public name?: string) {}
  postMessage(m: unknown): void { if (this.disconnected) throw new Error("port closed"); this.sent.push(structuredClone(m)); }
  disconnect(): void { if (this.disconnected) return; this.disconnected = true; this.discL.forEach((f) => f()); }
  onMessage = { addListener: (cb: (m: unknown) => void) => { this.msgL.push(cb); } };
  onDisconnect = { addListener: (cb: () => void) => { this.discL.push(cb); } };
  /** peer -> this side */
  emit(m: unknown): void { this.msgL.forEach((f) => f(structuredClone(m))); }
  /** peer closed the port */
  peerClose(): void { this.disconnected = true; this.discL.forEach((f) => f()); }
  ofType(t: string): Array<Record<string, unknown>> { return (this.sent as Array<Record<string, unknown>>).filter((m) => m["t"] === t); }
}

export interface Shared { session: FakeSessionStoreRecord; local: FakeLocalStore }
type FakeSessionStoreRecord = Map<string, unknown>;

export class FakeChrome {
  readonly id = EXT_ID;
  readonly session: Map<string, unknown>;
  readonly local = new FakeLocalStore();
  sessionSets = 0;
  failSessionSet = false;
  externalL: Array<(p: ChromePortLike) => void> = [];
  messageL: Array<(m: unknown, s: MessageSender, r: (x?: unknown) => void) => unknown> = [];
  nativePorts: FakePort[] = [];
  nativeHosts: string[] = [];
  sidePanelOpens: Array<{ windowId?: number; tabId?: number }> = [];
  tabs = new Map<number, TabLike>();
  tabText = new Map<number, string>();
  granted = new Set<string>();
  permChecks: string[][] = [];
  executeCalls = 0;
  constructor(session?: Map<string, unknown>) { this.session = session ?? new Map(); }
  /** New SW lifetime on the same chrome.storage.session (SW restart). */
  restart(): FakeChrome { const c = new FakeChrome(this.session); c.tabs = this.tabs; c.tabText = this.tabText; c.granted = this.granted; return c; }

  get api(): ChromeLike {
    const self = this;
    return {
      runtime: {
        id: this.id,
        onConnectExternal: { addListener: (cb) => { self.externalL.push(cb); } },
        onMessage: { addListener: (cb) => { self.messageL.push(cb); } },
        connectNative: (host: string) => { const p = new FakePort(); self.nativeHosts.push(host); self.nativePorts.push(p); return p; },
      },
      storage: {
        session: {
          get: async (k: string) => (self.session.has(k) ? { [k]: structuredClone(self.session.get(k)) } : {}),
          set: async (o: Record<string, unknown>) => {
            if (self.failSessionSet) throw new Error("quota");
            self.sessionSets++; for (const [k, v] of Object.entries(o)) self.session.set(k, structuredClone(v));
          },
        },
        local: { get: async () => ({}), set: async () => { self.local.writes++; } },
      },
      sidePanel: { open: async (o) => { self.sidePanelOpens.push(o); } },
      tabs: {
        get: async (id: number) => { const t = self.tabs.get(id); if (!t) throw new Error("no tab"); return t; },
        onRemoved: { addListener: () => {} },
      },
      scripting: { executeScript: async (o) => { self.executeCalls++; return [{ result: self.tabText.get(o.target.tabId) ?? "" }]; } },
      permissions: { contains: async (o) => { self.permChecks.push(o.origins); return o.origins.every((x) => self.granted.has(x)); } },
    };
  }
  connectExternal(origin: string | undefined): FakePort {
    const p = new FakePort(origin === undefined ? {} : { origin });
    this.externalL.forEach((f) => f(p)); return p;
  }
  /** Delivers a runtime message; resolves with the first sendResponse payload (or undefined). */
  async sendMessage(msg: unknown, sender: MessageSender): Promise<unknown> {
    let out: unknown; let got = false;
    for (const f of this.messageL) f(msg, sender, (r) => { if (!got) { got = true; out = r; } });
    await settle(3); return out;
  }
  nativeEmit(frame: unknown): void { this.nativePorts[0]?.emit(frame); }
}

export function evt(i: number, projectId = "p1", pad = 0): { projectId: string; payload: { n: number; pad: string } } {
  return { projectId, payload: { n: i, pad: "x".repeat(pad) } };
}
/** Event whose would-be ConnectorMsg serialization is exactly `chars` long. */
export function evtOfChars(chars: number, projectId = "p1"): { projectId: string; payload: { pad: string } } {
  const base = JSON.stringify({ t: "event", v: 1, seq: 2147483647, projectId, payload: { pad: "" } }).length;
  return { projectId, payload: { pad: "x".repeat(chars - base) } };
}
