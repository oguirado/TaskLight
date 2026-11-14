// Oracle helpers for U19: fake Clock / LocalStore / LedgerRemote and independent counting references.
import type { CapsuleState, PrivacyTier } from "../../../src/schema";
import type { Counts, DayLedger, InferenceEvent, LedgerRemote, LocalStore } from "../../../src/ledger";

export const flush = async (n = 6): Promise<void> => { for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0)); };
export const T0 = Date.parse("2026-03-01T10:00:00.000Z");
export const DAY0 = "2026-03-01";
export const TIERS: readonly PrivacyTier[] = ["private", "standard", "shared"];
export const COUNTERS = ["on_device", "in_cloud", "fallbacks", "refusals", "schema_rejects", "unattributed"] as const;
export type CounterName = (typeof COUNTERS)[number];

export const ev = (o: Partial<InferenceEvent> = {}): InferenceEvent => ({
  projectId: "p1", task: "summary", tier: "private", mode: "ONLY_ON_DEVICE", called: true, source: "ON_DEVICE", outcome: "ok", ...o,
});

export function zero(over: Partial<Record<CounterName, number>> = {}): Counts {
  return { on_device: 0, in_cloud: 0, fallbacks: 0, refusals: 0, schema_rejects: 0, unattributed: 0, ...over };
}
/** read counts for (project, tier) tolerating absent tiers */
export function countsOf(d: DayLedger, p: string, t: PrivacyTier): Counts {
  const row = (d.byProject as Record<string, Record<string, Counts> | undefined>)[p];
  return row?.[t] ?? zero();
}

export function makeClock(ms = T0) { const c = { ms, nowMs: () => c.ms }; return c; }

export function makeLocal(initial: DayLedger[] = []) {
  const s = { saves: [] as DayLedger[][], loadThrows: false, saveThrows: false, loadReturns: undefined as unknown, initial };
  const store: LocalStore = {
    load: () => { if (s.loadThrows) throw new Error("load boom"); return s.loadReturns !== undefined ? (s.loadReturns as DayLedger[]) : structuredClone(s.initial); },
    save: (d) => { if (s.saveThrows) throw new Error("save boom"); s.saves.push(structuredClone(d) as DayLedger[]); },
  };
  return { s, store, last: () => s.saves[s.saves.length - 1] };
}

export interface RemoteCall { dayKey: string; deltas: unknown; ok: boolean | null }
export function makeRemote() {
  const r = {
    calls: [] as RemoteCall[], mode: "ok" as "ok" | "reject" | "throw" | "manual",
    pending: [] as Array<{ resolve: () => void; reject: (e: unknown) => void; call: RemoteCall }>,
    rejectNext: 0,
  };
  const remote: LedgerRemote = {
    applyDeltas(dayKey, deltas) {
      const call: RemoteCall = { dayKey, deltas: structuredClone(deltas), ok: null };
      r.calls.push(call);
      if (r.mode === "throw") throw new Error("sync boom");
      if (r.rejectNext > 0) { r.rejectNext--; call.ok = false; return Promise.reject(new Error("remote rejected")); }
      if (r.mode === "reject") { call.ok = false; return Promise.reject(new Error("remote rejected")); }
      if (r.mode === "manual") return new Promise<void>((resolve, reject) => { r.pending.push({ resolve: () => { call.ok = true; resolve(); }, reject: (e) => { call.ok = false; reject(e); }, call }); });
      call.ok = true; return Promise.resolve();
    },
  };
  return { r, remote };
}

/** Flatten an applyDeltas payload into [project, tier, counter] -> n, tolerant to key encodings (nested or "tier.counter" / "tier/counter"). */
export function flattenDeltas(deltas: unknown): Array<{ project: string; tier: string; counter: string; n: number; leafOk: boolean }> {
  const out: Array<{ project: string; tier: string; counter: string; n: number; leafOk: boolean }> = [];
  const walk = (v: unknown, path: string[]) => {
    if (v !== null && typeof v === "object") { for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, [...path, k]); return; }
    const segs = path.flatMap((k, i) => (i === 0 ? [k] : k.split(/[./:|#]/)));
    const [project = "", ...rest] = segs;
    const tier = rest.find((s) => (TIERS as readonly string[]).includes(s)) ?? "";
    const counter = rest.find((s) => (COUNTERS as readonly string[]).includes(s)) ?? "";
    out.push({ project, tier, counter, n: typeof v === "number" ? v : NaN, leafOk: Number.isInteger(v) });
  };
  walk(deltas, []);
  return out;
}
export function sumDeltas(calls: readonly RemoteCall[], filter: (c: RemoteCall) => boolean = (c) => c.ok === true): Record<string, number> {
  const t: Record<string, number> = {};
  for (const c of calls.filter(filter)) for (const f of flattenDeltas(c.deltas)) { const k = `${c.dayKey}|${f.project}|${f.tier}|${f.counter}`; t[k] = (t[k] ?? 0) + f.n; }
  return t;
}

export const state = (over: Record<string, unknown> = {}): CapsuleState => ({
  lens_id: "dev", rev: 3, observed_rev: 3, status: "running", attention: "low", inference_source: "ON_DEVICE",
  updated_at: 1700000000000, writer_uid: "u1", headline: "HL-TEXT", summary: "SUM-TEXT", next_action: "NEXT-TEXT",
  ...over,
}) as CapsuleState;

export const day = (dayKey: string, byProject: Record<string, Partial<Record<PrivacyTier, Counts>>>): DayLedger =>
  ({ dayKey, byProject: byProject as DayLedger["byProject"] });
