import { foldRoomWithStats } from "../../../src/agents";
import type { AgentState, RoomEvent } from "../../../src/agents/types";

export const T0 = 1_700_000_000_000;
const MIN = 60_000;
/** Wall clock used by every U37b test: minute 45 after T0. */
export const NOW = T0 + 45 * MIN;
export const USER = "wall-user";

/** U38 V1 oracle (independent of the implementation): local `HH:MM` today, `Yesterday HH:MM`, `D Mon HH:MM` older. */
export const userTime = (ts: number, nowMs: number): string => {
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const d = new Date(ts); const n = new Date(nowMs);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (x: Date): number => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
  const diff = Math.round((day(n) - day(d)) / 86_400_000);
  return diff === 0 ? hm : diff === 1 ? `Yesterday ${hm}` : `${d.getDate()} ${M[d.getMonth()]} ${hm}`;
};

export const idOf = (n: number): string => `e-${n.toString(16).padStart(16, "0")}`;

type Extra = Partial<Pick<RoomEvent, "re" | "to" | "plan" | "step" | "evidence">>;
const mk = (base: number, room: string, lamport: number, minute: number, agent: string, act: RoomEvent["act"], text: string, extra: Extra = {}): RoomEvent =>
  ({ id: idOf(base + lamport), lamport, ts: T0 + minute * MIN, room, agent, act, text, ...extra });

export const pick = <T>(arr: readonly T[], i: number): T => {
  const v = arr[i];
  if (v === undefined) throw new Error(`fixture index ${i} out of range`);
  return v;
};

/* ---- plans ---- */
export const PLAN_V1 = { title: "Refactor auth module", steps: [
  { text: "Read current auth code" },
  { text: "Write failing tests", accept: "Tests fail for the right reason" },
  { text: "Implement token refresh" },
  { text: "Update docs" },
] };
/** v2 EDITS step 2 ("Implement token refresh"), which is `active` when v2 arrives. */
export const PLAN_V2 = { title: "Refactor auth module", steps: [
  { text: "Read current auth code" },
  { text: "Write failing tests", accept: "Tests fail for the right reason" },
  { text: "Implement token refresh with rotation" },
  { text: "Update docs" },
] };
export const PLAN_V3_ADD = { title: PLAN_V2.title, steps: [...PLAN_V2.steps, { text: "Publish changelog" }] };
export const PLAN_V3_DROP_PENDING = { title: PLAN_V2.title, steps: PLAN_V2.steps.filter((s) => s.text !== "Update docs") };
export const PLAN_V3_DROP_DONE = { title: PLAN_V2.title, steps: PLAN_V2.steps.filter((s) => s.text !== "Read current auth code") };
export const CODEX_PLAN = { title: "Review harness", steps: [{ text: "Set up fixtures" }, { text: "Run suite", accept: "All green" }] };
export const WRITER_PLAN = { title: "Ship docs site", steps: [{ text: "Outline pages" }, { text: "Draft quickstart" }, { text: "Review links" }] };
export const GEMINI_PLAN = { title: "Collect screenshots", steps: [{ text: "Capture dashboards" }, { text: "Caption them" }] };

/* ---- room "launch": claude + codex (lamports 1..14, minutes 30..44) ---- */
export const LAUNCH = "launch";
const L = 0x100;
export const LAUNCH_EVENTS: RoomEvent[] = [
  mk(L, LAUNCH, 1, 30, "claude", "open", "Starting the auth refactor"),
  mk(L, LAUNCH, 2, 30, "claude", "plan", "Plan v1", { plan: PLAN_V1 }),
  mk(L, LAUNCH, 3, 31, "codex", "open", "Joining as reviewer"),
  mk(L, LAUNCH, 4, 31, "codex", "plan", "Review plan", { plan: CODEX_PLAN }),
  mk(L, LAUNCH, 5, 32, "claude", "step", "Read it", { step: { index: 0, state: "done", outcome: "Mapped 3 entry points", took: "4m" } }),
  mk(L, LAUNCH, 6, 33, "claude", "step", "Tests written", { step: { index: 1, state: "done", outcome: "12 tests red", took: "9m" } }),
  mk(L, LAUNCH, 7, 34, "claude", "step", "Implementing", { step: { index: 2, state: "active" } }),
  mk(L, LAUNCH, 8, 34, "codex", "step", "Fixtures", { step: { index: 0, state: "done", outcome: "Fixtures ready", took: "2m" } }),
  mk(L, LAUNCH, 9, 35, "claude", "question", "Should refresh tokens rotate?", { to: "codex" }),
  mk(L, LAUNCH, 10, 36, "codex", "answer", "Yes, rotate on every use", { re: idOf(L + 9), to: "claude" }),
  mk(L, LAUNCH, 11, 37, "codex", "step", "Running suite", { step: { index: 1, state: "active" } }),
  mk(L, LAUNCH, 12, 42, "claude", "plan", "Plan v2: rotation", { plan: PLAN_V2 }),
  mk(L, LAUNCH, 13, 43, "codex", "heartbeat", "still here"),
  mk(L, LAUNCH, 14, 44, "codex", "question", "Do I need staging credentials?", { to: "claude" }),
];
/** Chat-only events (user, claude reply, Nano verdict); fed to toChatVM, never to the store. */
export const CHAT_EVENTS: RoomEvent[] = [
  mk(L, LAUNCH, 15, 44, USER, "question", "Why rotate refresh tokens on every use?", { to: "claude" }),
  mk(L, LAUNCH, 16, 44, "claude", "answer", "Reuse detection needs rotation", { re: idOf(L + 15), to: USER }),
  mk(L, LAUNCH, 17, 44, "nano", "verdict", "Plan v2 edits a step that was in progress", { to: "claude" }),
];
/** Later plan edits by claude (applied on top of v2). */
export const planV3 = (plan: { title: string; steps: { text: string; accept?: string }[] }): RoomEvent =>
  mk(L, LAUNCH, 20, 43, "claude", "plan", "Plan v3", { plan });

/* ---- room "docs-site": writer + gemini (lamports 1..7); gemini goes silent after minute 4 ---- */
export const DOCS = "docs-site";
const D = 0x200;
export const DOCS_EVENTS: RoomEvent[] = [
  mk(D, DOCS, 1, 2, "gemini", "open", "Collecting screenshots"),
  mk(D, DOCS, 2, 2, "gemini", "plan", "Screenshot plan", { plan: GEMINI_PLAN }),
  mk(D, DOCS, 3, 4, "gemini", "step", "Capturing", { step: { index: 0, state: "active" } }),
  mk(D, DOCS, 4, 36, "writer", "open", "Writing the docs"),
  mk(D, DOCS, 5, 36, "writer", "plan", "Docs plan", { plan: WRITER_PLAN }),
  mk(D, DOCS, 6, 38, "writer", "step", "Outline approved", { step: { index: 0, state: "done", outcome: "Outline approved", took: "3m" } }),
  mk(D, DOCS, 7, 41, "writer", "step", "Drafting", { step: { index: 1, state: "active" } }),
];

/** Unique events (21): 2 rooms x 2 agents. */
export const UNIQUE: RoomEvent[] = [...LAUNCH_EVENTS, ...DOCS_EVENTS];
/** At-least-once delivery: 5 redeliveries, including plan v1 re-sent AFTER plan v2 (a fake third version / fake drift without dedup). */
export const STREAM_WITH_DUPES: RoomEvent[] = [
  ...LAUNCH_EVENTS, pick(LAUNCH_EVENTS, 1),
  ...DOCS_EVENTS, pick(LAUNCH_EVENTS, 11), pick(LAUNCH_EVENTS, 1), pick(DOCS_EVENTS, 5), pick(LAUNCH_EVENTS, 4),
];
export const DUP_COUNT = 5;

export const toJsonl = (events: readonly unknown[]): string => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

/** Seeded PRNG (mulberry32) + Fisher-Yates. */
export const shuffled = <T>(arr: readonly T[], seed: number): T[] => {
  let a = seed >>> 0;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const x = pick(out, i); out[i] = pick(out, j); out[j] = x;
  }
  return out;
};

/** Reference fold (U34) used as the expected value for store.states(). */
export const foldAll = (events: readonly unknown[]): AgentState[] => foldRoomWithStats(events).states;
export const stateOf = (states: readonly AgentState[], room: string, agent: string): AgentState => {
  const s = states.find((x) => x.room === room && x.agent === agent);
  if (!s) throw new Error(`no state ${room}/${agent}`);
  return s;
};
/** claude's state in `launch` folded from the unique launch events with lamport <= upto, plus optional extra events. */
export const claudeAt = (upto: number, extra: readonly RoomEvent[] = []): AgentState =>
  stateOf(foldAll([...LAUNCH_EVENTS.filter((e) => e.lamport <= upto), ...extra]), LAUNCH, "claude");
