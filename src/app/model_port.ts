// U52 page-side model transport over the wall RuntimePort (SPEC_U52 section 4.1 + W2-R).
// Timers come only from the injected providers clock; no host, no frames.
import type { Clock as ProvidersClock, EndpointInfo, HealthState, ModelSelection, ModelTransport, Rung } from "../providers/types";
import type { RuntimePort } from "./types";

export interface ModelChannel {
  send(frame: object): boolean;
  onFrame(cb: (f: unknown) => void): () => void;
  onReset(cb: () => void): () => void;
}

export interface SelectionStore {
  get(): Promise<ModelSelection>;
  set(s: ModelSelection): Promise<void>;
  onChange(cb: (s: ModelSelection) => void): () => void;
}

const LIST_BOUND_MS = 1500;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asEndpoints = (v: unknown): EndpointInfo[] | null => (Array.isArray(v) ? (v as EndpointInfo[]) : null);

type Pending =
  | { kind: "list"; settle: (v: EndpointInfo[]) => void }
  | { kind: "probe"; id: string; settle: (v: { state: HealthState; rung: Rung | null }) => void }
  | { kind: "generate"; id: string; settle: (v: { ok: true; text: string } | { ok: false; nack: string }) => void };

export function createPageModelTransport(
  ch: ModelChannel,
  clock: ProvidersClock,
  onHello?: (eps: EndpointInfo[]) => void,
): ModelTransport & { helloSeen(): boolean; dispose(): void } {
  let seq = 0;
  let seen = false;
  let disposed = false;
  const pending = new Map<string, Pending>();
  const timers = new Map<string, unknown>();
  const abortCleanups = new Map<string, () => void>();

  const nextRid = (): string => {
    seq += 1;
    return `m${seq}`;
  };

  const disarm = (rid: string): void => {
    if (!timers.has(rid)) return;
    const h = timers.get(rid);
    timers.delete(rid);
    try {
      clock.clearTimeout(h);
    } catch {
      /* best-effort */
    }
  };

  const settlePending = (rid: string, value: { list?: EndpointInfo[]; health?: { state: HealthState; rung: Rung | null }; gen?: { ok: true; text: string } | { ok: false; nack: string } }): void => {
    const p = pending.get(rid);
    if (p === undefined) return;
    pending.delete(rid);
    disarm(rid);
    const cleanup = abortCleanups.get(rid);
    if (cleanup !== undefined) {
      abortCleanups.delete(rid);
      try {
        cleanup();
      } catch {
        /* best-effort */
      }
    }
    if (p.kind === "list") p.settle(value.list ?? []);
    else if (p.kind === "probe") p.settle(value.health ?? { state: "offline", rung: null });
    else p.settle(value.gen ?? { ok: false, nack: "offline" });
  };

  const settleAllOffline = (): void => {
    for (const rid of [...pending.keys()]) settlePending(rid, {});
  };

  const onFrameCb = (f: unknown): void => {
    if (disposed || !isRecord(f)) return;
    const t = f["t"];
    if (t === "model_hello") {
      const eps = asEndpoints(f["endpoints"]);
      if (eps === null) return;
      seen = true;
      const rid = f["rid"];
      if (typeof rid === "string" && pending.has(rid)) {
        settlePending(rid, { list: eps });
      }
      if (rid === undefined && onHello !== undefined) {
        try {
          onHello(eps);
        } catch {
          /* host callback must not break frame handling */
        }
      }
      return;
    }
    const rid = f["rid"];
    if (typeof rid !== "string") return;
    const p = pending.get(rid);
    if (p === undefined) return;
    if (t === "model_health" && p.kind === "probe") {
      const st = f["state"];
      const rung = f["rung"];
      const health: HealthState =
        st === "available" || st === "needs_setup" || st === "blocked" || st === "offline" ? st : "offline";
      settlePending(rid, { health: { state: health, rung: rung === 1 || rung === 2 || rung === 3 ? rung : null } });
      return;
    }
    if (t === "model_result" && p.kind === "generate") {
      const text = f["text"];
      settlePending(rid, { gen: typeof text === "string" ? { ok: true, text } : { ok: false, nack: "bad_result" } });
      return;
    }
    if (t === "model_nack") {
      const code = f["code"];
      if (code === "host_absent") {
        seen = false;
      }
      if (p.kind === "generate") {
        settlePending(rid, { gen: { ok: false, nack: typeof code === "string" ? code : "unknown" } });
      } else if (p.kind === "probe") {
        settlePending(rid, { health: { state: "offline", rung: null } });
      } else if (p.kind === "list") {
        settlePending(rid, { list: [] });
      }
    }
  };

  const onResetCb = (): void => {
    if (disposed) return;
    seen = false;
    settleAllOffline();
  };

  const offFrame = ch.onFrame(onFrameCb);
  const offReset = ch.onReset(onResetCb);

  const sendCancel = (rid: string): void => {
    try {
      ch.send({ t: "model_cancel", v: 1, rid });
    } catch {
      /* best-effort */
    }
  };

  const armExpiry = (rid: string, ms: number, expire: () => void): void => {
    try {
      const h = clock.setTimeout(() => {
        if (!pending.has(rid)) return;
        expire();
      }, ms);
      timers.set(rid, h);
    } catch {
      expire();
    }
  };

  const transport: ModelTransport = {
    list(): Promise<EndpointInfo[]> {
      if (!seen) return Promise.resolve([]);
      const rid = nextRid();
      return new Promise<EndpointInfo[]>((resolve) => {
        pending.set(rid, { kind: "list", settle: resolve });
        armExpiry(rid, LIST_BOUND_MS, () => settlePending(rid, { list: [] }));
        let ok = false;
        try {
          ok = ch.send({ t: "model_list", v: 1, rid }) === true;
        } catch {
          ok = false;
        }
        if (!ok) {
          settlePending(rid, { list: [] });
        }
      });
    },
    probe(id: string, signal: AbortSignal): Promise<{ state: HealthState; rung: Rung | null }> {
      if (!seen) return Promise.resolve({ state: "needs_setup", rung: null });
      if (signal.aborted) return Promise.resolve({ state: "offline", rung: null });
      const rid = nextRid();
      return new Promise<{ state: HealthState; rung: Rung | null }>((resolve) => {
        pending.set(rid, { kind: "probe", id, settle: resolve });
        const onAbort = (): void => {
          if (!pending.has(rid)) return;
          sendCancel(rid);
          settlePending(rid, { health: { state: "offline", rung: null } });
        };
        signal.addEventListener("abort", onAbort, { once: true });
        abortCleanups.set(rid, () => {
          signal.removeEventListener("abort", onAbort);
        });
        armExpiry(rid, LIST_BOUND_MS, () => settlePending(rid, { health: { state: "offline", rung: null } }));
        let ok = false;
        try {
          ok = ch.send({ t: "model_probe", v: 1, rid, id }) === true;
        } catch {
          ok = false;
        }
        if (!ok) {
          settlePending(rid, { health: { state: "offline", rung: null } });
        }
      });
    },
    generate(req: { id: string; messages: { role: "system" | "user"; content: string }[]; maxTokens: number; schema?: object; rung: Rung; tier: "private" | "standard" | "shared"; signal: AbortSignal }): Promise<{ ok: true; text: string } | { ok: false; nack: string }> {
      if (!seen) return Promise.resolve({ ok: false, nack: "needs_setup" });
      if (req.signal.aborted) return Promise.resolve({ ok: false, nack: "cancelled" });
      const rid = nextRid();
      return new Promise<{ ok: true; text: string } | { ok: false; nack: string }>((resolve) => {
        pending.set(rid, { kind: "generate", id: req.id, settle: resolve });
        const onAbort = (): void => {
          if (!pending.has(rid)) return;
          sendCancel(rid);
          settlePending(rid, { gen: { ok: false, nack: "cancelled" } });
        };
        req.signal.addEventListener("abort", onAbort, { once: true });
        abortCleanups.set(rid, () => {
          req.signal.removeEventListener("abort", onAbort);
        });
        const frame: Record<string, unknown> = {
          t: "model_generate", v: 1, rid, id: req.id, tier: req.tier,
          messages: req.messages, max_tokens: req.maxTokens, rung: req.rung,
        };
        if (req.rung === 1 && req.schema !== undefined) frame["schema"] = req.schema;
        let ok = false;
        try {
          ok = ch.send(frame) === true;
        } catch {
          ok = false;
        }
        if (!ok) {
          settlePending(rid, { gen: { ok: false, nack: "offline" } });
        }
      });
    },
    cancel(id: string): void {
      for (const [rid, p] of [...pending]) {
        if (p.kind === "generate" && p.id === id) {
          sendCancel(rid);
          settlePending(rid, { gen: { ok: false, nack: "cancelled" } });
        } else if (p.kind === "probe" && p.id === id) {
          sendCancel(rid);
          settlePending(rid, { health: { state: "offline", rung: null } });
        }
      }
    },
  };

  const withDispose: ModelTransport & { helloSeen(): boolean; dispose(): void } = {
    list: () => transport.list(),
    probe: (id: string, signal: AbortSignal) => transport.probe(id, signal),
    generate: (req) => transport.generate(req),
    cancel: (id: string) => transport.cancel(id),
    helloSeen(): boolean {
      return seen;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      settleAllOffline();
      try {
        offFrame();
      } catch {
        /* ignore */
      }
      try {
        offReset();
      } catch {
        /* ignore */
      }
      seen = false;
    },
  };
  return withDispose;
}

export function attachModelChannel(port: RuntimePort): ModelChannel {
  const frameCbs = new Set<(f: unknown) => void>();
  const resetCbs = new Set<() => void>();
  port.onMessage.addListener((msg: unknown) => {
    for (const cb of [...frameCbs]) cb(msg);
  });
  port.onDisconnect.addListener(() => {
    for (const cb of [...resetCbs]) cb();
  });
  return {
    send(frame: object): boolean {
      try {
        port.postMessage(frame);
        return true;
      } catch {
        return false;
      }
    },
    onFrame(cb: (f: unknown) => void): () => void {
      frameCbs.add(cb);
      return () => {
        frameCbs.delete(cb);
      };
    },
    onReset(cb: () => void): () => void {
      resetCbs.add(cb);
      return () => {
        resetCbs.delete(cb);
      };
    },
  };
}

const copySelection = (s: ModelSelection): ModelSelection => {
  const out: ModelSelection = {};
  if (typeof s.all === "string") out.all = s.all;
  if (typeof s.groups === "object" && s.groups !== null) out.groups = { ...s.groups };
  return out;
};

/** Frame-backed selection store (W2-R): deferred until a `model_hello` on the current port. */
export function createFrameSelectionStore(ch: ModelChannel, clock?: ProvidersClock): SelectionStore & { dispose(): void } {
  let seq = 0;
  let seen = false;
  let disposed = false;
  let revision = 0;
  let queued: ModelSelection | null = null;
  const pending = new Map<string, { revision: number; sent: boolean; finish(s: ModelSelection): void }>();
  const listeners = new Set<(s: ModelSelection) => void>();
  const nextRid = (): string => `s${++seq}`;
  const drain = (): void => {
    for (const read of [...pending.values()]) read.finish({});
  };
  const sendRead = (rid: string): void => {
    const read = pending.get(rid);
    if (disposed || !seen || read === undefined || read.sent) return;
    read.sent = true;
    try {
      if (!ch.send({ t: "model_sel_get", v: 1, rid })) read.finish({});
    } catch { read.finish({}); }
  };
  const flushQueued = (): void => {
    if (disposed || !seen || queued === null) return;
    const value = queued;
    queued = null;
    try {
      if (!ch.send({ t: "model_sel_set", v: 1, rid: nextRid(), selection: copySelection(value) })) queued = value;
    } catch { queued = value; }
  };
  const offFrame = ch.onFrame((f: unknown) => {
    if (disposed || !isRecord(f)) return;
    if (f["t"] === "model_hello" && Array.isArray(f["endpoints"])) {
      seen = true;
      // Every send rechecks readiness: a send may synchronously reset the channel.
      flushQueued();
      for (const rid of [...pending.keys()]) sendRead(rid);
    } else if (seen && f["t"] === "model_sel" && typeof f["rid"] === "string") {
      const read = pending.get(f["rid"]);
      if (read === undefined || !read.sent) return;
      const value = isRecord(f["selection"]) ? copySelection(f["selection"] as ModelSelection) : {};
      const current = read.revision === revision;
      read.finish(current ? value : {});
      if (current) for (const cb of [...listeners]) cb(copySelection(value));
    }
  });
  const offReset = ch.onReset(() => {
    seen = false;
    drain();
  });
  return {
    get(): Promise<ModelSelection> {
      if (disposed) return Promise.resolve({});
      const rid = nextRid();
      return new Promise<ModelSelection>((resolve) => {
        let timer: unknown;
        let armed = false;
        const finish = (value: ModelSelection): void => {
          if (!pending.delete(rid)) return;
          if (armed) {
            try { clock?.clearTimeout(timer); } catch { /* best-effort */ }
          }
          resolve(value);
        };
        pending.set(rid, { revision, sent: false, finish });
        if (clock !== undefined) {
          try { timer = clock.setTimeout(() => finish({}), LIST_BOUND_MS); armed = true; }
          catch { finish({}); return; }
        }
        // Preserve asynchronous get semantics while guarding reset/disposal.
        void Promise.resolve().then(() => sendRead(rid));
      });
    },
    set(s: ModelSelection): Promise<void> {
      if (disposed) return Promise.resolve();
      revision += 1;
      // Invalidate both the promise and notification paths of older reads.
      drain();
      queued = copySelection(s);
      flushQueued();
      return Promise.resolve();
    },
    onChange(cb: (s: ModelSelection) => void): () => void {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      seen = false;
      drain();
      queued = null;
      listeners.clear();
      try { offFrame(); } catch { /* best-effort */ }
      try { offReset(); } catch { /* best-effort */ }
    },
  };
}
