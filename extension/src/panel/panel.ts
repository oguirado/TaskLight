// Side-panel entrypoint (B9/B10/B16): boots the wall client and forwards iframe messages.
import type { ChromeLike } from "../chrome_ports";
import type { Clock, ExtConfig, QueuedEvent, RouterPort } from "../types";
import { createWallClient } from "../client";

const chromeGlobal = (globalThis as unknown as { chrome?: ChromeLike }).chrome;

const iframe = document.querySelector("iframe") as HTMLIFrameElement | null;

if (chromeGlobal && iframe) {
  const ch = chromeGlobal;
  const wallUrl = iframe.src;
  const ext: ExtConfig = { siteOrigin: new URL(wallUrl).origin, wallUrl };
  const frameSource: unknown = iframe.contentWindow;
  const clock: Clock = {
    now: () => Date.now(),
    setTimer: (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  };
  const router: RouterPort = {
    lease: async (max) => {
      const res = (await ch.runtime.sendMessage?.({ t: "u13_lease", v: 1, max })) as
        | { ok?: boolean; items?: QueuedEvent[] }
        | undefined;
      return res?.ok === true && Array.isArray(res.items) ? res.items : [];
    },
    commit: async (ids) => {
      await ch.runtime.sendMessage?.({ t: "u13_commit", v: 1, ids });
    },
    onWake: (cb) => {
      const port = ch.runtime.connect?.();
      if (!port) return () => {};
      port.onMessage.addListener((m) => {
        if (typeof m === "object" && m !== null && (m as Record<string, unknown>)["t"] === "u13_wake") cb();
      });
      return () => {
        try {
          port.disconnect();
        } catch {
          /* swallow */
        }
      };
    },
  };
  const client = createWallClient({
    ext,
    frame: {
      postMessage: (msg, targetOrigin) => {
        iframe.contentWindow?.postMessage(msg, targetOrigin);
      },
    },
    frameSource,
    router,
    clock,
    newNonce: () =>
      (globalThis.crypto?.randomUUID?.() as string | undefined) ?? `${Date.now().toString(16)}-${Math.random().toString(16)}`,
  });
  window.addEventListener("message", (ev: MessageEvent) => {
    client.onMessage({ origin: ev.origin, data: ev.data, source: ev.source });
  });
  window.addEventListener("pagehide", () => client.stop());
  window.addEventListener("unload", () => client.stop());
  client.start();
}
