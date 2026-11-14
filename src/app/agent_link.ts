// Page link: wraps U22 createWallPort with room_sync / room_post (SPEC_U37 "U37c").
// Accepts room frames only from the latest port. post() never rejects or throws.
import { createWallPort } from "./wall_port";
import type { Clock, RuntimePort, WallPort, WallPortState } from "./types";

export interface RoomEventFrame { t: "room_event"; v: 1; room: string; floor: "ONLY_ON_DEVICE" | "PREFER_ON_DEVICE"; event: unknown; rid?: string }
export interface RoomHelloFrame { t: "room_hello"; v: 1; rooms: Array<{ room: string; floor: "ONLY_ON_DEVICE" | "PREFER_ON_DEVICE" }>; agent: string; orchestrator?: string }
export interface PostRequest { room: string; text: string; to?: string; re?: string }
export type PostResult = { ok: true; id: string; lamport: number } | { ok: false; code: string };
export interface AgentLinkDeps {
  extId: string;
  connect: (id: string) => RuntimePort;
  clock: Clock;
  nonce?: () => string;
  since: () => Record<string, number>;
  onRoomEvent: (frame: RoomEventFrame) => void;
  onRoomHello: (frame: RoomHelloFrame) => void;
  onWallEvent?: (raw: string) => void;
}
export interface AgentLink {
  start(): void;
  stop(): void;
  state(): WallPortState;
  /** Never rejects. */
  post(req: PostRequest): Promise<PostResult>;
}
export const LINK_LIMITS = { POST_TIMEOUT_MS: 5000 } as const;

const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const FLOORS: ReadonlySet<string> = new Set(["ONLY_ON_DEVICE", "PREFER_ON_DEVICE"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function createAgentLink(deps: AgentLinkDeps): AgentLink {
  const { clock, since, onRoomEvent, onRoomHello, onWallEvent } = deps;
  let latestPort: RuntimePort | null = null;
  let started = false;
  let stopped = false;
  let seq = 0;
  const syncTimers = new Set<number>();
  const pendingPosts = new Map<string, { resolve: (r: PostResult) => void; timer: number }>();

  const nextRid = (): string => {
    seq += 1;
    return `l${seq}`;
  };

  const settle = (rid: string, result: PostResult): void => {
    const p = pendingPosts.get(rid);
    if (p === undefined) return;
    pendingPosts.delete(rid);
    try {
      clock.clearTimeout(p.timer);
    } catch {
      /* best-effort: the post must still settle */
    }
    p.resolve(result);
  };

  const sendSync = (port: RuntimePort, sinceMap?: Record<string, number>): void => {
    try {
      port.postMessage({ t: "room_sync", v: 1, rid: nextRid(), since: sinceMap ?? since() });
    } catch {
      /* transport-level failure: the next hello/snapshot retries */
    }
  };

  // U38 G1: after room_hello, ask for history in every hello room (0 when the
  // store has not seen the room yet), so a freshly opened page is replayed.
  const helloSince = (msg: Record<string, unknown>): Record<string, number> => {
    const out: Record<string, number> = {};
    const roomsRaw = msg["rooms"];
    if (Array.isArray(roomsRaw)) {
      const cur = since();
      for (const entry of roomsRaw) {
        if (!isRecord(entry)) continue;
        const room = entry["room"];
        if (typeof room !== "string" || !ROOM_RE.test(room)) continue;
        out[room] = cur[room] ?? 0;
      }
    }
    return out;
  };

  const scheduleSync = (port: RuntimePort): void => {
    let id: number;
    try {
      id = clock.setTimeout(() => {
        syncTimers.delete(id);
        if (stopped || latestPort !== port) return;
        if (wall.state().kind !== "linked") return;
        sendSync(port);
      }, 1);
    } catch {
      return;
    }
    syncTimers.add(id);
  };

  const handleMessage = (port: RuntimePort, msg: unknown): void => {
    if (!isRecord(msg)) return;
    const t = msg["t"];
    if (t === "snapshot") {
      scheduleSync(port);
      return;
    }
    if (t === "room_hello") {
      try {
        onRoomHello(msg as unknown as RoomHelloFrame);
      } catch {
        /* callback errors must not break the link */
      }
      sendSync(port, helloSince(msg));
      return;
    }
    if (t === "room_event") {
      const room = msg["room"];
      const floor = msg["floor"];
      if (msg["v"] !== 1 || typeof room !== "string" || !ROOM_RE.test(room)
        || typeof floor !== "string" || !FLOORS.has(floor) || !isRecord(msg["event"])) {
        return;
      }
      try {
        onRoomEvent(msg as unknown as RoomEventFrame);
      } catch {
        /* callback errors must not break the link */
      }
      return;
    }
    if (t === "room_ack") {
      const rid = msg["rid"];
      const id = msg["id"];
      const lamport = msg["lamport"];
      if (typeof rid !== "string" || typeof id !== "string" || typeof lamport !== "number" || !Number.isInteger(lamport)) return;
      settle(rid, { ok: true, id, lamport });
      return;
    }
    if (t === "room_nack") {
      const rid = msg["rid"];
      const code = msg["code"];
      if (typeof rid !== "string" || typeof code !== "string" || code.length === 0) return;
      settle(rid, { ok: false, code });
      return;
    }
  };

  const connectWrapped = (id: string): RuntimePort => {
    const port = deps.connect(id);
    latestPort = port;
    port.onMessage.addListener((msg: unknown) => {
      if (stopped || port !== latestPort) return;
      handleMessage(port, msg);
    });
    port.onDisconnect.addListener(() => {
      if (latestPort === port) latestPort = null;
    });
    return port;
  };

  const wall: WallPort = createWallPort({
    extId: deps.extId,
    connect: connectWrapped,
    clock,
    ...(deps.nonce !== undefined ? { nonce: deps.nonce } : {}),
    onEvent: (raw) => {
      onWallEvent?.(raw);
    },
  });

  return {
    start(): void {
      if (started) return;
      started = true;
      stopped = false;
      wall.start();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const id of syncTimers) {
        try {
          clock.clearTimeout(id);
        } catch {
          /* best-effort */
        }
      }
      syncTimers.clear();
      for (const p of pendingPosts.values()) {
        try {
          clock.clearTimeout(p.timer);
        } catch {
          /* best-effort: the post must still settle */
        }
        p.resolve({ ok: false, code: "stopped" });
      }
      pendingPosts.clear();
      wall.stop();
      latestPort = null;
    },
    state(): WallPortState {
      return wall.state();
    },
    post(req: PostRequest): Promise<PostResult> {
      try {
        if (stopped) return Promise.resolve({ ok: false, code: "stopped" });
        if (wall.state().kind !== "linked") return Promise.resolve({ ok: false, code: "not_linked" });
        const port = latestPort;
        if (port === null) return Promise.resolve({ ok: false, code: "not_linked" });
        const room = req.room;
        const text = req.text;
        if (typeof room !== "string" || typeof text !== "string") {
          return Promise.resolve({ ok: false, code: "bad_request" });
        }
        const rid = nextRid();
        const frame: Record<string, unknown> = { t: "room_post", v: 1, rid, room, act: "question", text };
        if (typeof req.to === "string") frame["to"] = req.to;
        if (typeof req.re === "string") frame["re"] = req.re;
        let resolve: (r: PostResult) => void = () => undefined;
        const promise = new Promise<PostResult>((r) => {
          resolve = r;
        });
        let timer: number;
        try {
          timer = clock.setTimeout(() => {
            pendingPosts.delete(rid);
            resolve({ ok: false, code: "timeout" });
          }, LINK_LIMITS.POST_TIMEOUT_MS);
        } catch {
          resolve({ ok: false, code: "timer_failed" });
          return promise;
        }
        pendingPosts.set(rid, { resolve, timer });
        try {
          port.postMessage(frame);
        } catch {
          pendingPosts.delete(rid);
          try {
            clock.clearTimeout(timer);
          } catch {
            /* best-effort: the post must still settle */
          }
          resolve({ ok: false, code: "send_failed" });
        }
        return promise;
      } catch {
        return Promise.resolve({ ok: false, code: "error" });
      }
    },
  };
}
