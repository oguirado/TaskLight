// U22 public types (SPEC_U22 §2 + SPEC_AMEND_C). Types only: no behaviour.
export type BuildMode = "dev" | "prod";
export interface HostEnv {
  mode: BuildMode;
  origin: string;
  firebaseConfig: Readonly<Record<string, string>>;
  recaptchaSiteKey?: string;
  debugToken?: string | true;
  extensionOrigins: readonly string[];
  useLimitedUseTokens: boolean;
}
export type BootErrorCode =
  | "CONFIG_INVALID" | "MISSING_RECAPTCHA_KEY" | "DEBUG_IN_PROD"
  | "DEBUG_ON_PUBLIC_ORIGIN" | "APPCHECK_INIT_FAILED" | "AUTH_FAILED";
export type AppCheckKind = "recaptcha_enterprise" | "debug";
export type DeviceModelState = "idle" | "initializing" | "initialized" | "failed";
export type HostState =
  | { kind: "booting" }
  | { kind: "ready"; uid: string; isAnonymous: boolean; appCheck: AppCheckKind; deviceModel: DeviceModelState; deviceModelProgress?: number }
  // ORACLE addition (SPEC_U22 §4 AUTH_FAILED: "local-only wall, AI continues"); see ORACLE.md Q1.
  | { kind: "degraded"; reason: "AUTH_FAILED"; appCheck: AppCheckKind; deviceModel: DeviceModelState; deviceModelProgress?: number }
  | { kind: "blocked"; reason: BootErrorCode };

export interface FirebasePorts {
  initializeApp(cfg: Readonly<Record<string, string>>): unknown;
  setDebugFlag(v: string | true): void;
  newRecaptchaEnterpriseProvider(siteKey: string): unknown;
  newDebugCompatibleProvider(): unknown;
  initializeAppCheck(app: unknown, opts: { provider: unknown; isTokenAutoRefreshEnabled: boolean }): unknown;
  getAuth(app: unknown): unknown;
  signInAnonymously(auth: unknown): Promise<{ uid: string }>;
  onAuthStateChanged(auth: unknown, cb: (u: { uid: string; isAnonymous: boolean } | null) => void): () => void;
  signInWithGooglePopup(auth: unknown): Promise<{ uid: string }>;
}
export interface HybridPort {
  create(app: unknown, opts: { useLimitedUseAppCheckTokens: boolean }): void;
  initializeDeviceModel(onProgress: (v: number) => void): Promise<void>;
}

// Connector (postMessage path, T2)
export type ConnectorMsg =
  | { t: "hello"; v: number; nonce: string }
  | { t: "event"; v: number; seq: number; projectId: string; payload: unknown }
  | { t: "bye"; v: number };
export type NackCode = "UNSUPPORTED_VERSION" | "BAD_SHAPE" | "TOO_LARGE" | "THROTTLED" | "NO_HANDSHAKE" | "SEQ_NOT_MONOTONIC";
export type HostReply =
  | { t: "ack"; v: 1; nonce: string }
  | { t: "nack"; v: 1; code: NackCode; seq?: number };
export interface ReplyTarget { postMessage(msg: HostReply, targetOrigin: string): void }
export interface IngestSink { accept(projectId: string, seq: number, payload: unknown): void }
export interface ConnectorStats { accepted: number; nacked: number; droppedOrigin: number }
export interface Connector {
  onMessage(ev: { origin: string; data: unknown; source: ReplyTarget | null }): void;
  stats(): ConnectorStats;
}

// Wall port (T1, externally_connectable). Clock/RuntimePort/QueuedEvent are ORACLE definitions (absent from the pack).
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
}
export interface RuntimePort {
  postMessage(msg: unknown): void;
  disconnect(): void;
  onMessage: { addListener(cb: (msg: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}
export interface QueuedEvent { seq: number; projectId: string; payload: unknown }
export type PortMsg =
  | { t: "hello"; v: 1; nonce: string }
  | { t: "snapshot"; v: 1; nonce: string; items: QueuedEvent[] }
  | { t: "event"; v: 1; seq: number; projectId: string; payload: unknown }
  | { t: "ping"; v: 1 } | { t: "pong"; v: 1 };
export type WallPortState =
  | { kind: "connecting"; attempt: number } | { kind: "linked"; nonce: string }
  | { kind: "resyncing"; nonce: string } | { kind: "unreachable"; reason: "NOT_LISTED" | "RETRIES_EXHAUSTED" };
export interface WallPortStats { reconnects: number; pings: number; snapshotsApplied: number; queueDropped: number }
export interface WallPort { start(): void; state(): WallPortState; stop(): void; stats(): WallPortStats }
export type DeviceAvailability = "available" | "downloadable" | "unavailable" | "unknown";
