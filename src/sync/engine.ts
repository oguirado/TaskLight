// U14 auth->sync policy engine (SPEC U14 §3). Fail-closed, generation-guarded, serial flush.

import type { CapsuleState, PrivacyTier } from "../schema";
import type { FirestorePort, FsErrorKind } from "./ports";
import { SYNC_KEYS, SYNC_LIMITS } from "./limits";
import { canonicalDigest, didOf, ridOf } from "./docs";
import type {
  Ack, AuthPort, DigestIn, PrivacyPorts, ProjectMeta, RefuseCode, Sync, SyncStatus,
} from "./types";

export interface SyncDeps {
  auth: AuthPort;
  fs: FirestorePort | null;
  privacy: PrivacyPorts;
  meta(projectId: string): ProjectMeta | null;
  hash32(s: string): string;
  clock: { nowMs(): number; setTimer(ms: number, fn: () => void): () => void };
  enabled?: boolean;
}

interface CapsuleEntry {
  kind: "capsule";
  key: string;
  projectId: string;
  rid: string;
  tier: PrivacyTier;
  observedRev: number;
  status: string;
  attention: unknown;
  headline: string | undefined;
  summary: string | undefined;
  nextAction: string | undefined;
  inferenceSource: string | undefined;
  meta: ProjectMeta;
  forceProject: boolean;
  onlyProject: boolean;
  nextAttemptMs: number;
  backoffCount: number;
}

interface DigestEntry {
  kind: "digest";
  key: string;
  did: string;
  revVectorRid: Record<string, number>;
  needsYouRid: string[];
  brief: string;
  inferenceSource: string;
  builtAt: number;
  nextAttemptMs: number;
  backoffCount: number;
}

type Entry = CapsuleEntry | DigestEntry;

interface StoredCapsule {
  key: string;
  projectId: string;
  rid: string;
  tier: PrivacyTier;
  observedRev: number;
  status: string;
  attention: unknown;
  headline: string | undefined;
  summary: string | undefined;
  nextAction: string | undefined;
  inferenceSource: string | undefined;
  meta: ProjectMeta;
  forceProject: boolean;
}

interface TxnResult {
  conflict: boolean;
  wrote: boolean;
}

type AttemptOutcome = "done" | "transient";

export function createSync(d: SyncDeps): Sync {
  const enabledFlag = d.enabled ?? true;
  const fsPort: FirestorePort | null = d.fs;

  let uid: string | null = null;
  let initialized = false;
  let generation = 0;
  let disposed = false;

  const counters = { written: 0, denied: 0, conflicts: 0, droppedFields: 0 };
  const outbox = new Map<string, Entry>();
  const lastCapsule = new Map<string, StoredCapsule | null>();
  const ridOwner = new Map<string, string>();
  const lastWriteMs = new Map<string, number>();
  const timeoutCancels = new Set<() => void>();
  const listeners = new Set<(s: SyncStatus) => void>();
  let lastNotified = "";
  let activePromise: Promise<SyncStatus> | null = null;
  let activeGen = -1;
  let unsub: () => void = () => undefined;

  const localDetail = (): SyncStatus["detail"] => {
    if (disposed) return null;
    if (!enabledFlag) return "DISABLED";
    if (fsPort === null) return "NO_FIREBASE";
    if (uid === null) return "NO_USER";
    return null;
  };

  const isLocalOnly = (): boolean => disposed || localDetail() !== null;

  const status = (): SyncStatus => {
    const pending = outbox.size;
    const snap = {
      pending,
      counters: { ...counters },
      detail: null as SyncStatus["detail"],
      state: "synced" as SyncStatus["state"],
    };
    if (isLocalOnly()) {
      snap.detail = localDetail();
      snap.state = "local_only";
      return snap;
    }
    if (pending === 0) return snap;
    snap.state = "pending";
    const now = d.clock.nowMs();
    let backoff = false;
    for (const e of outbox.values()) {
      if (e.nextAttemptMs > now) backoff = true;
    }
    snap.detail = backoff ? "BACKOFF" : "OFFLINE";
    return snap;
  };

  const notify = (): void => {
    const s = status();
    const j = JSON.stringify(s);
    if (j === lastNotified) return;
    lastNotified = j;
    for (const cb of [...listeners]) {
      try { cb(s); } catch { /* listener faults never break sync */ }
    }
  };

  const refuse = (code: RefuseCode): Ack => ({ ok: false, code });
  const RULES: readonly string[] = SYNC_KEYS.RULES_STATUS;
  const LEDGER_SET = new Set<string>(SYNC_KEYS.LEDGER);

  const cancelAllTimers = (): void => {
    for (const c of [...timeoutCancels]) {
      try { c(); } catch { /* already fired */ }
    }
    timeoutCancels.clear();
  };

  const requeueLatest = (newUid: string): void => {
    for (const [projectId, rec] of lastCapsule) {
      if (rec === null) continue;
      const ownerKey = `${newUid}\0${rec.rid}`;
      const owner = ridOwner.get(ownerKey);
      if (owner !== undefined && owner !== projectId) continue;
      ridOwner.set(ownerKey, projectId);
      const entry: CapsuleEntry = {
        kind: "capsule",
        key: rec.key,
        projectId: rec.projectId,
        rid: rec.rid,
        tier: rec.tier,
        observedRev: rec.observedRev,
        status: rec.status,
        attention: rec.attention,
        headline: rec.headline,
        summary: rec.summary,
        nextAction: rec.nextAction,
        inferenceSource: rec.inferenceSource,
        meta: rec.meta,
        forceProject: true,
        onlyProject: false,
        nextAttemptMs: 0,
        backoffCount: 0,
      };
      outbox.set(entry.key, entry);
    }
  };

  const onUserCb = (u: { uid: string } | null): void => {
    if (disposed) return;
    const newUid = u === null ? null : u.uid;
    if (!initialized) {
      uid = newUid;
      initialized = true;
      notify();
      return;
    }
    if (newUid === uid) return;
    uid = newUid;
    generation++;
    outbox.clear();
    cancelAllTimers();
    if (newUid !== null) requeueLatest(newUid);
    notify();
  };

  unsub = d.auth.onUser(onUserCb);

  const eligible = (e: Entry): boolean => {
    const now = d.clock.nowMs();
    if (e.nextAttemptMs > now) return false;
    if (e.kind === "capsule") {
      const lw = lastWriteMs.get(`${uid ?? ""}\0${e.rid}`);
      if (lw !== undefined && now - lw < SYNC_LIMITS.MIN_INTERVAL_MS) return false;
    }
    return true;
  };

  const classifyErr = (e: unknown): FsErrorKind => {
    try {
      return fsPort === null ? "other" : fsPort.classify(e);
    } catch {
      return "other";
    }
  };

  type TxnRace<T> = { kind: "value"; v: T } | { kind: "error"; e: unknown } | { kind: "timeout" };

  const withTimeoutRace = async <T>(p: Promise<T>): Promise<TxnRace<T>> => {
    const holder: { cancel: () => void } = { cancel: () => undefined };
    const timer = new Promise<{ kind: "timeout" }>((resolve) => {
      holder.cancel = d.clock.setTimer(SYNC_LIMITS.TXN_TIMEOUT_MS, () => {
        resolve({ kind: "timeout" });
      });
    });
    const cancel: () => void = () => holder.cancel();
    timeoutCancels.add(cancel);
    try {
      return await Promise.race<TxnRace<T>>([
        p.then(
          (v): TxnRace<T> => ({ kind: "value", v }),
          (e: unknown): TxnRace<T> => ({ kind: "error", e }),
        ),
        timer.then((t): TxnRace<T> => t),
      ]);
    } finally {
      try { cancel(); } catch { /* fired */ }
      timeoutCancels.delete(cancel);
    }
  };

  const armBackoff = (e: Entry): void => {
    const delay = Math.min(
      SYNC_LIMITS.BACKOFF_MIN_MS * 2 ** e.backoffCount,
      SYNC_LIMITS.BACKOFF_MAX_MS,
    );
    e.backoffCount++;
    e.nextAttemptMs = d.clock.nowMs() + delay;
  };

  const deleteIfCurrent = (entry: Entry): void => {
    if (outbox.get(entry.key) === entry) outbox.delete(entry.key);
  };

  const buildCapsuleDoc = (e: CapsuleEntry, attemptUid: string, remoteRev: number): Record<string, unknown> => {
    const doc: Record<string, unknown> = {
      rev: remoteRev + 1,
      observed_rev: e.observedRev,
      status: e.status,
      updated_at: fsPort === null ? d.clock.nowMs() : fsPort.timestamp(d.clock.nowMs()),
      writer_uid: attemptUid,
    };
    if (e.attention !== undefined) doc["attention"] = e.attention;
    if (e.tier !== "private") {
      if (e.headline !== undefined) doc["headline"] = e.headline;
      if (e.summary !== undefined) doc["summary"] = e.summary;
      if (e.nextAction !== undefined) doc["next_action"] = e.nextAction;
      if (e.inferenceSource !== undefined) doc["inference_source"] = e.inferenceSource;
    }
    return doc;
  };

  const buildProjectDoc = (
    e: CapsuleEntry, attemptUid: string, prev: Record<string, unknown> | null,
  ): Record<string, unknown> => {
    const created = prev !== null && prev["created_at"] !== undefined
      ? prev["created_at"]
      : (fsPort === null ? d.clock.nowMs() : fsPort.timestamp(d.clock.nowMs()));
    return {
      name: e.tier === "private" ? e.rid : e.meta.name,
      source_kind: e.meta.source_kind,
      privacy_tier: e.tier,
      template_hash: e.meta.template_hash,
      created_at: created,
    };
  };

  const runTxn = async (genAtStart: number, attemptUid: string, entry: Entry): Promise<TxnRace<TxnResult>> => {
    const fs = fsPort;
    if (fs === null) return { kind: "error", e: new Error("NO_FIREBASE") };
    const run = (): Promise<TxnResult> => fs.txn(async (tx) => {
      if (entry.kind === "capsule") {
        const wsPath = ["workspaces", attemptUid] as const;
        const projPath = ["workspaces", attemptUid, "projects", entry.rid] as const;
        const capPath = ["workspaces", attemptUid, "capsules", entry.rid] as const;
        const ws = await tx.get(wsPath);
        let proj: Record<string, unknown> | null = null;
        let cap: Record<string, unknown> | null = null;
        if (!entry.onlyProject) {
          proj = await tx.get(projPath);
          cap = await tx.get(capPath);
        } else {
          proj = await tx.get(projPath);
        }
        const remoteObserved = cap !== null && typeof cap["observed_rev"] === "number"
          ? cap["observed_rev"] as number : null;
        if (!entry.onlyProject && remoteObserved !== null && remoteObserved > entry.observedRev) {
          return { conflict: true, wrote: false };
        }
        if (ws === null) {
          tx.set(wsPath, { name: "personal", members: { [attemptUid]: "owner" } });
        }
        if (entry.onlyProject || entry.forceProject) {
          tx.set(projPath, buildProjectDoc(entry, attemptUid, proj));
        } else if (proj === null) {
          tx.set(projPath, buildProjectDoc(entry, attemptUid, null));
        }
        if (!entry.onlyProject) {
          const remoteRev = cap !== null && typeof cap["rev"] === "number" ? cap["rev"] as number : 0;
          tx.set(capPath, buildCapsuleDoc(entry, attemptUid, remoteRev));
        }
        return { conflict: false, wrote: true };
      }
      const wsPath = ["workspaces", attemptUid] as const;
      const digPath = ["workspaces", attemptUid, "digests", entry.did] as const;
      const ws = await tx.get(wsPath);
      const existing = await tx.get(digPath);
      if (existing !== null) return { conflict: false, wrote: false };
      if (ws === null) {
        tx.set(wsPath, { name: "personal", members: { [attemptUid]: "owner" } });
      }
      tx.set(digPath, {
        rev_vector: { ...entry.revVectorRid },
        needs_you: [...entry.needsYouRid],
        brief: entry.brief,
        inference_source: entry.inferenceSource,
        created_at: fsPort === null ? d.clock.nowMs() : fsPort.timestamp(entry.builtAt),
      });
      return { conflict: false, wrote: true };
    });
    let p: Promise<TxnResult>;
    try {
      p = run();
    } catch (e) {
      p = Promise.reject(e);
    }
    void genAtStart;
    return withTimeoutRace(p);
  };

  const attemptEntry = async (entry: Entry, genAtStart: number): Promise<AttemptOutcome> => {
    const attemptUid = uid;
    if (fsPort === null || attemptUid === null) return "done";
    for (let attempt = 0; attempt < 2; attempt++) {
      if (disposed || generation !== genAtStart) return "done";
      const raced = await runTxn(genAtStart, attemptUid, entry);
      if (disposed || generation !== genAtStart) return "done";
      if (raced.kind === "timeout") {
        armBackoff(entry);
        return "transient";
      }
      if (raced.kind === "error") {
        const kind = classifyErr(raced.e);
        if (kind === "denied") {
          if (attempt === 0) continue;
          counters.denied++;
          deleteIfCurrent(entry);
          notify();
          return "done";
        }
        armBackoff(entry);
        return "transient";
      }
      const r = raced.v;
      if (r.conflict) {
        counters.conflicts++;
        deleteIfCurrent(entry);
        notify();
        return "done";
      }
      if (r.wrote) {
        counters.written++;
        if (entry.kind === "capsule") {
          lastWriteMs.set(`${attemptUid}\0${entry.rid}`, d.clock.nowMs());
        }
        deleteIfCurrent(entry);
        notify();
        return "done";
      }
      deleteIfCurrent(entry);
      notify();
      return "done";
    }
    return "done";
  };

  const doFlush = async (genAtStart: number): Promise<void> => {
    const keys = [...outbox.keys()];
    for (const key of keys) {
      if (disposed || generation !== genAtStart) return;
      const entry = outbox.get(key);
      if (entry === undefined) continue;
      if (!eligible(entry)) continue;
      const outcome = await attemptEntry(entry, genAtStart);
      if (outcome === "transient") return;
    }
  };

  const flush = async (): Promise<SyncStatus> => {
    if (disposed) return status();
    if (isLocalOnly()) return status();
    const g = generation;
    if (activePromise !== null && activeGen === g) {
      return activePromise;
    }
    activeGen = g;
    const holder: { p: Promise<SyncStatus> | null } = { p: null };
    const p: Promise<SyncStatus> = (async (): Promise<SyncStatus> => {
      try {
        await doFlush(g);
      } catch {
        /* flush never rejects */
      } finally {
        if (activePromise === holder.p) {
          activePromise = null;
          activeGen = -1;
        }
      }
      notify();
      return status();
    })();
    holder.p = p;
    activePromise = p;
    return p;
  };

  const buildCapsuleFields = (guarded: Record<string, unknown>, tier: PrivacyTier): {
    observedRev: number; status: string; attention: unknown;
    headline: string | undefined; summary: string | undefined;
    nextAction: string | undefined; inferenceSource: string | undefined; dropped: boolean;
  } => {
    const st = guarded["status"];
    const obs = guarded["observed_rev"];
    const headline = typeof guarded["headline"] === "string" ? guarded["headline"] : undefined;
    const summary = typeof guarded["summary"] === "string" ? guarded["summary"] : undefined;
    const inf = typeof guarded["inference_source"] === "string" ? guarded["inference_source"] : undefined;
    let nextAction: string | undefined;
    let dropped = false;
    if (tier !== "private") {
      const na = guarded["next_action"];
      if (typeof na === "string") {
        if (na.length > SYNC_LIMITS.NEXT_ACTION_MAX) dropped = true;
        else nextAction = na;
      }
    }
    return {
      observedRev: typeof obs === "number" ? obs : 0,
      status: typeof st === "string" ? st : "",
      attention: guarded["attention"],
      headline: tier === "private" ? undefined : headline,
      summary: tier === "private" ? undefined : summary,
      nextAction,
      inferenceSource: tier === "private" ? undefined : inf,
      dropped,
    };
  };

  const queueCapsule = (e: CapsuleEntry): Ack => {
    const existed = outbox.has(e.key);
    if (!existed && outbox.size >= SYNC_LIMITS.OUTBOX_MAX) return refuse("OUTBOX_FULL");
    outbox.set(e.key, e);
    notify();
    return { ok: true, outcome: existed ? "coalesced" : "queued" };
  };

  const tryClaimRid = (projectId: string, rid: string): RefuseCode | null => {
    if (uid === null) return null;
    const ownerKey = `${uid}\0${rid}`;
    const owner = ridOwner.get(ownerKey);
    if (owner !== undefined && owner !== projectId) return "ID_COLLISION";
    return null;
  };

  const claimRid = (projectId: string, rid: string): void => {
    if (uid !== null) ridOwner.set(`${uid}\0${rid}`, projectId);
  };

  const validateAndBuild = (
    projectId: string, s: CapsuleState,
  ): { ok: true; e: CapsuleEntry } | { ok: false; code: RefuseCode } => {
    let m: ProjectMeta | null;
    try {
      m = d.meta(projectId);
    } catch {
      return { ok: false, code: "NO_META" };
    }
    if (m === null) return { ok: false, code: "NO_META" };
    let guarded: Record<string, unknown>;
    try {
      const projected: unknown = d.privacy.project(s, m.tier);
      const g = d.privacy.guard(projected, m.tier);
      if (!g.ok) return { ok: false, code: "GUARD_REJECT" };
      guarded = g.value;
    } catch {
      return { ok: false, code: "GUARD_REJECT" };
    }
    const st = guarded["status"];
    if (typeof st !== "string" || !RULES.includes(st)) {
      return { ok: false, code: "STATUS_NOT_SYNCABLE" };
    }
    const rid = ridOf(projectId, d.hash32);
    const collision = tryClaimRid(projectId, rid);
    if (collision !== null) return { ok: false, code: collision };
    const f = buildCapsuleFields(guarded, m.tier);
    return {
      ok: true,
      e: {
        kind: "capsule",
        key: `capsules/${rid}`,
        projectId,
        rid,
        tier: m.tier,
        observedRev: f.observedRev,
        status: f.status,
        attention: f.attention,
        headline: f.headline,
        summary: f.summary,
        nextAction: f.nextAction,
        inferenceSource: f.inferenceSource,
        meta: m,
        forceProject: false,
        onlyProject: false,
        nextAttemptMs: 0,
        backoffCount: 0,
      },
    };
  };

  const rememberCapsule = (e: CapsuleEntry): void => {
    lastCapsule.set(e.projectId, {
      key: e.key,
      projectId: e.projectId,
      rid: e.rid,
      tier: e.tier,
      observedRev: e.observedRev,
      status: e.status,
      attention: e.attention,
      headline: e.headline,
      summary: e.summary,
      nextAction: e.nextAction,
      inferenceSource: e.inferenceSource,
      meta: e.meta,
      forceProject: e.forceProject,
    });
  };

  const putCapsule = (projectId: string, s: CapsuleState): Ack => {
    if (isLocalOnly()) return refuse("LOCAL_ONLY");
    const built = validateAndBuild(projectId, s);
    if (!built.ok) return refuse(built.code);
    const entry = built.e;
    claimRid(projectId, entry.rid);
    rememberCapsule(entry);
    const existed = outbox.has(entry.key);
    if (!existed && outbox.size >= SYNC_LIMITS.OUTBOX_MAX) return refuse("OUTBOX_FULL");
    countDropped(entry, s);
    outbox.set(entry.key, entry);
    notify();
    return { ok: true, outcome: existed ? "coalesced" : "queued" };
  };

  const countDropped = (entry: CapsuleEntry, s: CapsuleState): void => {
    if (entry.tier === "private") return;
    const na: unknown = (s as unknown as Record<string, unknown>)["next_action"];
    if (typeof na === "string" && na.length > SYNC_LIMITS.NEXT_ACTION_MAX) counters.droppedFields++;
  };

  const setTier = (projectId: string, latest: CapsuleState | null): Ack => {
    if (isLocalOnly()) return refuse("LOCAL_ONLY");
    if (latest === null) {
      let m: ProjectMeta | null;
      try {
        m = d.meta(projectId);
      } catch {
        return refuse("NO_META");
      }
      if (m === null) return refuse("NO_META");
      const rid = ridOf(projectId, d.hash32);
      const collision = tryClaimRid(projectId, rid);
      if (collision !== null) return refuse(collision);
      const entry: CapsuleEntry = {
        kind: "capsule",
        key: `capsules/${rid}`,
        projectId,
        rid,
        tier: m.tier,
        observedRev: 0,
        status: "",
        attention: undefined,
        headline: undefined,
        summary: undefined,
        nextAction: undefined,
        inferenceSource: undefined,
        meta: m,
        forceProject: true,
        onlyProject: true,
        nextAttemptMs: 0,
        backoffCount: 0,
      };
      claimRid(projectId, rid);
      lastCapsule.set(projectId, null);
      const existed = outbox.has(entry.key);
      if (!existed && outbox.size >= SYNC_LIMITS.OUTBOX_MAX) return refuse("OUTBOX_FULL");
      outbox.set(entry.key, entry);
      notify();
      return { ok: true, outcome: existed ? "coalesced" : "queued" };
    }
    const built = validateAndBuild(projectId, latest);
    if (!built.ok) return refuse(built.code);
    const entry = built.e;
    entry.forceProject = true;
    claimRid(projectId, entry.rid);
    rememberCapsule(entry);
    const existed = outbox.has(entry.key);
    if (!existed && outbox.size >= SYNC_LIMITS.OUTBOX_MAX) return refuse("OUTBOX_FULL");
    countDropped(entry, latest);
    outbox.set(entry.key, entry);
    notify();
    return { ok: true, outcome: existed ? "coalesced" : "queued" };
  };

  const putDigest = (digest: DigestIn): Ack => {
    if (isLocalOnly()) return refuse("LOCAL_ONLY");
    if (digest.origin === "LOCAL_RULES") return refuse("DIGEST_LOCAL_ORIGIN");
    const ids: string[] = [
      ...Object.keys(digest.revVector),
      ...digest.needs_you.map((n) => n.projectId),
    ];
    for (const pid of ids) {
      let m: ProjectMeta | null;
      try {
        m = d.meta(pid);
      } catch {
        return refuse("DIGEST_HAS_PRIVATE");
      }
      if (m === null || m.tier === "private") return refuse("DIGEST_HAS_PRIVATE");
    }
    if (digest.brief.length > SYNC_LIMITS.BRIEF_MAX) return refuse("DIGEST_OVERSIZE");
    const revVectorRid: Record<string, number> = {};
    for (const pid of Object.keys(digest.revVector)) {
      revVectorRid[ridOf(pid, d.hash32)] = digest.revVector[pid] as number;
    }
    const needsYouRid = digest.needs_you.map((n) => ridOf(n.projectId, d.hash32));
    const did = didOf(canonicalDigest(revVectorRid, digest.prompt_version), d.hash32);
    const entry: DigestEntry = {
      kind: "digest",
      key: `digests/${did}`,
      did,
      revVectorRid,
      needsYouRid,
      brief: digest.brief,
      inferenceSource: digest.origin === "IN_CLOUD" ? "IN_CLOUD" : "ON_DEVICE",
      builtAt: digest.builtAt,
      nextAttemptMs: 0,
      backoffCount: 0,
    };
    const existed = outbox.has(entry.key);
    if (!existed && outbox.size >= SYNC_LIMITS.OUTBOX_MAX) return refuse("OUTBOX_FULL");
    outbox.set(entry.key, entry);
    notify();
    return { ok: true, outcome: existed ? "coalesced" : "queued" };
  };

  const applyDeltas = async (
    dayKey: string,
    deltas: Readonly<Record<string, Readonly<Record<string, number>>>>,
  ): Promise<void> => {
    if (isLocalOnly()) throw new Error("SYNC_LOCAL_ONLY");
    const fs = fsPort;
    const attemptUid = uid;
    if (fs === null || attemptUid === null) throw new Error("SYNC_LOCAL_ONLY");
    const sums: Record<string, number> = {};
    for (const k of SYNC_KEYS.LEDGER) sums[k] = 0;
    for (const projKey of Object.keys(deltas)) {
      const dlt: unknown = deltas[projKey];
      if (typeof dlt !== "object" || dlt === null) throw new Error("SYNC_BAD_DELTA");
      for (const k of Object.keys(dlt as Record<string, unknown>)) {
        if (!LEDGER_SET.has(k)) throw new Error("SYNC_BAD_DELTA");
        const v: unknown = (dlt as Record<string, unknown>)[k];
        if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
          throw new Error("SYNC_BAD_DELTA");
        }
        sums[k] = (sums[k] as number) + (v as number);
      }
    }
    const genAtStart = generation;
    const run = (): Promise<void> => fs.txn(async (tx) => {
      const wsPath = ["workspaces", attemptUid] as const;
      const ledgerPath = ["workspaces", attemptUid, "ledger", dayKey] as const;
      const ws = await tx.get(wsPath);
      const prev = await tx.get(ledgerPath);
      if (ws === null) {
        tx.set(wsPath, { name: "personal", members: { [attemptUid]: "owner" } });
      }
      const next: Record<string, unknown> = {};
      for (const k of SYNC_KEYS.LEDGER) {
        const base = prev !== null && typeof prev[k] === "number" ? prev[k] as number : 0;
        next[k] = base + (sums[k] as number);
      }
      tx.set(ledgerPath, next);
    });
    let p: Promise<void>;
    try {
      p = run();
    } catch (e) {
      throw e;
    }
    void genAtStart;
    await p;
  };

  const onStatus = (cb: (s: SyncStatus) => void): (() => void) => {
    listeners.add(cb);
    return (): void => {
      listeners.delete(cb);
    };
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    generation++;
    cancelAllTimers();
    outbox.clear();
    try {
      unsub();
    } catch {
      /* ignore */
    }
    notify();
  };

  const sync: Sync = {
    putCapsule,
    setTier,
    putDigest,
    ledger: { applyDeltas },
    status,
    onStatus,
    flush,
    dispose,
  };
  return sync;
}

