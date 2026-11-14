import type { Clock, EnqueueResult, QueueState, QueuedEvent, Router, RouterReject, RouterStats, SessionStore } from "./types";
import { EXT_LIMITS } from "./limits";

const KEY = "u13.queue";
const MAX_MSG_CHARS = 65536;
const MAX_PROJECT_ID_CHARS = 128;
const SENTINEL_SEQ = 2147483647;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isValidQueuedEvent(v: unknown): v is QueuedEvent {
  if (!isPlainObject(v)) return false;
  return (
    Number.isInteger(v["id"]) &&
    typeof v["projectId"] === "string" &&
    "payload" in v &&
    typeof v["chars"] === "number" &&
    typeof v["receivedAt"] === "number"
  );
}

function emptyState(nextId: number): QueueState {
  return { v: 1, nextId, items: [], totalChars: 0, dropped: 0 };
}

export function createRouter(d: { store: SessionStore; clock: Clock; notify: () => void }): Router {
  let state: QueueState = emptyState(1);
  const leased = new Set<number>();
  let accepted = 0;
  const rejected: Record<RouterReject, number> = {
    BAD_SHAPE: 0,
    PROJECT_ID_INVALID: 0,
    TOO_LARGE: 0,
    STORE_FAILED: 0,
  };
  let chain: Promise<void> = Promise.resolve();

  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    let out!: Promise<T>;
    chain = chain.then(async () => {
      out = fn();
      await out.then(
        () => {},
        () => {},
      );
    });
    return chain.then(() => out);
  };

  const totalOf = (items: readonly QueuedEvent[]): number =>
    items.reduce((n, e) => n + e.chars, 0);

  return {
    async load(): Promise<void> {
      leased.clear();
      let raw: unknown;
      try {
        raw = await d.store.get(KEY);
      } catch {
        state = emptyState(1);
        return;
      }
      const nextIdValid =
        isPlainObject(raw) &&
        Number.isInteger(raw["nextId"]) &&
        (raw["nextId"] as number) >= 1;
      const preserved = nextIdValid ? (raw as { nextId: number }).nextId : 1;
      if (
        !isPlainObject(raw) ||
        raw["v"] !== 1 ||
        !Number.isInteger(raw["nextId"]) ||
        (raw["nextId"] as number) < 1 ||
        !Array.isArray(raw["items"]) ||
        typeof raw["totalChars"] !== "number" ||
        typeof raw["dropped"] !== "number"
      ) {
        state = emptyState(preserved);
        return;
      }
      const items = raw["items"] as unknown[];
      if (!items.every(isValidQueuedEvent)) {
        state = emptyState(preserved);
        return;
      }
      const seen = new Set<number>();
      const kept = (items as QueuedEvent[])
        .slice()
        .sort((a, b) => a.id - b.id)
        .filter((e) => {
          if (seen.has(e.id)) return false;
          seen.add(e.id);
          return true;
        })
        .map((e) => ({
          id: e.id,
          projectId: e.projectId,
          payload: e.payload,
          chars: e.chars,
          receivedAt: e.receivedAt,
        }));
      let maxId = 0;
      for (const e of kept) if (e.id > maxId) maxId = e.id;
      state = {
        v: 1,
        nextId: Math.max(raw["nextId"] as number, maxId + 1),
        items: kept,
        totalChars: totalOf(kept),
        dropped: raw["dropped"] as number,
      };
    },

    accept(raw: unknown): Promise<EnqueueResult> {
      return serialize(async (): Promise<EnqueueResult> => {
        if (typeof raw !== "object") {
          return { ok: false, code: "BAD_SHAPE" };
        }
        if (
          !isPlainObject(raw) ||
          typeof raw["projectId"] !== "string" ||
          !("payload" in raw)
        ) {
          rejected.BAD_SHAPE++;
          return { ok: false, code: "BAD_SHAPE" };
        }
        const projectId = raw["projectId"] as string;
        const payload = raw["payload"];
        if (projectId.length < 1 || projectId.length > MAX_PROJECT_ID_CHARS) {
          rejected.PROJECT_ID_INVALID++;
          return { ok: false, code: "PROJECT_ID_INVALID" };
        }
        let chars: number;
        try {
          chars = JSON.stringify({
            t: "event",
            v: 1,
            seq: SENTINEL_SEQ,
            projectId,
            payload,
          }).length;
        } catch {
          rejected.BAD_SHAPE++;
          return { ok: false, code: "BAD_SHAPE" };
        }
        if (chars > MAX_MSG_CHARS) {
          rejected.TOO_LARGE++;
          return { ok: false, code: "TOO_LARGE" };
        }
        const item: QueuedEvent = {
          id: state.nextId,
          projectId,
          payload,
          chars,
          receivedAt: d.clock.now(),
        };
        const items = [...state.items, item];
        const evictedIds: number[] = [];
        let dropped = state.dropped;
        while (
          items.length > EXT_LIMITS.QUEUE_MAX_EVENTS ||
          totalOf(items) > EXT_LIMITS.QUEUE_MAX_CHARS
        ) {
          const ev = items.shift()!;
          evictedIds.push(ev.id);
          dropped++;
        }
        const next: QueueState = {
          v: 1,
          nextId: state.nextId + 1,
          items,
          totalChars: totalOf(items),
          dropped,
        };
        try {
          await d.store.set(KEY, next);
        } catch {
          rejected.STORE_FAILED++;
          return { ok: false, code: "STORE_FAILED" };
        }
        state = next;
        accepted++;
        d.notify();
        return { ok: true, id: item.id, evictedIds };
      });
    },

    async lease(max: number): Promise<QueuedEvent[]> {
      if (max <= 0) return [];
      const out: QueuedEvent[] = [];
      for (const e of state.items) {
        if (out.length >= max) break;
        if (!leased.has(e.id)) {
          leased.add(e.id);
          out.push({ ...e });
        }
      }
      return out;
    },

    commit(ids: readonly number[]): Promise<void> {
      return serialize(async () => {
        if (ids.length === 0) return;
        const gone = new Set(ids);
        const items = state.items.filter((e) => !gone.has(e.id));
        if (items.length === state.items.length) {
          for (const id of gone) leased.delete(id);
          return;
        }
        const next: QueueState = {
          v: 1,
          nextId: state.nextId,
          items,
          totalChars: totalOf(items),
          dropped: state.dropped,
        };
        try {
          await d.store.set(KEY, next);
        } catch (e) {
          // Memory never runs ahead of storage; lease ownership is released so the event can be re-leased.
          for (const id of gone) leased.delete(id);
          throw e;
        }
        state = next;
        for (const id of gone) leased.delete(id);
      });
    },

    peek(): readonly QueuedEvent[] {
      return state.items.map((e) => ({ ...e }));
    },

    stats(): RouterStats {
      return {
        accepted,
        rejected: { ...rejected },
        dropped: state.dropped,
        depth: state.items.length,
        totalChars: state.totalChars,
      };
    },
  };
}
