import type { CapsuleState, PrivacyTier } from "../schema";

export interface AuthPort { onUser(cb: (u: { uid: string } | null) => void): () => void } // from U22
export interface ProjectMeta { projectId: string; tier: PrivacyTier; name: string; source_kind: string; template_hash: string }
export interface PrivacyPorts {          // U19 syncProjection / guardSyncWrite
  project(s: CapsuleState, tier: PrivacyTier): unknown;
  guard(s: unknown, tier: PrivacyTier): { ok: true; value: Record<string, unknown> } | { ok: false };
}
export interface DigestIn {               // subset of U17 DigestRecord
  revVector: Readonly<Record<string, number>>; needs_you: readonly { projectId: string }[];
  brief: string; origin: "ON_DEVICE" | "IN_CLOUD" | "LOCAL_SERVER" | "REMOTE_PROVIDER" | "LOCAL_RULES"; prompt_version: string; builtAt: number;
}
export interface LedgerRemote {           // U19 port
  applyDeltas(dayKey: string, deltas: Readonly<Record<string, Readonly<Record<string, number>>>>): Promise<void>;
}
export type RefuseCode = "LOCAL_ONLY" | "NO_META" | "GUARD_REJECT" | "STATUS_NOT_SYNCABLE" | "OUTBOX_FULL"
  | "ID_COLLISION" | "DIGEST_LOCAL_ORIGIN" | "DIGEST_HAS_PRIVATE" | "DIGEST_OVERSIZE"
  | "DIGEST_BAD_ORIGIN" | "DIGEST_REMOTE_SHARED";
export type Ack = { ok: true; outcome: "queued" | "coalesced" } | { ok: false; code: RefuseCode };
export interface SyncStatus {
  state: "local_only" | "pending" | "synced";     // = U19 PanelModel.syncState
  detail: "DISABLED" | "NO_FIREBASE" | "NO_USER" | "OFFLINE" | "BACKOFF" | null;
  pending: number;
  counters: { written: number; denied: number; conflicts: number; droppedFields: number };
}
export interface Sync {
  putCapsule(projectId: string, s: CapsuleState): Ack;
  setTier(projectId: string, latest: CapsuleState | null): Ack;
  putDigest(d: DigestIn): Ack;
  readonly ledger: LedgerRemote;
  status(): SyncStatus;
  onStatus(cb: (s: SyncStatus) => void): () => void;
  flush(): Promise<SyncStatus>;                   // never rejects
  dispose(): Promise<void>;
}
