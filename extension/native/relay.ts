import type { Router, NativeRelayCfg } from "../src/types";
import type { ChromePortLike } from "../src/chrome_ports";
import { NATIVE_HOST_TO_EXT_MAX_BYTES } from "../src/limits";

export interface NativeRelayStats { frames: number; dropped: number; accepted: number; rejected: number }

export interface NativeRelay {
  start(): void;
  stop(): void;
  stats(): NativeRelayStats;
  /** Posts a frame to the live host port; false when there is no live port or the post fails. */
  send(frame: unknown): boolean;
  /** Registers a listener for every frame that passes the size check; returns an unsubscribe function. */
  onFrame(cb: (frame: unknown) => void): () => void;
  connected(): boolean;
}

const BACKOFF_BASE_MS = 100;
const BACKOFF_CAP_MS = 5000;

/** Throws RangeError when cfg.maxFrameChars is not in 1..NATIVE_HOST_TO_EXT_MAX_BYTES. Reconnects with backoff after the host port drops; only `t === "event"` frames reach Router.accept (room frames go through onFrame listeners instead). */
export function createNativeRelay(cfg: NativeRelayCfg, d: { connectNative: (host: string) => ChromePortLike; router: Pick<Router, "accept"> }): NativeRelay {
  if (!Number.isInteger(cfg.maxFrameChars) || cfg.maxFrameChars < 1 || cfg.maxFrameChars > NATIVE_HOST_TO_EXT_MAX_BYTES) {
    throw new RangeError("maxFrameChars must be an integer in 1..1048576");
  }
  let port: ChromePortLike | null = null;
  let active = false;
  let backoffSteps = 0;
  let retryId: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<(frame: unknown) => void>();
  let frames = 0;
  let dropped = 0;
  let accepted = 0;
  let rejected = 0;

  const clearRetry = (): void => {
    if (retryId !== undefined) {
      clearTimeout(retryId);
      retryId = undefined;
    }
  };

  const scheduleRetry = (): void => {
    if (!active || retryId !== undefined) return;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** backoffSteps, BACKOFF_CAP_MS);
    backoffSteps += 1;
    retryId = setTimeout(() => {
      retryId = undefined;
      if (!active) return;
      connect();
    }, delay);
  };

  const connect = (): void => {
    let p: ChromePortLike;
    try {
      p = d.connectNative(cfg.hostName);
    } catch {
      scheduleRetry();
      return;
    }
    port = p;
    p.onMessage.addListener((frame: unknown) => {
      if (!active || port !== p) return;
      frames += 1;
      backoffSteps = 0;
      let chars: number;
      try {
        const s = JSON.stringify(frame);
        if (typeof s !== "string") throw new Error("unserializable");
        chars = s.length;
      } catch {
        dropped += 1;
        return;
      }
      if (chars > cfg.maxFrameChars) {
        dropped += 1;
        return;
      }
      for (const cb of [...listeners]) {
        try {
          cb(frame);
        } catch {
          /* one bad listener must not break the others */
        }
      }
      const isEvent = typeof frame === "object" && frame !== null && !Array.isArray(frame)
        && (frame as Record<string, unknown>)["t"] === "event";
      if (!isEvent) return;
      let done = false;
      try {
        const res = d.router.accept(frame);
        void Promise.resolve(res).then(
          (r) => {
            if (done) return;
            done = true;
            if (r.ok) accepted += 1;
            else rejected += 1;
          },
          () => {
            if (done) return;
            done = true;
            rejected += 1;
          },
        );
      } catch {
        rejected += 1;
      }
    });
    p.onDisconnect.addListener(() => {
      if (!active || port !== p) return;
      port = null;
      scheduleRetry();
    });
  };

  return {
    start(): void {
      if (active) return;
      active = true;
      connect();
    },
    stop(): void {
      if (!active) return;
      active = false;
      clearRetry();
      const p = port;
      port = null;
      try {
        p?.disconnect();
      } catch {
        /* swallow */
      }
    },
    stats(): NativeRelayStats {
      return { frames, dropped, accepted, rejected };
    },
    send(frame: unknown): boolean {
      if (!active || port === null) return false;
      try {
        port.postMessage(frame);
        return true;
      } catch {
        return false;
      }
    },
    onFrame(cb: (frame: unknown) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    connected(): boolean {
      return active && port !== null;
    },
  };
}
