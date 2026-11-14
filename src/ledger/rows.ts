import type { LensSource } from "../lens";
import type { PrivacyTier } from "../schema";
import type { G10Result, G10Violation, LedgerRow } from "./types";

export function checkG10(rows: readonly LedgerRow[]): G10Result {
  const violations: { row: number; code: G10Violation }[] = [];
  try {
    if (!Array.isArray(rows)) return { ok: true, violations: [] };
    for (let i = 0; i < rows.length; i++) {
      try {
        const row: unknown = rows[i] as unknown;
        if (row === null || typeof row !== "object") continue;
        const rec = row as Record<string, unknown>;
        if (rec["inference_source"] !== "IN_CLOUD") continue;
        if (rec["floor"] === "ONLY_ON_DEVICE" || rec["effective"] === "ONLY_ON_DEVICE") {
          violations.push({ row: i, code: "CLOUD_UNDER_DEVICE_FLOOR" });
        }
      } catch {
        continue;
      }
    }
  } catch {
    // never throw; report what was seen
  }
  return { ok: violations.length === 0, violations };
}

export interface RowLog {
  record(row: LedgerRow): void;
  rows(): readonly LedgerRow[];
  check(): G10Result;
}

const ROW_KEYS: readonly string[] = [
  "jobKey",
  "projectId",
  "lens_id",
  "task",
  "source",
  "tier",
  "floor",
  "requested",
  "effective",
  "inference_source",
  "pack_hash",
];

export function createRowLog(): RowLog {
  const stored: LedgerRow[] = [];
  const seen = new Set<string>();

  function record(row: LedgerRow): void {
    try {
      if (row === null || typeof row !== "object" || Array.isArray(row)) return;
      const rec = row as unknown as Record<string, unknown>;
      const jobKey: unknown = rec["jobKey"];
      if (typeof jobKey !== "string" || jobKey.length === 0) return;
      if (seen.has(jobKey)) return;
      const copy: Record<string, unknown> = {};
      for (const key of ROW_KEYS) {
        if (Object.hasOwn(rec, key)) {
          copy[key] = rec[key];
        }
      }
      seen.add(jobKey);
      stored.push(copy as unknown as LedgerRow);
    } catch {
      // never throws
    }
  }

  function rows(): readonly LedgerRow[] {
    return stored.map((r) => ({ ...(r as unknown as Record<string, unknown>) } as unknown as LedgerRow));
  }

  function check(): G10Result {
    return checkG10(rows());
  }

  return { record, rows, check };
}

export interface SyncedDoc {
  source: LensSource | null;
  tier: PrivacyTier;
  synced: Readonly<Record<string, unknown>>;
}

const TEXT_KEYS: readonly string[] = ["headline", "summary", "next_action", "steps"];
const PAGE_ALLOWED: ReadonlySet<string> = new Set<string>(["status", "attention", "progress"]);

export function checkSyncedText(docs: readonly SyncedDoc[]): G10Result {
  const violations: { row: number; code: G10Violation }[] = [];
  try {
    if (!Array.isArray(docs)) return { ok: true, violations: [] };
    for (let i = 0; i < docs.length; i++) {
      try {
        const doc: unknown = docs[i] as unknown;
        if (doc === null || typeof doc !== "object") continue;
        const rec = doc as Record<string, unknown>;
        const synced: unknown = rec["synced"];
        if (synced === null || typeof synced !== "object" || Array.isArray(synced)) continue;
        const keys = Object.keys(synced as Record<string, unknown>);
        const tier = rec["tier"] as string;
        const source = rec["source"] as string | null | undefined;
        const isPrivate = tier !== "standard" && tier !== "shared";
        if (isPrivate) {
          if (keys.some((k) => TEXT_KEYS.includes(k))) {
            violations.push({ row: i, code: "TEXT_SYNCED_PRIVATE" });
          }
          continue;
        }
        if (source === "page") {
          if (keys.some((k) => !PAGE_ALLOWED.has(k))) {
            violations.push({ row: i, code: "TEXT_SYNCED_PAGE" });
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // never throw
  }
  return { ok: violations.length === 0, violations };
}
