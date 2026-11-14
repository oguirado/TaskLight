import type { AgentState, Contract, RoomEvent, StepState } from "../../../src/agents/types";

export const T0 = 1_700_000_000_000;
export const ROOM = "launch";

export const hex = (n: number): string => `e-${n.toString(16).padStart(16, "0")}`;

type Extra = Partial<Pick<RoomEvent, "re" | "to" | "plan" | "step" | "evidence">>;
export const ev = (lamport: number, agent: string, act: RoomEvent["act"], text: string, extra: Extra = {}, id: string = hex(lamport), room: string = ROOM): RoomEvent =>
  ({ id, lamport, ts: T0 + lamport * 60_000, room, agent, act, text, ...extra });

export const PLAN_V1 = { title: "Refactor auth module", steps: [
  { text: "Read current auth code" },
  { text: "Write failing tests", accept: "Tests fail for the right reason" },
  { text: "Implement token refresh" },
  { text: "Update docs" },
] };
export const PLAN_V2 = { title: "Refactor auth module", steps: [
  { text: "Read current auth code" },
  { text: "Write failing tests", accept: "Tests fail for the right reason" },
  { text: "Implement token refresh" },
  { text: "Add rotation tests" },
  { text: "Update docs" },
] };
export const CODEX_PLAN = { title: "Review harness", steps: [{ text: "Set up fixtures" }, { text: "Run suite", accept: "All green" }] };

/** Two agents, plan v1 -> v2, steps, one answered question, one open question, close. Lamports 1..17, all distinct. */
export const ROOM_EVENTS: RoomEvent[] = [
  ev(1, "claude", "open", "Starting the auth refactor"),
  ev(2, "claude", "plan", "Plan v1", { plan: PLAN_V1 }),
  ev(3, "codex", "open", "Joining as reviewer"),
  ev(4, "codex", "plan", "Review plan", { plan: CODEX_PLAN }),
  ev(5, "claude", "step", "Read it", { step: { index: 0, state: "done", outcome: "Mapped 3 entry points", took: "4m" } }),
  ev(6, "claude", "step", "Writing tests", { step: { index: 1, state: "active" } }),
  ev(7, "codex", "step", "Fixtures", { step: { index: 0, state: "done", outcome: "Fixtures ready", took: "2m" } }),
  ev(8, "claude", "question", "Should refresh tokens rotate?", { to: "codex" }),
  ev(9, "codex", "answer", "Yes, rotate on every use", { re: hex(8), to: "claude" }),
  ev(10, "claude", "step", "Tests written", { step: { index: 1, state: "done", outcome: "12 tests red", took: "9m" } }),
  ev(11, "claude", "step", "Implementing", { step: { index: 2, state: "active" } }),
  ev(12, "claude", "plan", "Plan v2: add rotation tests", { plan: PLAN_V2 }),
  ev(13, "codex", "step", "Running suite", { step: { index: 1, state: "active" } }),
  ev(14, "codex", "heartbeat", "still here"),
  ev(15, "claude", "step", "Rotation tests", { step: { index: 3, state: "done", outcome: "5 tests", took: "6m" } }),
  ev(16, "codex", "question", "Do I need staging credentials?", { to: "claude" }),
  ev(17, "claude", "close", "Auth refactor shipped"),
];

export const eventById = (id: string): RoomEvent => {
  const e = ROOM_EVENTS.find((x) => x.id === id);
  if (!e) throw new Error(`no fixture event ${id}`);
  return e;
};

/** mulberry32 seeded PRNG */
export const prng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const shuffled = <T>(xs: readonly T[], rnd: () => number): T[] => {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i] as T; a[i] = a[j] as T; a[j] = t;
  }
  return a;
};

export const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o as object)) deepFreeze((o as Record<string, unknown>)[k]);
  }
  return o;
};

export const contract = (title: string, texts: readonly string[], version = 1, lamport = 1): Contract =>
  ({ title, steps: texts.map((text) => ({ text })), hash: "00000000", version, lamport });

export const mkState = (over: Partial<AgentState> & { stepStates?: StepState[] } = {}, texts: readonly string[] | null = null): AgentState => {
  const c = texts ? contract("Plan", texts) : over.contract;
  const n = c ? c.steps.length : 0;
  const base: AgentState = {
    room: ROOM, agent: "claude", stepStates: Array.from({ length: n }, (): StepState => "pending"),
    outcomes: Array.from({ length: n }, () => undefined), took: Array.from({ length: n }, () => undefined),
    lastSeen: T0, openQuestions: [], closed: false,
  };
  if (c) base.contract = c;
  return { ...base, ...over, ...(c ? { contract: c } : {}) };
};

/** True when the string contains an unpaired UTF-16 surrogate. */
export const hasLoneSurrogate = (s: string): boolean => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
