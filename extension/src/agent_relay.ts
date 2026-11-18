// Hop B relay: page <-> native host for room frames (SPEC_U37 "Hop B").
// Pure wiring: validates both directions, rewrites rids, fans live frames out to
// subscribed ports. No logging, no storage; never throws.
import type { ChromePortLike } from "./chrome_ports";
import type { Clock } from "./types";

export interface AgentRelayNative {
  /** false when the native port is down (nothing was sent). */
  send(frame: unknown): boolean;
  onFrame(cb: (frame: unknown) => void): () => void;
  connected(): boolean;
}
export interface AgentRelayStats { forwarded: number; delivered: number; rejected: number; nacked: number; pending: number; ports: number }
export interface AgentRelay {
  onPortMessage(port: ChromePortLike, msg: unknown): void;
  onPortClosed(port: ChromePortLike): void;
  stats(): AgentRelayStats;
}
export const AGENT_RELAY_LIMITS = { FRAME_MAX_CHARS: 65536, TEXT_MAX_BYTES: 4096, PENDING_MAX: 32 } as const;

const RID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const FLOORS: ReadonlySet<string> = new Set(["ONLY_ON_DEVICE", "PREFER_ON_DEVICE"]);
const GAP_REASONS: ReadonlySet<string> = new Set(["sanitize_failed", "oversize"]);
const ROOMS_MAX = 12;
const hasControls = (s: string): boolean => { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 32 || c === 127) return true; } return false; };
const encoder = new TextEncoder();

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isRid = (v: unknown): v is string => typeof v === "string" && RID_RE.test(v);
const isRoom = (v: unknown): v is string => typeof v === "string" && ROOM_RE.test(v);
const isFloor = (v: unknown): v is string => typeof v === "string" && FLOORS.has(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

type PendingKind = "sync" | "post";
interface Pending { port: ChromePortLike; pageRid: string; kind: PendingKind; rooms: Set<string>; requested: Set<string> }

export function createAgentRelay(d: { native: AgentRelayNative; clock: Clock }): AgentRelay {
  void d.clock;
  const { native } = d;
  let forwarded = 0;
  let delivered = 0;
  let rejected = 0;
  let nacked = 0;
  let relaySeq = 0;
  const pending = new Map<string, Pending>();
  const pendingByPort = new Map<ChromePortLike, Set<string>>();
  const subscribed = new Set<ChromePortLike>();
  const ports = new Set<ChromePortLike>();
  let cachedHello: Record<string, unknown> | null = null;
  const initialRoomErrors = new Map<string, Record<string, unknown>>();

  const nextRid = (): string => {
    relaySeq += 1;
    return `r${relaySeq}`;
  };

  const dropPort = (port: ChromePortLike): void => {
    ports.delete(port);
    subscribed.delete(port);
    const set = pendingByPort.get(port);
    if (set !== undefined) {
      for (const rid of set) pending.delete(rid);
      pendingByPort.delete(port);
    }
  };

  const deliver = (port: ChromePortLike, frame: unknown): boolean => {
    try {
      port.postMessage(frame);
      delivered += 1;
      return true;
    } catch {
      dropPort(port);
      return false;
    }
  };

  const nack = (port: ChromePortLike, pageRid: string, code: string): void => {
    nacked += 1;
    deliver(port, { t: "room_nack", v: 1, rid: pageRid, code });
  };

  const settlePending = (relayRid: string): Pending | undefined => {
    const p = pending.get(relayRid);
    if (p === undefined) return undefined;
    pending.delete(relayRid);
    const set = pendingByPort.get(p.port);
    if (set !== undefined) {
      set.delete(relayRid);
      if (set.size === 0) pendingByPort.delete(p.port);
    }
    return p;
  };

  const forward = (port: ChromePortLike, pageRid: string, kind: PendingKind, partial: Record<string, unknown>, rooms: Set<string> = new Set<string>()): void => {
    const relayRid = nextRid();
    const frame = { ...partial, rid: relayRid };
    let ok = false;
    try {
      ok = native.connected() && native.send(frame);
    } catch {
      ok = false;
    }
    if (!ok) {
      cachedHello = null;
      initialRoomErrors.clear();
      nack(port, pageRid, "host_unavailable");
      return;
    }
    pending.set(relayRid, { port, pageRid, kind, rooms, requested: new Set<string>(rooms) });
    let set = pendingByPort.get(port);
    if (set === undefined) {
      set = new Set<string>();
      pendingByPort.set(port, set);
    }
    set.add(relayRid);
    forwarded += 1;
  };

  const capacityFull = (port: ChromePortLike): boolean =>
    (pendingByPort.get(port)?.size ?? 0) >= AGENT_RELAY_LIMITS.PENDING_MAX;

  const onPageSync = (port: ChromePortLike, pageRid: string, msg: Record<string, unknown>): void => {
    const since = msg["since"];
    if (!isRecord(since)) {
      rejected += 1;
      return;
    }
    const keys = Object.keys(since);
    if (keys.length > ROOMS_MAX) {
      rejected += 1;
      return;
    }
    for (const k of keys) {
      if (!isRoom(k) || !isInt(since[k])) {
        rejected += 1;
        return;
      }
    }
    const firstSubscribe = !subscribed.has(port);
    subscribed.add(port);
    if (firstSubscribe && cachedHello !== null) {
      try {
        if (native.connected()) {
          if (deliver(port, JSON.parse(JSON.stringify(cachedHello)) as Record<string, unknown>)) {
            for (const frame of initialRoomErrors.values()) deliver(port, frame);
          }
        } else {
          cachedHello = null;
        }
        initialRoomErrors.clear();
      } catch {
        /* cache delivery must never break the sync path */
      }
    }
    if (capacityFull(port)) {
      nack(port, pageRid, "pending_overflow");
      return;
    }
    forward(port, pageRid, "sync", { t: "room_sync", v: 1, since: { ...since } }, new Set(keys));
  };

  const onPagePost = (port: ChromePortLike, pageRid: string, msg: Record<string, unknown>): void => {
    const room = msg["room"];
    const act = msg["act"];
    const text = msg["text"];
    if (!isRoom(room) || act !== "question") {
      rejected += 1;
      return;
    }
    if (typeof text !== "string" || text.length === 0 || hasControls(text)
      || encoder.encode(text).length > AGENT_RELAY_LIMITS.TEXT_MAX_BYTES) {
      rejected += 1;
      return;
    }
    const to = msg["to"];
    const re = msg["re"];
    if (to !== undefined && typeof to !== "string") {
      rejected += 1;
      return;
    }
    if (re !== undefined && typeof re !== "string") {
      rejected += 1;
      return;
    }
    if (capacityFull(port)) {
      nack(port, pageRid, "pending_overflow");
      return;
    }
    const frame: Record<string, unknown> = { t: "room_post", v: 1, room, act: "question", text };
    if (to !== undefined) frame["to"] = to;
    if (re !== undefined) frame["re"] = re;
    forward(port, pageRid, "post", frame);
  };

  const fanOut = (frame: unknown): void => {
    for (const port of [...subscribed]) deliver(port, frame);
  };

  const routeReply = (relayRid: string, frame: Record<string, unknown>): void => {
    const p = pending.get(relayRid);
    if (p === undefined || p.kind !== "post") {
      rejected += 1;
      return;
    }
    settlePending(relayRid);
    deliver(p.port, { ...frame, rid: p.pageRid });
  };

  const routeSyncEnd = (relayRid: string, frame: Record<string, unknown>): void => {
    const p = pending.get(relayRid);
    if (p === undefined || p.kind !== "sync") {
      rejected += 1;
      return;
    }
    const room = frame["room"] as string;
    if (p.rooms.size > 0 || frame["t"] === "room_sync_error") {
      if (!p.rooms.has(room)) {
        rejected += 1;
        return;
      }
      p.rooms.delete(room);
    }
    deliver(p.port, { ...frame, rid: p.pageRid });
    if (p.rooms.size === 0) settlePending(relayRid);
  };

  const onNativeFrame = (frame: Record<string, unknown>): void => {
    const t = frame["t"];
    if (t === "room_sync_error") {
      const room = frame["room"];
      const code = frame["code"];
      const rid = frame["rid"];
      if (frame["v"] !== 1 || !isRoom(room) || typeof code !== "string"
        || ("rid" in frame && !isRid(rid))) {
        rejected += 1;
        return;
      }
      const fault = { t, v: 1, room, code: code === "room_read_failed" ? code : "room_sync_failed" };
      if (isRid(rid)) {
        routeSyncEnd(rid, fault);
      } else if (subscribed.size > 0) {
        fanOut(fault);
      } else if (cachedHello !== null && (cachedHello["rooms"] as Record<string, unknown>[]).some(entry => entry["room"] === room)) {
        // Native startup can announce a fault before the page subscribes.
        initialRoomErrors.set(room, fault);
      }
      return;
    }
    if (t === "room_event") {
      if (frame["v"] !== 1 || !isRoom(frame["room"]) || !isFloor(frame["floor"]) || !isRecord(frame["event"])) {
        rejected += 1;
        return;
      }
      const rid = frame["rid"];
      if (rid !== undefined) {
        if (typeof rid !== "string") {
          rejected += 1;
          return;
        }
        const p = pending.get(rid);
        if (p === undefined || p.kind !== "sync") {
          rejected += 1;
          return;
        }
        if (p.requested.size > 0 && !p.requested.has(frame["room"] as string)) {
          rejected += 1;
          return;
        }
        deliver(p.port, { ...frame, rid: p.pageRid });
        return;
      }
      fanOut(frame);
      return;
    }
    if (t === "room_gap") {
      if (frame["v"] !== 1 || !isRoom(frame["room"])
        || typeof frame["from_lamport"] !== "number" || !Number.isSafeInteger(frame["from_lamport"])
        || (frame["from_lamport"] as number) < 1
        || typeof frame["to_lamport"] !== "number" || !Number.isSafeInteger(frame["to_lamport"])
        || (frame["to_lamport"] as number) < 1
        || (frame["from_lamport"] as number) > (frame["to_lamport"] as number)
        || typeof frame["reason"] !== "string" || !GAP_REASONS.has(frame["reason"] as string)) {
        rejected += 1;
        return;
      }
      const rid = frame["rid"];
      if (rid !== undefined) {
        if (typeof rid !== "string" || !isRid(rid)) {
          rejected += 1;
          return;
        }
        const p = pending.get(rid);
        if (p === undefined || p.kind !== "sync") {
          rejected += 1;
          return;
        }
        if (p.requested.size > 0 && !p.requested.has(frame["room"] as string)) {
          rejected += 1;
          return;
        }
        deliver(p.port, { ...frame, rid: p.pageRid });
        return;
      }
      fanOut(frame);
      return;
    }
    if (t === "room_hello") {
      if (frame["v"] !== 1 || !Array.isArray(frame["rooms"])) {
        rejected += 1;
        return;
      }
      for (const entry of frame["rooms"] as unknown[]) {
        if (!isRecord(entry) || !isRoom(entry["room"]) || !isFloor(entry["floor"])) {
          rejected += 1;
          return;
        }
      }
      try {
        cachedHello = JSON.parse(JSON.stringify(frame)) as Record<string, unknown>;
      } catch {
        rejected += 1;
        return;
      }
      initialRoomErrors.clear();
      fanOut(frame);
      return;
    }
    if (t === "room_synced") {
      if (frame["v"] !== 1 || !isRid(frame["rid"]) || !isRoom(frame["room"]) || !isInt(frame["upto"])
        || typeof frame["more"] !== "boolean") {
        rejected += 1;
        return;
      }
      routeSyncEnd(frame["rid"] as string, frame);
      return;
    }
    if (t === "room_ack") {
      if (frame["v"] !== 1 || !isRid(frame["rid"]) || typeof frame["id"] !== "string" || !isInt(frame["lamport"])) {
        rejected += 1;
        return;
      }
      routeReply(frame["rid"] as string, frame);
      return;
    }
    if (t === "room_nack") {
      if (frame["v"] !== 1 || !isRid(frame["rid"]) || typeof frame["code"] !== "string" || (frame["code"] as string).length === 0) {
        rejected += 1;
        return;
      }
      routeReply(frame["rid"] as string, frame);
      return;
    }
    rejected += 1;
  };

  native.onFrame((frame: unknown) => {
    let chars: number;
    try {
      const s = JSON.stringify(frame);
      chars = typeof s === "string" ? s.length : Number.POSITIVE_INFINITY;
    } catch {
      rejected += 1;
      return;
    }
    if (chars > AGENT_RELAY_LIMITS.FRAME_MAX_CHARS) {
      rejected += 1;
      return;
    }
    if (!isRecord(frame)) {
      rejected += 1;
      return;
    }
    onNativeFrame(frame);
  });

  return {
    onPortMessage(port: ChromePortLike, msg: unknown): void {
      ports.add(port);
      let chars: number;
      try {
        const s = JSON.stringify(msg);
        chars = typeof s === "string" ? s.length : Number.POSITIVE_INFINITY;
      } catch {
        rejected += 1;
        return;
      }
      if (chars > AGENT_RELAY_LIMITS.FRAME_MAX_CHARS) {
        rejected += 1;
        return;
      }
      if (!isRecord(msg) || msg["v"] !== 1 || !isRid(msg["rid"])) {
        rejected += 1;
        return;
      }
      const t = msg["t"];
      const pageRid = msg["rid"] as string;
      if (t === "room_sync") {
        onPageSync(port, pageRid, msg);
        return;
      }
      if (t === "room_post") {
        onPagePost(port, pageRid, msg);
        return;
      }
      rejected += 1;
    },
    onPortClosed(port: ChromePortLike): void {
      dropPort(port);
    },
    stats(): AgentRelayStats {
      return { forwarded, delivered, rejected, nacked, pending: pending.size, ports: ports.size };
    },
  };
}
