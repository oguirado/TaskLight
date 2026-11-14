import type { ExtConfig, FrameTarget, RouterPort, Clock, WallClient, LinkState, ClientStats, QueuedEvent } from "./types";
import type { HostReply, NackCode } from "../../src/app/types";
import { EXT_LIMITS } from "./limits";

const NACK_CODES: ReadonlySet<string> = new Set([
  "UNSUPPORTED_VERSION",
  "BAD_SHAPE",
  "TOO_LARGE",
  "THROTTLED",
  "NO_HANDSHAKE",
  "SEQ_NOT_MONOTONIC",
]);

function isHostReply(v: unknown): v is HostReply {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  if (m["v"] !== 1) return false;
  if (m["t"] === "ack") return typeof m["nonce"] === "string";
  if (m["t"] === "nack") {
    if (typeof m["code"] !== "string" || !NACK_CODES.has(m["code"])) return false;
    if ("seq" in m && m["seq"] !== undefined && !Number.isInteger(m["seq"])) return false;
    return true;
  }
  return false;
}

export function createWallClient(cfg: {
  ext: ExtConfig; frame: FrameTarget; frameSource: unknown; router: RouterPort; clock: Clock; newNonce: () => string;
}): WallClient {
  let state: LinkState = { kind: "idle" };
  let nonce = "";
  let hellosSent = 0;
  let nextSeq = 1;
  let helloCancel: (() => void) | null = null;
  let wakeCancel: (() => void) | null = null;
  let paceCancel: (() => void) | null = null;
  let sent = 0;
  let ignoredReplies = 0;
  let retried = 0;
  const nacked: Partial<Record<NackCode, number>> = {};
  const inflight = new Map<number, QueuedEvent>();
  const retriedIds = new Set<number>();
  const sendTimes: number[] = [];
  let resends: QueuedEvent[] = [];
  let pumping = false;
  let pumpQueued = false;

  const clearHello = (): void => {
    if (helloCancel) {
      helloCancel();
      helloCancel = null;
    }
  };
  const clearPace = (): void => {
    if (paceCancel) {
      paceCancel();
      paceCancel = null;
    }
  };

  const postHello = (): void => {
    nonce = cfg.newNonce();
    state = { kind: "handshaking", attempt: hellosSent, nonce };
    cfg.frame.postMessage({ t: "hello", v: 1, nonce }, cfg.ext.siteOrigin);
  };

  const armHelloTimer = (): void => {
    clearHello();
    helloCancel = cfg.clock.setTimer(EXT_LIMITS.HELLO_TIMEOUT_MS, () => {
      helloCancel = null;
      if (state.kind !== "handshaking") return;
      if (hellosSent > EXT_LIMITS.HELLO_MAX_RETRIES) {
        state = { kind: "unreachable", reason: "HELLO_TIMEOUT" };
        return;
      }
      hellosSent++;
      postHello();
      armHelloTimer();
    });
  };

  const beginHandshake = (): void => {
    hellosSent = 1;
    nextSeq = 1;
    inflight.clear();
    retriedIds.clear();
    postHello();
    armHelloTimer();
  };

  const pruneTimes = (now: number): void => {
    const cutoff = now - 1000;
    while (sendTimes.length > 0 && sendTimes[0]! <= cutoff) sendTimes.shift();
  };

  const schedulePump = (delay: number): void => {
    clearPace();
    paceCancel = cfg.clock.setTimer(Math.max(0, delay), () => {
      paceCancel = null;
      void pump();
    });
  };

  const sendOne = async (ev: QueuedEvent, isResend: boolean): Promise<void> => {
    const seq = nextSeq++;
    inflight.set(seq, ev);
    if (inflight.size > EXT_LIMITS.INFLIGHT_KEEP) {
      const first = inflight.keys().next().value;
      if (first !== undefined) inflight.delete(first);
    }
    cfg.frame.postMessage(
      { t: "event", v: 1, seq, projectId: ev.projectId, payload: ev.payload },
      cfg.ext.siteOrigin,
    );
    sendTimes.push(cfg.clock.now());
    sent++;
    if (isResend) retried++;
    state = { kind: "linked", nonce, nextSeq };
    try {
      await cfg.router.commit([ev.id]);
    } catch {
      // SW unreachable mid-send: the event stays queued SW-side and will be re-leased (at-least-once).
    }
  };

  const pump = async (): Promise<void> => {
    if (pumping) {
      pumpQueued = true;
      return;
    }
    pumping = true;
    try {
      do {
        pumpQueued = false;
        while (true) {
          if (state.kind !== "linked") break;
          const now0 = cfg.clock.now();
          pruneTimes(now0);
          if (sendTimes.length >= EXT_LIMITS.SEND_MAX_PER_SEC) {
            const wait = Math.max(0, sendTimes[0]! + 1000 - now0);
            schedulePump(wait);
            break;
          }
          let next: QueuedEvent;
          let isResend = false;
          if (resends.length > 0) {
            next = resends.shift()!;
            isResend = true;
          } else {
            // Lease one at a time: a state transition mid-send can then never strand a staged batch.
            let batch: QueuedEvent[];
            try {
              batch = await cfg.router.lease(1);
            } catch {
              break;
            }
            if (batch.length === 0) break;
            next = batch[0]!;
          }
          await sendOne(next, isResend);
        }
      } while (pumpQueued);
    } finally {
      pumping = false;
    }
  };

  const onLinked = (): void => {
    clearHello();
    nextSeq = 1;
    state = { kind: "linked", nonce, nextSeq };
    void pump();
  };

  const onNack = (reply: Extract<HostReply, { t: "nack" }>): void => {
    const code = reply.code as NackCode;
    nacked[code] = (nacked[code] ?? 0) + 1;
    if (code === "UNSUPPORTED_VERSION") {
      clearHello();
      clearPace();
      state = { kind: "unreachable", reason: "UNSUPPORTED_VERSION" };
      return;
    }
    if (code === "THROTTLED") {
      const seq = reply.seq;
      if (typeof seq === "number") {
        const ev = inflight.get(seq);
        if (ev && !retriedIds.has(ev.id)) {
          retriedIds.add(ev.id);
          inflight.delete(seq);
          cfg.clock.setTimer(EXT_LIMITS.THROTTLE_RETRY_MS, () => {
            resends.push(ev);
            if (state.kind === "linked") void pump();
          });
        }
      }
      return;
    }
    if (code === "BAD_SHAPE" || code === "TOO_LARGE") {
      const seq = reply.seq;
      if (typeof seq === "number") inflight.delete(seq);
      return;
    }
    if (code === "NO_HANDSHAKE" || code === "SEQ_NOT_MONOTONIC") {
      if (state.kind !== "linked") return;
      const from = typeof reply.seq === "number" ? reply.seq : 0;
      const pending: QueuedEvent[] = [];
      for (const [s, ev] of inflight) {
        if (s >= from) pending.push(ev);
      }
      inflight.clear();
      retriedIds.clear();
      resends = [...resends, ...pending];
      clearPace();
      hellosSent = 1;
      nextSeq = 1;
      postHello();
      armHelloTimer();
    }
  };

  return {
    start(): void {
      if (state.kind === "handshaking" || state.kind === "linked") return;
      if (wakeCancel === null) {
        wakeCancel = cfg.router.onWake(() => {
          if (state.kind === "linked") void pump();
        });
      }
      beginHandshake();
    },

    onMessage(ev: { origin: string; data: unknown; source: unknown }): void {
      if (state.kind === "closed") {
        ignoredReplies++;
        return;
      }
      if (ev.origin !== cfg.ext.siteOrigin || ev.source !== cfg.frameSource) {
        ignoredReplies++;
        return;
      }
      if (!isHostReply(ev.data)) {
        ignoredReplies++;
        return;
      }
      const data = ev.data;
      if (data.t === "ack") {
        if (state.kind !== "handshaking" || data.nonce !== nonce) {
          ignoredReplies++;
          return;
        }
        onLinked();
        return;
      }
      onNack(data);
    },

    state(): LinkState {
      return state;
    },

    stats(): ClientStats {
      return { sent, nacked: { ...nacked }, ignoredReplies, retried };
    },

    stop(): void {
      if (state.kind === "closed") return;
      clearHello();
      clearPace();
      cfg.frame.postMessage({ t: "bye", v: 1 }, cfg.ext.siteOrigin);
      state = { kind: "closed" };
      if (wakeCancel) {
        wakeCancel();
        wakeCancel = null;
      }
    },
  };
}
