// S8 cache_choice + bindFirestore contract + static import discipline (B13, §1).
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import * as api from "../../../src/sync";
import { bindFirestore, ridOf, type FirestoreModules } from "../../../src/sync";
import { fnv1a32 } from "./harness";

function fakeModules() {
  const calls: unknown[][] = [];
  const store = new Map<string, Record<string, unknown>>();
  const tx = {
    get: async (ref: { path: string[] }) => {
      const v = store.get(ref.path.join("/"));
      return { exists: () => v !== undefined, data: () => v };
    },
    set: (...a: unknown[]) => { calls.push(["tx.set", ...a]); const r = a[0] as { path: string[] }; store.set(r.path.join("/"), a[1] as Record<string, unknown>); },
  };
  const m: FirestoreModules = {
    initializeFirestore: (app, s) => { calls.push(["init", app, s]); return { db: true, s }; },
    memoryLocalCache: () => { calls.push(["mem"]); return { kind: "memory" }; },
    persistentLocalCache: (s) => { calls.push(["pers", s]); return { kind: "persistent" }; },
    doc: (db, ...segs) => { calls.push(["doc", db, ...segs]); return { db, path: segs }; },
    runTransaction: (db, fn) => { calls.push(["run", db]); return fn(tx); },
  };
  return { m, calls, store };
}
const X = { timestamp: (ms: number) => ({ ms }), classify: () => "other" as const };

describe("S8 cache_choice (B13)", () => {
  it("default -> memoryLocalCache() reaches initializeFirestore; persistentLocalCache never called", () => {
    const { m, calls } = fakeModules();
    const app = { app: 1 };
    bindFirestore(m, app, undefined as never, X);
    const init = calls.find((c) => c[0] === "init")!;
    expect(init[1]).toBe(app);
    expect(init[2]).toEqual({ localCache: { kind: "memory" } });
    expect(calls.some((c) => c[0] === "pers")).toBe(false);
    expect(calls.filter((c) => c[0] === "init")).toHaveLength(1);
  });
  it("'memory' choice behaves like the default", () => {
    const { m, calls } = fakeModules();
    bindFirestore(m, {}, "memory", X);
    expect(calls.some((c) => c[0] === "mem")).toBe(true);
    expect(calls.some((c) => c[0] === "pers")).toBe(false);
  });
  it("opt-in persistent_single_tab -> persistentLocalCache() without a multi-tab manager", () => {
    const { m, calls } = fakeModules();
    bindFirestore(m, {}, "persistent_single_tab", X);
    const init = calls.find((c) => c[0] === "init")!;
    expect(init[2]).toEqual({ localCache: { kind: "persistent" } });
    expect(calls.some((c) => c[0] === "mem")).toBe(false);
    const pers = calls.find((c) => c[0] === "pers")!;
    expect(JSON.stringify(pers[1] ?? {})).not.toMatch(/tabManager|Multiple/i);
  });
});

describe("bindFirestore txn/timestamp/classify", () => {
  it("get -> null when absent, data when present; set is (ref, data) with no options (never merge); returns fn result", async () => {
    const { m, calls, store } = fakeModules();
    store.set("workspaces/u1", { name: "personal" });
    const fs = bindFirestore(m, {}, "memory", X);
    const out = await fs.txn(async (tx) => {
      const a = await tx.get(["workspaces", "u1"]);
      const b = await tx.get(["workspaces", "nope"]);
      tx.set(["workspaces", "u1", "capsules", "p_1"], { rev: 1 });
      return { a, b };
    });
    expect(out).toEqual({ a: { name: "personal" }, b: null });
    const set = calls.find((c) => c[0] === "tx.set")!;
    expect(set).toHaveLength(3);                                  // ["tx.set", ref, data]: no merge arg
    expect(set[2]).toEqual({ rev: 1 });
    const docCall = calls.find((c) => c[0] === "doc" && c.includes("capsules"))!;
    expect(docCall.slice(2)).toEqual(["workspaces", "u1", "capsules", "p_1"]);
    expect((docCall[1] as { db: boolean }).db).toBe(true);        // db = initializeFirestore result
  });
  it("errors thrown inside the txn propagate unchanged; timestamp/classify delegate", async () => {
    const { m } = fakeModules();
    const fs = bindFirestore(m, {}, "memory", X);
    const boom = new Error("boom");
    await expect(fs.txn(async () => { throw boom; })).rejects.toBe(boom);
    expect(fs.timestamp(5)).toEqual({ ms: 5 });
    expect(fs.classify(new Error("x"))).toBe("other");
  });
});

describe("docs.ts", () => {
  it("ridOf = 'p_' + hash32(projectId)", () => {
    expect(ridOf("acme-secret", fnv1a32)).toBe("p_" + fnv1a32("acme-secret"));
    expect(ridOf("acme-secret", fnv1a32)).not.toContain("acme");
  });
});

const SYNC = resolve(__dirname, "../../../src/sync");
const files = (): string[] => (existsSync(SYNC) ? readdirSync(SYNC).filter((f) => f.endsWith(".ts")) : []);
const code = (f: string): string =>
  readFileSync(resolve(SYNC, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("static discipline (§1)", () => {
  it("module set exists and index exports the public API", () => {
    for (const f of ["types.ts", "limits.ts", "ports.ts", "docs.ts", "outbox.ts", "engine.ts", "index.ts"]) expect(files()).toContain(f);
    for (const n of ["createSync", "bindFirestore", "SYNC_KEYS", "SYNC_LIMITS"]) expect(api).toHaveProperty(n);
  });
  it("firebase/* is imported only by ports.ts; never firebase/auth or firebase/ai", () => {
    for (const f of files()) {
      const c = code(f);
      expect(/firebase\/(auth|ai)/.test(c), `${f} imports auth/ai`).toBe(false);
      if (f !== "ports.ts") expect(/["']firebase\//.test(c), `${f} imports firebase/*`).toBe(false);
    }
  });
  it("no ingest import, no DOM, no non-injected timers", () => {
    for (const f of files()) {
      const c = code(f);
      expect(/ingest/.test(c), `${f} ingest`).toBe(false);
      expect(/\b(document|window|localStorage|sessionStorage|indexedDB|navigator)\b/.test(c), `${f} DOM`).toBe(false);
      expect(/\b(setTimeout|setInterval)\s*\(/.test(c), `${f} timers`).toBe(false);
    }
  });
  it("relative imports stay inside sync/ or the admitted schema/reconcile/lens modules", () => {
    for (const f of files()) {
      for (const m of code(f).matchAll(/from\s+["'](\.[^"']*)["']/g)) {
        expect(/^\.\/[\w-]+$|^\.\.\/(schema|reconcile|lens)(\/.*)?$/.test(m[1]!), `${f}: ${m[1]}`).toBe(true);
      }
    }
  });
});
