// Test support for U37c (no assertions). Fakes only; nothing here redefines Event.isTrusted.
import { FakePort as ExtPort } from "../u13/harness";
import type { Clock as ExtClock } from "../../../extension/src/types";
import type { Clock as AppClock, RuntimePort } from "../../../src/app/types";

export { ExtPort };
export const EXT_ID = "nnmhdaibaopekhjcpnekgdpeaaojclof";
export const ROOM = "demo";
export const idOf = (n: number): string => `e-${n.toString(16).padStart(16, "0")}`;
export const roomEvent = (lamport: number, room = ROOM, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ id: idOf(lamport), lamport, ts: 1_700_000_000_000 + lamport, room, agent: "worker-1", act: "question", text: `t${lamport}`, ...extra });
export const settle = async (n = 4): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve(); };

interface T { at: number; fn: () => void; every?: number }
abstract class TimerBase {
  t = 0; protected seq = 1; protected timers = new Map<number, T>();
  now(): number { return this.t; }
  pending(): number { return this.timers.size; }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let nextId = -1; let nextAt = Infinity;
      for (const [id, x] of this.timers) if (x.at <= end && (x.at < nextAt || (x.at === nextAt && id < nextId))) { nextAt = x.at; nextId = id; }
      if (nextId < 0) break;
      const x = this.timers.get(nextId)!; this.t = Math.max(this.t, x.at);
      if (x.every) x.at += x.every; else this.timers.delete(nextId);
      x.fn();
    }
    this.t = end;
  }
}
/** Extension clock ({now,setTimer}). */
export class FakeExtClock extends TimerBase implements ExtClock {
  setTimer(ms: number, fn: () => void): () => void { const id = this.seq++; this.timers.set(id, { at: this.t + ms, fn }); return () => { this.timers.delete(id); }; }
}
/** App clock ({setTimeout,setInterval,...}). */
export class FakeAppClock extends TimerBase implements AppClock {
  setTimeout(fn: () => void, ms: number): number { const id = this.seq++; this.timers.set(id, { at: this.t + ms, fn }); return id; }
  clearTimeout(id: number): void { this.timers.delete(id); }
  setInterval(fn: () => void, ms: number): number { const id = this.seq++; this.timers.set(id, { at: this.t + ms, fn, every: ms }); return id; }
  clearInterval(id: number): void { this.timers.delete(id); }
}

/** Native side as seen by createAgentRelay. */
export class FakeNative {
  sent: Array<Record<string, unknown>> = [];
  up = true;
  private cbs = new Set<(f: unknown) => void>();
  send = (f: unknown): boolean => { if (!this.up) return false; this.sent.push(structuredClone(f) as Record<string, unknown>); return true; };
  onFrame = (cb: (f: unknown) => void): (() => void) => { this.cbs.add(cb); return () => { this.cbs.delete(cb); }; };
  connected = (): boolean => this.up;
  emit(f: unknown): void { for (const cb of [...this.cbs]) cb(structuredClone(f)); }
  ofType(t: string): Array<Record<string, unknown>> { return this.sent.filter((m) => m["t"] === t); }
}

/** Page-side runtime port (src/app RuntimePort). */
export class PagePort implements RuntimePort {
  sent: Array<Record<string, unknown>> = []; disconnected = false; throwOnPost = false;
  private ml: Array<(m: unknown) => void> = []; private dl: Array<() => void> = [];
  onMessage = { addListener: (cb: (m: unknown) => void) => { this.ml.push(cb); } };
  onDisconnect = { addListener: (cb: () => void) => { this.dl.push(cb); } };
  postMessage(m: unknown): void { if (this.throwOnPost) throw new Error("port closed"); this.sent.push(structuredClone(m) as Record<string, unknown>); }
  disconnect(): void { this.disconnected = true; }
  emit(m: unknown): void { for (const l of this.ml) l(structuredClone(m)); }
  drop(): void { for (const l of this.dl) l(); }
  ofType(t: string): Array<Record<string, unknown>> { return this.sent.filter((m) => m["t"] === t); }
}
export function pageRuntime(): { ports: PagePort[]; ids: string[]; connect: (id: string) => RuntimePort; last: () => PagePort } {
  const ports: PagePort[] = []; const ids: string[] = [];
  return { ports, ids, connect: (id) => { ids.push(id); const p = new PagePort(); ports.push(p); return p; }, last: () => ports[ports.length - 1]! };
}

/** AMEND_W view types (the real NativeRelay / ServiceWorker gain these members; cast so tsc stays clean until then). */
export interface NativeRelayAmended {
  start(): void; stop(): void; stats(): { frames: number; dropped: number; accepted: number; rejected: number };
  send(frame: unknown): boolean; onFrame(cb: (frame: unknown) => void): () => void; connected(): boolean;
}
