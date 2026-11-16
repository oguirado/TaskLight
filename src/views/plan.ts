import type {
  AccentVM,
  ActivityStateVM,
  ActivityVM,
  AgendaGroupVM,
  AgendaItemVM,
  ArchivedVM,
  AttentionVM,
  DiaryEntryVM,
  MemorySectionVM,
  MemoryVM,
  NanoVerdictKind,
  PlanAgentDotVM,
  PlanPhaseVM,
  PlanVerdictVM,
  PlanVM,
  SourceVM,
  StepDetailVM,
  StepStateVM,
  StepVM,
  TaskStatusVM,
  TaskVM,
  WallHandlers,
  ViewId,
} from "./types";

export type {
  AccentVM,
  ActivityStateVM,
  ActivityVM,
  AgendaGroupVM,
  AgendaItemVM,
  ArchivedVM,
  AttentionVM,
  DiaryEntryVM,
  MemorySectionVM,
  MemoryVM,
  NanoVerdictKind,
  PlanAgentDotVM,
  PlanPhaseVM,
  PlanVerdictVM,
  PlanVM,
  SourceVM,
  StepDetailVM,
  StepStateVM,
  StepVM,
  TaskStatusVM,
  TaskVM,
  ViewId,
};

/** Contain failures at injected view callback boundaries, including async results. */
export function containViewCallback(action: () => unknown): void {
  try {
    const result = action();
    if (result !== null && (typeof result === "object" || typeof result === "function")
      && typeof (result as { then?: unknown }).then === "function") {
      (result as PromiseLike<unknown>).then(undefined, () => { /* contained */ });
    }
  } catch { /* contained */ }
}

export const PLAN_VIEW_LIMITS = Object.freeze({
  TASKS_MAX: 40,
  MICRO_MAX: 12,
  PHASES_MAX: 8,
  DEPS_MAX: 8,
  EVIDENCE_MAX: 8,
  TITLE_MAX: 120,
  STEP_TEXT_MAX: 80,
  ACCEPT_MAX: 160,
  OUTCOME_MAX: 240,
  ESTIMATE_MAX: 32,
  TOOK_MAX: 32,
  PROGRESS_MIN: 0,
  PROGRESS_MAX: 100,
} as const);

export type PlanViewDiagCode =
  | "EMPTY_PLAN"
  | "INVALID_PROGRESS"
  | "UNKNOWN_PHASE"
  | "TRUNCATED_LIST"
  | "MISSING_REQUIRED_MEMORY";

export interface PhaseGroupVM {
  phaseId: string;
  label: string;
  active: boolean;
  tasks: readonly TaskVM[];
}

export interface DiaryDayGroupVM {
  day: string;
  entries: readonly DiaryEntryVM[];
}

export type AnnounceFn = (msg: string) => void;

export interface PlanCardHandlers {
  onOpenTask?: (id: string, triggerSelector?: string, trigger?: { triggerId?: string; taskId?: string; microId?: string; ref?: string }) => void;
  onToggleMicroDetail?: (taskId: string, microIndex: number) => void;
  announce?: AnnounceFn;
}

const ACTIVITY_LABEL: Readonly<Record<ActivityStateVM, string>> = {
  idle: "Idle", working: "Working", done: "Done", blocked: "Blocked",
  waiting: "Waiting", needs_you: "Needs you", unknown: "Liveness unknown", cancelled: "Cancelled",
};
const ACTIVITY_GLYPH: Readonly<Record<ActivityStateVM, string>> = {
  idle: "○", working: "◐", done: "✓", blocked: "■",
  waiting: "◇", needs_you: "!", unknown: "?", cancelled: "✕",
};
const ACTIVITY_STATES: ReadonlySet<string> = new Set(["idle", "working", "done", "blocked", "waiting", "needs_you", "unknown", "cancelled"]);

/** Resolve an untrusted activity field to the inert fallback. Never throws. */
function resolveActivity(raw: unknown): ActivityStateVM {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "unknown";
  const state = (raw as { state?: unknown }).state;
  if (typeof state !== "string" || !ACTIVITY_STATES.has(state)) return "unknown";
  return state as ActivityStateVM;
}

function displayActivity(raw: unknown, stale: boolean): ActivityStateVM {
  const state = resolveActivity(raw);
  if (stale && state === "working") return "unknown";
  return state;
}

function activityIcon(doc: Document, cls: string, state: ActivityStateVM): HTMLElement {
  const icon = el(doc, "span", cls);
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("data-activity", state);
  icon.textContent = ACTIVITY_GLYPH[state];
  return icon;
}

function asStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return "";
}

function trunc(v: string, max: number): string {
  return v.length > max ? v.slice(0, max) : v;
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const SAFE_RE = /^[a-z]{1,16}$/;

function isSafe(v: unknown): v is string {
  return typeof v === "string" && SAFE_RE.test(v);
}

function safeMs(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return `${v} ms`;
  if (typeof v === "string") return `${v} ms`;
  return "0 ms";
}

const SOURCE_LABEL: Readonly<Record<string, string>> = {
  device: "Gemini Nano · on device",
  cloud: "Gemini · cloud fallback",
  local: "Local model",
  remote: "Network model",
};

function sourcechip(doc: Document, src: unknown): HTMLElement {
  const safe = (src && typeof src === "object" ? src : {}) as Partial<SourceVM>;
  const kind = (safe as { kind?: unknown }).kind;
  const chip = el(doc, "span", "source");
  if (isSafe(kind)) chip.setAttribute("data-source", kind);
  const icon = el(doc, "span", "source-icon");
  icon.setAttribute("aria-hidden", "true");
  chip.appendChild(icon);
  const rawMs = (safe as { ms?: unknown }).ms;
  const ran = kind !== "rules" && typeof rawMs === "number" && rawMs > 0;
  if (!ran) {
    chip.appendChild(el(doc, "span", "source-label", "Rules"));
    return chip;
  }
  const label = typeof kind === "string" && Object.prototype.hasOwnProperty.call(SOURCE_LABEL, kind) ? SOURCE_LABEL[kind] : undefined;
  if (label === undefined) {
    chip.appendChild(el(doc, "span", "source-label", "Rules"));
    return chip;
  }
  chip.appendChild(el(doc, "span", "source-label", label));
  chip.appendChild(el(doc, "span", "source-ms", safeMs(rawMs)));
  return chip;
}

const STATUS_LABEL: Record<string, string> = {
  blocked: "Blocked",
  waiting: "Needs input",
  running: "In progress",
  idle: "Idle",
  done: "Done",
  failed: "Failed",
};

function statusLabel(status: unknown): string {
  if (typeof status === "string" && Object.prototype.hasOwnProperty.call(STATUS_LABEL, status)) return STATUS_LABEL[status] as string;
  if (typeof status === "string" && status.length > 0) return status;
  return "";
}

const STEP_LABEL: Record<string, string> = {
  done: "Done",
  active: "In progress",
  blocked: "Blocked",
  pending: "To do",
};

function stepLabel(state: unknown): string {
  if (typeof state === "string" && Object.prototype.hasOwnProperty.call(STEP_LABEL, state)) return STEP_LABEL[state] as string;
  if (typeof state === "string" && state.length > 0) return state;
  return "unknown";
}

export function computeProgressPct(done: number, total: number): number {
  const d = typeof done === "number" ? done : Number(done);
  const t = typeof total === "number" ? total : Number(total);
  if (!Number.isFinite(d) || !Number.isFinite(t)) return 0;
  if (d <= 0 || t <= 0) return 0;
  const pct = Math.round((d / t) * 100);
  if (!Number.isFinite(pct)) return 0;
  if (pct < PLAN_VIEW_LIMITS.PROGRESS_MIN) return 0;
  if (pct > PLAN_VIEW_LIMITS.PROGRESS_MAX) return 100;
  return pct;
}

export function formatWaitsFor(waitsFor: readonly string[] | undefined): string {
  if (!Array.isArray(waitsFor)) return "";
  const deps: string[] = [];
  for (const w of waitsFor) {
    if (deps.length >= PLAN_VIEW_LIMITS.DEPS_MAX) break;
    const s = asStr(w);
    deps.push(s);
  }
  if (deps.length === 0) return "";
  return `Waits for ${deps.join(", ")}`;
}

function taskIdOf(t: TaskVM): string {
  const tid = asStr((t as { taskId?: unknown }).taskId);
  if (tid) return tid;
  return asStr((t as { id?: unknown }).id);
}

function taskSteps(t: TaskVM): StepVM[] {
  if (!t || typeof t !== "object") return [];
  const s = (t as { steps?: unknown }).steps;
  if (!Array.isArray(s)) return [];
  const out: StepVM[] = [];
  for (const item of s) {
    if (!item || typeof item !== "object") continue;
    out.push(item as StepVM);
    if (out.length >= 500) break;
  }
  return out;
}

function taskWaitsFor(t: TaskVM): readonly string[] {
  const w = (t as { waitsFor?: unknown }).waitsFor;
  return Array.isArray(w) ? (w as readonly string[]) : [];
}

function microIdOf(taskId: string, idx: number, step: StepVM): string {
  const m = asStr((step as { microId?: unknown }).microId);
  if (m) return m;
  const base = taskId || "T01";
  return `${base}.M${String(idx + 1).padStart(2, "0")}`;
}

function safeTasks(tasks: unknown): TaskVM[] {
  if (!Array.isArray(tasks)) return [];
  const out: TaskVM[] = [];
  for (const t of tasks) {
    if (!t || typeof t !== "object") continue;
    out.push(t as TaskVM);
    if (out.length >= 2000) break;
  }
  return out;
}

function validPhases(phases: unknown): PlanPhaseVM[] {
  if (!Array.isArray(phases)) return [];
  const out: PlanPhaseVM[] = [];
  for (const p of phases) {
    if (!p || typeof p !== "object") continue;
    out.push(p as PlanPhaseVM);
    if (out.length >= 200) break;
  }
  return out;
}

export function groupTasksByPhase(
  tasks: readonly TaskVM[],
  phases: readonly PlanPhaseVM[],
): readonly PhaseGroupVM[] {
  try {
    const safe = safeTasks(tasks).slice(0, PLAN_VIEW_LIMITS.TASKS_MAX);
    const declared = validPhases(phases).slice(0, PLAN_VIEW_LIMITS.PHASES_MAX);
    const groups: PhaseGroupVM[] = declared.map((p) => ({
      phaseId: asStr((p as { id?: unknown }).id),
      label: asStr((p as { label?: unknown }).label),
      active: (p as { active?: unknown }).active === true,
      tasks: [],
    }));
    const byId = new Map<string, PhaseGroupVM>();
    for (const g of groups) {
      if (!byId.has(g.phaseId)) byId.set(g.phaseId, g);
    }
    const orphans: TaskVM[] = [];
    for (const t of safe) {
      const pid = asStr((t as { phaseId?: unknown }).phaseId);
      const g = byId.get(pid);
      if (g) (g.tasks as TaskVM[]).push(t);
      else orphans.push(t);
    }
    if (orphans.length > 0) {
      groups.push({ phaseId: "unassigned", label: "Unassigned", active: false, tasks: orphans });
    }
    return groups;
  } catch {
    return [];
  }
}

export function buildPlanAgenda(tasks: readonly TaskVM[]): readonly AgendaGroupVM[] {
  try {
    const safe = safeTasks(tasks).slice(0, PLAN_VIEW_LIMITS.TASKS_MAX);
    const now: AgendaItemVM[] = [];
    const next: AgendaItemVM[] = [];
    const blocked: AgendaItemVM[] = [];
    for (const t of safe) {
      const tid = taskIdOf(t) || asStr((t as { id?: unknown }).id);
      const identity = { workspace: t.workspace, taskVmId: t.id };
      const assignee = asStr((t as { assignee?: unknown }).assignee);
      const agent = asStr((t as { agent?: unknown }).agent) || assignee;
      const status = asStr((t as { status?: unknown }).status);
      const archived = (t as { archived?: unknown }).archived === true;
      const rawTaskAct = (t as { activity?: unknown }).activity;
      const taskAct: ActivityStateVM | undefined = rawTaskAct === undefined ? undefined : resolveActivity(rawTaskAct);
      const waits = taskWaitsFor(t);
      const hasWaits = waits.length > 0;
      const waitsText = formatWaitsFor(waits);
      if (status === "blocked" || taskAct === "blocked") {
        const reason = asStr((t as { blockedReason?: unknown }).blockedReason) || waitsText;
        const title = asStr((t as { title?: unknown }).title);
        const what = reason ? `${title ? `${title} — ` : ""}${reason}` : title;
        blocked.push({ ...identity, when: "Blocked", task: tid, taskId: tid, what: what || tid, ...(agent ? { agent } : {}), ...(reason ? { reason } : {}) });
      } else if (hasWaits) {
        const title = asStr((t as { title?: unknown }).title);
        const what = `${title ? `${title} — ` : ""}${waitsText}`;
        blocked.push({ ...identity, when: "Blocked", task: tid, taskId: tid, what, ...(agent ? { agent } : {}), reason: waitsText });
      }
      const terminal = archived || status === "done" || status === "failed" || taskAct === "done" || taskAct === "cancelled" || taskAct === "unknown" || taskAct === "blocked" || (rawTaskAct !== undefined && rawTaskAct !== null && resolveActivity(rawTaskAct) === "unknown");
      const ready = !hasWaits && status !== "blocked" && !terminal;
      const steps = taskSteps(t);
      steps.forEach((s, idx) => {
        const state = asStr((s as { state?: unknown }).state);
        const label = asStr((s as { label?: unknown }).label);
        const microId = microIdOf(tid, idx, s);
        const microAct = (s as { activity?: unknown }).activity !== undefined ? resolveActivity((s as { activity?: unknown }).activity) : taskAct;
        if (state === "active") {
          now.push({ ...identity, when: "Now", task: tid, taskId: tid, microId, what: label, ...(agent ? { agent } : {}) });
        } else if (state === "pending" && ready && microAct !== "unknown" && microAct !== "done" && microAct !== "cancelled" && microAct !== "blocked") {
          next.push({ ...identity, when: "Next", task: tid, taskId: tid, microId, what: label, ...(agent ? { agent } : {}) });
        } else if (state === "blocked") {
          const title = asStr((t as { title?: unknown }).title);
          const reason = asStr((s as { note?: unknown }).note) || asStr((t as { blockedReason?: unknown }).blockedReason);
          blocked.push({ ...identity, when: "Blocked", task: tid, taskId: tid, microId, what: label || title, ...(agent ? { agent } : {}), ...(reason ? { reason } : {}) });
        }
      });
    }
    return [{ group: "Now", items: now }, { group: "Next", items: next }, { group: "Blocked", items: blocked }];
  } catch {
    return [{ group: "Now", items: [] }, { group: "Next", items: [] }, { group: "Blocked", items: [] }];
  }
}

export function buildPlanDiary(entries: readonly DiaryEntryVM[]): readonly DiaryDayGroupVM[] {
  try {
    if (!Array.isArray(entries)) return [];
    const order: string[] = [];
    const map = new Map<string, DiaryEntryVM[]>();
    for (const e of entries) {
      if (!e || typeof e !== "object") continue;
      const day = asStr((e as { day?: unknown }).day);
      const key = day || "";
      if (!map.has(key)) {
        map.set(key, []);
        order.push(key);
      }
      (map.get(key) as DiaryEntryVM[]).push(e as DiaryEntryVM);
    }
    const out: DiaryDayGroupVM[] = [];
    for (const day of order) {
      out.push({ day, entries: map.get(day) as DiaryEntryVM[] });
    }
    return out;
  } catch {
    return [];
  }
}

function safeGroups(groups: unknown): PhaseGroupVM[] {
  if (!Array.isArray(groups)) return [];
  const out: PhaseGroupVM[] = [];
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    out.push(g as PhaseGroupVM);
    if (out.length >= 64) break;
  }
  return out;
}

function safeAgendaGroups(groups: unknown): AgendaGroupVM[] {
  if (!Array.isArray(groups)) return [];
  const out: AgendaGroupVM[] = [];
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    out.push(g as AgendaGroupVM);
    if (out.length >= 64) break;
  }
  return out;
}

function safeDiaryGroups(groups: unknown): DiaryDayGroupVM[] {
  if (!Array.isArray(groups)) return [];
  const out: DiaryDayGroupVM[] = [];
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    out.push(g as DiaryDayGroupVM);
    if (out.length >= 256) break;
  }
  return out;
}

function safeArchived(items: unknown): ArchivedVM[] {
  if (!Array.isArray(items)) return [];
  const out: ArchivedVM[] = [];
  for (const a of items) {
    if (!a || typeof a !== "object") continue;
    out.push(a as ArchivedVM);
    if (out.length >= 512) break;
  }
  return out;
}

function safePlan(plan: unknown): PlanVM {
  if (plan && typeof plan === "object") return plan as PlanVM;
  return { id: "p1", title: "", templateId: "", templateHash: "", phaseId: "", phases: [], doneCount: 0, totalCount: 0, progressPct: 0, agents: [] } as PlanVM;
}

export function renderPlanBand(doc: Document, plan: PlanVM, opts?: { onSelectPhase?: (id: string) => void; announce?: AnnounceFn; selectedPhase?: string | null; syncStale?: boolean }): HTMLElement {
  const sec = el(doc, "section", "plan-band");
  try {
    const p = safePlan(plan);
    const raw = (p as unknown) as Record<string, unknown>;
    const title = trunc(asStr(raw.title), PLAN_VIEW_LIMITS.TITLE_MAX);
    const planId = asStr(raw.id);
    if (planId) sec.setAttribute("data-plan-id", planId);
    const head = el(doc, "div", "plan-band-head");
    const titleEl = el(doc, "h2", "plan-title", title);
    head.appendChild(titleEl);
    const done = typeof raw.doneCount === "number" ? raw.doneCount : (raw.doneCount as number);
    const total = typeof raw.totalCount === "number" ? raw.totalCount : (raw.totalCount as number);
    const pct = computeProgressPct(done, total);
    const prog = el(doc, "div", "progress");
    const track = el(doc, "span", "progress-track");
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-valuenow", String(pct));
    track.setAttribute("aria-label", "Overall progress");
    const fill = el(doc, "span", "progress-fill");
    fill.textContent = `${pct}%`;
    track.appendChild(fill);
    prog.appendChild(el(doc, "span", "progress-label", `${pct}%`));
    prog.appendChild(track);
    head.appendChild(prog);
    sec.appendChild(head);
    const phases = validPhases(raw.phases).slice(0, PLAN_VIEW_LIMITS.PHASES_MAX);
    const phasesWrap = el(doc, "div", "plan-phases");
    phasesWrap.setAttribute("role", "group");
    phasesWrap.setAttribute("aria-label", "Phases");
    for (const ph of phases) {
      const pid = asStr((ph as { id?: unknown }).id);
      const label = asStr((ph as { label?: unknown }).label);
      const active = (ph as { active?: unknown }).active === true;
      const chip = el(doc, "button", "phase-chip", label);
      chip.setAttribute("type", "button");
      chip.setAttribute("data-phase-id", pid);
      const selected = opts !== undefined && opts.selectedPhase === pid;
      chip.setAttribute("aria-pressed", selected ? "true" : "false");
      chip.setAttribute("data-active", active ? "true" : "false");
      if (active) {
        chip.setAttribute("aria-current", "step");
        chip.setAttribute("aria-label", `${label} (current phase)`);
        chip.setAttribute("title", `${label} (current phase)`);
      } else {
        chip.setAttribute("aria-current", "false");
        if (selected) {
          chip.setAttribute("aria-label", `${label} (selected)`);
          chip.setAttribute("title", `${label} (selected)`);
        }
      }
      if (opts && typeof opts.onSelectPhase === "function") {
        const cb = opts.onSelectPhase;
        const ann = opts ? opts.announce : undefined;
        chip.addEventListener("click", () => {
          containViewCallback(() => cb(pid));
          if (typeof ann === "function") {
            containViewCallback(() => ann(`Phase ${pid} selected`));
          }
        });
      }
      phasesWrap.appendChild(chip);
    }
    sec.appendChild(phasesWrap);
    const agents = Array.isArray(raw.agents) ? (raw.agents as unknown[]) : [];
    const agentsWrap = el(doc, "div", "plan-agents");
    for (const a of agents) {
      if (!a || typeof a !== "object") continue;
      const rec = a as Record<string, unknown>;
      const name = asStr(rec.agent);
      const active = rec.active === true && opts?.syncStale !== true;
      const accent = rec.accent;
      const dot = el(doc, "span", "agent-dot", name);
      dot.setAttribute("data-agent", name);
      dot.setAttribute("data-active", active ? "true" : "false");
      if (isSafe(accent)) dot.setAttribute("data-accent", accent as string);
      agentsWrap.appendChild(dot);
    }
    sec.appendChild(agentsWrap);
    const brief = asStr(raw.brief);
    if (brief.length > 0) {
      sec.appendChild(el(doc, "p", "plan-brief", brief));
    }
    const findings = Array.isArray(raw.conformanceFindings) ? (raw.conformanceFindings as unknown[]) : [];
    const texts: string[] = [];
    for (const f of findings) {
      const s = asStr(f);
      if (s.length > 0) texts.push(s);
      if (texts.length >= 32) break;
    }
    if (texts.length > 0) {
      const ul = el(doc, "ul", "plan-findings");
      for (const f of texts) ul.appendChild(el(doc, "li", "plan-finding", f));
      sec.appendChild(ul);
    }
  } catch { /* contained: never throw */ }
  return sec;
}

function renderStepRow(doc: Document, step: StepVM, taskId: string, idx: number, handlers: PlanCardHandlers | undefined, stale: boolean): HTMLElement {
  const s = (step as unknown) as Record<string, unknown>;
  const state = asStr(s.state);
  const detailRaw = s.detail;
  const detail = detailRaw && typeof detailRaw === "object" ? (detailRaw as StepDetailVM) : undefined;
  const acceptRaw = trunc(asStr((step as { accept?: unknown }).accept), PLAN_VIEW_LIMITS.ACCEPT_MAX);
  const hasPanel = detail != null || acceptRaw.length > 0;
  const act = displayActivity((step as { activity?: unknown }).activity, stale);
  const li = el(doc, "li", "step");
  if (isSafe(state)) li.setAttribute("data-state", state);
  li.setAttribute("data-activity", act);
  const label = trunc(asStr(s.label), PLAN_VIEW_LIMITS.STEP_TEXT_MAX);
  const microId = microIdOf(taskId, idx, step as StepVM);
  const drec = detail ? (detail as unknown as Record<string, unknown>) : undefined;
  let row: HTMLElement;
  if (hasPanel) {
    const btn = el(doc, "button", "step-row");
    btn.setAttribute("type", "button");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("data-task-id", taskId);
    btn.setAttribute("data-step-idx", String(idx));
    btn.setAttribute("data-micro-id", microId);
    const panelId = `step-${microId}`;
    btn.setAttribute("aria-controls", panelId);
    btn.setAttribute("aria-label", `${label} · ${ACTIVITY_LABEL[act]}`);
    btn.appendChild(activityIcon(doc, "step-indicator", act));
    const stxt = el(doc, "span", "step-text");
    stxt.appendChild(el(doc, "span", "step-label", label));
    stxt.appendChild(el(doc, "span", "step-activity-label", ` · ${ACTIVITY_LABEL[act]}`));
    stxt.appendChild(el(doc, "span", "visually-hidden", ` — ${stepLabel(state)}`));
    btn.appendChild(stxt);
    const chev = el(doc, "span", "step-chevron");
    chev.setAttribute("aria-hidden", "true");
    btn.appendChild(chev);
    row = btn;
    const div = el(doc, "div", "step-detail");
    div.id = panelId;
    div.setAttribute("data-micro-id", microId);
    div.setAttribute("aria-label", `Acceptance: ${label}`);
    div.hidden = true;
    const outcome = detail ? trunc(asStr(drec ? drec.outcome : ""), PLAN_VIEW_LIMITS.OUTCOME_MAX) : "";
    if (detail && outcome.length > 0) div.appendChild(el(doc, "p", "detail-outcome", outcome));
    if (acceptRaw.length > 0) div.appendChild(el(doc, "p", "detail-accept", acceptRaw));
    const ev = drec && Array.isArray(drec.evidence) ? (drec.evidence as unknown[]) : [];
    if (ev.length > 0) {
      div.appendChild(el(doc, "p", "detail-heading", "Evidence recorded"));
      const evList = el(doc, "ul", "detail-evidence");
      let evCount = 0;
      for (const e of ev) {
        if (evCount >= PLAN_VIEW_LIMITS.EVIDENCE_MAX) break;
        evList.appendChild(el(doc, "li", undefined, asStr(e)));
        evCount += 1;
      }
      div.appendChild(evList);
    } else {
      div.appendChild(el(doc, "p", "detail-heading", "No evidence recorded"));
    }
    if (detail) div.appendChild(sourcechip(doc, drec ? drec.source : undefined));
    li.appendChild(row);
    li.appendChild(div);
    {
      const onToggle = handlers ? handlers.onToggleMicroDetail : undefined;
      const ann = handlers ? handlers.announce : undefined;
      const panel = div;
      btn.addEventListener("click", () => {
        const open = btn.getAttribute("aria-expanded") !== "true";
        btn.setAttribute("aria-expanded", open ? "true" : "false");
        panel.hidden = !open;
        li.toggleAttribute("data-open", open);
        if (typeof onToggle === "function") {
          containViewCallback(() => onToggle(taskId, idx));
        }
        if (typeof ann === "function") {
          containViewCallback(() => ann(open ? `Expanded outcome for ${microId}` : `Collapsed outcome for ${microId}`));
        }
      });
    }
  } else {
    const divRow = el(doc, "div", "step-row");
    divRow.setAttribute("data-task-id", taskId);
    divRow.setAttribute("data-step-idx", String(idx));
    divRow.appendChild(activityIcon(doc, "step-indicator", act));
    const stxt = el(doc, "span", "step-text");
    stxt.appendChild(el(doc, "span", "step-label", label));
    stxt.appendChild(el(doc, "span", "step-activity-label", ` · ${ACTIVITY_LABEL[act]}`));
    stxt.appendChild(el(doc, "span", "visually-hidden", ` — ${stepLabel(state)}`));
    divRow.appendChild(stxt);
    row = divRow;
    li.appendChild(row);
  }
  const note = asStr((step as { note?: unknown }).note);
  if (note.length > 0) li.appendChild(el(doc, "p", "step-note", note));
  return li;
}

export function renderPhaseTaskCards(doc: Document, groups: readonly PhaseGroupVM[], handlers?: PlanCardHandlers, opts?: { syncStale?: boolean }): HTMLElement {
  const wrap = el(doc, "div", "phase-groups");
  const stale = opts?.syncStale === true;
  try {
    const safe = safeGroups(groups);
    let rendered = 0;
    for (const g of safe) {
      if (rendered >= PLAN_VIEW_LIMITS.TASKS_MAX) break;
      const grec = (g as unknown) as Record<string, unknown>;
      const phaseId = asStr(grec.phaseId);
      const label = asStr(grec.label);
      const active = grec.active === true;
      const gtasks = Array.isArray(grec.tasks) ? (grec.tasks as unknown[]) : [];
      const sec = el(doc, "section", "phase-group");
      sec.setAttribute("data-phase-id", phaseId);
      const hdr = el(doc, "h3", "phase-header", gtasks.length > 0 ? `${label} · ${gtasks.length} tasks` : label);
      sec.appendChild(hdr);
      const list = el(doc, "div", "phase-tasks");
      for (const t of gtasks) {
        if (rendered >= PLAN_VIEW_LIMITS.TASKS_MAX) break;
        if (!t || typeof t !== "object") continue;
        const trec = (t as unknown) as Record<string, unknown>;
        const tid = asStr(trec.taskId) || asStr(trec.id);
        const vmId = asStr(trec.id) || tid;
        const title = asStr(trec.title);
        const taskType = asStr(trec.taskType);
        const assignee = asStr(trec.assignee);
        const estimate = trunc(asStr(trec.estimate), PLAN_VIEW_LIMITS.ESTIMATE_MAX);
        const waits = taskWaitsFor(t as TaskVM);
        const waitsText = formatWaitsFor(waits);
        const status = asStr(trec.status);
        const blockedReason = asStr(trec.blockedReason);
        const taskAct = trec.operatorQuestion !== undefined && trec.operatorQuestion !== null ? "needs_you" : displayActivity(trec.activity, stale);
        const art = el(doc, "article", "task");
        art.setAttribute("data-task-id", tid);
        art.setAttribute("data-task-vm-id", vmId);
        art.setAttribute("data-activity", taskAct);
        if (waitsText.length > 0) art.setAttribute("data-ready", "false");
        else art.setAttribute("data-ready", "true");
        if (isSafe(status)) art.setAttribute("data-status", status);
        const head = el(doc, "div", "task-head");
        if (tid.length > 0) head.appendChild(el(doc, "span", "task-id", tid));
        if (taskType.length > 0) head.appendChild(el(doc, "span", "task-type", taskType));
        head.appendChild(el(doc, "h3", "task-title", title));
        if (assignee.length > 0) head.appendChild(el(doc, "span", "assignee", assignee));
        if (estimate.length > 0) head.appendChild(el(doc, "span", "estimate", estimate));
        const st = el(doc, "span", "status", statusLabel(status));
        if (isSafe(status)) st.setAttribute("data-status", status);
        head.appendChild(st);
        head.appendChild(activityIcon(doc, "status-icon", taskAct));
        head.appendChild(el(doc, "span", "activity-label", ACTIVITY_LABEL[taskAct]));
        art.appendChild(head);
        if (waitsText.length > 0) art.appendChild(el(doc, "p", "waits-for", waitsText));
        if (blockedReason.length > 0) art.appendChild(el(doc, "p", "blocked-reason", blockedReason));
        const questionRaw = trec.operatorQuestion;
        if (questionRaw && typeof questionRaw === "object") {
          const qrec = questionRaw as Record<string, unknown>;
          const qtext = asStr(qrec.text);
          const qwrap = el(doc, "div", "operator-question");
          qwrap.appendChild(el(doc, "span", "operator-question-text", qtext));
          art.appendChild(qwrap);
        }
        const verdictRaw = trec.nanoVerdict;
        if (verdictRaw && typeof verdictRaw === "object") {
          const vrec = verdictRaw as Record<string, unknown>;
          const verdict = asStr(vrec.verdict);
          const reason = asStr(vrec.reason);
          const isReview = verdict === "needs_user";
          const vwrap = el(doc, "div", "nano-verdict");
          vwrap.appendChild(el(doc, "span", "verdict-badge", isReview ? "Review request" : verdict));
          if (reason.length > 0) vwrap.appendChild(el(doc, "span", "verdict-reason", reason));
          vwrap.appendChild(sourcechip(doc, vrec.source));
          art.appendChild(vwrap);
        }
        const steps = taskSteps(t as TaskVM).slice(0, PLAN_VIEW_LIMITS.MICRO_MAX);
        const ol = el(doc, "ol", "steps");
        steps.forEach((s, i) => {
          ol.appendChild(renderStepRow(doc, s, tid, i, handlers, stale));
        });
        art.appendChild(ol);
        const foot = el(doc, "div", "task-foot");
        const stepsArr = taskSteps(t as TaskVM);
        const firstMicro = stepsArr.length > 0 ? microIdOf(tid, 0, stepsArr[0] as StepVM) : undefined;
        let chatBtn: HTMLButtonElement | undefined;
        if (handlers && typeof handlers.onOpenTask === "function") {
          chatBtn = el(doc, "button", "task-chat", "Chat");
          chatBtn.setAttribute("type", "button");
          chatBtn.setAttribute("data-task-id", tid);
          chatBtn.setAttribute("data-task-vm-id", vmId);
          if (firstMicro !== undefined) chatBtn.setAttribute("data-micro-id", firstMicro);
          chatBtn.id = `chat-${tid}`;
          chatBtn.setAttribute("aria-label", `Open chat: ${title}`);
          foot.appendChild(chatBtn);
        }
        art.appendChild(foot);
        if (handlers && typeof handlers.onOpenTask === "function" && chatBtn !== undefined) {
          const cb = handlers.onOpenTask;
          const openId = vmId;
          const chatId = chatBtn.id;
          const btn = chatBtn;
          btn.addEventListener("click", (e: MouseEvent) => {
            e.preventDefault();
            const trig: { triggerId: string; taskId: string; microId?: string } = { triggerId: chatId, taskId: tid };
            if (firstMicro !== undefined) trig.microId = firstMicro;
            containViewCallback(() => cb(openId, chatId, trig));
          });
          art.addEventListener("click", (e: MouseEvent) => {
            const target = e.target as Element | null;
            if (target && typeof (target as Element).closest === "function") {
              const inside = (target as Element).closest("button");
              if (inside && art.contains(inside)) return;
            }
            containViewCallback(() => cb(openId));
          });
        }
        list.appendChild(art);
        rendered += 1;
      }
      sec.appendChild(list);
      wrap.appendChild(sec);
    }
  } catch { /* contained: never throw */ }
  return wrap;
}

export function renderPlanAgenda(doc: Document, groups: readonly AgendaGroupVM[], announce?: AnnounceFn): HTMLElement {
  const sec = el(doc, "section", "agenda");
  void announce;
  try {
    const safe = safeAgendaGroups(groups);
    if (safe.length === 0) {
      sec.appendChild(el(doc, "p", "agenda-empty", "No agenda items."));
      return sec;
    }
    for (const g of safe) {
      const grec = (g as unknown) as Record<string, unknown>;
      const groupName = asStr(grec.group);
      const items = Array.isArray(grec.items) ? (grec.items as unknown[]) : [];
      const clean = groupName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "misc";
      const wrap = el(doc, "div", `agenda-group agenda-${clean}`);
      wrap.appendChild(el(doc, "h2", "agenda-heading", groupName));
      const ul = el(doc, "ul", "agenda-list");
      for (const it of items) {
        if (!it || typeof it !== "object") continue;
        const irec = (it as unknown) as Record<string, unknown>;
        const li = el(doc, "li", "agenda-item");
        const when = asStr(irec.when);
        const task = asStr(irec.task) || asStr(irec.taskId);
        const what = asStr(irec.what);
        const agent = asStr(irec.agent);
        const reason = asStr(irec.reason);
        if (when.length > 0) li.appendChild(el(doc, "span", "agenda-when", when));
        if (task.length > 0) li.appendChild(el(doc, "span", "agenda-task", task));
        li.appendChild(el(doc, "span", "agenda-what", what));
        if (agent.length > 0) li.appendChild(el(doc, "span", "agenda-agent", agent));
        if (reason.length > 0) li.appendChild(el(doc, "span", "agenda-reason", reason));
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
      sec.appendChild(wrap);
    }
  } catch { /* contained: never throw */ }
  return sec;
}

export function renderPlanDiary(doc: Document, groups: readonly DiaryDayGroupVM[]): HTMLElement {
  const sec = el(doc, "section", "diary");
  try {
    const safe = safeDiaryGroups(groups);
    let total = 0;
    for (const g of safe) {
      const grec = (g as unknown) as Record<string, unknown>;
      const day = asStr(grec.day);
      const entries = Array.isArray(grec.entries) ? (grec.entries as unknown[]) : [];
      const valid: unknown[] = [];
      for (const e of entries) {
        if (!e || typeof e !== "object") continue;
        valid.push(e);
      }
      if (valid.length === 0) continue;
      total += valid.length;
      const gdiv = el(doc, "div", "diary-day");
      gdiv.appendChild(el(doc, "h2", "diary-heading", day));
      const ol = el(doc, "ol", "timeline");
      for (const e of valid) {
        const erec = (e as unknown) as Record<string, unknown>;
        const kind = asStr(erec.kind);
        const at = asStr(erec.at);
        const title = asStr(erec.title);
        const outcome = trunc(asStr(erec.outcome), PLAN_VIEW_LIMITS.OUTCOME_MAX);
        const took = trunc(asStr(erec.took), PLAN_VIEW_LIMITS.TOOK_MAX);
        const author = asStr(erec.author);
        const li = el(doc, "li", "entry");
        if (kind) li.setAttribute("data-kind", kind);
        if (at.length > 0) li.appendChild(el(doc, "time", "entry-time", at));
        li.appendChild(el(doc, "p", "entry-title", title));
        if (outcome.length > 0) li.appendChild(el(doc, "p", "entry-outcome", outcome));
        if (took.length > 0) li.appendChild(el(doc, "span", "entry-took", took));
        if (author.length > 0) li.appendChild(el(doc, "span", "entry-author", author));
        const ev = Array.isArray(erec.evidence) ? (erec.evidence as unknown[]) : [];
        let evCount = 0;
        if (ev.length > 0) {
          const ul = el(doc, "ul", "entry-evidence");
          for (const p of ev) {
            if (evCount >= PLAN_VIEW_LIMITS.EVIDENCE_MAX) break;
            ul.appendChild(el(doc, "li", undefined, asStr(p)));
            evCount += 1;
          }
          li.appendChild(ul);
        }
        ol.appendChild(li);
      }
      gdiv.appendChild(ol);
      sec.appendChild(gdiv);
    }
    if (total === 0) {
      sec.appendChild(el(doc, "p", "diary-empty", "No diary entries yet."));
    }
  } catch { /* contained: never throw */ }
  return sec;
}

export function renderPlanArchive(doc: Document, items: readonly ArchivedVM[], handlers?: Pick<WallHandlers, "onRestore">): HTMLElement {
  const sec = el(doc, "section", "archive-plan");
  try {
    const safe = safeArchived(items);
    const ul = el(doc, "ul", "archive-list");
    for (const a of safe) {
      const arec = (a as unknown) as Record<string, unknown>;
      const id = asStr(arec.id) || asStr(arec.planId);
      const title = asStr(arec.title);
      const archived = asStr(arec.archived);
      const took = asStr(arec.took);
      const outcome = asStr(arec.outcome);
      const stepsRaw = arec.steps;
      const countRaw = arec.taskCount;
      const hasTaskCount = countRaw !== undefined && countRaw !== null && asStr(countRaw) !== "";
      const countValue = hasTaskCount ? asStr(countRaw) : asStr(stepsRaw);
      const countLabel = countValue.length === 0 ? "" : hasTaskCount
        ? `${countValue} task${countValue === "1" ? "" : "s"}`
        : `${countValue} steps`;
      const tookLabel = (took === "" || took === "unavailable") ? "Duration unknown" : took;
      const li = el(doc, "li", "archived");
      if (id) li.setAttribute("data-arch-id", id);
      li.appendChild(el(doc, "h2", "archived-title", title));
      if (archived.length > 0 && archived !== "unavailable") li.appendChild(el(doc, "p", "archived-date", `Archived ${archived} `));
      li.appendChild(el(doc, "p", "archived-took", `${tookLabel} `));
      if (countLabel.length > 0) li.appendChild(el(doc, "p", "archived-count", ` ${countLabel} `));
      if (outcome.length > 0) li.appendChild(el(doc, "p", "archived-outcome", outcome));
      li.appendChild(sourcechip(doc, arec.source));
      const btn = el(doc, "button", "archived-restore", "Restore");
      btn.setAttribute("type", "button");
      btn.setAttribute("data-arch-id", id);
      if (handlers && typeof handlers.onRestore === "function") {
        const cb = handlers.onRestore;
        const rid = id;
        btn.addEventListener("click", () => {
          containViewCallback(() => cb(rid));
        });
      }
      li.appendChild(btn);
      ul.appendChild(li);
    }
    sec.appendChild(ul);
  } catch { /* contained: never throw */ }
  return sec;
}
