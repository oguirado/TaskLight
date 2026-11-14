import type {
  AccentVM, AgendaGroupVM, ArchivedVM, AttentionVM, SourceVM, StepStateVM, StepVM, TaskStatusVM, TaskVM, WallVM, WorkspaceVM,
} from "../../../src/views/types";

/** Fri 13 Nov 2026 is "today" in the prototype fixture. */
export const ms = (day: number, h: number, m: number): number => Date.UTC(2026, 10, day, h, m);

const dev = (n: number): SourceVM => ({ kind: "device", ms: n });
const cloud = (n: number): SourceVM => ({ kind: "cloud", ms: n });

export const WORKSPACES: readonly WorkspaceVM[] = [
  { id: "w1", name: "Backend & API", lens: "dev", accent: "rose" },
  { id: "w2", name: "Notes mobile app", lens: "dev", accent: "iris" },
  { id: "w3", name: "Master's thesis", lens: "study", accent: "lagoon" },
];

export const TASKS: readonly TaskVM[] = [
  {
    id: "t1", workspace: "w1", project: "Payments gateway", accent: "rose",
    title: "Webhook migration is waiting for the staging signing key",
    summary: "All 14 handlers use the v2 schema and the contract tests pass locally. The staging deploy stopped because the test signing key is missing; without it, refund events are rejected with 401.",
    status: "blocked", attention: "now", updated: "09:42", source: dev(142),
    next: "Add the test signing key to the staging config and redeploy.",
    steps: [
      { label: "Port handlers to the v2 schema", state: "done", at: "Yesterday 17:10", at_ms: ms(12, 17, 10), day: "Yesterday", took: "2 h 05 min",
        detail: { outcome: "14 handlers moved to the v2 event schema; the v1 adapter is kept for replay.",
          evidence: ["handlers/*.ts — 14 files changed", "schema/v2.json — new", "git: 3 commits on feat/webhooks-v2"], source: dev(131) } },
      { label: "Run contract tests locally", state: "done", at: "Today 09:20", at_ms: ms(13, 9, 20), day: "Today", took: "12 min",
        detail: { outcome: "42 of 42 contract tests pass against the local mock provider.",
          evidence: ["npm test — 42 passed", "coverage 91 % on handlers/"], source: dev(118) } },
      { label: "Deploy to staging", state: "blocked", note: "Missing STAGING_SIGNING_KEY — deploy stopped at 09:42." },
      { label: "Replay yesterday's failed events", state: "pending" },
      { label: "Retire the v1 endpoint", state: "pending" },
    ],
  },
  {
    id: "t2", workspace: "w2", project: "Notes mobile app", accent: "iris",
    title: "Offline sync works, but conflicting edits still overwrite each other",
    summary: "The change queue survives restarts and syncs with one device. With two devices editing the same note, the last write silently wins.",
    status: "waiting", attention: "high", updated: "10:05", source: cloud(1180),
    next: "Decide what wins when two devices edit the same note: last write or a merge.",
    steps: [
      { label: "Persistent change queue", state: "done", at: "Today 08:15", at_ms: ms(13, 8, 15), day: "Today", took: "1 h 40 min",
        detail: { outcome: "Queue stored in IndexedDB; survives app restarts and offline periods.",
          evidence: ["sync/queue.ts — new", "12 unit tests added, all pass"], source: cloud(1180) } },
      { label: "Choose the conflict strategy", state: "active", note: "Waiting on your decision." },
      { label: "Test with two devices", state: "pending" },
    ],
  },
  {
    id: "t3", workspace: "w1", project: "Public API docs", accent: "sky",
    title: "Pagination examples are being written",
    summary: "Reference pages are complete. Cursor pagination needs runnable examples in three languages.",
    status: "running", attention: "low", updated: "18:31", source: dev(97),
    next: "Review the Python example before the Go one is generated.",
    steps: [
      { label: "Reference pages for /v2", state: "done", at: "Wed 11 Nov 16:02", at_ms: ms(11, 16, 2), day: "Wed 11 Nov", took: "3 h",
        detail: { outcome: "38 endpoints documented from the OpenAPI file.", evidence: ["docs/reference — 38 pages", "openapi.yaml validated"], source: dev(104) } },
      { label: "Python example", state: "done", at: "Today 18:12", at_ms: ms(13, 18, 12), day: "Today", took: "19 min",
        detail: { outcome: "Cursor loop with retry; runs against the sandbox.", evidence: ["examples/paginate.py", "ran 3 pages in sandbox"], source: dev(97) } },
      { label: "JavaScript example", state: "active", note: "Drafting — 60 % of the snippet written." },
      { label: "Go example", state: "pending" },
    ],
  },
  {
    id: "t4", workspace: "w1", project: "Monorepo", accent: "slate",
    title: "Dependency cleanup finished",
    summary: "Unused packages removed and lockfile regenerated. Build time dropped and all suites are green.",
    status: "done", attention: "none", updated: "Yesterday", source: dev(88), next: "Nothing to do.", archived: true,
    steps: [
      { label: "Find unused packages", state: "done", at: "Yesterday 11:30", at_ms: ms(12, 11, 30), day: "Yesterday", took: "8 min",
        detail: { outcome: "17 unused packages found by import scan.", evidence: ["depcheck report"], source: dev(90) } },
      { label: "Remove and regenerate lockfile", state: "done", at: "Yesterday 11:52", at_ms: ms(12, 11, 52), day: "Yesterday", took: "15 min",
        detail: { outcome: "Lockfile shrank by 2,140 lines.", evidence: ["package-lock.json"], source: dev(88) } },
      { label: "Run all suites", state: "done", at: "Yesterday 12:20", at_ms: ms(12, 12, 20), day: "Yesterday", took: "21 min",
        detail: { outcome: "All 6 suites green; build 18 % faster.", evidence: ["CI run #482"], source: dev(85) } },
    ],
  },
  {
    id: "t5", workspace: "w3", project: "Thesis — chapter 3", accent: "lagoon",
    title: "Literature review: two sections left",
    summary: "Sections 3.1–3.3 are drafted with 41 sources. Sections 3.4 and 3.5 still need an outline and their key papers.",
    status: "running", attention: "high", updated: "17:55", source: dev(133),
    next: "Outline section 3.4 from your highlighted papers.",
    steps: [
      { label: "Draft sections 3.1–3.3", state: "done", at: "Today 16:40", at_ms: ms(13, 16, 40), day: "Today", took: "2 h 30 min",
        detail: { outcome: "3,900 words drafted; citations linked.", evidence: ["thesis/ch3.md", "41 sources in library"], source: dev(140) } },
      { label: "Outline section 3.4", state: "active", note: "6 highlighted papers ready to group." },
      { label: "Draft section 3.5", state: "pending" },
      { label: "Check citation format", state: "pending" },
    ],
  },
  {
    id: "t6", workspace: "w3", project: "Statistics exam", accent: "saffron",
    title: "Exam prep: hypothesis testing set is next",
    summary: "Probability and distributions are done. Hypothesis testing practice is scheduled for tomorrow morning.",
    status: "idle", attention: "low", updated: "16:10", source: cloud(1340),
    next: "Start practice set 4 tomorrow at 09:00.",
    steps: [
      { label: "Probability review", state: "done", at: "Thu 12 Nov 19:00", at_ms: ms(12, 19, 0), day: "Thu 12 Nov", took: "1 h 15 min",
        detail: { outcome: "Practice set 2: 18 of 20 correct.", evidence: ["notes/probability.md"], source: cloud(1340) } },
      { label: "Distributions review", state: "done", at: "Today 15:50", at_ms: ms(13, 15, 50), day: "Today", took: "50 min",
        detail: { outcome: "Practice set 3: 16 of 20 correct; weak on Poisson.", evidence: ["notes/distributions.md"], source: dev(126) } },
      { label: "Hypothesis testing practice", state: "pending" },
      { label: "Mock exam", state: "pending" },
    ],
  },
];

export const AGENDA: readonly AgendaGroupVM[] = [
  { group: "Waiting on you", items: [
    { when: "Now", task: "t1", what: "Add the staging signing key" },
    { when: "Now", task: "t2", what: "Choose the conflict strategy" } ] },
  { group: "Next up", items: [
    { when: "19:00", task: "t3", what: "Review the JavaScript example" },
    { when: "20:30", task: "t5", what: "Outline section 3.4" } ] },
  { group: "Tomorrow", items: [
    { when: "09:00", task: "t6", what: "Hypothesis testing practice set 4" },
    { when: "11:00", task: "t1", what: "Replay yesterday's failed events" } ] },
];

export const ARCHIVE: readonly ArchivedVM[] = [
  { id: "a1", workspace: "w1", project: "Auth service", accent: "sky", title: "Rate limiting shipped to production",
    archived: "Tue 10 Nov", took: "2 days", steps: 4,
    outcome: "Token-bucket limiter on all public routes; 0 false positives in 24 h of shadow mode.", source: dev(121) },
  { id: "t4", workspace: "w1", project: "Monorepo", accent: "slate", title: "Dependency cleanup finished",
    archived: "Yesterday", took: "44 min", steps: 3,
    outcome: "17 unused packages removed; build 18 % faster; all suites green.", source: dev(88) },
  { id: "a2", workspace: "w2", project: "Notes mobile app", accent: "iris", title: "Offline editor shipped in beta",
    archived: "Mon 9 Nov", took: "3 days", steps: 6,
    outcome: "Editor works fully offline; 120 beta users, crash-free rate 99.6 %.", source: cloud(1210) },
  { id: "a3", workspace: "w3", project: "Thesis — chapter 2", accent: "lagoon", title: "Methodology chapter submitted to supervisor",
    archived: "Fri 6 Nov", took: "1 week", steps: 5,
    outcome: "5,200 words; supervisor feedback received with 3 minor changes.", source: dev(137) },
];

/** Prototype data: 3 workspaces, 6 tasks (t4 archived), agenda, archive. Wall view of w1. */
export const FIXTURE: WallVM = {
  now: "Fri 13 Nov · 18:40",
  model: { state: "ready", label: "Gemini Nano ready on this device" },
  network: "online",
  workspaces: WORKSPACES,
  workspace: "w1",
  view: "wall",
  archiveScope: "workspace",
  tasks: TASKS,
  agenda: AGENDA,
  archive: ARCHIVE,
};

export const vm = (o: Partial<WallVM> = {}): WallVM => ({ ...FIXTURE, ...o });

/* ---- small builders for focused cases ------------------------------------------------ */

export const mkTask = (id: string, o: Partial<TaskVM> = {}): TaskVM => ({
  id, workspace: "w1", project: `Project ${id}`, accent: "sky" as AccentVM, title: `Title ${id}`, summary: `Summary ${id}`,
  status: "running" as TaskStatusVM, attention: "none" as AttentionVM, updated: "10:00", source: dev(100), next: `Next ${id}`,
  steps: [], ...o,
});

export const mkStep = (label: string, state: StepStateVM, o: Partial<StepVM> = {}): StepVM => ({ label, state, ...o });

export const mkDone = (label: string, at: string, at_ms: number, day: string, o: Partial<StepVM> = {}): StepVM => ({
  label, state: "done", at, at_ms, day, took: "5 min",
  detail: { outcome: `Outcome of ${label}`, evidence: [`evidence for ${label}`], source: dev(50) }, ...o,
});

/** VM with only the given tasks in workspace w1 (other collections kept). */
export const withTasks = (tasks: readonly TaskVM[], o: Partial<WallVM> = {}): WallVM => vm({ tasks, ...o });

/* ---- string / id mappers (text-safety and invalid-input tests) ----------------------- */

/** Maps every free-text string of the VM. Enum values, ids, `at`, `day` and numbers are kept. */
export function mapText(src: WallVM, f: (s: string) => string): WallVM {
  const opt = <K extends string>(k: K, v: string | undefined): { [P in K]?: string } => (v === undefined ? {} : ({ [k]: f(v) } as { [P in K]?: string }));
  const step = (s: StepVM): StepVM => ({
    ...s, label: f(s.label), ...opt("note", s.note), ...opt("took", s.took),
    ...(s.detail ? { detail: { ...s.detail, outcome: f(s.detail.outcome), evidence: s.detail.evidence.map(f) } } : {}),
  });
  return {
    ...src,
    now: f(src.now),
    model: { ...src.model, label: f(src.model.label) },
    workspaces: src.workspaces.map((w) => ({ ...w, name: f(w.name) })),
    tasks: src.tasks.map((t) => ({ ...t, project: f(t.project), title: f(t.title), summary: f(t.summary), updated: f(t.updated), next: f(t.next), steps: t.steps.map(step) })),
    agenda: src.agenda.map((g) => ({ group: f(g.group), items: g.items.map((i) => ({ ...i, when: f(i.when), what: f(i.what) })) })),
    archive: src.archive.map((a) => ({ ...a, project: f(a.project), title: f(a.title), archived: f(a.archived), took: f(a.took), outcome: f(a.outcome) })),
  };
}

/** Maps every id and every reference to an id (task.id/workspace, agenda.task, archive.id/workspace, vm.workspace). */
export function mapIds(src: WallVM, f: (s: string) => string): WallVM {
  return {
    ...src,
    workspace: f(src.workspace),
    workspaces: src.workspaces.map((w) => ({ ...w, id: f(w.id) })),
    tasks: src.tasks.map((t) => ({ ...t, id: f(t.id), workspace: f(t.workspace) })),
    agenda: src.agenda.map((g) => ({ ...g, items: g.items.map((i) => ({ ...i, task: f(i.task) })) })),
    archive: src.archive.map((a) => ({ ...a, id: f(a.id), workspace: f(a.workspace) })),
  };
}

export function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

export const frozenFixture = (): WallVM => deepFreeze(structuredClone(FIXTURE));
