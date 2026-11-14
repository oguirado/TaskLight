import type { ChromeLike, ChromePortLike } from "./chrome_ports";
import type { Clock, ExternalPortGate, QueuedEvent, PinRegistry, Router } from "./types";
import type { SourceCollector } from "./snapshot";
import { createSessionStore } from "./chrome_ports";
import { createRouter } from "./router";
import { createPinRegistry } from "./pins";
import { createSourceCollector } from "./snapshot";
import { createExternalPortServer } from "./port";
import { createNativeRelay } from "../native/relay";
import type { NativeRelay } from "../native/relay";
import { EXT_LIMITS } from "./limits";

export type PanelReject = "NO_GESTURE" | "NOT_EXTENSION_PAGE";
export interface PanelOpenRequest { t: "open_panel"; userGesture: boolean; windowId?: number; tabId?: number }
export interface ServiceWorker {
  start(): Promise<void>;
  router: Router;
  pins: PinRegistry;
  sources: SourceCollector;
  relay: NativeRelay;
}
/** Wires router + T1 server + native relay + pins. sidePanel.open is called ONLY from an `open_panel` message sent by an extension page with userGesture=true. */
export function createServiceWorker(d: {
  chrome: ChromeLike; clock: Clock; gate: ExternalPortGate; nativeHostName: string; maxFrameChars: number;
  onExtra?: (port: ChromePortLike, msg: unknown) => void;
}): ServiceWorker {
  const ch = d.chrome;
  let server: { publish(item: QueuedEvent): void } | null = null;
  const panelPorts = new Set<{ postMessage(msg: unknown): void; disconnect(): void; onDisconnect: { addListener(cb: () => void): void } }>();

  const store = createSessionStore(d.chrome);
  const router = createRouter({
    store,
    clock: d.clock,
    notify: () => {
      for (const p of [...panelPorts]) {
        try {
          p.postMessage({ t: "u13_wake", v: 1 });
        } catch {
          panelPorts.delete(p);
        }
      }
      if (!server) return;
      const items = router.peek();
      const last = items[items.length - 1];
      if (last) server.publish(last);
    },
  });
  const pins = createPinRegistry();
  const sources = createSourceCollector({ chrome: d.chrome, pins, router });
  const external = createExternalPortServer({
    chrome: d.chrome, gate: d.gate, router, clock: d.clock,
    ...(d.onExtra !== undefined ? { onExtra: d.onExtra } : {}),
  });
  server = external;
  const relay = createNativeRelay(
    { hostName: d.nativeHostName, maxFrameChars: d.maxFrameChars },
    { connectNative: (h) => ch.runtime.connectNative(h), router },
  );

  return {
    router,
    pins,
    sources,
    relay,
    async start(): Promise<void> {
      await router.load();
      external.start();
      relay.start();
      ch.runtime.onMessage.addListener((msg: unknown, sender: { id?: string; url?: string; tab?: { id?: number; url?: string } }, sendResponse: (r?: unknown) => void) => {
        if (typeof msg !== "object" || msg === null) return;
        const m = msg as Record<string, unknown>;
        if (m["t"] !== "open_panel") return;
        const extPrefix = "chrome-extension://" + ch.runtime.id + "/";
        if (
          sender.id !== ch.runtime.id ||
          typeof sender.url !== "string" ||
          !sender.url.startsWith(extPrefix) ||
          sender.tab !== undefined
        ) {
          sendResponse({ ok: false, code: "NOT_EXTENSION_PAGE" });
          return;
        }
        if (m["userGesture"] !== true) {
          sendResponse({ ok: false, code: "NO_GESTURE" });
          return;
        }
        const req: { windowId?: number; tabId?: number } = {};
        if (typeof m["windowId"] === "number") req.windowId = m["windowId"];
        if (typeof m["tabId"] === "number") req.tabId = m["tabId"];
        // A rejected open() (no window, policy) is reported to the caller, never unhandled.
        ch.sidePanel.open(req).then(
          () => sendResponse({ ok: true }),
          () => sendResponse({ ok: false, code: "OPEN_FAILED" }),
        );
        return true;
      });
      ch.runtime.onConnect?.addListener((port) => {
        panelPorts.add(port);
        port.onDisconnect.addListener(() => panelPorts.delete(port));
      });
      // Panel RouterPort protocol (B9): lease/commit over runtime messaging.
      ch.runtime.onMessage.addListener((msg: unknown, sender: { id?: string }, sendResponse: (r?: unknown) => void) => {
        if (typeof msg !== "object" || msg === null || sender.id !== ch.runtime.id) return;
        const m = msg as Record<string, unknown>;
        if (m["t"] === "u13_lease") {
          const raw = m["max"];
          const max =
            typeof raw === "number" && raw > 0
              ? Math.min(Math.floor(raw), EXT_LIMITS.LEASE_MAX)
              : EXT_LIMITS.LEASE_MAX;
          router.lease(max).then(
            (items) => sendResponse({ ok: true, items }),
            () => sendResponse({ ok: false, code: "PORT_FAILED" }),
          );
          return true;
        }
        if (m["t"] === "u13_commit") {
          const ids = Array.isArray(m["ids"]) ? m["ids"].filter((x): x is number => typeof x === "number") : [];
          router.commit(ids).then(
            () => sendResponse({ ok: true }),
            () => sendResponse({ ok: false, code: "PORT_FAILED" }),
          );
          return true;
        }
      });
    },
  };
}
