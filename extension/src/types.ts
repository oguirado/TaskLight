import type { ConnectorMsg, HostReply, NackCode } from "../../src/app/types";

export interface ExtConfig { siteOrigin: string; wallUrl: string }
export interface QueuedEvent {
  readonly id: number;
  readonly projectId: string;
  readonly payload: unknown;
  readonly chars: number;
  readonly receivedAt: number;
}
export interface QueueState { v: 1; nextId: number; items: QueuedEvent[]; totalChars: number; dropped: number }
export type RouterReject = "BAD_SHAPE" | "PROJECT_ID_INVALID" | "TOO_LARGE" | "STORE_FAILED";
export type EnqueueResult = { ok: true; id: number; evictedIds: number[] } | { ok: false; code: RouterReject };
export interface SessionStore { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
export interface Clock { now(): number; setTimer(ms: number, fn: () => void): () => void }
export interface RouterStats {
  accepted: number; rejected: Readonly<Record<RouterReject, number>>; dropped: number; depth: number; totalChars: number;
}
export interface Router {
  load(): Promise<void>;
  accept(raw: unknown): Promise<EnqueueResult>;
  lease(max: number): Promise<QueuedEvent[]>;
  commit(ids: readonly number[]): Promise<void>;
  /** ORACLE addition: non-leasing read of the whole current queue (FIFO by id). Used for the T1 snapshot. */
  peek(): readonly QueuedEvent[];
  stats(): RouterStats;
}
export type LinkState =
  | { kind: "idle" }
  | { kind: "handshaking"; attempt: number; nonce: string }
  | { kind: "linked"; nonce: string; nextSeq: number }
  | { kind: "unreachable"; reason: "HELLO_TIMEOUT" | "UNSUPPORTED_VERSION" }
  | { kind: "closed" };
export interface FrameTarget { postMessage(msg: ConnectorMsg, targetOrigin: string): void }
export interface RouterPort {
  lease(max: number): Promise<QueuedEvent[]>;
  commit(ids: readonly number[]): Promise<void>;
  onWake(cb: () => void): () => void;
}
export interface ClientStats { sent: number; nacked: Readonly<Partial<Record<NackCode, number>>>; ignoredReplies: number; retried: number }
export interface WallClient {
  start(): void;
  onMessage(ev: { origin: string; data: unknown; source: unknown }): void;
  state(): LinkState;
  stats(): ClientStats;
  stop(): void;
}
export type { HostReply };

// ---- SPEC_AMEND_C delta ----
export const SOURCE_LIMITS = { TITLE_MAX: 120, TEXT_MAX: 2000, PINS_MAX: 12 } as const;
export const PORT_LIMITS = { PING_MS: 20000, RECONNECT_RETRY_MS: 100, RECONNECT_MAX: 50 } as const;
export type PinnedSource = "tab" | "selection" | "page";
export interface PinnedSourceEvent {
  tabId: number; projectId: string; source: PinnedSource;
  kind: "tab_pinned" | "tab_focused" | "selection_captured" | "page_snapshot";
  title: string; originPath: string; text: string; userGesture: boolean;
}
export type PinReject = "NOT_PINNED" | "NO_GESTURE" | "BAD_URL" | "PINS_FULL";
export interface PinRegistry {
  pin(tabId: number, projectId: string, gesture: boolean): { ok: true } | { ok: false; code: PinReject };
  unpin(tabId: number): void;
  projectOf(tabId: number): string | undefined;
}
/** Snapshot item on the T1 port. ORACLE decision: `seq` = QueuedEvent.id, matching U22 `types.ts` QueuedEvent {seq,projectId,payload}. */
export interface PortSnapshotItem { seq: number; projectId: string; payload: unknown }
export type PortMsg =
  | { t: "hello"; v: 1; nonce: string }
  | { t: "snapshot"; v: 1; nonce: string; items: PortSnapshotItem[] }
  | { t: "event"; v: 1; seq: number; projectId: string; payload: unknown }
  | { t: "ping"; v: 1 } | { t: "pong"; v: 1 };
export interface ExternalPortGate { allowedOrigins: readonly string[] }
export interface NativeRelayCfg { hostName: string; maxFrameChars: number }
