// Page link: wraps U22 createWallPort with room_sync / room_post (SPEC_U37 "U37c").
// Accepts room frames only from the latest port. post() never rejects or throws.
import { createWallPort } from "./wall_port";
import type { Clock, RuntimePort, WallPort, WallPortState } from "./types";

export interface RoomEventFrame { t: "room_event"; v: 1; room: string; floor: "ONLY_ON_DEVICE" | "PREFER_ON_DEVICE"; event: unknown; rid?: string }
export interface RoomHelloFrame { t: "room_hello"; v: 1; rooms: Array<{ room: string; floor: "ONLY_ON_DEVICE" | "PREFER_ON_DEVICE" }>; agent: string; orchestrator?: string }
export interface PostRequest { room: string; text: string; to?: string; re?: string }
export type PostResult = { ok: true; id: string; lamport: number } | { ok: false; code: string };
export interface RoomGapFrame {
  t: "room_gap"; v: 1; room: string; from_lamport: number; to_lamport: number;
  reason: "sanitize_failed" | "oversize"; rid?: string;
}
export type RoomSyncErrorCode = "room_read_failed" | "room_sync_failed";
export interface RoomSyncErrorFrame { t: "room_sync_error"; v: 1; room: string; code: RoomSyncErrorCode; rid?: string }
export interface RoomSyncedFrame { t: "room_synced"; v: 1; rid: string; room: string; upto: number; more: boolean }
export interface AgentLinkDeps {
  extId: string;
  connect: (id: string) => RuntimePort;
  clock: Clock;
  nonce?: () => string;
  since: () => Record<string, number>;
  onRoomEvent: (frame: RoomEventFrame) => void;
  onRoomHello: (frame: RoomHelloFrame) => void;
  onRoomGap?: (frame: RoomGapFrame) => void;
  onRoomSynced?: (frame: RoomSyncedFrame) => void;
  onRoomSyncError?: (frame: RoomSyncErrorFrame) => void;
  onRoomSyncRecovered?: (room: string) => void;
  onWallEvent?: (raw: string) => void;
}
export interface AgentLink {
  start(): void;
  stop(): void;
  state(): WallPortState;
  /** Whether replay data has arrived without a final terminal for the room. */
  hasUnverifiedReplay?(room: string): boolean;
  /** Never rejects. */
  post(req: PostRequest): Promise<PostResult>;
}
export const LINK_LIMITS = { POST_TIMEOUT_MS: 5000, SYNC_TIMEOUT_MS: 15000, SYNC_CONTINUATIONS_MAX: 64 } as const;

const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const FLOORS: ReadonlySet<string> = new Set(["ONLY_ON_DEVICE", "PREFER_ON_DEVICE"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function createAgentLink(deps: AgentLinkDeps): AgentLink {
  const { clock, since, onRoomEvent, onRoomHello, onWallEvent } = deps;
  const onRoomGap = deps.onRoomGap;
  const onRoomSynced = deps.onRoomSynced;
  let helloRooms: Set<string> | null = null;
  let latestPort: RuntimePort | null = null;
  let started = false;
  let stopped = false;
  let seq = 0;
  const syncTimers = new Set<number>();
  const pendingPosts = new Map<string, { resolve: (r: PostResult) => void; timer: number }>();
  const outstanding = new Map<string, { rid: string; recoversFault: boolean; timer: number }>();
  const faultedRooms = new Set<string>();
  const unverifiedRooms = new Set<string>();
  const pendingSyncs = new Set<string>();
  const continuations = new Map<string, number>();

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

  const cancelTimer = (id: number): void => {
    try {
      clock.clearTimeout(id);
    } catch {
      /* best-effort: callbacks also check current link state */
    }
  };

  const releaseReplay = (room: string): void => {
    const replay = outstanding.get(room);
    if (replay === undefined) return;
    outstanding.delete(room);
    cancelTimer(replay.timer);
  };

  const resetReplays = (): void => {
    for (const room of outstanding.keys()) releaseReplay(room);
    pendingSyncs.clear();
    continuations.clear();
  };

  const resetSyncTimers = (): void => {
    for (const id of syncTimers) cancelTimer(id);
    syncTimers.clear();
    resetReplays();
  };

  const reportSyncError = (frame: RoomSyncErrorFrame): void => {
    try {
      deps.onRoomSyncError?.(frame);
    } catch {
      /* callback errors must not break the link */
    }
  };

  const expireReplay = (port: RuntimePort, room: string, rid: string): void => {
    if (stopped || latestPort !== port || outstanding.get(room)?.rid !== rid) return;
    outstanding.delete(room);
    continuations.delete(room);
    const queued = pendingSyncs.delete(room);
    if (!helloRooms?.has(room)) return;
    const firstFault = !faultedRooms.has(room);
    faultedRooms.add(room);
    reportSyncError({ t: "room_sync_error", v: 1, room, code: "room_sync_failed", rid });
    // Try once on expiry. Further failures can retry on new sync demand.
    if ((firstFault || queued) && !stopped && latestPort === port && helloRooms?.has(room)
      && !outstanding.has(room)) {
      sendSync(port, { [room]: 0 });
    }
  };

  const sendSync = (port: RuntimePort, sinceMap?: Record<string, number>, continuation?: boolean): void => {
    // Only the first page chooses a recovery cursor; later pages carry eligibility forward.
    const requested = sinceMap ?? { ...since() };
    if (sinceMap === undefined) {
      for (const room of faultedRooms) {
        if (helloRooms?.has(room)) requested[room] = 0;
      }
    }
    const map: Record<string, number> = {};
    for (const room of Object.keys(requested)) {
      if (outstanding.has(room)) {
        pendingSyncs.add(room);
      } else {
        map[room] = continuation === undefined && faultedRooms.has(room) ? 0 : requested[room]!;
      }
    }
    // Preserve an empty subscription, but do not send when every room is busy.
    if (Object.keys(requested).length > 0 && Object.keys(map).length === 0) return;
    const rid = nextRid();
    try {
      for (const room of Object.keys(map)) {
        const timer = clock.setTimeout(() => expireReplay(port, room, rid), LINK_LIMITS.SYNC_TIMEOUT_MS);
        outstanding.set(room, { rid, timer, recoversFault: continuation ?? faultedRooms.has(room) });
      }
      port.postMessage({ t: "room_sync", v: 1, rid, since: map });
    } catch {
      for (const room of Object.keys(map)) {
        if (outstanding.get(room)?.rid === rid) releaseReplay(room);
      }
      /* Failed setup or send: the next hello/snapshot retries. */
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
        if (typeof entry["floor"] !== "string" || !FLOORS.has(entry["floor"])) continue; // O-U85b: same rule as membership
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
      const roomsRaw = msg["rooms"];
      if (msg["v"] !== 1 || !Array.isArray(roomsRaw) || typeof msg["agent"] !== "string") return;
      // O-U85b: malformed entries are skipped (U38 G1); only valid room+floor entries become members.
      const validEntry = (entry: unknown): entry is Record<string, unknown> => isRecord(entry)
        && typeof entry["room"] === "string" && ROOM_RE.test(entry["room"])
        && typeof entry["floor"] === "string" && FLOORS.has(entry["floor"]);
      const members = new Set<string>();
      for (const entry of roomsRaw) {
        if (validEntry(entry)) members.add(entry["room"] as string);
      }
      helloRooms = members;
      resetReplays();
      try {
        onRoomHello(msg as unknown as RoomHelloFrame);
      } catch {
        /* callback errors must not break the link */
      }
      sendSync(port, helloSince(msg));
      return;
    }
    if (t === "room_sync_error") {
      const room = msg["room"];
      const code = msg["code"];
      const rid = msg["rid"];
      if (msg["v"] !== 1 || typeof room !== "string" || !helloRooms?.has(room)
        || (code !== "room_read_failed" && code !== "room_sync_failed")) return;
      const replay = outstanding.get(room);
      if ("rid" in msg && (typeof rid !== "string" || replay?.rid !== rid)) return;

      faultedRooms.add(room);
      if (replay !== undefined) replay.recoversFault = false;
      if (typeof rid === "string") {
        releaseReplay(room);
        continuations.delete(room);
      }
      reportSyncError({ t, v: 1, room, code, ...(typeof rid === "string" ? { rid } : {}) });
      if (typeof rid === "string" && pendingSyncs.delete(room)) {
        sendSync(port, { [room]: 0 });
      }
      return;
    }
    if (t === "room_synced") {
      const rid = msg["rid"];
      const room = msg["room"];
      const upto = msg["upto"];
      const more = msg["more"];
      if (msg["v"] !== 1 || typeof rid !== "string"
        || typeof room !== "string" || !ROOM_RE.test(room)
        || typeof upto !== "number" || !Number.isSafeInteger(upto) || upto < 0
        || typeof more !== "boolean") {
        return;
      }
      if (!helloRooms?.has(room)) return;
      const replay = outstanding.get(room);
      if (replay?.rid !== rid) return;
      releaseReplay(room);
      const deliver = (): void => {
        try {
          onRoomSynced?.(msg as unknown as RoomSyncedFrame);
        } catch {
          /* callback errors must not break the link */
        }
      };
      if (!more) {
        unverifiedRooms.delete(room);
        if (replay.recoversFault && faultedRooms.delete(room)) {
          try {
            deps.onRoomSyncRecovered?.(room);
          } catch {
            /* callback errors must not break the link */
          }
        }
        if (pendingSyncs.delete(room)) {
          sendSync(port, { [room]: since()[room] ?? 0 });
        }
        deliver();
        return;
      }
      const used = continuations.get(room) ?? 0;
      if (used >= LINK_LIMITS.SYNC_CONTINUATIONS_MAX) {
        pendingSyncs.delete(room);
        deliver();
        return;
      }
      continuations.set(room, used + 1);
      sendSync(port, { [room]: upto }, replay.recoversFault);
      deliver();
      return;
    }
    if (t === "room_gap") {
      const room = msg["room"];
      const from = msg["from_lamport"];
      const to = msg["to_lamport"];
      const reason = msg["reason"];
      if (msg["v"] !== 1
        || typeof room !== "string" || !ROOM_RE.test(room)
        || typeof from !== "number" || !Number.isSafeInteger(from) || from < 1
        || typeof to !== "number" || !Number.isSafeInteger(to) || to < 1
        || from > to
        || (reason !== "sanitize_failed" && reason !== "oversize")) {
        return;
      }
      if (helloRooms === null || !helloRooms.has(room as string)) return;
      if ("rid" in msg) {
        const rid = msg["rid"];
        if (typeof rid !== "string" || outstanding.get(room)?.rid !== rid) return;
      }
      try {
        onRoomGap?.(msg as unknown as RoomGapFrame);
      } catch {
        /* callback errors must not break the link */
      }
      return;
    }
    if (t === "room_event") {
      const room = msg["room"];
      const floor = msg["floor"];
      if (msg["v"] !== 1 || typeof room !== "string" || !ROOM_RE.test(room)
        || typeof floor !== "string" || !FLOORS.has(floor) || !isRecord(msg["event"])) {
        return;
      }
      if (helloRooms === null || !helloRooms.has(room as string)) return;
      if ("rid" in msg) {
        const rid = msg["rid"];
        if (typeof rid !== "string" || outstanding.get(room)?.rid !== rid) return;
      }
      const innerRoom = (msg["event"] as Record<string, unknown>)["room"];
      if (innerRoom !== room) return;
      if ("rid" in msg) unverifiedRooms.add(room);
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
    helloRooms = null;
    const port = deps.connect(id);
    latestPort = port;
    port.onMessage.addListener((msg: unknown) => {
      if (stopped || port !== latestPort) return;
      handleMessage(port, msg);
    });
    port.onDisconnect.addListener(() => {
      if (latestPort === port) {
        helloRooms = null;
        latestPort = null;
        resetSyncTimers();
      }
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
      resetSyncTimers();
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
    hasUnverifiedReplay(room: string): boolean {
      return unverifiedRooms.has(room);
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
