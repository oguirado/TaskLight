// STUB (oracle phase U19): public types per SPEC_U19 section 2 and SPEC_AMEND_C (LedgerRow, G10).
import type { PrivacyTier, InferenceSource, TaskId } from "../schema";
import type { ModeName } from "../ai";
import type { LensId, LensMode, LensSource, LensTaskId } from "../lens";
import type { ScreenshotRefuse } from "../privacy/types";

export type LedgerCounter = "on_device" | "in_cloud" | "fallbacks" | "refusals" | "schema_rejects";
export type Outcome = "ok" | "schema_reject" | "refused" | "discarded" | "error";
export interface InferenceEvent {
  projectId: string; task: TaskId; tier: PrivacyTier; mode: ModeName;
  called: boolean;                 // U06 RunMeta.called
  source: InferenceSource | null;  // null = BAD_SOURCE or no call
  outcome: Outcome;
}
export type Counts = Readonly<Record<LedgerCounter, number>> & { readonly unattributed: number };
export interface DayLedger {
  dayKey: string;                                         // "YYYY-MM-DD" UTC
  byProject: Readonly<Record<string, Readonly<Record<PrivacyTier, Counts>>>>;
}
export interface Clock { nowMs(): number }
export interface LocalStore { load(): DayLedger[]; save(days: readonly DayLedger[]): void } // binding AUSENTE
export interface LedgerRemote {   // U14 binds via runTransaction on workspaces/{wsId}/ledger/{dayKey} [TARGET]
  applyDeltas(dayKey: string, deltas: Readonly<Record<string, Readonly<Record<string, number>>>>): Promise<void>;
}
export interface Ledger {
  record(ev: InferenceEvent): void;            // never throws
  day(dayKey?: string): DayLedger;
  flush(): Promise<{ written: boolean; pendingKeys: number }>;
  invalidEvents(): number;
}
export interface LedgerDeps {
  clock: Clock; local: LocalStore; remote?: LedgerRemote; retentionDays?: number; // 14 [TARGET-spec]
}

export type PrivacyVerdict = "zero_cloud" | "cloud_seen" | "unverifiable" | "not_private";
export interface PanelRow {
  projectId: string; tierNow: PrivacyTier; counts: Counts;
  verdict: PrivacyVerdict; tierChangedToday: boolean;
  screenshot: "enabled" | ScreenshotRefuse;
}
export interface PanelModel {
  dayKey: string; rows: readonly PanelRow[]; totals: Counts;
  syncState: "synced" | "pending" | "local_only";
}

// SPEC_AMEND_C B31/B32
export interface LedgerRow { jobKey: string; projectId: string; lens_id: LensId; task: LensTaskId;
  source: LensSource | null; tier: PrivacyTier; floor: LensMode | null; requested: LensMode;
  effective: LensMode; inference_source: InferenceSource | null; pack_hash?: string }
export type G10Violation = "CLOUD_UNDER_DEVICE_FLOOR" | "NON_DEVICE_UNDER_DEVICE_FLOOR" | "TEXT_SYNCED_PRIVATE" | "TEXT_SYNCED_PAGE";
export interface G10Result { ok: boolean; violations: { row: number; code: G10Violation }[] }
