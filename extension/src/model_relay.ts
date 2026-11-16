// U49 model relay: page <-> native host for model_* frames (SPEC_U49).
// Pure wiring: validates both directions (mirror of bridge/wall/model_relay.py:80-108), rewrites rids,
// serializes probe/generate through one host slot, arms timeouts, stores the model selection (ids only)
// through an injected store. No logging, no globals; never throws.
import type { ChromePortLike } from "./chrome_ports";
import { MODEL_RELAY_LIMITS } from "./types";
import type { Clock, ModelEndpointWire, SessionStore, StoredSelection } from "./types";

export interface ModelRelayNative {
  /** false when the native port is down (nothing was sent). */
  send(frame: unknown): boolean;
  onFrame(cb: (frame: unknown) => void): () => void;
  connected(): boolean;
}
export interface ModelRelayStats {
  forwarded: number; delivered: number; dropped: number; late: number; nacked: number; pending: number; queued: number; ports: number;
}
export interface ModelRelay {
  onPortMessage(port: ChromePortLike, msg: unknown): void;
  onPortClosed(port: ChromePortLike): void;
  stats(): ModelRelayStats;
}
export const MODEL_SELECTION_KEY = "u49.model_selection";

type Rec = Record<string, unknown>;
type Kind = "list" | "probe" | "generate";
interface Entry {
  relayRid: string;
  /** null once the page port closed while the host still holds the request (orphan: slot kept until the host answers). */
  port: ChromePortLike | null;
  pageRid: string;
  kind: Kind;
  endpointId: string;
  hostFrame: Rec;
  state: "queued" | "inflight";
  cancelSent: boolean;
  disarm: () => void;
}

const L = MODEL_RELAY_LIMITS;
const RID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TIERS: ReadonlySet<string> = new Set(["private", "standard", "shared"]);
const ROLES: ReadonlySet<string> = new Set(["system", "user", "assistant"]);
const KIND_LOCAL = "local-openai-compatible";
const KIND_REMOTE = "remote-openai-compatible";
const STATES: ReadonlySet<string> = new Set(["available", "needs_setup", "offline", "blocked"]);
const HOST_CODES: ReadonlySet<string> = new Set([
  "unknown_endpoint", "needs_setup", "policy", "busy", "too_large", "not_loopback", "redirect", "timeout",
  "offline", "auth", "rate_limited", "rung_unsupported", "http_error", "bad_reply", "reply_too_large", "cancelled",
]);
const GROUPS = ["capsule", "digest", "routing", "drift"] as const;
const EP_KEYS = ["allow_private", "has_key", "id", "kind", "label", "loopback", "model"];
const GEN_KEYS = ["id", "max_tokens", "messages", "rid", "rung", "t", "tier", "v"];
const encoder = new TextEncoder();
/**
 * A-U49r1: budget for one selection store op (get or set). chrome.storage.local normally settles in
 * milliseconds; 2,000 ms equals the list budget (host-free op, same slack). On expiry the page gets
 * `store_failed`, the rid is released and a late completion is ignored.
 */
export const SELECTION_MS = 2_000;

const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isRid = (v: unknown): v is string => typeof v === "string" && RID_RE.test(v);
const isId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const hasKeys = (o: Rec, keys: readonly string[]): boolean => {
  const k = Object.keys(o).sort();
  const want = [...keys].sort();
  return k.length === want.length && k.every((x, i) => x === want[i]);
};
const keysWithin = (o: Rec, allowed: readonly string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));

/** UTF-8 bytes of JSON.stringify(o); Infinity when unserializable. */
function jsonBytes(o: unknown): number {
  try {
    const s = JSON.stringify(o);
    return typeof s === "string" ? encoder.encode(s).length : Infinity;
  } catch {
    return Infinity;
  }
}
/**
 * Conservative wire size of a frame sent to the host. The host measures the bytes the browser wrote
 * (native_host.py:389); the browser's JSON writer may escape `<`, DEL and U+2028/2029 as \uXXXX where
 * JSON.stringify does not, so those are counted at their escaped width (never under-estimates).
 */
function hostWireBytes(o: unknown): number {
  let s: string | undefined;
  try {
    s = JSON.stringify(o);
  } catch {
    return Infinity;
  }
  if (typeof s !== "string") return Infinity;
  let extra = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x3c || c === 0x7f) extra += 5;
    else if (c === 0x2028 || c === 0x2029) extra += 3;
  }
  return encoder.encode(s).length + extra;
}

function messagesOk(m: unknown): boolean {
  if (!Array.isArray(m) || m.length < 1 || m.length > L.MESSAGES_MAX) return false;
  for (const x of m) {
    if (!isRecord(x) || !hasKeys(x, ["role", "content"])) return false;
    if (typeof x["role"] !== "string" || !ROLES.has(x["role"]) || typeof x["content"] !== "string") return false;
  }
  return true;
}

/** Mirror of model_relay.py `_valid` plus the extension-local frames. */
function validPage(o: Rec): boolean {
  const t = o["t"];
  if (!isInt(o["v"]) || o["v"] !== 1) return false;
  switch (t) {
    case "model_list":
    case "model_cancel":
    case "model_sel_get":
      return hasKeys(o, ["t", "v", "rid"]);
    case "model_probe":
      return hasKeys(o, ["t", "v", "rid", "id"]) && isId(o["id"]);
    case "model_sel_set":
      return hasKeys(o, ["t", "v", "rid", "selection"]) && parseSelection(o["selection"]) !== null;
    case "model_generate": {
      if (!hasKeys(o, GEN_KEYS) && !hasKeys(o, [...GEN_KEYS, "schema"])) return false;
      if (!isId(o["id"])) return false;
      if (typeof o["tier"] !== "string" || !TIERS.has(o["tier"])) return false;
      if (!messagesOk(o["messages"])) return false;
      const mt = o["max_tokens"];
      if (!isInt(mt) || mt < 1 || mt > L.MAX_TOKENS_MAX) return false;
      const rung = o["rung"];
      if (!isInt(rung) || (rung !== 1 && rung !== 2 && rung !== 3)) return false;
      if ("schema" in o && !isRecord(o["schema"])) return false;
      if (rung === 1 && !("schema" in o)) return false;
      return true;
    }
    default:
      return false;
  }
}

/** Selection as sent by the page: {all?, groups?:{capsule?,digest?,routing?,drift?}}; rebuilt, or null. */
function parseSelection(v: unknown): StoredSelection | null {
  if (!isRecord(v) || !keysWithin(v, ["all", "groups"])) return null;
  const out: StoredSelection = {};
  if ("all" in v) {
    if (!isId(v["all"])) return null;
    out.all = v["all"];
  }
  if ("groups" in v) {
    const g = v["groups"];
    if (!isRecord(g) || !keysWithin(g, GROUPS)) return null;
    const groups: NonNullable<StoredSelection["groups"]> = {};
    for (const k of GROUPS) {
      if (k in g) {
        if (!isId(g[k])) return null;
        groups[k] = g[k];
      }
    }
    out.groups = groups;
  }
  return out;
}

/** Stored value {v:1, all?, groups?} -> selection without v; anything malformed -> {}. */
function parseStored(v: unknown): StoredSelection {
  if (!isRecord(v) || v["v"] !== 1 || !keysWithin(v, ["v", "all", "groups"])) return {};
  const rest: Rec = {};
  if ("all" in v) rest["all"] = v["all"];
  if ("groups" in v) rest["groups"] = v["groups"];
  return parseSelection(rest) ?? {};
}

function parseEndpoints(v: unknown): ModelEndpointWire[] | null {
  if (!Array.isArray(v)) return null;
  const out: ModelEndpointWire[] = [];
  for (const e of v) {
    if (!isRecord(e) || !hasKeys(e, EP_KEYS)) return null;
    const { id, kind, label, model, loopback, has_key, allow_private } = e;
    if (!isId(id) || (kind !== KIND_LOCAL && kind !== KIND_REMOTE)) return null;
    if (typeof label !== "string" || typeof model !== "string") return null;
    if (typeof loopback !== "boolean" || typeof has_key !== "boolean" || typeof allow_private !== "boolean") return null;
    out.push({ id, kind, label, model, loopback, has_key, allow_private });
  }
  return out;
}

export function createModelRelay(d: { native: ModelRelayNative; clock: Clock; store: SessionStore }): ModelRelay {
  const { native, clock, store } = d;
  let forwarded = 0;
  let delivered = 0;
  let dropped = 0;
  let late = 0;
  let nacked = 0;
  let seq = 0;
  let selSeq = 0;
  let ready = false;
  let cache = new Map<string, ModelEndpointWire>();
  const entries = new Map<string, Entry>();
  /** port -> pageRid -> relay rid (or a "sel:<n>" marker for an in-progress selection op). */
  const byPort = new Map<ChromePortLike, Map<string, string>>();
  const ports = new Set<ChromePortLike>();
  const queue: Entry[] = [];
  let slot: Entry | null = null;
  let pumping = false;
  /**
   * A-U49r2 selection write fence. Page sets run one at a time in arrival order (`writeTail`). A set whose
   * budget expires releases the chain (so later sets stay bounded, A-U49r1) but stays counted in
   * stale until its store.set settles; when it settles, the last acknowledged selection is
   * re-written behind the fence, so an older write can never leave a newer acknowledged value overwritten.
   */
  let writeTail: Promise<void> = Promise.resolve();
  let lastAcked: Rec | null = null;

  const ridsOf = (port: ChromePortLike): Map<string, string> => {
    let m = byPort.get(port);
    if (m === undefined) {
      m = new Map<string, string>();
      byPort.set(port, m);
    }
    return m;
  };

  const deliver = (port: ChromePortLike, frame: Rec): void => {
    try {
      port.postMessage(frame);
      delivered += 1;
      if (frame["t"] === "model_nack") nacked += 1;
    } catch {
      closePort(port);
    }
  };
  const nack = (port: ChromePortLike, rid: string, code: string): void => {
    deliver(port, { t: "model_nack", v: 1, rid, code });
  };

  /** Removes an entry from every index (timer included) without delivering anything. */
  const detach = (e: Entry): void => {
    try {
      e.disarm();
    } catch {
      /* A-U49r1: a throwing disarm must not stall cleanup (slot release, queue advance) */
    }
    entries.delete(e.relayRid);
    if (slot === e) slot = null;
    const qi = queue.indexOf(e);
    if (qi >= 0) queue.splice(qi, 1);
    if (e.port !== null) {
      const m = byPort.get(e.port);
      if (m !== undefined && m.get(e.pageRid) === e.relayRid) m.delete(e.pageRid);
    }
  };
  /** Detach and answer the page (if its port is still open). */
  const finish = (e: Entry, frame: Rec): void => {
    const port = e.port;
    detach(e);
    if (port !== null) deliver(port, frame);
  };

  const sendHost = (frame: Rec): boolean => {
    try {
      return native.send(frame);
    } catch {
      return false;
    }
  };
  const sendCancel = (e: Entry): boolean => {
    if (e.cancelSent) return true;
    e.cancelSent = true;
    return sendHost({ t: "model_cancel", v: 1, rid: e.relayRid });
  };

  const reset = (): void => {
    ready = false;
    cache = new Map<string, ModelEndpointWire>();
    const all = [...entries.values()];
    for (const e of all) detach(e);
    queue.length = 0;
    slot = null;
    for (const e of all) if (e.port !== null) nack(e.port, e.pageRid, "host_absent");
    for (const p of [...ports]) deliver(p, { t: "model_hello", v: 1, endpoints: [] });
  };

  /** Gate: ready and connected. A disconnected native port found here resets the relay. */
  const gateOpen = (): boolean => {
    if (!ready) return false;
    let up = false;
    try {
      up = native.connected();
    } catch {
      up = false;
    }
    if (!up) {
      reset();
      return false;
    }
    return true;
  };

  /** Third policy gate against the CURRENT endpoint cache; uncached ids pass (the host decides). */
  const prohibited = (id: string, tier: string): boolean => {
    const ep = cache.get(id);
    if (ep === undefined) return false;
    const remote = ep.kind === KIND_REMOTE;
    return (remote && (tier === "private" || tier === "shared")) || (!remote && tier === "private" && !ep.allow_private);
  };

  /** Sends a queued/new probe or generate into the free slot, or answers it locally instead. */
  const launch = (e: Entry): void => {
    if (!gateOpen()) {
      if (entries.has(e.relayRid)) finish(e, { t: "model_nack", v: 1, rid: e.pageRid, code: "host_absent" });
      return;
    }
    /* A-U49r2: the cache may have changed (unsolicited model_hello) while the request was queued. */
    if (e.kind === "generate" && prohibited(e.endpointId, String(e.hostFrame["tier"]))) {
      finish(e, { t: "model_nack", v: 1, rid: e.pageRid, code: "policy" });
      return;
    }
    e.state = "inflight";
    slot = e;
    if (!sendHost(e.hostFrame)) {
      finish(e, { t: "model_nack", v: 1, rid: e.pageRid, code: "host_absent" });
      return;
    }
    forwarded += 1;
  };

  const pump = (): void => {
    if (pumping) return;
    pumping = true;
    try {
      while (slot === null && queue.length > 0) {
        const e = queue.shift() as Entry;
        launch(e);
      }
    } finally {
      pumping = false;
    }
  };

  const budgetOf = (kind: Kind, endpointId: string): number => {
    if (kind === "list") return L.LIST_MS;
    if (kind === "probe") return L.PROBE_MS;
    const ep = cache.get(endpointId);
    return ep !== undefined && ep.kind === KIND_LOCAL ? L.LOCAL_GENERATE_MS : L.REMOTE_GENERATE_MS;
  };

  const onTimeout = (relayRid: string): void => {
    const e = entries.get(relayRid);
    if (e === undefined) return;
    if (e.state === "inflight" && e.kind !== "list") sendCancel(e);
    finish(e, { t: "model_nack", v: 1, rid: e.pageRid, code: "timeout" });
    pump();
  };

  /**
   * Local terminal answer used when the request cannot be bounded (setTimer threw, A-U49r1): the same
   * answer as with the host gate closed (spec Behaviour 2), so nothing unbounded is ever forwarded.
   */
  const answerUnbounded = (port: ChromePortLike, pageRid: string, kind: Kind, endpointId: string): void => {
    if (kind === "list") deliver(port, { t: "model_hello", v: 1, rid: pageRid, endpoints: [] });
    else if (kind === "probe") deliver(port, { t: "model_health", v: 1, rid: pageRid, id: endpointId, state: "needs_setup", rung: null });
    else nack(port, pageRid, "host_absent");
  };

  /** Accepts a request: relay rid, host frame size check, timer, indexes. null when answered locally. */
  const accept = (port: ChromePortLike, pageRid: string, kind: Kind, endpointId: string, build: (rid: string) => Rec): Entry | null => {
    seq += 1;
    const relayRid = `m${seq}`;
    const hostFrame = build(relayRid);
    if (hostWireBytes(hostFrame) > L.FRAME_MAX_BYTES) {
      nack(port, pageRid, "too_large");
      return null;
    }
    const e: Entry = { relayRid, port, pageRid, kind, endpointId, hostFrame, state: "queued", cancelSent: false, disarm: () => {} };
    try {
      e.disarm = clock.setTimer(budgetOf(kind, endpointId), () => {
        try {
          onTimeout(relayRid);
        } catch {
          /* never throw from a timer */
        }
      });
    } catch {
      answerUnbounded(port, pageRid, kind, endpointId);
      return null;
    }
    entries.set(relayRid, e);
    ridsOf(port).set(pageRid, relayRid);
    return e;
  };

  const onList = (port: ChromePortLike, rid: string): void => {
    if (!gateOpen()) {
      deliver(port, { t: "model_hello", v: 1, rid, endpoints: [] });
      return;
    }
    const e = accept(port, rid, "list", "", (r) => ({ t: "model_list", v: 1, rid: r }));
    if (e === null) return;
    e.state = "inflight";
    if (!sendHost(e.hostFrame)) {
      finish(e, { t: "model_nack", v: 1, rid, code: "host_absent" });
      return;
    }
    forwarded += 1;
  };

  const enqueue = (e: Entry): void => {
    if (slot === null && queue.length === 0) launch(e);
    else queue.push(e);
  };
  const queueFull = (): boolean => slot !== null && queue.length >= L.QUEUE_MAX;

  const onProbe = (port: ChromePortLike, rid: string, id: string): void => {
    if (!gateOpen()) {
      deliver(port, { t: "model_health", v: 1, rid, id, state: "needs_setup", rung: null });
      return;
    }
    if (queueFull()) {
      nack(port, rid, "busy");
      return;
    }
    const e = accept(port, rid, "probe", id, (r) => ({ t: "model_probe", v: 1, rid: r, id }));
    if (e !== null) enqueue(e);
  };

  const onGenerate = (port: ChromePortLike, rid: string, o: Rec): void => {
    if (!gateOpen()) {
      nack(port, rid, "host_absent");
      return;
    }
    const id = o["id"] as string;
    const tier = o["tier"] as string;
    if (prohibited(id, tier)) {
      nack(port, rid, "policy");
      return;
    }
    if (queueFull()) {
      nack(port, rid, "busy");
      return;
    }
    const messages = (o["messages"] as Rec[]).map((m) => ({ role: m["role"] as string, content: m["content"] as string }));
    const e = accept(port, rid, "generate", id, (r) => {
      const f: Rec = { t: "model_generate", v: 1, rid: r, id, tier, messages, max_tokens: o["max_tokens"], rung: o["rung"] };
      if ("schema" in o) f["schema"] = o["schema"];
      return f;
    });
    if (e !== null) enqueue(e);
  };

  const onCancel = (port: ChromePortLike, rid: string): void => {
    const relayRid = byPort.get(port)?.get(rid);
    if (relayRid === undefined) return;
    const e = entries.get(relayRid);
    if (e === undefined) return; /* selection op or already settled: silence */
    if (e.state === "queued" || e.kind === "list") {
      finish(e, { t: "model_nack", v: 1, rid: e.pageRid, code: "cancelled" });
      return;
    }
    if (e.cancelSent) return;
    if (!sendCancel(e)) {
      finish(e, { t: "model_nack", v: 1, rid: e.pageRid, code: "cancelled" });
      pump();
    }
  };

  const onSelection = (port: ChromePortLike, rid: string, o: Rec): void => {
    selSeq += 1;
    const marker = `sel:${selSeq}`;
    ridsOf(port).set(rid, marker);
    let settled = false;
    let disarm: () => void = () => {};
    /** Settles once: the first of completion / failure / budget expiry wins; later ones are ignored. */
    const done = (frame: Rec): void => {
      if (settled) return;
      settled = true;
      try {
        disarm();
      } catch {
        /* ignore */
      }
      const m = byPort.get(port);
      if (m === undefined || m.get(rid) !== marker) return;
      m.delete(rid);
      deliver(port, frame);
    };
    const fail = (): void => done({ t: "model_nack", v: 1, rid, code: "store_failed" });
    try {
      disarm = clock.setTimer(SELECTION_MS, () => {
        try {
          fail();
        } catch {
          /* never throw from a timer */
        }
      });
    } catch {
      fail();
      return;
    }
    if (o["t"] === "model_sel_get") {
      Promise.resolve()
        .then(() => store.get(MODEL_SELECTION_KEY))
        .then((v) => done({ t: "model_sel", v: 1, rid, selection: parseStored(v) }), fail)
        .catch(() => {});
      return;
    }
    const sel = parseSelection(o["selection"]) as StoredSelection;
    const stored: Rec = { v: 1 };
    if (sel.all !== undefined) stored["all"] = sel.all;
    if (sel.groups !== undefined) stored["groups"] = { ...sel.groups };
    fenced(() => (settled ? null : store.set(MODEL_SELECTION_KEY, stored)), (ok) => {
      if (!ok) {
        fail();
        return;
      }
      if (settled) return; /* timed out: never acknowledged */
      lastAcked = stored;
      done({ t: "model_sel", v: 1, rid, selection: sel });
    });
  };

  /**
   * Runs one selection write behind the fence. `start` returns the store promise (null = skip: the op
   * already settled while waiting). The fence is released when the write settles, or SELECTION_MS after it
   * started; a write still running then is stale (never acknowledged) and triggers a repair write of the
   * last acknowledged selection once it settles.
   */
  function fenced(start: () => Promise<void> | null, end: (ok: boolean) => void): void {
    writeTail = writeTail.then(() => new Promise<void>((release) => {
      let p: Promise<void> | null = null;
      try {
        p = start();
      } catch {
        try { end(false); } catch { /* ignore */ }
        release();
        return;
      }
      if (p === null) {
        release();
        return;
      }
      let running = true;
      let stale = false;
      let disarm: () => void = () => {};
      const settle = (ok: boolean): void => {
        if (!running) return;
        running = false;
        try { disarm(); } catch { /* ignore */ }
        try { end(ok && !stale); } catch { /* ignore */ } /* a stale write is never acknowledged */
        if (stale) repair();
        release();
      };
      try {
        /* armed after the op's own budget timer, so the op has already been answered store_failed here */
        disarm = clock.setTimer(SELECTION_MS, () => {
          if (running) {
            stale = true;
            release();
          }
        });
      } catch {
        /* no timer: the fence is released when the write settles */
      }
      Promise.resolve(p).then(() => settle(true), () => settle(false)).catch(() => {});
    })).catch(() => {});
  }

  /** Re-asserts the last acknowledged selection behind the fence after a stale write settled. */
  function repair(): void {
    if (lastAcked === null) return;
    fenced(() => (lastAcked === null ? null : store.set(MODEL_SELECTION_KEY, { ...lastAcked })), () => {});
  }

  const handlePage = (port: ChromePortLike, msg: unknown): void => {
    if (!isRecord(msg)) {
      dropped += 1;
      return;
    }
    ports.add(port);
    const rid = msg["rid"];
    if (!isRid(rid)) {
      dropped += 1;
      return;
    }
    if (jsonBytes(msg) > L.FRAME_MAX_BYTES) {
      nack(port, rid, "too_large");
      return;
    }
    if (!validPage(msg)) {
      nack(port, rid, "bad_request");
      return;
    }
    const t = msg["t"];
    if (t === "model_cancel") {
      onCancel(port, rid);
      return;
    }
    if (byPort.get(port)?.has(rid) === true) {
      nack(port, rid, "bad_request");
      return;
    }
    if (t === "model_list") onList(port, rid);
    else if (t === "model_probe") onProbe(port, rid, msg["id"] as string);
    else if (t === "model_generate") onGenerate(port, rid, msg);
    else onSelection(port, rid, msg);
  };

  /** Validates a host reply against its pending entry; returns the page frame or null (bad_reply). */
  const pageReply = (e: Entry, f: Rec): Rec | null => {
    if (!isInt(f["v"]) || f["v"] !== 1) return null;
    const t = f["t"];
    if (t === "model_nack") {
      if (!hasKeys(f, ["t", "v", "rid", "code"])) return null;
      const code = f["code"];
      if (typeof code !== "string" || !HOST_CODES.has(code)) return null;
      return { t: "model_nack", v: 1, rid: e.pageRid, code };
    }
    if (e.kind === "list" && t === "model_hello") {
      if (!hasKeys(f, ["t", "v", "rid", "endpoints"])) return null;
      const eps = parseEndpoints(f["endpoints"]);
      return eps === null ? null : { t: "model_hello", v: 1, rid: e.pageRid, endpoints: eps };
    }
    if (e.kind === "probe" && t === "model_health") {
      if (!hasKeys(f, ["t", "v", "rid", "id", "state", "rung"])) return null;
      const { id, state, rung } = f;
      if (id !== e.endpointId || typeof state !== "string" || !STATES.has(state)) return null;
      if (!(rung === 1 || rung === 2 || rung === 3)) return null; /* null only in local answers (A-U49b) */
      return { t: "model_health", v: 1, rid: e.pageRid, id: e.endpointId, state, rung };
    }
    if (e.kind === "generate" && t === "model_result") {
      if (!hasKeys(f, ["t", "v", "rid", "text"])) return null;
      const text = f["text"];
      return typeof text === "string" ? { t: "model_result", v: 1, rid: e.pageRid, text } : null;
    }
    return null;
  };

  const handleHost = (f: unknown): void => {
    if (!isRecord(f)) return;
    const t = f["t"];
    if (t === "hello") {
      reset();
      return;
    }
    if (typeof t !== "string" || !t.startsWith("model_")) return;
    if (t === "model_hello" && !Object.prototype.hasOwnProperty.call(f, "rid")) {
      if (!hasKeys(f, ["t", "v", "endpoints"]) || !isInt(f["v"]) || f["v"] !== 1) return;
      const eps = parseEndpoints(f["endpoints"]);
      if (eps === null) return;
      ready = true;
      cache = new Map(eps.map((ep) => [ep.id, ep] as const));
      for (const p of [...ports]) deliver(p, { t: "model_hello", v: 1, endpoints: eps.map((ep) => ({ ...ep })) });
      return;
    }
    const rid = f["rid"];
    if (!isRid(rid)) return;
    const e = entries.get(rid);
    if (e === undefined || e.state !== "inflight") {
      late += 1;
      return;
    }
    const reply = pageReply(e, f);
    finish(e, reply ?? { t: "model_nack", v: 1, rid: e.pageRid, code: "bad_reply" });
    pump();
  };

  try {
    native.onFrame((f) => {
      try {
        handleHost(f);
      } catch {
        /* never throw into the native relay */
      }
    });
  } catch {
    /* A-U49r1: no host frames can arrive, so `ready` stays false and every request is answered locally. */
  }

  function closePort(port: ChromePortLike): void {
    ports.delete(port);
    const m = byPort.get(port);
    byPort.delete(port);
    if (m === undefined) return;
    for (const relayRid of m.values()) {
      const e = entries.get(relayRid);
      if (e === undefined) continue;
      if (e.state === "queued" || e.kind === "list") {
        detach(e);
        continue;
      }
      e.port = null; /* orphan: holds the slot until the host answers (J9) or its budget expires */
      if (!sendCancel(e)) detach(e);
    }
    pump();
  }

  return {
    onPortMessage(port: ChromePortLike, msg: unknown): void {
      try {
        handlePage(port, msg);
      } catch {
        /* never throws */
      }
    },
    onPortClosed(port: ChromePortLike): void {
      try {
        closePort(port);
      } catch {
        /* never throws */
      }
    },
    stats(): ModelRelayStats {
      let pending = 0;
      for (const e of entries.values()) if (e.port !== null) pending += 1;
      return { forwarded, delivered, dropped, late, nacked, pending, queued: queue.length, ports: ports.size };
    },
  };
}
