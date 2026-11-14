import type { Connector, HostEnv, HostReply, IngestSink, ReplyTarget } from "./types";

export const CONNECTOR_PROTOCOL = 1 as const;
export const CONNECTOR_LIMITS = { MAX_MSG_CHARS: 65536, MAX_EVENTS_PER_SEC: 50, MAX_PROJECT_ID_CHARS: 128 } as const;

interface Session {
  lastSeq: number | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function createConnector(env: HostEnv, sink: IngestSink, nowMs: () => number): Connector {
  const origins = new Set<string>(env.extensionOrigins);
  const sessions = new Map<string, Session>();
  const windows = new Map<string, number[]>();
  let accepted = 0;
  let nacked = 0;
  let droppedOrigin = 0;

  function reply(source: ReplyTarget, origin: string, msg: HostReply): void {
    source.postMessage(msg, origin);
  }

  void reply;

  return {
    onMessage(ev: { origin: string; data: unknown; source: ReplyTarget | null }): void {
      if (!origins.has(ev.origin)) {
        droppedOrigin++;
        return;
      }
      const source = ev.source;
      if (source === null) return;

      let serialized: string;
      try {
        const s = JSON.stringify(ev.data);
        if (s === undefined) throw new Error("unserialisable");
        serialized = s;
      } catch {
        nacked++;
        reply(source, ev.origin, { t: "nack", v: 1, code: "BAD_SHAPE" });
        return;
      }
      if (serialized.length > CONNECTOR_LIMITS.MAX_MSG_CHARS) {
        const seqGuess = eventSeq(ev.data);
        nacked++;
        reply(source, ev.origin, seqGuess !== undefined
          ? { t: "nack", v: 1, code: "TOO_LARGE", seq: seqGuess }
          : { t: "nack", v: 1, code: "TOO_LARGE" });
        return;
      }

      const data = ev.data;
      if (!isRecord(data) || typeof data["t"] !== "string") {
        nacked++;
        reply(source, ev.origin, { t: "nack", v: 1, code: "BAD_SHAPE" });
        return;
      }
      const t = data["t"] as string;
      if (t !== "hello" && t !== "event" && t !== "bye") {
        nacked++;
        reply(source, ev.origin, { t: "nack", v: 1, code: "BAD_SHAPE" });
        return;
      }
      const v = data["v"];
      if (typeof v !== "number" || !Number.isInteger(v)) {
        nacked++;
        reply(source, ev.origin, { t: "nack", v: 1, code: "BAD_SHAPE" });
        return;
      }
      if (v !== CONNECTOR_PROTOCOL) {
        const s = t === "event" ? eventSeq(data) : undefined;
        nacked++;
        reply(source, ev.origin, s !== undefined
          ? { t: "nack", v: 1, code: "UNSUPPORTED_VERSION", seq: s }
          : { t: "nack", v: 1, code: "UNSUPPORTED_VERSION" });
        return;
      }

      if (t === "hello") {
        const nonce = data["nonce"];
        if (typeof nonce !== "string") {
          nacked++;
          reply(source, ev.origin, { t: "nack", v: 1, code: "BAD_SHAPE" });
          return;
        }
        // Commit the handshake only after the ack is delivered.
        reply(source, ev.origin, { t: "ack", v: 1, nonce });
        sessions.set(ev.origin, { lastSeq: null });
        return;
      }

      if (t === "bye") {
        sessions.delete(ev.origin);
        return;
      }

      // t === "event"
      const seq = eventSeq(data);
      const projectId = data["projectId"];
      if (
        seq === undefined ||
        typeof projectId !== "string" ||
        projectId.length === 0 ||
        projectId.length > CONNECTOR_LIMITS.MAX_PROJECT_ID_CHARS
      ) {
        nacked++;
        reply(source, ev.origin, seq !== undefined
          ? { t: "nack", v: 1, code: "BAD_SHAPE", seq }
          : { t: "nack", v: 1, code: "BAD_SHAPE" });
        return;
      }

      const session = sessions.get(ev.origin);
      if (session === undefined) {
        nacked++;
        reply(source, ev.origin, { t: "nack", v: 1, code: "NO_HANDSHAKE", seq });
        return;
      }
      if (session.lastSeq !== null && seq <= session.lastSeq) {
        nacked++;
        reply(source, ev.origin, { t: "nack", v: 1, code: "SEQ_NOT_MONOTONIC", seq });
        return;
      }

      const now = nowMs();
      const win = (windows.get(ev.origin) ?? []).filter((ts) => ts > now - 1000);
      if (win.length >= CONNECTOR_LIMITS.MAX_EVENTS_PER_SEC) {
        windows.set(ev.origin, win);
        nacked++;
        reply(source, ev.origin, { t: "nack", v: 1, code: "THROTTLED", seq });
        return;
      }
      // Commit sequence, rate window and counters only after the sink accepts.
      sink.accept(projectId, seq, data["payload"]);
      win.push(now);
      windows.set(ev.origin, win);
      session.lastSeq = seq;
      accepted++;
    },
    stats(): { accepted: number; nacked: number; droppedOrigin: number } {
      return { accepted, nacked, droppedOrigin };
    },
  };
}

function eventSeq(data: unknown): number | undefined {
  if (!isRecord(data)) return undefined;
  const s = data["seq"];
  if (typeof s !== "number" || !Number.isInteger(s)) return undefined;
  return s;
}
