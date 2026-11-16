// U14 oracle harness: in-memory FirestorePort with rules-like commit checks, fake auth, manual clock.
import type { CapsuleState, PrivacyTier } from "../../../src/schema";
import {
  createSync, SYNC_KEYS,
  type AuthPort, type FirestorePort, type FsErrorKind, type FsTxn, type PrivacyPorts,
  type ProjectMeta, type Sync,
} from "../../../src/sync";

export const settle = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

export function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

export class FakeClock {
  t = 1_700_000_000_000;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private seq = 0;
  nowMs = (): number => this.t;
  setTimer = (ms: number, fn: () => void): (() => void) => {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + Math.max(0, ms), fn });
    return () => { this.timers = this.timers.filter((x) => x.id !== id); };
  };
  timerCount(): number { return this.timers.length; }
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    await settle();
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x.id !== due.id);
      this.t = Math.max(this.t, due.at);
      due.fn();
      await settle();
    }
    this.t = target;
    await settle();
  }
}

export class FsErr extends Error {
  constructor(public kind: FsErrorKind) { super(`fs:${kind}`); }
}
export interface TsMark { __ts: number }
export const isTs = (v: unknown): v is TsMark =>
  typeof v === "object" && v !== null && typeof (v as TsMark).__ts === "number";

export interface SetRec { path: string; segs: string[]; data: Record<string, unknown>; extraArgs: number; txn: number }
export type FsMode = "ok" | "offline" | "throw" | "reject" | "hang";

const key = (p: readonly string[]): string => p.join("/");
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const hasOnly = (d: Record<string, unknown>, ks: readonly string[]): boolean => Object.keys(d).every((k) => ks.includes(k));
const hasAll = (d: Record<string, unknown>, ks: readonly string[]): boolean => ks.every((k) => k in d);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

export class FakeFs implements FirestorePort {
  store = new Map<string, Record<string, unknown>>();
  attempted: SetRec[] = [];     // every set a transaction tried to commit (even if rejected)
  log: SetRec[] = [];           // committed sets, in order
  txnCalls = 0;
  capsuleCommits = 0;           // commit attempts that contained a capsule path
  activeTxns = 0; maxActive = 0;
  timestampCalls = 0; classifyCalls = 0;
  mode: FsMode = "ok";
  denyCapsule = 0;              // commits containing a capsule set that are denied (Infinity = all)
  onGet: ((k: string, n: number, store: Map<string, Record<string, unknown>>) => void) | null = null;
  gate: Promise<void> | null = null;      // first txn awaits this before committing
  private reads = new Map<string, number>();
  private txnSeq = 0;
  attemptTimes: number[] = [];
  constructor(private nowMs: () => number = () => 0) {}

  timestamp = (ms: number): TsMark => { this.timestampCalls++; return { __ts: ms }; };
  classify = (e: unknown): FsErrorKind => { this.classifyCalls++; return e instanceof FsErr ? e.kind : "other"; };

  seedWorkspace(uid: string, members: Record<string, string> = { [uid]: "owner" }): void {
    this.store.set(`workspaces/${uid}`, { name: "personal", members });
  }
  seedProject(uid: string, rid: string, tier: PrivacyTier, createdAt: unknown = { __ts: 1 }): void {
    this.store.set(`workspaces/${uid}/projects/${rid}`,
      { name: "seed", source_kind: "claude_code", privacy_tier: tier, template_hash: "th0", created_at: createdAt });
  }
  seedCapsule(uid: string, rid: string, doc: Record<string, unknown>): void {
    this.store.set(`workspaces/${uid}/capsules/${rid}`, doc);
  }
  committedTo(kind: "workspaces" | "projects" | "capsules" | "digests" | "ledger"): SetRec[] {
    return this.log.filter((r) => (kind === "workspaces" ? r.segs.length === 2 : r.segs[2] === kind));
  }
  attemptedTo(kind: "capsules" | "projects" | "digests" | "ledger"): SetRec[] {
    return this.attempted.filter((r) => r.segs[2] === kind);
  }
  calls(): number { return this.txnCalls + this.timestampCalls + this.classifyCalls; }

  async txn<T>(fn: (tx: FsTxn) => Promise<T>): Promise<T> {
    this.txnCalls++;
    this.attemptTimes.push(this.nowMs());
    if (this.mode === "offline") throw new FsErr("unavailable");
    if (this.mode === "throw") throw new Error("sync-throw");
    if (this.mode === "reject") return Promise.reject("plain-string-rejection");
    if (this.mode === "hang") return new Promise<T>(() => undefined);
    const id = ++this.txnSeq;
    this.activeTxns++; this.maxActive = Math.max(this.maxActive, this.activeTxns);
    try {
      const sets: { p: string[]; d: Record<string, unknown>; extra: number }[] = [];
      const tx = {
        get: async (p: readonly string[]) => {
          const k = key(p);
          const n = (this.reads.get(k) ?? 0) + 1; this.reads.set(k, n);
          const v = this.store.get(k);
          const out = v ? clone(v) : null;
          this.onGet?.(k, n, this.store);
          return out;
        },
        set: (p: readonly string[], d: Record<string, unknown>, ...rest: unknown[]) => {
          sets.push({ p: [...p], d: clone(d), extra: rest.length });
        },
      } as FsTxn;
      const r = await fn(tx);
      if (this.gate) { const g = this.gate; this.gate = null; await g; }
      await Promise.resolve();
      const recs = sets.map((s) => ({ path: key(s.p), segs: s.p, data: s.d, extraArgs: s.extra, txn: id }));
      this.attempted.push(...recs);
      this.commit(recs);
      return r;
    } finally { this.activeTxns--; }
  }

  private commit(recs: SetRec[]): void {
    if (recs.some((r) => r.segs[2] === "capsules")) {
      this.capsuleCommits++;
      if (this.denyCapsule > 0) { this.denyCapsule--; throw new FsErr("denied"); }
    }
    const work = new Map(this.store);
    for (const r of recs) {
      if (!this.rulesOk(r, work)) throw new FsErr("denied");
      work.set(r.path, clone(r.data));
    }
    this.store = work;
    this.log.push(...recs);
  }

  private rulesOk(r: SetRec, w: Map<string, Record<string, unknown>>): boolean {
    const s = r.segs, d = r.data, uid = s[1];
    if (r.extraArgs !== 0) return false;                                  // merge/options never allowed
    if (s.length === 2 && s[0] === "workspaces") {
      const m = d.members as Record<string, unknown> | undefined;
      return !w.has(r.path) && hasOnly(d, ["name", "members"]) && hasAll(d, ["name", "members"])
        && !!m && Object.keys(m).length === 1 && m[s[1] ?? ""] === "owner";
    }
    if (s.length !== 4 || s[0] !== "workspaces" || !uid || !w.has(`workspaces/${uid}`)) return false;
    const prev = w.get(r.path);
    switch (s[2]) {
      case "projects":
        return hasOnly(d, ["name", "source_kind", "privacy_tier", "template_hash", "created_at"])
          && hasAll(d, ["name", "source_kind", "privacy_tier", "template_hash", "created_at"])
          && ["private", "standard", "shared"].includes(String(d.privacy_tier));
      case "capsules": {
        const proj = w.get(`workspaces/${uid}/projects/${s[3]}`);
        if (!proj) return false;
        const priv = proj.privacy_tier === "private";
        const allowed = priv ? SYNC_KEYS.CAPSULE_PRIVATE : SYNC_KEYS.CAPSULE_FULL;
        const sz = (k: string): number => (typeof d[k] === "string" ? (d[k] as string).length : 0);
        return hasOnly(d, allowed) && hasAll(d, ["rev", "status", "writer_uid"])
          && isInt(d.rev) && d.rev === (isInt(prev?.rev) ? prev.rev : 0) + 1
          && (SYNC_KEYS.RULES_STATUS as readonly string[]).includes(String(d.status))
          && isInt(d.observed_rev) && d.observed_rev >= 0
          && sz("headline") <= 120 && sz("summary") <= 600 && sz("next_action") <= 120
          && (!("inference_source" in d) || ["ON_DEVICE", "IN_CLOUD", "LOCAL_SERVER", "REMOTE_PROVIDER"].includes(d.inference_source)) /* A-U46b: mirrors firestore.rules:36 */;
      }
      case "digests":
        return !prev && hasOnly(d, ["rev_vector", "needs_you", "brief", "inference_source", "created_at"])
          && hasAll(d, ["rev_vector", "needs_you", "brief", "inference_source", "created_at"])
          && ["ON_DEVICE", "IN_CLOUD", "LOCAL_SERVER", "REMOTE_PROVIDER"].includes(d.inference_source) /* A-U46b: mirrors firestore.rules:54 */
          && typeof d.brief === "string" && d.brief.length <= 600;
      case "ledger": {
        const ks = SYNC_KEYS.LEDGER;
        if (!hasOnly(d, ks) || !hasAll(d, ks)) return false;
        if (!ks.every((k) => isInt(d[k]) && (d[k] as number) >= 0)) return false;
        return !prev || ks.every((k) => (d[k] as number) >= (prev[k] as number));
      }
      default: return false;
    }
  }
}

export class FakeAuth implements AuthPort {
  private cbs = new Set<(u: { uid: string } | null) => void>();
  constructor(public user: { uid: string } | null) {}
  onUser = (cb: (u: { uid: string } | null) => void): (() => void) => {
    this.cbs.add(cb); cb(this.user);
    return () => { this.cbs.delete(cb); };
  };
  emit(u: { uid: string } | null): void { this.user = u; [...this.cbs].forEach((cb) => cb(u)); }
  listeners(): number { return this.cbs.size; }
}

const TEXT_KEYS = ["headline", "summary", "next_action", "steps"];
export const KNOWN_STATE_KEYS = [...SYNC_KEYS.CAPSULE_FULL, "lens_id", "steps", "progress"];

export const cap = (over: Partial<CapsuleState> & Record<string, unknown> = {}): CapsuleState => ({
  lens_id: "dev", rev: 77, observed_rev: 5, status: "running",
  headline: "HDLN_SECRET", summary: "SUMM_SECRET", next_action: "NEXT_SECRET",
  steps: [{ text: "STEP_SECRET", state: "todo" }], progress: 0.5,
  attention: "low", inference_source: "ON_DEVICE", updated_at: 1_700_000_000_000, writer_uid: "local-x",
  ...over,
}) as CapsuleState;

export interface EnvOpts {
  user?: string | null; tiers?: Record<string, PrivacyTier>; enabled?: boolean; fsNull?: boolean;
  hash32?: (s: string) => string; guardReject?: boolean; metaName?: string;
}
export interface Env {
  sync: Sync; fs: FakeFs; auth: FakeAuth; clock: FakeClock; tiers: Record<string, PrivacyTier>;
  privacyLog: string[]; ridOf(projectId: string): string;
}
export function makeEnv(o: EnvOpts = {}): Env {
  const clock = new FakeClock();
  const fs = new FakeFs(clock.nowMs);
  const auth = new FakeAuth(o.user === undefined ? { uid: "u1" } : o.user === null ? null : { uid: o.user });
  const tiers: Record<string, PrivacyTier> = o.tiers ?? { p1: "standard" };
  const hash32 = o.hash32 ?? fnv1a32;
  const privacyLog: string[] = [];
  const privacy: PrivacyPorts = {
    // Deliberately LEAKY: project() returns the state verbatim so U14's own allowlist is what must strip text/raw keys.
    project: (s, tier) => { privacyLog.push(`project:${tier}`); return { ...s }; },
    guard: (s, tier) => {
      privacyLog.push(`guard:${tier}`);
      if (o.guardReject) return { ok: false };
      const v = s as Record<string, unknown>;
      if (Object.keys(v).some((k) => !KNOWN_STATE_KEYS.includes(k))) return { ok: false };
      return { ok: true, value: { ...v } };
    },
  };
  const meta = (id: string): ProjectMeta | null => {
    const tier = tiers[id];
    return tier ? { projectId: id, tier, name: o.metaName ?? "Display Name", source_kind: "claude_code", template_hash: "th0" } : null;
  };
  const sync = createSync({
    auth, fs: o.fsNull ? null : fs, privacy, meta, hash32, clock,
    ...(o.enabled === undefined ? {} : { enabled: o.enabled }),
  });
  return { sync, fs, auth, clock, tiers, privacyLog, ridOf: (id) => "p_" + hash32(id) };
}

/** Resolve a promise that may need timer progress (rate limit/backoff) by stepping the manual clock. */
export async function drive<T>(clock: FakeClock, p: Promise<T>, maxMs = 40_000): Promise<T> {
  let done = false; let val: T | undefined; let err: unknown; let failed = false;
  p.then((v) => { done = true; val = v; }, (e) => { done = true; failed = true; err = e; });
  for (let t = 0; !done && t <= maxMs; t += 100) await clock.advance(100);
  await settle();
  if (!done) throw new Error("drive: promise never settled");
  if (failed) throw err;
  return val as T;
}

/** Drain the outbox: advance past any backoff / rate-limit then flush, until pending 0 (max rounds). */
export async function drain(env: Env, rounds = 6, step = 30_001): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await env.sync.flush();
    if (env.sync.status().pending === 0) return;
    await env.clock.advance(step);
  }
  await env.sync.flush();
}

export const B4_KINDS = new Set(["projects", "capsules", "digests", "ledger"]);
/** B4: every attempted path is workspaces/{uid} or one of its 4 child collections. */
export function assertB4Paths(fs: FakeFs, uids: string[]): string[] {
  const bad: string[] = [];
  for (const r of fs.attempted) {
    const s = r.segs;
    const ok = s[0] === "workspaces" && !!s[1] && uids.includes(s[1])
      && (s.length === 2 || (s.length === 4 && B4_KINDS.has(s[2] ?? "") && !!s[3]));
    if (!ok) bad.push(r.path);
  }
  return bad;
}
export const textLeaks = (fs: FakeFs, needles: string[]): string[] =>
  fs.attempted.flatMap((r) => needles.filter((n) => JSON.stringify(r.data).includes(n) || r.path.includes(n)));
export const TEXT_MARKERS = ["HDLN_SECRET", "SUMM_SECRET", "NEXT_SECRET", "STEP_SECRET"];
export { TEXT_KEYS };
