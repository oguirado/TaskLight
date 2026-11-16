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

// ---- U49 (SPEC_U49): model_* passthrough frames. Types and constants are final; functions elsewhere throw. ----
export const MODEL_RELAY_LIMITS = {
  FRAME_MAX_BYTES: 65536, QUEUE_MAX: 8, MESSAGES_MAX: 32, MAX_TOKENS_MAX: 8192, SLACK_MS: 2000,
  LIST_MS: 2000, PROBE_MS: 3500, LOCAL_GENERATE_MS: 32000, REMOTE_GENERATE_MS: 62000,
} as const;
export type ModelNackCode =
  | "unknown_endpoint" | "needs_setup" | "policy" | "busy" | "too_large" | "not_loopback" | "redirect" | "timeout"
  | "offline" | "auth" | "rate_limited" | "rung_unsupported" | "http_error" | "bad_reply" | "reply_too_large" | "cancelled"
  | "host_absent" | "bad_request" | "store_failed";
export type ModelHealthState = "available" | "needs_setup" | "offline" | "blocked";
export interface ModelEndpointWire {
  id: string; kind: "local-openai-compatible" | "remote-openai-compatible"; label: string; model: string;
  loopback: boolean; has_key: boolean; allow_private: boolean;
}
export interface StoredSelection { all?: string; groups?: { capsule?: string; digest?: string; routing?: string; drift?: string } }
export type PageModelMsg =
  | { t: "model_list"; v: 1; rid: string }
  | { t: "model_probe"; v: 1; rid: string; id: string }
  | { t: "model_generate"; v: 1; rid: string; id: string; tier: "private" | "standard" | "shared";
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>; max_tokens: number; rung: 1 | 2 | 3; schema?: object }
  | { t: "model_cancel"; v: 1; rid: string }
  | { t: "model_sel_get"; v: 1; rid: string }
  | { t: "model_sel_set"; v: 1; rid: string; selection: StoredSelection };
export type ExtModelMsg =
  | { t: "model_hello"; v: 1; rid?: string; endpoints: ModelEndpointWire[] }
  | { t: "model_health"; v: 1; rid: string; id: string; state: ModelHealthState; rung: 1 | 2 | 3 | null }
  | { t: "model_result"; v: 1; rid: string; text: string }
  | { t: "model_nack"; v: 1; rid: string; code: ModelNackCode }
  | { t: "model_sel"; v: 1; rid: string; selection: StoredSelection };
