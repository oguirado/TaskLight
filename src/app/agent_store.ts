// U37b: agent store + view models. Spec: SPEC_U37 section "U37b".
import { diffPlans, foldRoomWithStats, formatUserTime, toTaskVM } from "../agents";
import type { AgentState, DriftVerdict, RoomEvent } from "../agents/types";
import type { AgentChatVM, ChatMessageVM } from "../agentsui/types";
import type { AccentVM, WallVM } from "../views/types";

export interface AgentStoreOptions { maxPerRoom?: number }
export interface IngestSummary { accepted: number; duplicate: number; malformed: number; torn: boolean }
export interface AgentStore {
  ingest(ev: unknown): boolean;
  ingestJsonl(text: string): IngestSummary;
  since(): Record<string, number>;
  states(): AgentState[];
  events(room: string): RoomEvent[];
}
export interface ChatOpts { userAgent: string; nowMs: number; drift?: DriftVerdict; sending: boolean }
export interface WallOpts { nowMs: number; model: WallVM["model"]; network: WallVM["network"]; userAgent?: string }

const ACTS: ReadonlySet<string> = new Set([
  "open", "plan", "step", "question", "answer", "handoff", "ack", "heartbeat", "verdict", "close",
]);
const STEP_STATES: ReadonlySet<string> = new Set(["done", "active", "blocked", "pending"]);
const CHAT_ACTS: ReadonlySet<string> = new Set(["question", "answer", "verdict"]);
const ID_RE = /^e-[0-9a-f]{16}$/;
const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const AGENT_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const TEXT_MAX_BYTES = 4096;
const TS_MAX_ABS = 8.64e15; // JS Date valid range (+/- 8,640,000,000,000,000 ms)
const SILENT_AFTER_MS = 600_000;
const ACCENTS: readonly AccentVM[] = ["rose", "iris", "sky", "slate", "lagoon", "saffron"];
const encoder = new TextEncoder();

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Stricter than U34's shape check: id/room/agent slugs, lamport >= 1, 4096 UTF-8 byte cap. */
function validEvent(v: unknown): v is RoomEvent {
  if (!isRecord(v)) return false;
  const id = v["id"]; if (typeof id !== "string" || !ID_RE.test(id)) return false;
  const room = v["room"]; if (typeof room !== "string" || !ROOM_RE.test(room)) return false;
  const agent = v["agent"]; if (typeof agent !== "string" || !AGENT_RE.test(agent)) return false;
  const act = v["act"]; if (typeof act !== "string" || !ACTS.has(act)) return false;
  const lamport = v["lamport"];
  if (typeof lamport !== "number" || !Number.isInteger(lamport) || lamport < 1) return false;
  const ts = v["ts"]; if (typeof ts !== "number" || !Number.isFinite(ts) || Math.abs(ts) > TS_MAX_ABS) return false;
  const text = v["text"];
  if (typeof text !== "string" || encoder.encode(text).length > TEXT_MAX_BYTES) return false;
  if (v["re"] !== undefined && typeof v["re"] !== "string") return false;
  if (v["to"] !== undefined && typeof v["to"] !== "string") return false;
  if (v["evidence"] !== undefined && !Array.isArray(v["evidence"])) return false;
  const plan = v["plan"];
  if (plan !== undefined) {
    if (!isRecord(plan) || typeof plan["title"] !== "string") return false;
    const steps = plan["steps"];
    if (!Array.isArray(steps) || steps.length === 0) return false;
    for (const s of steps) {
      if (!isRecord(s) || typeof s["text"] !== "string") return false;
      const accept = s["accept"];
      if (accept !== undefined && typeof accept !== "string") return false;
    }
  }
  if (act === "plan" && plan === undefined) return false;
  const step = v["step"];
  if (step !== undefined) {
    if (!isRecord(step)) return false;
    if (typeof step["index"] !== "number" || !Number.isInteger(step["index"]) || step["index"] < 0) return false;
    if (typeof step["state"] !== "string" || !STEP_STATES.has(step["state"])) return false;
  }
  if (act === "step" && step === undefined) return false;
  return true;
}

const compareEvents = (a: RoomEvent, b: RoomEvent): number =>
  a.lamport !== b.lamport ? a.lamport - b.lamport : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const cloneEvent = (e: RoomEvent): RoomEvent => {
  const c: RoomEvent = { ...e };
  if (e.plan !== undefined) {
    c.plan = {
      title: e.plan.title,
      steps: e.plan.steps.map((s) => (s.accept === undefined ? { text: s.text } : { text: s.text, accept: s.accept })),
    };
  }
  if (e.step !== undefined) c.step = { ...e.step };
  if (e.evidence !== undefined) c.evidence = e.evidence.map((x) => ({ ...x }));
  return c;
};

export function createAgentStore(opts?: AgentStoreOptions): AgentStore {
  const maxPerRoom = opts?.maxPerRoom ?? 5000;
  if (!Number.isInteger(maxPerRoom) || maxPerRoom <= 0) {
    throw new RangeError(`maxPerRoom must be a positive integer, got ${String(maxPerRoom)}`);
  }
  const seen = new Set<string>();
  const rooms = new Map<string, RoomEvent[]>();
  const maxLamport = new Map<string, number>();

  const ingest = (ev: unknown): boolean => {
    if (!validEvent(ev)) return false;
    if (seen.has(ev.id)) return false;
    seen.add(ev.id);
    let list = rooms.get(ev.room);
    if (list === undefined) {
      list = [];
      rooms.set(ev.room, list);
    }
    list.push(cloneEvent(ev));
    if (list.length > maxPerRoom) {
      list.sort(compareEvents);
      list.splice(0, list.length - maxPerRoom);
    }
    const cur = maxLamport.get(ev.room);
    if (cur === undefined || ev.lamport > cur) maxLamport.set(ev.room, ev.lamport);
    return true;
  };

  return {
    ingest,
    ingestJsonl(text: string): IngestSummary {
      const summary: IngestSummary = { accepted: 0, duplicate: 0, malformed: 0, torn: false };
      if (typeof text !== "string" || text.length === 0) return summary;
      try {
        const endsWithNewline = text.endsWith("\n");
        const segments = text.split("\n");
        for (let i = 0; i < segments.length; i++) {
          const complete = !(i === segments.length - 1 && !endsWithNewline);
          let line = segments[i] as string;
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.trim() === "") continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            if (complete) summary.malformed += 1;
            else summary.torn = true;
            continue;
          }
          if (!validEvent(parsed)) {
            summary.malformed += 1;
            continue;
          }
          if (seen.has(parsed.id)) {
            summary.duplicate += 1;
            continue;
          }
          if (ingest(parsed)) summary.accepted += 1;
          else summary.duplicate += 1;
        }
      } catch {
        /* never throws */
      }
      return summary;
    },
    since(): Record<string, number> {
      return Object.fromEntries(maxLamport);
    },
    states(): AgentState[] {
      const all: RoomEvent[] = [];
      for (const list of rooms.values()) all.push(...list);
      return foldRoomWithStats(all).states;
    },
    events(room: string): RoomEvent[] {
      const list = rooms.get(room);
      if (list === undefined) return [];
      return list.map(cloneEvent).sort(compareEvents);
    },
  };
}

/* ------------------------------------------------------------------ */
/* toChatVM (U35 view model from a folded state + events)              */
/* ------------------------------------------------------------------ */

function isChatEvent(e: unknown): e is RoomEvent {
  if (!isRecord(e)) return false;
  if (typeof e["id"] !== "string") return false;
  if (typeof e["lamport"] !== "number" || !Number.isInteger(e["lamport"])) return false;
  if (typeof e["ts"] !== "number" || !Number.isFinite(e["ts"]) || Math.abs(e["ts"] as number) > TS_MAX_ABS) return false;
  if (typeof e["room"] !== "string" || typeof e["agent"] !== "string" || typeof e["text"] !== "string") return false;
  if (typeof e["act"] !== "string" || !CHAT_ACTS.has(e["act"])) return false;
  return true;
}

export function toChatVM(state: AgentState, events: readonly RoomEvent[], opts: ChatOpts): AgentChatVM {
  const list = Array.isArray(events) ? (events as readonly unknown[]) : [];
  const relevant = list
    .filter((e): e is RoomEvent => isChatEvent(e) && e.room === state.room && (e.agent === state.agent || e.to === state.agent))
    .sort(compareEvents);
  const messages: ChatMessageVM[] = relevant.map((e) => {
    const msg: ChatMessageVM = {
      id: e.id,
      from: e.agent === opts.userAgent ? "user" : e.act === "verdict" ? "nano" : "agent",
      agent: e.agent,
      text: e.text,
      at: formatUserTime(e.ts, opts.nowMs),
    };
    if (typeof e.re === "string") msg.re = e.re;
    return msg;
  });
  const silent = !state.closed && opts.nowMs - state.lastSeen > SILENT_AFTER_MS;
  const vm: AgentChatVM = {
    room: state.room,
    agent: state.agent,
    title: state.contract !== undefined ? state.contract.title : `${state.agent} (no plan yet)`,
    messages,
    silent,
    sending: opts.sending,
  };
  if (silent) {
    const totalMin = Math.floor((opts.nowMs - state.lastSeen) / 60_000);
    if (totalMin < 60) vm.silentFor = `${totalMin} min`;
    else {
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      vm.silentFor = m === 0 ? `${h} h` : `${h} h ${m} min`;
    }
  }
  if (opts.drift !== undefined) {
    const d = opts.drift;
    let added: string[] = [];
    let removed: string[] = [];
    if (state.previous !== undefined && state.contract !== undefined) {
      const diff = diffPlans(state.previous, state.contract);
      added = [...diff.added, ...diff.edited.map((x) => x.to)];
      removed = [...diff.removed, ...diff.edited.map((x) => x.from)];
    }
    vm.drift = { verdict: d.verdict, reason: d.reason, source: d.source, added, removed };
  }
  return vm;
}

/* ------------------------------------------------------------------ */
/* toWallVM (U36 wall from all folded states)                          */
/* ------------------------------------------------------------------ */

export function toWallVM(
  states: readonly AgentState[],
  verdicts: ReadonlyMap<string, DriftVerdict>,
  opts: WallOpts,
): WallVM {
  // U38 G5: the human user is never an agent task.
  const visible = opts.userAgent !== undefined
    ? states.filter((s) => s.agent !== opts.userAgent)
    : states;
  const sorted = [...visible].sort((a, b) =>
    a.room !== b.room ? (a.room < b.room ? -1 : 1) : a.agent !== b.agent ? (a.agent < b.agent ? -1 : 1) : 0,
  );
  const rooms: string[] = [];
  for (const s of sorted) if (!rooms.includes(s.room)) rooms.push(s.room);
  const accentOf = new Map<string, AccentVM>();
  rooms.forEach((r, i) => accentOf.set(r, ACCENTS[i % ACCENTS.length] as AccentVM));
  const workspaces = rooms.map((r) => ({ id: r, name: r, lens: "dev" as const, accent: accentOf.get(r) as AccentVM }));
  const tasks = sorted.map((s) => {
    const v = verdicts.get(`agent:${s.room}:${s.agent}`);
    const accent = accentOf.get(s.room) as AccentVM;
    return v === undefined
      ? toTaskVM(s, { workspace: s.room, nowMs: opts.nowMs, accent })
      : toTaskVM(s, { workspace: s.room, nowMs: opts.nowMs, accent, verdict: v });
  });
  return {
    now: formatUserTime(opts.nowMs, opts.nowMs),
    model: opts.model,
    network: opts.network,
    workspaces,
    workspace: rooms[0] ?? "",
    view: "wall",
    archiveScope: "workspace",
    tasks,
    agenda: [],
    archive: [],
  };
}
