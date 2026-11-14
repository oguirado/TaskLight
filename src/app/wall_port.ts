import type { Clock, QueuedEvent, RuntimePort, WallPort, WallPortState, WallPortStats } from "./types";

export const PORT_LIMITS = { PING_MS: 20000, RECONNECT_RETRY_MS: 100, RECONNECT_MAX: 50 } as const;
/** [TARGET, ORACLE decision] max events buffered while resyncing; oldest dropped first. */
export const WALL_QUEUE_MAX = 256 as const;

export function createWallPort(d: {
  extId: string;
  connect: (id: string) => RuntimePort;
  clock: Clock;
  onEvent: (raw: string) => void;
  nonce?: () => string;
}): WallPort {
  let state: WallPortState = { kind: "connecting", attempt: 0 };
  let port: RuntimePort | null = null;
  let currentNonce = "";
  let links = 0;
  let stopped = false;
  let started = false;
  let connectedOnce = false;
  let pingId: number | null = null;
  let retryId: number | null = null;
  let retriesUsed = 0;
  let reconnects = 0;
  let pings = 0;
  let snapshotsApplied = 0;
  let queueDropped = 0;
  let queue: QueuedEvent[] = [];

  const genNonce: () => string =
    d.nonce ?? (() => globalThis.crypto.randomUUID());

  function clearPing(): void {
    if (pingId !== null) {
      d.clock.clearInterval(pingId);
      pingId = null;
    }
  }

  function clearRetry(): void {
    if (retryId !== null) {
      d.clock.clearTimeout(retryId);
      retryId = null;
    }
  }

  function rawOf(item: QueuedEvent): string {
    return JSON.stringify({ t: "event", v: 1, seq: item.seq, projectId: item.projectId, payload: item.payload });
  }

  /** Max time to wait for a snapshot after connecting before the link is treated as dead. */
  const RESYNC_TIMEOUT_MS = 90_000;
  let resyncId: number | null = null;

  function clearResync(): void {
    if (resyncId !== null) {
      d.clock.clearTimeout(resyncId);
      resyncId = null;
    }
  }

  function startPing(): void {
    clearPing();
    pingId = d.clock.setInterval(() => {
      if (stopped || port === null) return;
      if (state.kind !== "linked") return;
      try {
        port.postMessage({ t: "ping", v: 1 });
      } catch {
        return;
      }
      pings++;
    }, PORT_LIMITS.PING_MS);
  }

  /** If no snapshot arrives within RESYNC_TIMEOUT_MS, disconnect and reconnect (or exhaust retries). */
  function startResyncTimer(p: RuntimePort): void {
    clearResync();
    resyncId = d.clock.setTimeout(() => {
      resyncId = null;
      if (stopped || port !== p || state.kind !== "resyncing") return;
      try {
        p.disconnect();
      } catch {
        /* ignore */
      }
      handleDisconnect(p);
    }, RESYNC_TIMEOUT_MS);
  }

  function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }

  function validEventFields(m: Record<string, unknown>): QueuedEvent | null {
    if (m["v"] !== 1) return null;
    const seq = m["seq"];
    const projectId = m["projectId"];
    if (typeof seq !== "number" || !Number.isInteger(seq)) return null;
    if (typeof projectId !== "string" || projectId.length === 0) return null;
    return { seq, projectId, payload: m["payload"] };
  }

  function handleMessage(p: RuntimePort, msg: unknown): void {
    if (stopped) return;
    if (port !== p) return;
    if (!isRecord(msg) || typeof msg["t"] !== "string") return;
    const t = msg["t"] as string;

    if (t === "snapshot") {
      if (msg["v"] !== 1) return;
      const nonce = msg["nonce"];
      if (typeof nonce !== "string" || nonce !== currentNonce) return;
      if (state.kind !== "resyncing") return;
      const items = msg["items"];
      if (!Array.isArray(items)) return;
      const valid: QueuedEvent[] = [];
      for (const it of items) {
        if (!isRecord(it)) continue;
        const seq = it["seq"];
        const projectId = it["projectId"];
        if (typeof seq !== "number" || !Number.isInteger(seq)) continue;
        if (typeof projectId !== "string" || projectId.length === 0) continue;
        valid.push({ seq, projectId, payload: it["payload"] });
      }
      snapshotsApplied++;
      links++;
      clearResync();
      state = { kind: "linked", nonce: currentNonce };
      retriesUsed = 0;
      for (const item of valid) {
        try {
          d.onEvent(rawOf(item));
        } catch {
          /* one bad item must not drop the rest */
        }
      }
      const pending = queue;
      queue = [];
      for (const item of pending) {
        try {
          d.onEvent(rawOf(item));
        } catch {
          /* ignore */
        }
      }
      startPing();
      return;
    }

    if (t === "event") {
      const ev = validEventFields(msg);
      if (ev === null) return;
      if (state.kind === "linked") {
        try {
          d.onEvent(rawOf(ev));
        } catch {
          /* ignore */
        }
        return;
      }
      if (state.kind === "resyncing") {
        queue.push(ev);
        if (queue.length > WALL_QUEUE_MAX) {
          queue.shift();
          queueDropped++;
        }
      }
      return;
    }
    // pong / unknown: ignored.
    return;
  }

  function handleDisconnect(p: RuntimePort): void {
    if (stopped) return;
    if (port !== p) return;
    clearPing();
    clearResync();
    queue = [];
    port = null;
    if (state.kind === "unreachable") return;
    if (retriesUsed >= PORT_LIMITS.RECONNECT_MAX) {
      state = { kind: "unreachable", reason: "RETRIES_EXHAUSTED" };
      return;
    }
    retriesUsed++;
    state = { kind: "connecting", attempt: retriesUsed };
    const id = d.clock.setTimeout(() => {
      retryId = null;
      if (stopped) return;
      connectOnce(true);
    }, PORT_LIMITS.RECONNECT_RETRY_MS);
    retryId = id;
  }

  function connectOnce(isRetry: boolean): void {
    if (stopped) return;
    let p: RuntimePort;
    try {
      p = d.connect(d.extId);
    } catch {
      clearPing();
      clearRetry();
      state = { kind: "unreachable", reason: "NOT_LISTED" };
      port = null;
      return;
    }
    if (isRetry) {
      reconnects++;
    }
    connectedOnce = true;
    port = p;
    currentNonce = genNonce();
    p.onMessage.addListener((m) => { handleMessage(p, m); });
    p.onDisconnect.addListener(() => { handleDisconnect(p); });
    queue = [];
    try {
      p.postMessage({ t: "hello", v: 1, nonce: currentNonce });
    } catch {
      // A hello that cannot be sent means the link is dead: retry or exhaust.
      try {
        p.disconnect();
      } catch {
        /* ignore */
      }
      handleDisconnect(p);
      return;
    }
    state = { kind: "resyncing", nonce: currentNonce };
    startResyncTimer(p);
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      stopped = false;
      retriesUsed = 0;
      connectOnce(false);
    },
    state(): WallPortState {
      return state;
    },
    stop(): void {
      stopped = true;
      clearPing();
      clearResync();
      clearRetry();
      if (port !== null) {
        try {
          port.disconnect();
        } catch {
          /* ignore */
        }
        port = null;
      }
      queue = [];
    },
    stats(): WallPortStats {
      return { reconnects, pings, snapshotsApplied, queueDropped };
    },
  };
}
