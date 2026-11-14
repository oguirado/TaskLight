// U14 §2 ports: the only module allowed to touch firebase/* (modules injected, so no import needed).

export interface FirestoreModules {
  initializeFirestore(app: unknown, s: { localCache: unknown }): unknown;
  memoryLocalCache(): unknown;
  persistentLocalCache(s?: object): unknown;
  doc(db: unknown, ...segments: string[]): unknown;
  runTransaction<T>(db: unknown, fn: (tx: unknown) => Promise<T>): Promise<T>;
}

export type CacheChoice = "memory" | "persistent_single_tab";

export type FsErrorKind = "denied" | "unavailable" | "other";

export interface FsTxn {
  get(path: readonly string[]): Promise<Record<string, unknown> | null>;
  set(path: readonly string[], data: Record<string, unknown>): void;
}

export interface FirestorePort {
  txn<T>(fn: (tx: FsTxn) => Promise<T>): Promise<T>;
  timestamp(ms: number): unknown;
  classify(e: unknown): FsErrorKind;
}

interface ModularSnapshot {
  exists(): boolean;
  data(): unknown;
}

interface ModularTx {
  get(ref: unknown): Promise<ModularSnapshot>;
  set(ref: unknown, data: unknown): void;
}

export function bindFirestore(
  m: FirestoreModules,
  app: unknown,
  cache: CacheChoice,
  x: Pick<FirestorePort, "timestamp" | "classify">,
): FirestorePort {
  const localCache = cache === "persistent_single_tab" ? m.persistentLocalCache() : m.memoryLocalCache();
  const db: unknown = m.initializeFirestore(app, { localCache });
  return {
    timestamp: (ms: number): unknown => x.timestamp(ms),
    classify: (e: unknown): FsErrorKind => x.classify(e),
    txn: <T>(fn: (tx: FsTxn) => Promise<T>): Promise<T> =>
      m.runTransaction<T>(db, async (rawTx: unknown) => {
        const modularTx = rawTx as ModularTx;
        const tx: FsTxn = {
          get: async (path: readonly string[]): Promise<Record<string, unknown> | null> => {
            const ref: unknown = m.doc(db, ...path);
            const snap: ModularSnapshot = await modularTx.get(ref);
            if (!snap.exists()) return null;
            const data: unknown = snap.data();
            return (data ?? null) as Record<string, unknown> | null;
          },
          set: (path: readonly string[], data: Record<string, unknown>): void => {
            const ref: unknown = m.doc(db, ...path);
            modularTx.set(ref, data);
          },
        };
        return fn(tx);
      }),
  };
}
