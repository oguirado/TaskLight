import type { PrivacyTier } from "../schema";
import type {
  Counts,
  DayLedger,
  InferenceEvent,
  Ledger,
  LedgerDeps,
  LocalStore,
} from "./types";
import {
  addDelta,
  buildDeltasForDay,
  countPendingKeys,
  mergePendingInto,
} from "./flush";
import type { PendingDeltas } from "./flush";

const TIERS: readonly string[] = ["private", "standard", "shared"];
const MODES: ReadonlySet<string> = new Set<string>([
  "PREFER_ON_DEVICE",
  "ONLY_ON_DEVICE",
  "PREFER_IN_CLOUD",
  "ONLY_IN_CLOUD",
]);
const TASKS: ReadonlySet<string> = new Set<string>([
  "status",
  "summary",
  "next_action",
  "screenshot",
  "digest",
  "plan",
]);
const OUTCOMES: ReadonlySet<string> = new Set<string>([
  "ok",
  "schema_reject",
  "refused",
  "discarded",
  "error",
]);
const COUNTER_KEYS: readonly string[] = [
  "on_device",
  "in_cloud",
  "fallbacks",
  "refusals",
  "schema_rejects",
  "unattributed",
];

type MutableCounts = {
  on_device: number;
  in_cloud: number;
  fallbacks: number;
  refusals: number;
  schema_rejects: number;
  unattributed: number;
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function zeroCounts(): MutableCounts {
  return {
    on_device: 0,
    in_cloud: 0,
    fallbacks: 0,
    refusals: 0,
    schema_rejects: 0,
    unattributed: 0,
  };
}

function toCounts(m: MutableCounts): Counts {
  return {
    on_device: m.on_device,
    in_cloud: m.in_cloud,
    fallbacks: m.fallbacks,
    refusals: m.refusals,
    schema_rejects: m.schema_rejects,
    unattributed: m.unattributed,
  };
}

function isValidDayKey(s: unknown): s is string {
  if (typeof s !== "string" || !DAY_RE.test(s)) return false;
  return !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
}

function dayKeyOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayMsOf(dayKey: string): number {
  return Date.parse(`${dayKey}T00:00:00.000Z`);
}

function sanitizeCounts(raw: unknown): MutableCounts {
  if (!isPlainObject(raw)) return zeroCounts();
  const out = zeroCounts();
  for (const key of COUNTER_KEYS) {
    const v: unknown = raw[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[key as keyof MutableCounts] = Math.max(0, Math.floor(v));
    }
  }
  return out;
}

export function createLedger(deps: LedgerDeps): Ledger {
  const retention =
    typeof deps.retentionDays === "number" &&
    Number.isFinite(deps.retentionDays) &&
    Number.isInteger(deps.retentionDays) &&
    (deps.retentionDays as number) > 0
      ? (deps.retentionDays as number)
      : 14;

  const counts = new Map<string, Map<string, Map<string, MutableCounts>>>();
  let pending: PendingDeltas = new Map();
  let invalid = 0;

  function ensureBucket(dayKey: string, projectId: string, tier: string): MutableCounts {
    let day = counts.get(dayKey);
    if (day === undefined) {
      day = new Map();
      counts.set(dayKey, day);
    }
    let project = day.get(projectId);
    if (project === undefined) {
      project = new Map();
      day.set(projectId, project);
    }
    let bucket = project.get(tier);
    if (bucket === undefined) {
      bucket = zeroCounts();
      project.set(tier, bucket);
    }
    return bucket;
  }

  function snapshotDay(dayKey: string): DayLedger {
    const day = counts.get(dayKey);
    const byProject: Record<string, Record<string, Counts>> = {};
    if (day !== undefined) {
      for (const [projectId, tierMap] of day.entries()) {
        const rec: Record<string, Counts> = {};
        for (const [tier, bucket] of tierMap.entries()) {
          rec[tier] = toCounts(bucket);
        }
        byProject[projectId] = rec;
      }
    }
    return { dayKey, byProject } as DayLedger;
  }

  function snapshotDays(): DayLedger[] {
    return [...counts.keys()].sort().map((k) => snapshotDay(k));
  }

  function persist(): void {
    try {
      const days = snapshotDays();
      deps.local.save(days);
    } catch {
      // local failure never reaches the caller (memory stays authoritative)
    }
  }

  function prune(currentDayKey: string): void {
    try {
      const cutoff = dayMsOf(currentDayKey) - (retention - 1) * 86400000;
      for (const dk of [...counts.keys()]) {
        if (!isValidDayKey(dk) || dayMsOf(dk) < cutoff) {
          counts.delete(dk);
          pending.delete(dk);
        }
      }
    } catch {
      // pruning must never throw
    }
  }

  // Restore from local store, tolerating failures and garbage.
  try {
    const loaded: unknown = deps.local.load();
    if (Array.isArray(loaded)) {
      for (const entry of loaded as unknown[]) {
        try {
          if (!isPlainObject(entry)) continue;
          const dk: unknown = entry["dayKey"];
          const bp: unknown = entry["byProject"];
          if (!isValidDayKey(dk)) continue;
          if (!isPlainObject(bp)) continue;
          for (const [projectId, tierMap] of Object.entries(bp)) {
            if (!isPlainObject(tierMap)) continue;
            for (const [tierStr, c] of Object.entries(tierMap)) {
              if (!TIERS.includes(tierStr)) continue;
              const bucket = ensureBucket(dk, projectId, tierStr);
              const clean = sanitizeCounts(c);
              for (const key of COUNTER_KEYS) {
                bucket[key as keyof MutableCounts] += clean[key as keyof MutableCounts];
              }
            }
          }
        } catch {
          continue;
        }
      }
      // Prune loaded overflow relative to the latest day present.
      const keys = [...counts.keys()].filter((k) => isValidDayKey(k)).sort();
      const latest = keys[keys.length - 1];
      if (latest !== undefined) prune(latest);
    }
  } catch {
    // load failure: start empty
    counts.clear();
  }

  function record(ev: InferenceEvent): void {
    try {
      if (!isPlainObject(ev)) {
        invalid++;
        persist();
        return;
      }
      const e = ev as unknown as Record<string, unknown>;
      const projectId: unknown = e["projectId"];
      const task: unknown = e["task"];
      const tier: unknown = e["tier"];
      const mode: unknown = e["mode"];
      const called: unknown = e["called"];
      const source: unknown = e["source"];
      const outcome: unknown = e["outcome"];

      const malformed =
        typeof projectId !== "string" ||
        projectId.length === 0 ||
        typeof task !== "string" ||
        !TASKS.has(task) ||
        typeof tier !== "string" ||
        !TIERS.includes(tier) ||
        typeof mode !== "string" ||
        !MODES.has(mode) ||
        typeof called !== "boolean" ||
        !(source === null || source === "ON_DEVICE" || source === "IN_CLOUD") ||
        typeof outcome !== "string" ||
        !OUTCOMES.has(outcome) ||
        (called === false && source !== null) ||
        (outcome === "refused" && called !== false);

      if (malformed) {
        invalid++;
        persist();
        return;
      }

      let dayKey: string;
      try {
        const now: unknown = deps.clock.nowMs();
        if (typeof now !== "number" || !Number.isFinite(now)) {
          invalid++;
          persist();
          return;
        }
        dayKey = dayKeyOf(now);
        if (!isValidDayKey(dayKey)) {
          invalid++;
          persist();
          return;
        }
      } catch {
        invalid++;
        persist();
        return;
      }

      const pid = projectId as string;
      const tierStr = tier as string;
      const modeStr = mode as string;
      const sourceStr = source as string | null;
      const outcomeStr = outcome as string;
      const calledBool = called as boolean;

      const bucket = ensureBucket(dayKey, pid, tierStr);
      if (sourceStr === "ON_DEVICE") {
        bucket.on_device++;
        addDelta(pending, dayKey, pid, tierStr, "on_device");
      }
      if (sourceStr === "IN_CLOUD") {
        bucket.in_cloud++;
        addDelta(pending, dayKey, pid, tierStr, "in_cloud");
      }
      if (outcomeStr === "schema_reject") {
        bucket.schema_rejects++;
        addDelta(pending, dayKey, pid, tierStr, "schema_rejects");
      }
      if (outcomeStr === "refused") {
        bucket.refusals++;
        addDelta(pending, dayKey, pid, tierStr, "refusals");
      }
      if (
        (modeStr === "PREFER_ON_DEVICE" && sourceStr === "IN_CLOUD") ||
        (modeStr === "PREFER_IN_CLOUD" && sourceStr === "ON_DEVICE")
      ) {
        bucket.fallbacks++;
        addDelta(pending, dayKey, pid, tierStr, "fallbacks");
      }
      if (
        calledBool === true &&
        sourceStr === null &&
        !(modeStr === "ONLY_ON_DEVICE" && outcomeStr === "error")
      ) {
        bucket.unattributed++;
        addDelta(pending, dayKey, pid, tierStr, "unattributed");
      }
      prune(dayKey);
      persist();
    } catch {
      // record never throws
    }
  }

  function day(dayKey?: string): DayLedger {
    try {
      let key: string;
      if (typeof dayKey === "string" && dayKey.length > 0) {
        key = dayKey;
      } else {
        const now: unknown = deps.clock.nowMs();
        if (typeof now !== "number" || !Number.isFinite(now)) {
          return { dayKey: "", byProject: {} } as DayLedger;
        }
        key = dayKeyOf(now);
      }
      return snapshotDay(key);
    } catch {
      return { dayKey: "", byProject: {} } as DayLedger;
    }
  }

  async function flush(): Promise<{ written: boolean; pendingKeys: number }> {
    const remote = deps.remote;
    if (remote === undefined) {
      return { written: false, pendingKeys: countPendingKeys(pending) };
    }
    const toSend: PendingDeltas = pending;
    pending = new Map();
    if (countPendingKeys(toSend) === 0) {
      return { written: false, pendingKeys: 0 };
    }
    const dayKeys = [...toSend.keys()].sort();
    let anyWritten = false;
    for (const dk of dayKeys) {
      const dayMap = toSend.get(dk);
      if (dayMap === undefined) continue;
      const payload = buildDeltasForDay(dayMap);
      if (Object.keys(payload).length === 0) continue;
      try {
        await remote.applyDeltas(dk, payload);
        anyWritten = true;
      } catch {
        const requeue: PendingDeltas = new Map();
        requeue.set(dk, dayMap);
        mergePendingInto(pending, requeue);
      }
    }
    return { written: anyWritten, pendingKeys: countPendingKeys(pending) };
  }

  function invalidEvents(): number {
    return invalid;
  }

  return { record, day, flush, invalidEvents };
}
