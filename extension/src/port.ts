import type { ChromeLike, ChromePortLike } from "./chrome_ports";
import type { Clock, ExternalPortGate, PortSnapshotItem, QueuedEvent, Router } from "./types";

export function isOriginAllowed(gate: ExternalPortGate, origin: string | undefined): boolean {
  if (typeof origin !== "string" || origin.length === 0 || origin === "null") return false;
  for (const pattern of gate.allowedOrigins) {
    if (typeof pattern !== "string") continue;
    let prefix = pattern;
    if (pattern.endsWith("/*")) prefix = pattern.slice(0, -2);
    else if (pattern.endsWith("*")) prefix = pattern.slice(0, -1);
    if (prefix === "http://localhost") {
      if (origin === "http://localhost") return true;
      if (/^http:\/\/localhost:\d+$/.test(origin)) return true;
      continue;
    }
    if (origin === prefix) return true;
  }
  return false;
}
export interface ExternalPortServer {
  /** Registers chrome.runtime.onConnectExternal. */
  start(): void;
  /** Called after each accepted event: forwards `event` to every linked port. */
  publish(item: QueuedEvent): void;
  portCount(): number;
}
export function createExternalPortServer(d: { chrome: ChromeLike; gate: ExternalPortGate; router: Pick<Router, "peek">; clock: Clock; onExtra?: (port: ChromePortLike, msg: unknown) => void }): ExternalPortServer {
  const ch = d.chrome;
  const ports = new Set<ChromePortLike>();
  const helloed = new Set<ChromePortLike>();
  let started = false;

  const snapshotItems = (): PortSnapshotItem[] => {
    const latest = new Map<string, QueuedEvent>();
    for (const e of d.router.peek()) latest.set(e.projectId, e);
    return [...latest.values()]
      .sort((a, b) => a.id - b.id)
      .map((e) => ({ seq: e.id, projectId: e.projectId, payload: e.payload }));
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      ch.runtime.onConnectExternal.addListener((port: ChromePortLike) => {
        const origin = port.sender?.origin;
        if (!isOriginAllowed(d.gate, origin)) {
          try {
            port.disconnect();
          } catch {
            /* swallow */
          }
          return;
        }
        ports.add(port);
        port.onDisconnect.addListener(() => {
          ports.delete(port);
          helloed.delete(port);
        });
        port.onMessage.addListener((msg: unknown) => {
          if (typeof msg !== "object" || msg === null) return;
          const m = msg as Record<string, unknown>;
          if (m["t"] === "hello") {
            if (m["v"] !== 1 || typeof m["nonce"] !== "string") return;
            helloed.add(port);
            try {
              port.postMessage({ t: "snapshot", v: 1, nonce: m["nonce"], items: snapshotItems() });
            } catch {
              /* swallow */
            }
            return;
          }
          if (m["t"] === "ping") {
            if (m["v"] !== 1) return;
            try {
              port.postMessage({ t: "pong", v: 1 });
            } catch {
              /* swallow */
            }
            return;
          }
          if (typeof m["t"] === "string" && d.onExtra !== undefined) {
            try {
              d.onExtra(port, msg);
            } catch {
              /* a throwing hook must not break hello/ping */
            }
          }
        });
      });
    },
    publish(item: QueuedEvent): void {
      const frame = { t: "event", v: 1, seq: item.id, projectId: item.projectId, payload: item.payload };
      for (const port of [...ports]) {
        if (!helloed.has(port)) continue;
        try {
          port.postMessage(frame);
        } catch {
          ports.delete(port);
          helloed.delete(port);
        }
      }
    },
    portCount(): number {
      return ports.size;
    },
  };
}
export type { ChromePortLike };
