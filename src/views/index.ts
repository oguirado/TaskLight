import type {
  AccentVM,
  AgendaGroupVM,
  ArchivedVM,
  AttentionVM,
  SourceVM,
  StepStateVM,
  StepVM,
  TaskStatusVM,
  TaskVM,
  PlanVM,
  AgendaItemVM,
  ViewId,
  WallHandle,
  WallHandlers,
  WallVM,
  WorkspaceVM,
} from "./types";
import {
  buildPlanAgenda,
  buildPlanDiary,
  containViewCallback,
  groupTasksByPhase,
  renderPlanAgenda,
  renderPlanArchive,
  renderPlanBand,
  renderPlanDiary,
  renderPhaseTaskCards,
} from "./plan";
import { renderMemoryView } from "./memory";
import { renderSwarmView } from "./swarm";
import { renderAgentStrip } from "./agent_strip";
import type { SwarmViewModel } from "../app/swarm_vm";

// Local mount contracts leave the shared legacy store/view contracts intact.
export type WallViewId = ViewId | "swarm";
export interface WorkspaceGuidanceNotice { heading: string; action: string; body?: string }
export interface WorkspaceGuidanceVM {
  room: string;
  heading: string | null;
  action: string | null;
  body?: string;
  error?: string;
  connected: boolean;
  saved: boolean;
  notices: WorkspaceGuidanceNotice[];
}
export type WallMountVM = Omit<WallVM, "view"> & {
  view: WallViewId;
  swarm?: SwarmViewModel;
  availability?: string;
  workspaceGuidance?: WorkspaceGuidanceVM;
};
export type WallMountHandlers = Omit<WallHandlers, "onView"> & {
  onView?(view: WallViewId): void;
  onOpenMessages?(): void;
  /** Read-only workspace metadata, separate from the legacy store view model. */
  workspaceGuidance?(): WorkspaceGuidanceVM | undefined;
};
export interface WallMountHandle {
  update(vm: WallMountVM): void;
  destroy(): void;
}
function isWallView(value: unknown): value is WallViewId {
  return value === "wall" || value === "agenda" || value === "diary"
    || value === "archive" || value === "memory" || value === "swarm";
}

// Dependency waits describe scheduling; plan focus follows the reviewer.
function needsUserTasks(tasks: readonly TaskVM[]): TaskVM[] {
  const seen = new Set<string>();
  return tasks.filter(t => {
    const needs = t.taskId !== undefined || t.id.startsWith("plan:")
      ? t.nanoVerdict?.verdict === "needs_user"
      : t.attention === "now" || t.status === "waiting" || t.status === "blocked";
    if (!needs || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

const SAFE_RE = /^[a-z]{1,16}$/;

function isSafe(v: unknown): v is string {
  return typeof v === "string" && SAFE_RE.test(v);
}

function setSafeData(el: Element, name: string, value: unknown): void {
  if (isSafe(value)) el.setAttribute(name, value);
}

function asStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return "";
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

const STATUS_LABEL: Record<string, string> = {
  blocked: "Blocked",
  waiting: "Needs input",
  running: "In progress",
  idle: "Idle",
  done: "Done",
  failed: "Failed",
};

const STEP_LABEL: Record<string, string> = {
  done: "Done",
  active: "In progress",
  blocked: "Blocked",
  pending: "To do",
};

const ACTIVITY_LABEL: Record<string, string> = {
  idle: "Idle", working: "Working", done: "Done", blocked: "Blocked",
  waiting: "Waiting", needs_you: "Needs you", unknown: "Liveness unknown", cancelled: "Cancelled",
};
const ACTIVITY_GLYPH: Record<string, string> = {
  idle: "○", working: "◐", done: "✓", blocked: "■",
  waiting: "◇", needs_you: "!", unknown: "?", cancelled: "✕",
};
const ACTIVITY_STATES: ReadonlySet<string> = new Set(["idle", "working", "done", "blocked", "waiting", "needs_you", "unknown", "cancelled"]);

function resolveActivity(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "unknown";
  const state = (raw as { state?: unknown }).state;
  if (typeof state !== "string" || !ACTIVITY_STATES.has(state)) return "unknown";
  return state;
}

function displayActivity(raw: unknown, stale: boolean): string {
  const state = resolveActivity(raw);
  if (stale && state === "working") return "unknown";
  return state;
}

function activityIcon(doc: Document, cls: string, state: string): HTMLElement {
  const icon = el(doc, "span", cls);
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("data-activity", state);
  icon.textContent = ACTIVITY_GLYPH[state] ?? "?";
  return icon;
}

/** View-side expiry: derive the VM with expired working activity dropped to unknown. Never mutates input. */
function expireVm(vm: WallMountVM, now: number): WallMountVM {
  if (!vm || typeof vm !== "object") return vm;
  const stale = (vm as { syncStale?: unknown }).syncStale === true;
  if (stale) return vm;
  const tasks = Array.isArray(vm.tasks) ? vm.tasks : [];
  let changed = false;
  const nextTasks = tasks.map((t) => {
    if (!t || typeof t !== "object") return t;
    const rec = t as unknown as Record<string, unknown>;
    const steps = Array.isArray((t as TaskVM).steps) ? (t as TaskVM).steps : [];
    let taskChanged = false;
    const nextSteps = steps.map((s) => {
      if (!s || typeof s !== "object") return s;
      const raw = (s as { activity?: unknown }).activity;
      if (!raw || typeof raw !== "object") return s;
      const act = raw as { state?: unknown; expiresAt?: unknown };
      if (act.state !== "working") return s;
      const exp = act.expiresAt;
      if (typeof exp !== "number" || !Number.isFinite(exp) || now <= exp) return s;
      taskChanged = true;
      return { ...(s as object), activity: { state: "unknown" } } as StepVM;
    });
    const rawT0 = rec["activity"];
    let taskDue = false;
    if (rawT0 && typeof rawT0 === "object") {
      const actT0 = rawT0 as { state?: unknown; expiresAt?: unknown };
      const expT0 = actT0.expiresAt;
      taskDue = actT0.state === "working" && typeof expT0 === "number" && Number.isFinite(expT0) && now > expT0;
    }
    if (taskChanged || taskDue) {
      const nextTask = { ...(t as unknown as Record<string, unknown>), steps: nextSteps } as unknown as TaskVM;
      // A parent's earliest deadline is a refresh boundary, not the end of
      // every child's work. Preserve scheduling/terminal overrides.
      const state = resolveActivity(rawT0);
      if (state === "working" || state === "unknown" || state === "idle") {
        const working = nextSteps.filter((step) => step?.activity?.state === "working");
        const deadlines = working.map((step) => step.activity?.expiresAt)
          .filter((deadline): deadline is number => typeof deadline === "number" && Number.isFinite(deadline));
        nextTask.activity = working.length > 0
          ? { state: "working", ...(deadlines.length > 0 ? { expiresAt: Math.min(...deadlines) } : {}) }
          : { state: "unknown" };
      }
      changed = true;
      return nextTask;
    }
    return t as TaskVM;
  });
  if (!changed) return vm;
  const plan = vm.plan;
  let nextPlan = plan as PlanVM | undefined;
  if (plan && typeof plan === "object" && Array.isArray((plan as { agents?: unknown }).agents)) {
    const agents = (plan as { agents: readonly { agent: string; active: boolean }[] }).agents;
    const workingAgents = new Set<string>();
    for (const t of nextTasks) {
      if (!t || typeof t !== "object") continue;
      if ((t as TaskVM).workspace !== vm.workspace || (t as TaskVM).archived) continue;
      if ((t as TaskVM).activity?.state !== "working") continue;
      const a = (t as TaskVM).assignee;
      if (typeof a === "string" && a.length > 0) workingAgents.add(a);
    }
    nextPlan = { ...plan, agents: agents.map((a) => ({ ...a, active: workingAgents.has(a.agent) })) } as PlanVM;
  }
  return { ...vm, tasks: nextTasks, ...(nextPlan !== undefined ? { plan: nextPlan } : {}) };
}

function minExpiry(vm: WallMountVM): number | undefined {
  if (!vm || typeof vm !== "object") return undefined;
  const stale = (vm as { syncStale?: unknown }).syncStale === true;
  if (stale) return undefined;
  let min: number | undefined;
  const consider = (raw: unknown): void => {
    if (!raw || typeof raw !== "object") return;
    const act = raw as { state?: unknown; expiresAt?: unknown };
    if (act.state !== "working") return;
    const exp = act.expiresAt;
    if (typeof exp === "number" && Number.isFinite(exp)) min = min === undefined ? exp : Math.min(min, exp);
  };
  for (const t of Array.isArray(vm.tasks) ? vm.tasks : []) {
    if (!t || typeof t !== "object") continue;
    consider((t as TaskVM).activity);
    for (const s of Array.isArray((t as TaskVM).steps) ? (t as TaskVM).steps : []) {
      if (s && typeof s === "object") consider((s as { activity?: unknown }).activity);
    }
  }
  return min;
}

const ATT_ORDER: Record<string, number> = { now: 0, high: 1, low: 2, none: 3 };

const VIEWS: [WallViewId, string][] = [
  ["wall", "Wall"],
  ["agenda", "Agenda"],
  ["diary", "Diary"],
  ["archive", "Archive"],
  ["memory", "Memory"],
];
const DESTINATIONS: [WallViewId, string][] = [...VIEWS, ["swarm", "Swarm"]];

function isOpenTask(t: unknown): boolean {
  if (!t || typeof t !== "object") return false;
  const rec = t as TaskVM;
  if (rec.archived) return false;
  if (rec.status === "done" || rec.status === "failed") return false;
  return true;
}

function statusLabel(status: unknown): string {
  if (typeof status === "string" && Object.prototype.hasOwnProperty.call(STATUS_LABEL, status)) return STATUS_LABEL[status] as string;
  if (typeof status === "string" && status.length > 0) return status;
  return "";
}

function stepLabel(state: unknown): string {
  if (typeof state === "string" && Object.prototype.hasOwnProperty.call(STEP_LABEL, state)) return STEP_LABEL[state] as string;
  if (typeof state === "string" && state.length > 0) return state;
  return "unknown";
}

function attOrder(a: unknown): number {
  if (typeof a === "string" && Object.prototype.hasOwnProperty.call(ATT_ORDER, a)) return ATT_ORDER[a] as number;
  return 3;
}

function safeMs(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return `${v} ms`;
  if (typeof v === "string") return `${v} ms`;
  return "0 ms";
}

/** U51: explicit chip map; any other kind is treated as Rules (no cloud mislabel). */
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
  // U38 V3: Nano/cloud chips only when a model actually ran (source + ms > 0);
  // otherwise the content came from rules / plain agent text.
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

function extractTime(at: unknown): string {
  if (typeof at !== "string" || at.length === 0) return "";
  const m = /(\d{2}:\d{2})/.exec(at);
  return m ? (m[1] as string) : "";
}

function stepTimeText(at: unknown): string {
  if (typeof at !== "string" || at.length === 0) return "";
  const t = extractTime(at);
  if (t) return t;
  return at;
}

let mountSeq = 0;

export function mountWall(host: HTMLElement, vm: WallMountVM, handlers?: WallMountHandlers): WallMountHandle;
export function mountWall(host: HTMLElement, vm: WallVM, handlers?: WallHandlers): WallHandle;
export function mountWall(host: HTMLElement, vm: WallMountVM, handlers?: WallMountHandlers): WallMountHandle {
  if (!host || (host as unknown as { nodeType?: unknown }).nodeType !== 1) {
    throw new TypeError("mountWall: host element required");
  }
  const doc: Document = host.ownerDocument;
  const instanceId = `u36-${++mountSeq}`;
  const expanded = new Map<string, boolean>();
  let wsHelpOpen = false;
  let wsHelpReturn: "new" | "guidance" = "new";
  let messagesOpen = false;
  let navigationOpen = false;
  let messageTaskId: string | undefined;
  let selectedPhase: string | null = null;
  let destroyed = false;
  let currentHandlers = handlers;
  let currentVm: WallMountVM = vm;
  let pendingFocusView: WallViewId | null = null;
  let lastLive = "";
  let lastGuidanceCopy = "";
  let lastView: WallViewId | undefined;
  let lastActivities = new Map<string, string>();
  let lastLifecycles = new Map<string, string>();
  let lastLifecycleScope: string | undefined;
  let swarmScope = "";
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  const navigationToggle = el(doc, "button", "nav-toggle", "Navigation");
  navigationToggle.type = "button";
  navigationToggle.setAttribute("aria-controls", `${instanceId}-navigation`);
  navigationToggle.setAttribute("aria-expanded", "false");

  // A stable, wall-owned native trigger survives refreshes and sheet focus return.
  const modelsTrigger = el(doc, "button", "status-line models-trigger", "Models");
  modelsTrigger.type = "button";
  modelsTrigger.setAttribute("aria-haspopup", "dialog");
  modelsTrigger.setAttribute("aria-controls", "model-sheet");
  modelsTrigger.setAttribute("aria-expanded", "false");

  const messagesToggle = el(doc, "button", "messages-toggle", "Messages (legacy)");
  messagesToggle.type = "button";
  messagesToggle.setAttribute("aria-controls", `${instanceId}-messages`);

  // Keep the single app root and its polite region attached across refreshes.
  const app = el(doc, "div", "app");
  const rail = el(doc, "aside", "rail");
  const announcer = el(doc, "div", "announcer visually-hidden");
  announcer.setAttribute("aria-live", "polite");
  announcer.setAttribute("role", "status");
  rail.appendChild(announcer);
  app.appendChild(rail);
  host.replaceChildren(app);

  function announceLive(msg: string): void {
    try {
      announcer.textContent = msg;
      lastLive = msg;
    } catch { /* contained */ }
  }

  function clearExpiry(): void {
    if (expiryTimer !== undefined) {
      try { clearTimeout(expiryTimer); } catch { /* contained */ }
      expiryTimer = undefined;
    }
  }

  function scheduleExpiry(): void {
    clearExpiry();
    if (destroyed) return;
    const min = minExpiry(currentVm);
    if (min === undefined) return;
    const delay = Math.max(0, min - Date.now() + 1);
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined;
      if (destroyed) return;
      const next = expireVm(currentVm, Date.now());
      if (next === currentVm) return;
      currentVm = next;
      render(next);
    }, delay);
  }

  type SwarmTaskIdentity = { metadataId: string; taskLabel: string };

  function swarmMetadata(root: ParentNode, id: string): HTMLButtonElement | undefined {
    return [...root.querySelectorAll<HTMLButtonElement>(".swarm-metadata-toggle")]
      .find(button => button.getAttribute("aria-controls") === id);
  }

  function swarmIdentity(control: Element): SwarmTaskIdentity | undefined {
    const metadataId = control.closest(".swarm-card")
      ?.querySelector(".swarm-metadata-toggle")?.getAttribute("aria-controls");
    return metadataId ? { metadataId, taskLabel: control.textContent ?? "" } : undefined;
  }

  function swarmTask(root: ParentNode, identity: SwarmTaskIdentity): HTMLButtonElement | null {
    const button = swarmMetadata(root, identity.metadataId)?.closest(".swarm-card")
      ?.querySelector<HTMLButtonElement>(".swarm-task-open");
    return button?.textContent === identity.taskLabel ? button : null;
  }

  function disposeSwarm(root: HTMLElement | null): void {
    // Detach before closing: release the renderer's document listener without
    // focusing its obsolete trigger during a refresh or destruction.
    root?.remove();
    root?.querySelector<HTMLButtonElement>(".swarm-detail-close")?.click();
  }

  type FocusDescriptor = { kind: "step"; taskId: string; idx: string; microId: string }
    | { kind: "workspace"; id: string }
    | { kind: "workspace-help"; control: "new" | "guidance" | "heading" | "close" }
    | { kind: "swarm"; scope: string; identity: SwarmTaskIdentity; control: "metadata" | "task" | "detail" | "close" }
    | { kind: "task-title"; scope: string; view: string; taskVmId: string }
    | { kind: "phase-reset"; phaseId: string | null }
    | { kind: "phase"; phaseId: string }
    | { kind: "nav"; nav: string }
    | { kind: "view-panel"; id: string }
    | { kind: "navigation" }
    | { kind: "models" }
    | { kind: "messages" }
    | { kind: "messages-control"; control: "messages-open" | "messages-task"; taskId?: string };

  function captureFocus(): FocusDescriptor | undefined {
    try {
      const active = doc.activeElement;
      if (!active || active === doc.body || !host.contains(active)) return undefined;
      const elc = active as HTMLElement;
      if (elc.matches(".workspace-help")) return { kind: "workspace-help", control: "guidance" };
      if (elc.matches(".ws-new")) return { kind: "workspace-help", control: "new" };
      if (elc.matches(".ws-help > h2")) return { kind: "workspace-help", control: "heading" };
      if (elc.matches(".ws-close")) return { kind: "workspace-help", control: "close" };
      if (elc.matches('.view[role="tabpanel"]')) return { kind: "view-panel", id: elc.id };
      if (elc.matches("button[data-wsid]")) return { kind: "workspace", id: elc.getAttribute("data-wsid") ?? "" };
      if (elc.matches(".swarm-metadata-toggle, .swarm-task-open")) {
        const identity = swarmIdentity(elc);
        if (identity) return { kind: "swarm", scope: swarmScope, identity,
          control: elc.classList.contains("swarm-metadata-toggle") ? "metadata" : "task" };
      }
      const detail = elc.closest(".swarm-detail");
      if (detail) {
        const trigger = detail.closest(".swarm-view")?.querySelector('.swarm-task-open[aria-expanded="true"]');
        const identity = trigger ? swarmIdentity(trigger) : undefined;
        if (identity) return { kind: "swarm", scope: swarmScope, identity,
          control: elc.classList.contains("swarm-detail-close") ? "close" : "detail" };
      }
      if (elc === navigationToggle) return { kind: "navigation" };
      if (elc === modelsTrigger) return { kind: "models" };
      if (elc.classList.contains("messages-toggle")) return { kind: "messages" };
      if (elc.classList.contains("messages-open")) return { kind: "messages-control", control: "messages-open" };
      if (elc.classList.contains("messages-task")) return { kind: "messages-control", control: "messages-task", taskId: elc.getAttribute("data-task-vm-id") ?? "" };
      if (elc.matches(".task-detail-toggle")) return {
        kind: "task-title", scope: swarmScope, view: app.getAttribute("data-view") ?? "",
        taskVmId: elc.getAttribute("data-task-vm-id") ?? "",
      };
      if (elc.matches(".phase-show-all")) return { kind: "phase-reset", phaseId: selectedPhase };
      if (elc.classList && elc.classList.contains("phase-chip")) return { kind: "phase", phaseId: elc.getAttribute("data-phase-id") || "" };
      if (elc.classList && elc.classList.contains("step-row")) {
        return { kind: "step", taskId: elc.getAttribute("data-task-id") || "", idx: elc.getAttribute("data-step-idx") || "", microId: elc.getAttribute("data-micro-id") || "" };
      }
      const tab = typeof (active as Element).closest === "function" ? ((active as Element).closest('button.nav-item[data-nav]') as Element | null) : null;
      if (tab) return { kind: "nav", nav: tab.getAttribute("data-nav") || "" };
    } catch { /* contained */ }
    return undefined;
  }

  function restoreFocus(descriptor: FocusDescriptor | undefined): void {
    if (!descriptor || destroyed) return;
    try {
      let target: Element | null = null;
      if (descriptor.kind === "workspace") {
        target = [...host.querySelectorAll<HTMLButtonElement>("button[data-wsid]")]
          .find(button => button.getAttribute("data-wsid") === descriptor.id) ?? null;
      } else if (descriptor.kind === "workspace-help") {
        const selector = descriptor.control === "guidance" ? ".workspace-help" : descriptor.control === "new" ? ".ws-new"
          : descriptor.control === "heading" ? ".ws-help > h2" : ".ws-close";
        target = host.querySelector(selector);
      } else if (descriptor.kind === "swarm") {
        if (descriptor.scope !== swarmScope) return;
        const trigger = swarmTask(host, descriptor.identity);
        if (descriptor.control === "metadata") target = swarmMetadata(host, descriptor.identity.metadataId) ?? null;
        else if (descriptor.control === "task") target = trigger;
        else if (trigger?.getAttribute("aria-expanded") === "true") {
          target = host.querySelector(descriptor.control === "close" ? ".swarm-detail-close" : ".swarm-detail");
        }
      } else if (descriptor.kind === "view-panel") {
        target = [...host.querySelectorAll<HTMLElement>('[role="tabpanel"]')]
          .find(panel => panel.id === descriptor.id && !panel.hidden) ?? null;
      } else if (descriptor.kind === "navigation") {
        target = navigationToggle;
      } else if (descriptor.kind === "models") {
        target = modelsTrigger;
      } else if (descriptor.kind === "messages") {
        target = host.querySelector(".messages-toggle");
      } else if (descriptor.kind === "messages-control") {
        target = descriptor.control === "messages-open" ? host.querySelector(".messages-open")
          : [...host.querySelectorAll<HTMLElement>(".messages-task")]
            .find(node => node.getAttribute("data-task-vm-id") === descriptor.taskId) ?? null;
      } else if (descriptor.kind === "task-title") {
        if (descriptor.scope !== swarmScope || descriptor.view !== app.getAttribute("data-view")) return;
        target = [...host.querySelectorAll<HTMLElement>(".task-detail-toggle")]
          .find(control => control.getAttribute("data-task-vm-id") === descriptor.taskVmId
            && !control.closest("[hidden], [inert]")) ?? null;
      } else if (descriptor.kind === "phase-reset") {
        const phases = [...host.querySelectorAll<HTMLButtonElement>("button.phase-chip")]
          .filter(button => !button.closest("[hidden], [inert]"));
        target = host.querySelector(".phase-show-all:not([hidden])")
          ?? phases.find(button => button.getAttribute("data-phase-id") === descriptor.phaseId)
          ?? phases.find(button => button.getAttribute("aria-current") === "step")
          ?? phases[0] ?? host.querySelector('.view[role="tabpanel"]');
      } else if (descriptor.kind === "phase") {
        target = host.querySelector(`button.phase-chip[data-phase-id="${descriptor.phaseId.replace(/"/g, '')}"]`);
      } else if (descriptor.kind === "step") {
        target = [...host.querySelectorAll<HTMLElement>("button.step-row")].find((n) => {
          const micro = n.getAttribute("data-micro-id");
          const task = n.getAttribute("data-task-id");
          const idxAttr = n.getAttribute("data-step-idx");
          return (descriptor.microId !== "" && micro === descriptor.microId) || (task === descriptor.taskId && idxAttr === descriptor.idx);
        }) ?? null;
      } else if (descriptor.kind === "nav") {
        target = [...host.querySelectorAll<HTMLElement>("button.nav-item[data-nav]")]
          .find(button => button.getAttribute("data-nav") === descriptor.nav) ?? null;
        const panel = target?.closest(".navigation-panel");
        if (panel && doc.defaultView?.getComputedStyle(panel).display === "none") target = navigationToggle;
      }
      if (target && typeof (target as HTMLElement).focus === "function") {
        (target as HTMLElement).focus({ preventScroll: descriptor.kind === "task-title" });
      }
    } catch { /* contained */ }
  }

  function expKey(taskId: unknown, idx: number): string {
    return `${asStr(taskId)}:${idx}`;
  }

  function setNavigationOpen(open: boolean): void {
    navigationOpen = open;
    navigationToggle.setAttribute("aria-expanded", String(open));
    const panel = host.querySelector<HTMLElement>(".navigation-panel");
    panel?.setAttribute("data-expanded", String(open));
    // A compact menu must not leave keyboard focus in its collapsed contents.
    if (!open && panel?.contains(doc.activeElement) && doc.defaultView?.getComputedStyle(panel).display === "none") {
      navigationToggle.focus();
    }
  }

  function closeWorkspaceHelp(): void {
    wsHelpOpen = false;
    render(currentVm);
    const trigger = host.querySelector<HTMLElement>(wsHelpReturn === "guidance" ? ".workspace-help" : ".ws-new")
      ?? host.querySelector<HTMLElement>(".ws-new");
    trigger?.focus();
  }

  function onKey(e: KeyboardEvent): void {
    if (destroyed) return;
    if (e.key === "Escape" && navigationOpen && (e.target === navigationToggle
      || host.querySelector(".navigation-panel")?.contains(e.target as Node))) {
      e.preventDefault();
      setNavigationOpen(false);
      navigationToggle.focus();
      return;
    }
    if (e.key === "Escape" && wsHelpOpen) {
      e.preventDefault();
      closeWorkspaceHelp();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const t = e.target as Element | null;
    if (t && typeof (t as HTMLElement).tagName === "string") {
      const tag = (t as HTMLElement).tagName.toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      let cur: Element | null = t;
      while (cur) {
        if (typeof cur.hasAttribute === "function" && cur.hasAttribute("contenteditable")) {
          const v = cur.getAttribute("contenteditable");
          if (v !== "false" && (v ?? "").toLowerCase() !== "false") return;
          break;
        }
        cur = cur.parentElement;
      }
    }
    const tab = t && typeof t.closest === "function" ? t.closest('[role="tab"]') : null;
    if (tab && host.contains(tab)) {
      const index = VIEWS.findIndex(([vid]) => vid === tab.getAttribute("data-nav"));
      let destination: number | null = null;
      if ((e.key === "ArrowRight" || e.key === "ArrowDown") && index >= 0) destination = (index + 1) % VIEWS.length;
      else if ((e.key === "ArrowLeft" || e.key === "ArrowUp") && index >= 0) destination = (index - 1 + VIEWS.length) % VIEWS.length;
      else if (e.key === "Home") destination = 0;
      else if (e.key === "End") destination = VIEWS.length - 1;
      const entry = destination === null ? undefined : VIEWS[destination];
      if (entry) {
        e.preventDefault();
        pendingFocusView = entry[0];
        if (currentHandlers?.onView) containViewCallback(() => currentHandlers?.onView?.(entry[0]));
        return;
      }
    }
    const idx = ["1", "2", "3", "4", "5", "6"].indexOf(e.key);
    if (idx < 0) return;
    const entry = DESTINATIONS[idx];
    if (!entry) return;
    setNavigationOpen(false);
    if (currentHandlers?.onView) containViewCallback(() => currentHandlers?.onView?.(entry[0]));
  }

  function onClick(e: MouseEvent): void {
    if (destroyed) return;
    const target = e.target as Element | null;
    if (!target || typeof (target as Element).closest !== "function") return;
    const btn = (target as Element).closest("button");
    // Wall task cards are read-only; legacy chat opens from Messages only.
    if (!btn || !host.contains(btn)) return;
    if (btn === navigationToggle) {
      setNavigationOpen(!navigationOpen);
      return;
    }
    if (btn.classList.contains("nav-item")) {
      const v = btn.getAttribute("data-nav");
      if (isWallView(v)) {
        setNavigationOpen(false);
        if (currentHandlers?.onView) containViewCallback(() => currentHandlers?.onView?.(v));
      }
      return;
    }
    if (btn.classList.contains("messages-toggle")) {
      messagesOpen = !messagesOpen;
      render(currentVm);
      return;
    }
    if (btn.classList.contains("messages-open") || btn.classList.contains("messages-task")) {
      if (!messagesOpen || btn.hasAttribute("disabled") || !btn.closest(".messages-body")) return;
      const id = btn.getAttribute("data-task-vm-id") ?? messageTaskId;
      const task = currentVm.tasks.find(t => t.id === id && !t.archived && t.workspace === currentVm.workspace);
      if (!task) return;
      messageTaskId = task.id;
      if (currentHandlers?.onOpenTask) {
        const trigger = { triggerId: btn.id, taskId: task.taskId ?? task.id,
          ...(task.steps?.[0]?.microId ? { microId: task.steps[0].microId } : {}) };
        containViewCallback(() => currentHandlers?.onOpenTask?.(task.id, btn.id, trigger));
      } else containViewCallback(() => currentHandlers?.onOpenMessages?.());
      return;
    }
    if (btn.classList.contains("workspace")) {
      const id = btn.getAttribute("data-wsid");
      if (id !== null && currentHandlers?.onWorkspace) containViewCallback(() => currentHandlers?.onWorkspace?.(id));
      return;
    }
    if (btn.classList.contains("ws-new") || btn.classList.contains("workspace-help")) {
      wsHelpReturn = btn.classList.contains("workspace-help") ? "guidance" : "new";
      wsHelpOpen = true;
      if (wsHelpReturn === "new" && currentHandlers?.onNewWorkspace) containViewCallback(() => currentHandlers?.onNewWorkspace?.());
      render(currentVm);
      host.querySelector<HTMLElement>(".ws-help > h2")?.focus();
      return;
    }
    if (btn.classList.contains("ws-close")) {
      closeWorkspaceHelp();
      return;
    }
    if (btn.classList.contains("phase-show-all")) {
      const resetFocus: FocusDescriptor = { kind: "phase-reset", phaseId: selectedPhase };
      selectedPhase = null;
      render(currentVm, resetFocus);
      return;
    }
    // U51: the model trigger is identified by its fixed aria-controls marker, never by the sanitized state.
    if ((btn.classList.contains("status-line") || btn.classList.contains("rules-line")) && btn.getAttribute("aria-controls") === "model-sheet") {
      const open = currentHandlers?.onOpenModels;
      // Contained: a sync throw or an async rejection from the injected callback never escapes the listener.
      if (open) {
        try {
          const r: unknown = (open as (b: HTMLElement) => unknown)(btn);
          if (r !== null && (typeof r === "object" || typeof r === "function") && typeof (r as { then?: unknown }).then === "function") {
            (r as PromiseLike<unknown>).then(undefined, () => { /* contained */ });
          }
        } catch { /* contained */ }
      }
      return;
    }
    if (btn.classList.contains("theme-toggle")) {
      if (currentHandlers?.onThemeToggle) containViewCallback(() => currentHandlers?.onThemeToggle?.());

      return;
    }
    if (btn.classList.contains("archive-option")) {
      const s = btn.getAttribute("data-scope") as "workspace" | "all" | null;
      if (s && currentHandlers?.onArchiveScope) containViewCallback(() => currentHandlers?.onArchiveScope?.(s));
      return;
    }
    if (btn.classList.contains("archived-restore")) {
      const id = btn.getAttribute("data-arch-id");
      if (id !== null && currentHandlers?.onRestore) containViewCallback(() => currentHandlers?.onRestore?.(id));
      return;
    }
    if (btn.classList.contains("step-row")) {
      const legacyBody = btn.closest<HTMLElement>(".messages-body");
      if (legacyBody !== null) {
        messagesOpen = true;
        messagesToggle.setAttribute("aria-expanded", "true");
        legacyBody.hidden = false;
      }
      const taskId = btn.getAttribute("data-task-id");
      const idxS = btn.getAttribute("data-step-idx");
      if (taskId === null || idxS === null) return;
      const idx = Number(idxS);
      const key = expKey(taskId, idx);
      const next = !(expanded.get(key) === true);
      expanded.set(key, next);
      btn.setAttribute("aria-expanded", String(next));
      const li = btn.closest("li.step");
      if (li) {
        const panel = li.querySelector(".step-detail") as HTMLElement | null;
        if (panel) panel.hidden = !next;
        li.toggleAttribute("data-open", next);
      }
      const micro = btn.getAttribute("data-micro-id") || `${taskId}.M${String(idx + 1).padStart(2, "0")}`;
      announceLive(next ? `Expanded outcome for ${micro}` : `Collapsed outcome for ${micro}`);
      if (currentHandlers?.onToggleMicroDetail) {
        containViewCallback(() => currentHandlers?.onToggleMicroDetail?.(taskId, idx));
      }
      return;
    }
    if (btn.classList.contains("phase-chip")) {
      const pid = btn.getAttribute("data-phase-id");
      if (pid !== null) {
        selectedPhase = pid;
        render(currentVm);
        announceLive(`Phase ${pid} selected`);
        if (currentHandlers?.onSelectPhase) {
          containViewCallback(() => currentHandlers?.onSelectPhase?.(pid));
        }
      }
      return;
    }
  }

  doc.addEventListener("keydown", onKey);
  host.addEventListener("click", onClick);

  function render(rawVm: WallMountVM, focusOverride?: FocusDescriptor): void {
    if (destroyed) return;
    rawVm = expireVm(rawVm, Date.now());
    currentVm = rawVm;
    const focusDesc = focusOverride ?? captureFocus();
    const previousTaskView = app.getAttribute("data-view");
    const openTaskDetails = new Set([...host.querySelectorAll<HTMLDetailsElement>(".task-detail[open]")]
      .map(detail => detail.querySelector(".task-detail-toggle")?.getAttribute("data-task-vm-id")));
    const previousSwarm = host.querySelector<HTMLElement>(".swarm-view");
    const previousScope = swarmScope;
    const openMetadata = new Set([...previousSwarm?.querySelectorAll('.swarm-metadata-toggle[aria-expanded="true"]') ?? []]
      .map(button => button.getAttribute("aria-controls")));
    const openTrigger = previousSwarm?.querySelector('.swarm-task-open[aria-expanded="true"]');
    const openTask = openTrigger ? swarmIdentity(openTrigger) : undefined;
    // U51: keep the sheet-owned aria-expanded across re-renders of the model trigger.
    const prevExpanded = host.querySelector('button.status-line[aria-controls="model-sheet"]')?.getAttribute("aria-expanded") === "true";
    for (const child of Array.from(app.children)) if (child !== rail) child.remove();
    for (const child of Array.from(rail.children)) if (child !== announcer) child.remove();
    disposeSwarm(previousSwarm);
    const input = (rawVm && typeof rawVm === "object" ? rawVm : {}) as Partial<WallMountVM>;
    const workspaces: WorkspaceVM[] = Array.isArray(input.workspaces) ? (input.workspaces as WorkspaceVM[]) : [];
    const tasks: TaskVM[] = Array.isArray(input.tasks) ? (input.tasks as TaskVM[]) : [];
    const agenda: AgendaGroupVM[] = Array.isArray(input.agenda) ? (input.agenda as AgendaGroupVM[]) : [];
    const archive: ArchivedVM[] = Array.isArray(input.archive) ? (input.archive as ArchivedVM[]) : [];
    const workspaceId = asStr((input as { workspace?: unknown }).workspace);
    const view: WallViewId = isWallView(input.view) ? input.view : "wall";
    const planIn = (input as { plan?: unknown }).plan;
    const hasPlan = planIn !== undefined && planIn !== null;
    const planId = planIn && typeof planIn === "object" ? asStr((planIn as { id?: unknown }).id) : "";
    swarmScope = JSON.stringify([workspaceId, input.swarm?.room ?? null, planId]);
    const diaryIn = (input as { diary?: unknown }).diary;
    const memoryIn = (input as { memory?: unknown }).memory as unknown;
    const archiveScope = (input.archiveScope as unknown) === "all" ? "all" : "workspace";
    const nowText = asStr(input.now);
    const model = (input.model && typeof input.model === "object" ? input.model : {}) as { state?: unknown; label?: unknown };
    const modelState = asStr(model.state);
    // U38 V5: never an empty model status label when the state is unknown.
    // Availability wins over a stale provider label; Rules may remain active.
    let reportedModelLabel = asStr(model.label);
    if (modelState === "unavailable") {
      reportedModelLabel = reportedModelLabel.replace(/\b(Gemini Nano|on[- ]device(?: provider| model)?|cloud(?: provider| model)?)\s*[:·-]?\s*(?:is\s+)?(?:active|ready)\b/gi, "$1 unavailable");
    }
    if (/\bcloud\s+disabled\b/i.test(asStr(input.availability))) {
      reportedModelLabel = reportedModelLabel.replace(/\b(cloud(?: provider| model)?)\s*[:·-]?\s*(?:is\s+)?(?:active|ready)\b/gi, "$1 unavailable");
    }
    const modelLabel = reportedModelLabel || (modelState === "ready"
      ? "Gemini Nano: ready on this device."
      : modelState === "downloading"
        ? "Gemini Nano: downloading on this device."
        : hasPlan
          ? "Gemini Nano: not available on this device — enable the on-device model flags in Chrome. Rules is the active reviewer."
          : "Gemini Nano: checking…");
    const network = asStr(input.network);

    // Root attributes are refreshed even when the next VM omits a workspace.
    app.removeAttribute("data-lens");
    // root attributes
    app.setAttribute("data-view", view);
    if (workspaceId) app.setAttribute("data-workspace", workspaceId);
    else app.setAttribute("data-workspace", "");
    app.setAttribute("data-archive-scope", archiveScope);
    // data-lens from effective workspace if safe
    const effWs = workspaces.find((w) => w && (w as WorkspaceVM).id === workspaceId) ?? (workspaces.length > 0 ? (workspaces[0] as WorkspaceVM) : null);
    if (effWs) setSafeData(app, "data-lens", (effWs as { lens?: unknown }).lens);
    // effective workspace for topbar eyebrow; if raw id unknown, fall back to first for highlight
    const highlightedWsId = effWs ? asStr((effWs as { id?: unknown }).id) : workspaceId;

    // ---- rail ----
    const brand = el(doc, "div", "brand");
    const brandMark = el(doc, "span", "brand-mark");
    brandMark.setAttribute("aria-hidden", "true");
    brand.appendChild(brandMark);
    brand.appendChild(el(doc, "span", "brand-name", "TaskLight"));
    rail.appendChild(brand);

    navigationToggle.setAttribute("aria-expanded", String(navigationOpen));
    const navigation = el(doc, "div", "navigation-panel");
    navigation.id = `${instanceId}-navigation`;
    navigation.setAttribute("data-expanded", String(navigationOpen));
    rail.append(navigationToggle, navigation);

    const nav = el(doc, "nav", "nav");
    nav.setAttribute("aria-label", "Views");
    const tablist = el(doc, "div", "nav-tabs");
    tablist.setAttribute("role", "tablist");
    tablist.setAttribute("aria-label", "Primary views");
    tablist.setAttribute("aria-orientation", "vertical");
    nav.appendChild(tablist);
    const visibleViews = VIEWS;
    visibleViews.forEach(([vid, label], i) => {
      const b = el(doc, "button", "nav-item");
      b.setAttribute("type", "button");
      b.setAttribute("data-nav", vid);
      b.id = `${instanceId}-${vid}-tab`;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(vid === view));
      b.setAttribute("aria-controls", `${instanceId}-${vid}-panel`);
      b.tabIndex = vid === view || (view === "swarm" && vid === "wall") ? 0 : -1;
      b.setAttribute("aria-keyshortcuts", String(i + 1));
      if (vid === view) b.setAttribute("aria-current", "page");
      const ic = el(doc, "span", "nav-icon");
      ic.setAttribute("aria-hidden", "true");
      ic.setAttribute("data-icon", vid);
      b.appendChild(ic);
      b.appendChild(el(doc, "span", "nav-label", label));
      const k = el(doc, "kbd", "nav-key", String(i + 1));
      k.setAttribute("aria-hidden", "true");
      b.appendChild(k);
      tablist.appendChild(b);
    });
    navigation.appendChild(nav);
    const secondary = el(doc, "nav", "nav-secondary");
    secondary.setAttribute("aria-label", "More views");
    const swarmNav = el(doc, "button", "nav-item", "Swarm");
    swarmNav.type = "button";
    swarmNav.setAttribute("data-nav", "swarm");
    swarmNav.setAttribute("aria-keyshortcuts", "6");
    if (view === "swarm") swarmNav.setAttribute("aria-current", "page");
    const swarmKey = el(doc, "kbd", "nav-key", "6");
    swarmKey.setAttribute("aria-hidden", "true");
    swarmNav.appendChild(swarmKey);
    secondary.appendChild(swarmNav);
    navigation.appendChild(secondary);
    const keyboardHelp = el(doc, "p", "keyboard-help",
      "Keyboard: use arrow keys to move between primary views (one Tab stop). Tab moves between regions and their controls.");
    keyboardHelp.id = `${instanceId}-keyboard-help`;
    tablist.setAttribute("aria-describedby", keyboardHelp.id);
    navigation.appendChild(keyboardHelp);

    const messages = el(doc, "section", "messages-legacy");
    messagesToggle.setAttribute("aria-expanded", String(messagesOpen));
    const messagesBody = el(doc, "div", "messages-body");
    messagesBody.id = `${instanceId}-messages`;
    messagesBody.hidden = !messagesOpen;
    messagesBody.appendChild(el(doc, "p", undefined, "Use your harness to message agents"));
    messagesBody.appendChild(el(doc, "p", undefined, "Open task messages for legacy chat and liaison."));
    const messageTasks = tasks.filter(t => t && !t.archived && t.workspace === workspaceId);
    const chosenMessageTask = messageTasks.find(task => task.id === messageTaskId) ?? messageTasks[0];
    messageTaskId = chosenMessageTask?.id;
    const messageList = el(doc, "ul", "messages-tasks");
    messageTasks.forEach((task, index) => {
      const item = el(doc, "li");
      const button = el(doc, "button", "messages-task", `${asStr(task.taskId) || asStr(task.project)} · ${asStr(task.title)}`);
      button.type = "button";
      button.id = `${instanceId}-message-task-${index}`;
      button.dataset.taskVmId = asStr(task.id);
      button.dataset.taskId = asStr(task.taskId) || asStr(task.id);
      button.disabled = !(currentHandlers?.onOpenTask || currentHandlers?.onOpenMessages);
      item.appendChild(button); messageList.appendChild(item);
    });
    messagesBody.appendChild(messageList);
    const openMessages = el(doc, "button", "messages-open", "Open task messages");
    openMessages.type = "button";
    openMessages.id = `${instanceId}-messages-open`;
    const messageTask = messageTasks.find(task => task.id === messageTaskId);
    if (messageTask) {
      openMessages.dataset.taskId = messageTask.taskId ?? messageTask.id;
    }
    openMessages.disabled = messageTasks.length === 0 || !(currentHandlers?.onOpenTask || currentHandlers?.onOpenMessages);
    messagesBody.appendChild(openMessages);
    messages.append(messagesToggle, messagesBody);
    rail.appendChild(messages);

    const heading = el(doc, "div", "rail-heading");
    heading.appendChild(el(doc, "span", undefined, "Workspaces"));
    const runningAll = tasks.filter((t) => t && !(t as TaskVM).archived && (t as TaskVM).status === "running").length;
    const meta = el(doc, "span", "rail-heading-meta", `${runningAll} running`);
    meta.setAttribute("aria-label", `${runningAll} tasks running across workspaces`);
    heading.appendChild(meta);
    rail.appendChild(heading);

    const wsList = el(doc, "ul", "workspaces");
    wsList.setAttribute("aria-label", "Workspaces");
    for (const w of workspaces) {
      if (!w || typeof w !== "object") continue;
      const wid = asStr((w as { id?: unknown }).id);
      const li = el(doc, "li");
      const b = el(doc, "button", "workspace");
      b.setAttribute("type", "button");
      setSafeData(b, "data-accent", (w as { accent?: unknown }).accent);
      setSafeData(b, "data-lens", (w as { lens?: unknown }).lens);
      if (wid === highlightedWsId) b.setAttribute("aria-current", "true");
      const wsDot = el(doc, "span", "ws-dot");
      wsDot.setAttribute("aria-hidden", "true");
      b.setAttribute("data-wsid", wid);
      b.appendChild(wsDot);
      const txtWrap = el(doc, "span", "ws-text");
      txtWrap.appendChild(el(doc, "span", "ws-name", asStr((w as { name?: unknown }).name)));
      const openCount = tasks.filter((t) => t && (t as TaskVM).workspace === wid && isOpenTask(t as TaskVM)).length;
      const lensWord = (w as { lens?: unknown }).lens === "study" ? "Study" : "Development";
      txtWrap.appendChild(el(doc, "span", "ws-lens", `${lensWord} · ${openCount} open`));
      b.appendChild(txtWrap);
      const badges = el(doc, "span", "ws-badges");
      const wsTasks = tasks.filter((t) => t && (t as TaskVM).workspace === wid && !(t as TaskVM).archived);
      const run = wsTasks.filter((t) => (t as TaskVM).status === "running").length;
      const need = needsUserTasks(wsTasks).length;
      if (run > 0) {
        const r = el(doc, "span", "ws-running", String(run));
        r.setAttribute("data-activity", wsTasks.some((t) => displayActivity(t.activity, input.syncStale === true) === "working") ? "working" : "unknown");
        r.setAttribute("aria-label", `${run} running`);
        r.setAttribute("title", `${run} running`);
        badges.appendChild(r);
      }
      if (need > 0) {
        const nd = el(doc, "span", "ws-needs", String(need));
        nd.setAttribute("aria-label", `${need} need you`);
        nd.setAttribute("title", `${need} need you`);
        badges.appendChild(nd);
      }
      b.appendChild(badges);
      li.appendChild(b);
      wsList.appendChild(li);
    }
    rail.appendChild(wsList);

    const wsNew = el(doc, "button", "ws-new");
    wsNew.setAttribute("type", "button");
    const nIcon = el(doc, "span", "ws-new-icon");
    nIcon.setAttribute("aria-hidden", "true");
    wsNew.appendChild(nIcon);
    wsNew.appendChild(el(doc, "span", undefined, "New workspace"));
    rail.appendChild(wsNew);

    const helpMount = el(doc, "div", "workspace-help-panel");
    helpMount.id = `${instanceId}-workspace-help`;
    helpMount.hidden = !wsHelpOpen;
    rail.appendChild(helpMount);
    if (wsHelpOpen) {
      const help = el(doc, "section", "ws-help");
      help.setAttribute("aria-label", "How to add a workspace");
      const helpHeading = el(doc, "h2", "ws-help-title", "How a workspace appears");
      helpHeading.tabIndex = -1;
      help.appendChild(helpHeading);
      help.style.minWidth = "0";
      help.style.overflowWrap = "anywhere";
      help.appendChild(el(doc, "p", "ws-help-body", "Installation allowlists the room in wall.config.json. Your harness connects through MCP, and an agent post supplies room activity. Opening this help or installing configuration does not connect a harness or deploy an agent."));
      help.appendChild(el(doc, "p", "ws-help-body", "Run these commands from the repository root. Replace <extension-id> with the loaded extension's ID. Preview writes nothing; Install writes configuration and preserves an existing wall.config.json."));
      const addCommand = (text: string, label: string): void => {
        const block = el(doc, "pre", "ws-help-cmd");
        block.setAttribute("aria-label", label);
        block.style.minWidth = "0";
        block.style.whiteSpace = "pre-wrap";
        block.style.overflowWrap = "anywhere";
        block.style.userSelect = "text";
        block.appendChild(el(doc, "code", undefined, text));
        help.appendChild(block);
      };
      const installer = 'python3 bridge/install.py --browser chrome --extension-id "<extension-id>" --room my-room:private';
      help.appendChild(el(doc, "h3", "ws-help-title", "Preview"));
      addCommand(installer, "Preview installer command");
      help.appendChild(el(doc, "h3", "ws-help-title", "Install"));
      addCommand(`${installer} --apply`, "Install command");
      help.appendChild(el(doc, "h3", "ws-help-title", "Connect your MCP client or agent harness"));
      addCommand("python3 -m bridge.room.mcp", "MCP server launch command");
      addCommand(JSON.stringify({
        command: "python3",
        args: ["-m", "bridge.room.mcp"],
        cwd: "<repo-root>",
        env: { CW_HOME: "<cw-home-path>" },
      }, null, 2), "MCP server registration");
      help.appendChild(el(doc, "p", "ws-help-body", "Replace <repo-root> with the path to the repository root and <cw-home-path> with the path to your local data directory. Use the same CW_HOME for the MCP server and native host, including when running the installer."));
      const link = el(doc, "a", "ws-help-link", "Read the desktop setup guide");
      link.setAttribute("href", "https://github.com/oguirado/TaskLight/blob/main/docs/DESKTOP_SETUP.md");
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
      help.appendChild(link);
      const close = el(doc, "button", "ws-close", "Close");
      close.setAttribute("type", "button");
      help.appendChild(close);
      helpMount.appendChild(help);
    }

    const railStatus = el(doc, "div", "rail-status");
    const modelLine = modelsTrigger;
    modelLine.setAttribute("aria-expanded", String(prevExpanded));
    setSafeData(modelLine, "data-model", modelState);
    railStatus.appendChild(modelLine);
    // One passive status line preserves device, reviewer and room-policy evidence.
    const modelHealth = el(doc, "div", "status-line model-health");
    setSafeData(modelHealth, "data-model", modelState);
    const modelDot = el(doc, "span", "status-dot");
    modelDot.setAttribute("aria-hidden", "true");
    const deviceStatus = modelState === "unavailable" ? "on-device unavailable"
      : modelState === "ready" ? "on-device ready"
      : modelState === "downloading" ? "downloading on-device model" : "status unavailable";
    modelHealth.append(modelDot, el(doc, "span", "model-status-copy"));
    const statusCopy = modelHealth.lastElementChild!;
    statusCopy.append(el(doc, "span", "model-device-status", `Models: ${deviceStatus} · `),
      el(doc, "span", "status-text", modelLabel));
    if (!/\bRules\b/i.test(modelLabel)) statusCopy.append(doc.createTextNode(" · Rules summary"));
    if (input.availability) statusCopy.append(doc.createTextNode(` · ${input.availability}`));
    railStatus.appendChild(modelHealth);
    const netLine = el(doc, "div", "status-line");
    setSafeData(netLine, "data-network", network);
    const nDot = el(doc, "span", "status-dot");
    nDot.setAttribute("aria-hidden", "true");
    netLine.appendChild(nDot);
    netLine.appendChild(el(doc, "span", "status-text", network === "offline" ? "Offline" : "Online"));
    railStatus.appendChild(netLine);
    const themeName = input.theme === "dark" ? "dark" : input.theme === "light"
      ? "light"
      : (doc.documentElement?.dataset?.theme === "dark" ? "dark" : "light");
    const theme = el(doc, "button", "theme-toggle", "Toggle theme");
    theme.setAttribute("type", "button");
    theme.setAttribute("aria-label", `Toggle theme: ${themeName}`);
    railStatus.appendChild(theme);
    rail.appendChild(railStatus);

    const main = el(doc, "main", "main");
    // topbar
    const topbar = el(doc, "header", "topbar");
    const titles = el(doc, "div", "topbar-titles");
    titles.appendChild(el(doc, "p", "view-eyebrow", effWs ? asStr((effWs as { name?: unknown }).name) : ""));
    const viewTitle = DESTINATIONS.find((v) => v[0] === view)?.[1] ?? view;
    titles.appendChild(el(doc, "h1", "view-title", viewTitle));
    const knownWorkspace = workspaces.some((w) => w && typeof w === "object" && (w as { id?: unknown }).id === workspaceId);
    const openForRaw = knownWorkspace ? tasks.filter((t) => t && (t as TaskVM).workspace === workspaceId && isOpenTask(t as TaskVM)).length : 0;
    // if workspace unknown but effective exists, show effective open count? Use raw (0). Tests for known workspaces equal.
    // For unknown, raw is 0 which is fine.
    const lensSub = effWs ? ((effWs as { lens?: unknown }).lens === "study" ? "Study" : "Development") : "Development";
    titles.appendChild(el(doc, "p", "view-sub", `${nowText} · ${openForRaw} open tasks · ${lensSub} lens`));
    topbar.appendChild(titles);
    main.appendChild(topbar);

    // focus section (always present)
    const focusSec = el(doc, "section", "focus");
    main.appendChild(focusSec);

    const viewWrap = el(doc, "div", "view");
    main.appendChild(viewWrap);
    // Inactive panels are empty until selected, but every tab relationship resolves.
    for (const [vid] of VIEWS) {
      const panel = vid === view ? viewWrap : el(doc, "div", "inactive-view");
      panel.id = `${instanceId}-${vid}-panel`;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", `${instanceId}-${vid}-tab`);
      panel.tabIndex = 0;
      if (panel !== viewWrap) {
        panel.hidden = true;
        main.appendChild(panel);
      }
    }
    app.appendChild(main);

    // helpers for tasks
    const wsTasksAll = (wsid: string, withArchived: boolean): TaskVM[] => {
      if (wsid !== workspaceId || !knownWorkspace) return [];
      return tasks.filter((t) => t && typeof t === "object" && (t as TaskVM).workspace === wsid && (withArchived || !(t as TaskVM).archived));
    };
    const sortByAttention = (arr: TaskVM[]): TaskVM[] => {
      const indexed = arr.map((t, i) => ({ t, i, o: attOrder((t as TaskVM).attention) }));
      indexed.sort((a, b) => (a.o - b.o) || (a.i - b.i));
      return indexed.map((x) => x.t);
    };

    // ---- focus ----
    const needs = needsUserTasks(sortByAttention(wsTasksAll(workspaceId, false)));
    const showFocus = view === "wall" && needs.length > 0;
    if (!showFocus) {
      focusSec.hidden = true;
    } else {
      focusSec.hidden = false;
      const first = needs[0] as TaskVM;
      setSafeData(focusSec, "data-attention", (first as { attention?: unknown }).attention);
      focusSec.appendChild(el(doc, "p", "focus-eyebrow", needs.length === 1 ? "1 task needs you" : `${needs.length} tasks need you`));
      const ul = el(doc, "ul", "focus-list");
      for (const t of needs) {
        const tid = asStr((t as { id?: unknown }).id);
        const li = el(doc, "li", "focus-item");
        setSafeData(li, "data-status", (t as { status?: unknown }).status);
        const a = el(doc, "a", "focus-link");
        a.setAttribute("href", `#${tid}`);
        a.appendChild(el(doc, "span", "focus-project", t.taskId !== undefined ? `${t.taskId} ${t.title}` : asStr((t as { project?: unknown }).project)));
        const steps = Array.isArray((t as { steps?: unknown }).steps) ? ((t as unknown as { steps: unknown }).steps as unknown[]) : [];
        const cur = steps.find((s) => s && typeof s === "object" && (((s as StepVM).state as string) === "blocked" || ((s as StepVM).state as string) === "active"));
        let focusText: string;
        const low = statusLabel((t as { status?: unknown }).status).toLowerCase();
        if (cur && typeof (cur as StepVM).label === "string") focusText = `${(cur as StepVM).label} — ${low}`;
        else focusText = low || asStr((t as { status?: unknown }).status);
        a.appendChild(el(doc, "span", "focus-step", focusText));
        li.appendChild(a);
        ul.appendChild(li);
      }
      focusSec.appendChild(ul);
    }

    const syncStaleOf = (inp: Pick<Partial<WallVM>, "syncStale">): boolean => (inp as { syncStale?: unknown }).syncStale === true;
    function renderStep(doc: Document, step: StepVM, taskId: string, idx: number): HTMLElement {
      const li = el(doc, "li", "step");
      setSafeData(li, "data-state", (step as { state?: unknown }).state);
      li.setAttribute("data-activity", displayActivity((step as { activity?: unknown }).activity, syncStaleOf(input)));
      const st = (step as { state?: unknown }).state as StepStateVM;
      const detail = (step as { detail?: unknown }).detail as StepVM["detail"];
      const acceptRaw = asStr((step as { accept?: unknown }).accept);
      const hasDetail = detail != null && typeof detail === "object";
      const hasPanel = hasDetail || acceptRaw.length > 0;
      const syncStale = (input as { syncStale?: unknown }).syncStale === true;
      const act = displayActivity((step as { activity?: unknown }).activity, syncStale);
      let row: HTMLElement;
      if (hasPanel) {
        const btn = el(doc, "button", "step-row");
        btn.setAttribute("type", "button");
        const key = expKey(taskId, idx);
        const isOpen = expanded.get(key) === true;
        btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
        btn.setAttribute("aria-controls", `${instanceId}-${taskId}-s${idx}`);
        btn.setAttribute("data-task-id", taskId);
        btn.setAttribute("data-step-idx", String(idx));
        const microId = asStr((step as { microId?: unknown }).microId) || `${taskId}.M${String(idx + 1).padStart(2, "0")}`;
        btn.setAttribute("data-micro-id", microId);
        row = btn;
      } else {
        row = el(doc, "div", "step-row");
      }
      row.appendChild(activityIcon(doc, "step-indicator", act));
      const stxt = el(doc, "span", "step-text");
      stxt.appendChild(el(doc, "span", "step-label", asStr((step as { label?: unknown }).label)));
      stxt.appendChild(el(doc, "span", "step-activity-label", ` · ${ACTIVITY_LABEL[act] ?? "Liveness unknown"}`));
      stxt.appendChild(el(doc, "span", "visually-hidden", ` — ${stepLabel(st as unknown)}`));
      row.appendChild(stxt);
      const atVal = (step as { at?: unknown }).at;
      if (typeof atVal === "string" && atVal.length > 0) {
        row.appendChild(el(doc, "span", "step-time", stepTimeText(atVal)));
      }
      if (hasDetail) {
        const chev = el(doc, "span", "step-chevron");
        chev.setAttribute("aria-hidden", "true");
        row.appendChild(chev);
        // set initial open on li
        const key = expKey(taskId, idx);
        if (expanded.get(key) === true) li.toggleAttribute("data-open", true);
      }
      li.appendChild(row);
      const note = (step as { note?: unknown }).note;
      if (typeof note === "string" && note.length > 0) li.appendChild(el(doc, "p", "step-note", note));
      if (hasDetail) {
        const d = detail as NonNullable<StepVM["detail"]>;
        const div = el(doc, "div", "step-detail");
        (div as HTMLElement).id = `${instanceId}-${taskId}-s${idx}`;
        const key = expKey(taskId, idx);
        const isOpen = expanded.get(key) === true;
        div.hidden = !isOpen;
        div.appendChild(el(doc, "p", "detail-outcome", asStr((d as { outcome?: unknown }).outcome)));
        const metaDl = el(doc, "dl", "detail-meta");
        const atV = (step as { at?: unknown }).at;
        const tookV = (step as { took?: unknown }).took;
        if (typeof atV === "string" && atV.length > 0) {
          const pair = el(doc, "div", "detail-pair");
          pair.appendChild(el(doc, "dt", undefined, "Finished"));
          pair.appendChild(el(doc, "dd", undefined, atV));
          metaDl.appendChild(pair);
        }
        if (typeof tookV === "string" && tookV.length > 0) {
          const pair = el(doc, "div", "detail-pair");
          pair.appendChild(el(doc, "dt", undefined, "Took"));
          pair.appendChild(el(doc, "dd", undefined, tookV));
          metaDl.appendChild(pair);
        }
        div.appendChild(metaDl);
        div.appendChild(el(doc, "p", "detail-heading", "Evidence"));
        const evList = el(doc, "ul", "detail-evidence");
        const ev = Array.isArray((d as { evidence?: unknown }).evidence) ? ((d as unknown as { evidence: unknown }).evidence as unknown[]) : [];
        for (const e of ev) evList.appendChild(el(doc, "li", undefined, asStr(e)));
        div.appendChild(evList);
        div.appendChild(sourcechip(doc, (d as { source?: unknown }).source));
        li.appendChild(div);
      }
      return li;
    }

    // Guidance surrounds the existing read-only Swarm/Wall slots. Its text is
    // announced through the persistent region, never through remounted notices.
    let guidance = input.workspaceGuidance;
    try { guidance ??= currentHandlers?.workspaceGuidance?.(); } catch { /* Optional observation is unavailable. */ }
    if (guidance && guidance.room === workspaceId) {
      const section = el(doc, "section", "workspace-guidance");
      section.setAttribute("aria-label", `Workspace guidance for ${guidance.room}`);
      section.style.minWidth = "0";
      section.style.overflowWrap = "anywhere";
      section.appendChild(el(doc, "p", undefined, `Workspace: ${guidance.room}`));
      if (guidance.connected) section.appendChild(el(doc, "p", undefined, "Bridge connected"));
      if (guidance.saved) section.appendChild(el(doc, "p", undefined, "Saved progress; connection unavailable"));
      if (guidance.heading !== null) {
        const notice = el(doc, "div", "workspace-state");
        notice.appendChild(el(doc, "h2", undefined, guidance.heading));
        notice.appendChild(el(doc, "p", undefined, `Workspace: ${guidance.room}`));
        if (guidance.action === "Open workspace help" || guidance.action === "Check workspace connection setup") {
          const help = el(doc, "button", "workspace-help", guidance.action);
          help.type = "button";
          help.setAttribute("aria-controls", `${instanceId}-workspace-help`);
          help.setAttribute("aria-expanded", String(wsHelpOpen));
          help.style.minHeight = "var(--touch)";
          help.style.maxWidth = "100%";
          help.style.whiteSpace = "normal";
          notice.appendChild(help);
        } else if (guidance.action !== null) notice.appendChild(el(doc, "p", undefined, guidance.action));
        if (guidance.body) notice.appendChild(el(doc, "p", undefined, guidance.body));
        if (guidance.error) notice.appendChild(el(doc, "p", undefined, guidance.error));
        section.appendChild(notice);
      }
      for (const item of guidance.notices) {
        const notice = el(doc, "div", "workspace-registration");
        notice.appendChild(el(doc, "h3", undefined, item.heading));
        notice.appendChild(el(doc, "p", undefined, `Workspace: ${guidance.room}`));
        notice.appendChild(el(doc, "p", undefined, item.action));
        if (item.body) notice.appendChild(el(doc, "p", undefined, item.body));
        section.appendChild(notice);
      }
      viewWrap.appendChild(section);
    }

    // ---- view content ----
    if (view === "wall" && input.swarm !== undefined) {
      viewWrap.appendChild(renderAgentStrip(doc, input.swarm));
    }
    if (view === "swarm") {
      if (input.swarm === undefined) throw new TypeError("Swarm view model required");
      const swarmView = renderSwarmView(doc, input.swarm);
      if (previousScope === swarmScope) {
        for (const button of swarmView.querySelectorAll<HTMLButtonElement>(".swarm-metadata-toggle")) {
          if (openMetadata.has(button.getAttribute("aria-controls"))) button.click();
        }
        // Reopen through the renderer while detached: its fresh detail and
        // Close/Escape handlers cannot take focus from another control.
        if (openTask) swarmTask(swarmView, openTask)?.click();
      }
      viewWrap.appendChild(swarmView);
    }
    // Legacy task context remains separate from the Swarm renderer.
    // Chat activation belongs solely to the collapsed Messages entry.
    const taskDestination = view === "swarm" ? messagesBody : viewWrap;
    if ((view === "wall" || view === "swarm") && hasPlan) {
      const planSec = el(doc, "section", "plan-wall");
      planSec.setAttribute("aria-label", "Plan");
      const planVm = planIn as unknown as Parameters<typeof renderPlanBand>[1];
      planSec.appendChild(renderPlanBand(doc, planVm, { selectedPhase, syncStale: input.syncStale === true }).cloneNode(true) as HTMLElement);
      if (selectedPhase !== null) {
        const showAll = el(doc, "button", "phase-show-all", "Show all phases");
        showAll.setAttribute("type", "button");
        planSec.appendChild(showAll);
      }
      const phasesForGroup = (planVm && typeof planVm === "object" ? (planVm as unknown as Record<string, unknown>).phases : undefined) as unknown as Parameters<typeof groupTasksByPhase>[1];
      let groupsForWall = groupTasksByPhase(wsTasksAll(workspaceId, false), phasesForGroup);
      if (selectedPhase !== null) groupsForWall = groupsForWall.filter((g) => g.phaseId === selectedPhase);
      planSec.appendChild(renderPhaseTaskCards(doc, groupsForWall, { ...(currentHandlers?.onOpenTask ? { onOpenTask: currentHandlers.onOpenTask } : {}), ...(currentHandlers?.onToggleMicroDetail ? { onToggleMicroDetail: currentHandlers.onToggleMicroDetail } : {}) }, { syncStale: input.syncStale === true, ...(view === "wall" && input.swarm !== undefined ? { swarm: input.swarm } : {}) }).cloneNode(true) as HTMLElement);
      taskDestination.appendChild(planSec);
    } else if (view === "wall" || view === "swarm") {
      const board = el(doc, "section", "board");
      board.setAttribute("aria-label", "Tasks");
      const list = sortByAttention(wsTasksAll(workspaceId, false));
      for (const t of list) {
        const task = t as TaskVM;
        const tid = asStr((task as { id?: unknown }).id);
        const art = el(doc, "div", "task");
        art.setAttribute("role", "group");
        (art as HTMLElement).id = tid;
        art.setAttribute("data-task-id", tid);
        setSafeData(art, "data-status", (task as { status?: unknown }).status);
        setSafeData(art, "data-attention", (task as { attention?: unknown }).attention);
        setSafeData(art, "data-accent", (task as { accent?: unknown }).accent);
        art.setAttribute("aria-labelledby", `${tid}-title`);
        const head = el(doc, "header", "task-head");
        const proj = el(doc, "p", "task-project");
        const dot = el(doc, "span", "project-dot");
        dot.setAttribute("aria-hidden", "true");
        proj.appendChild(dot);
        proj.appendChild(el(doc, "span", "project-name", asStr((task as { project?: unknown }).project)));
        head.appendChild(proj);
        const st = el(doc, "span", "status");
        setSafeData(st, "data-status", (task as { status?: unknown }).status);
        const si = el(doc, "span", "status-icon");
        si.setAttribute("aria-hidden", "true");
        st.appendChild(si);
        st.appendChild(el(doc, "span", "status-label", statusLabel((task as { status?: unknown }).status)));
        head.appendChild(st);
        art.appendChild(head);
        const h2 = el(doc, "h2", "task-title", asStr((task as { title?: unknown }).title));
        (h2 as HTMLElement).id = `${tid}-title`;
        art.appendChild(h2);
        art.appendChild(el(doc, "p", "task-summary", asStr((task as { summary?: unknown }).summary)));
        const stepsArr: StepVM[] = Array.isArray((task as { steps?: unknown }).steps) ? ((task as unknown as { steps: StepVM[] }).steps ?? []) : [];
        const safeSteps = stepsArr.filter((s) => s && typeof s === "object");
        const doneN = safeSteps.filter((s) => (s as { state?: unknown }).state === "done").length;
        const total = safeSteps.length;
        const pct = total === 0 ? 0 : Math.round((doneN / total) * 100);
        const prog = el(doc, "div", "progress");
        prog.appendChild(el(doc, "span", "progress-label", `${doneN} of ${total} steps`));
        const track = el(doc, "span", "progress-track");
        track.setAttribute("role", "progressbar");
        track.setAttribute("aria-valuemin", "0");
        track.setAttribute("aria-valuemax", "100");
        track.setAttribute("aria-valuenow", String(pct));
        track.setAttribute("aria-label", "Task progress");
        if (total > 0) {
          const fill = el(doc, "span", "progress-fill");
          (fill as HTMLElement).style.setProperty("--p", `${pct}%`);
          track.appendChild(fill);
        }
        prog.appendChild(track);
        art.appendChild(prog);
        const ol = el(doc, "ol", "steps");
        ol.setAttribute("aria-label", "Steps");
        stepsArr.forEach((s, i) => {
          if (!s || typeof s !== "object") return;
          ol.appendChild(renderStep(doc, s as StepVM, tid, i));
        });
        art.appendChild(ol);
        const foot = el(doc, "footer", "task-foot");
        const nxt = el(doc, "div", "next");
        nxt.appendChild(el(doc, "p", "next-label", "Next"));
        nxt.appendChild(el(doc, "p", "next-text", asStr((task as { next?: unknown }).next)));
        foot.appendChild(nxt);
        const prov = el(doc, "p", "provenance");
        prov.appendChild(sourcechip(doc, (task as { source?: unknown }).source));
        prov.appendChild(el(doc, "span", "updated", `Updated ${asStr((task as { updated?: unknown }).updated)}`));
        foot.appendChild(prov);
        art.appendChild(foot);
        board.appendChild(art);
      }
      taskDestination.appendChild(board);
    } else if (view === "agenda" && hasPlan) {
      const workspaceTasks = wsTasksAll(workspaceId, false);
      function resolveAgendaTask(item: AgendaItemVM): TaskVM | undefined {
        if (!item || typeof item !== "object" || !knownWorkspace) return undefined;
        if (item.workspace !== undefined && item.workspace !== workspaceId) return undefined;
        const id = asStr(item.taskVmId) || asStr(item.taskId) || asStr(item.task);
        if (!id) return undefined;
        // Unqualified local ids must be unique across rooms. Never attach
        // foreign text to whichever colliding task happens to be first.
        const candidates = tasks.filter((task) => task && typeof task === "object"
          && (item.workspace === undefined || task.workspace === item.workspace)
          && (item.taskVmId !== undefined ? task.id === id : task.id === id || task.taskId === id));
        if (candidates.length !== 1) return undefined;
        const task = candidates[0]!;
        if (task.workspace !== workspaceId || task.archived) return undefined;
        if (item.taskId && item.taskId !== task.id && item.taskId !== task.taskId) return undefined;
        const microId = asStr(item.microId);
        const steps = Array.isArray(task.steps) ? task.steps : [];
        if (microId && !steps.some((step, idx) => step && typeof step === "object"
          && (step.microId || `${task.taskId || task.id}.M${String(idx + 1).padStart(2, "0")}`) === microId)) return undefined;
        return task;
      }
      function eligibleNext(task: TaskVM, item: AgendaItemVM): boolean {
        // Use the same microtask admission rules for generated and supplied
        // Next, including task-only entries and published stale outcomes.
        const forAgenda: TaskVM = { ...task,
          ...(task.activity !== undefined ? { activity: { state: displayActivity(task.activity, input.syncStale === true) as NonNullable<TaskVM["activity"]>["state"] } } : {}),
          steps: (Array.isArray(task.steps) ? task.steps : []).filter((step) => step && typeof step === "object").map((step) => ({ ...step,
            ...(step.activity !== undefined ? { activity: { state: displayActivity(step.activity, input.syncStale === true) as NonNullable<StepVM["activity"]>["state"] } } : {}),
          })),
        };
        const eligible = buildPlanAgenda([forAgenda]).find((group) => group.group === "Next")?.items ?? [];
        return eligible.some((candidate) => !item.microId || candidate.microId === item.microId);
      }
      const reconcileGroups = (groups: readonly AgendaGroupVM[]): AgendaGroupVM[] => groups
        .filter((group) => group && typeof group === "object")
        .map((group) => {
          const name = asStr(group.group).trim().toLowerCase();
          const items = Array.isArray(group.items) ? group.items : [];
          return { ...group, items: items.filter((item) => {
            const task = resolveAgendaTask(item);
            return task !== undefined && (name !== "next" || eligibleNext(task, item));
          }) };
        });
      const groupsToRender = reconcileGroups(agenda.length > 0 ? agenda : buildPlanAgenda(workspaceTasks));
      viewWrap.appendChild(renderPlanAgenda(doc, groupsToRender as unknown as Parameters<typeof renderPlanAgenda>[1]));
    } else if (view === "agenda") {
      const sec = el(doc, "section", "agenda");
      sec.setAttribute("aria-label", "Agenda");
      const taskById = new Map<string, TaskVM>();
      for (const t of tasks) {
        if (t && typeof t === "object") taskById.set(asStr((t as { id?: unknown }).id), t as TaskVM);
      }
      for (const g of agenda) {
        if (!g || typeof g !== "object") continue;
        const grp = g as AgendaGroupVM;
        const items = Array.isArray((grp as { items?: unknown }).items) ? ((grp as unknown as { items: unknown[] }).items) : [];
        const filtered: { when: string; task: TaskVM; what: string }[] = [];
        for (const it of items) {
          if (!it || typeof it !== "object") continue;
          const tid = asStr((it as { task?: unknown }).task);
          const task = taskById.get(tid);
          if (!task) continue;
          if (!knownWorkspace) continue;
          if ((task as { workspace?: unknown }).workspace !== workspaceId) continue;
          if ((task as { archived?: unknown }).archived) continue;
          filtered.push({ when: asStr((it as { when?: unknown }).when), task, what: asStr((it as { what?: unknown }).what) });
        }
        if (filtered.length === 0) continue;
        const wrap = el(doc, "div", "agenda-group");
        wrap.appendChild(el(doc, "h2", "agenda-heading", asStr((grp as { group?: unknown }).group)));
        const ul = el(doc, "ul", "agenda-list");
        for (const f of filtered) {
          const li = el(doc, "li", "agenda-item");
          setSafeData(li, "data-accent", (f.task as { accent?: unknown }).accent);
          setSafeData(li, "data-attention", (f.task as { attention?: unknown }).attention);
          li.appendChild(el(doc, "span", "agenda-when", f.when));
          const body = el(doc, "span", "agenda-body");
          body.appendChild(el(doc, "span", "agenda-what", f.what));
          body.appendChild(el(doc, "span", "agenda-task", asStr((f.task as { project?: unknown }).project)));
          li.appendChild(body);
          const st = el(doc, "span", "status");
          setSafeData(st, "data-status", (f.task as { status?: unknown }).status);
          const si = el(doc, "span", "status-icon");
          si.setAttribute("aria-hidden", "true");
          st.appendChild(si);
          st.appendChild(el(doc, "span", "status-label", statusLabel((f.task as { status?: unknown }).status)));
          li.appendChild(st);
          ul.appendChild(li);
        }
        wrap.appendChild(ul);
        sec.appendChild(wrap);
      }
      viewWrap.appendChild(sec);
    } else if (view === "diary" && (hasPlan || diaryIn !== undefined)) {
      const entriesForDiary = Array.isArray(diaryIn) ? (diaryIn as readonly unknown[]) : [];
      const diaryGroups = buildPlanDiary(entriesForDiary as unknown as Parameters<typeof buildPlanDiary>[0]);
      viewWrap.appendChild(renderPlanDiary(doc, diaryGroups as unknown as Parameters<typeof renderPlanDiary>[1]));
    } else if (view === "diary") {
      const sec = el(doc, "section", "diary");
      sec.setAttribute("aria-label", "Diary");
      type Entry = { day: string; time: string; task: TaskVM; step: StepVM; ms: number; idx: number };
      const entries: Entry[] = [];
      let counter = 0;
      for (const t of tasks) {
        if (!t || typeof t !== "object") continue;
        const task = t as TaskVM;
        if (!knownWorkspace) continue;
        if ((task as { workspace?: unknown }).workspace !== workspaceId) continue;
        const steps = Array.isArray((task as { steps?: unknown }).steps) ? ((task as unknown as { steps: unknown[] }).steps) : [];
        for (const s of steps) {
          if (!s || typeof s !== "object") continue;
          const step = s as StepVM;
          if ((step as { state?: unknown }).state !== "done") continue;
          if (!(step as { detail?: unknown }).detail) continue;
          const atMs = (step as { at_ms?: unknown }).at_ms;
          const msVal = typeof atMs === "number" && Number.isFinite(atMs) ? atMs : Number.NEGATIVE_INFINITY;
          const day = asStr((step as { day?: unknown }).day);
          const time = extractTime((step as { at?: unknown }).at);
          entries.push({ day, time, task, step, ms: msVal, idx: counter++ });
        }
      }
      entries.sort((a, b) => (b.ms - a.ms) || (a.idx - b.idx));
      // group by day in sorted order
      const order: string[] = [];
      const map = new Map<string, Entry[]>();
      for (const e of entries) {
        if (!map.has(e.day)) { map.set(e.day, []); order.push(e.day); }
        (map.get(e.day) as Entry[]).push(e);
      }
      for (const day of order) {
        const g = el(doc, "div", "diary-day");
        g.appendChild(el(doc, "h2", "diary-heading", day));
        const ol = el(doc, "ol", "timeline");
        for (const e of map.get(day) as Entry[]) {
          const li = el(doc, "li", "entry");
          setSafeData(li, "data-accent", (e.task as { accent?: unknown }).accent);
          const tm = el(doc, "time", "entry-time", e.time);
          li.appendChild(tm);
          const body = el(doc, "div", "entry-body");
          body.appendChild(el(doc, "p", "entry-title", asStr((e.step as { label?: unknown }).label)));
          const detail = (e.step as { detail?: unknown }).detail as { outcome?: unknown; source?: unknown } | undefined;
          body.appendChild(el(doc, "p", "entry-outcome", detail ? asStr(detail.outcome) : ""));
          const meta = el(doc, "p", "entry-meta");
          meta.appendChild(el(doc, "span", "entry-project", asStr((e.task as { project?: unknown }).project)));
          meta.appendChild(el(doc, "span", "entry-took", asStr((e.step as { took?: unknown }).took)));
          meta.appendChild(sourcechip(doc, detail?.source));
          body.appendChild(meta);
          li.appendChild(body);
          ol.appendChild(li);
        }
        g.appendChild(ol);
        sec.appendChild(g);
      }
      viewWrap.appendChild(sec);
    } else if (view === "memory") {
      const memNode = renderMemoryView(doc, (memoryIn ?? undefined) as unknown as Parameters<typeof renderMemoryView>[1]);
      viewWrap.appendChild(memNode);
    } else if (view === "archive" && hasPlan) {
      const sec = el(doc, "section", "archive");
      sec.setAttribute("aria-label", "Archive");
      const bar = el(doc, "div", "archive-bar");
      const filt = el(doc, "div", "archive-filter");
      filt.setAttribute("role", "group");
      filt.setAttribute("aria-label", "Archive scope");
      const opts: [string, string][] = [["workspace", "This workspace"], ["all", "All workspaces"]];
      for (const [val, label] of opts) {
        const b = el(doc, "button", "archive-option", label);
        b.setAttribute("type", "button");
        b.setAttribute("aria-pressed", String(archiveScope === val));
        b.setAttribute("data-scope", val);
        filt.appendChild(b);
      }
      bar.appendChild(filt);
      const filtered = archive.filter(item => item && typeof item === "object"
        && (archiveScope === "all" || (knownWorkspace && item.workspace === workspaceId)));
      const scopeLabel = archiveScope === "all" ? "across all workspaces" : "in this workspace";
      bar.appendChild(el(doc, "p", "archive-count",
        `${filtered.length} archived ${filtered.length === 1 ? "plan" : "plans"} ${scopeLabel}`));
      sec.appendChild(bar);
      sec.appendChild(el(doc, "p", "archive-scope-note",
        "Archive counts closed plans only. Completed tasks in the active plan are shown in Swarm."));
      sec.appendChild(renderPlanArchive(doc, filtered as unknown as Parameters<typeof renderPlanArchive>[1]));
      viewWrap.appendChild(sec);
    } else {
      // archive
      const sec = el(doc, "section", "archive");
      sec.setAttribute("aria-label", "Archive");
      const bar = el(doc, "div", "archive-bar");
      const filt = el(doc, "div", "archive-filter");
      filt.setAttribute("role", "group");
      filt.setAttribute("aria-label", "Archive scope");
      const opts: [string, string][] = [["workspace", "This workspace"], ["all", "All workspaces"]];
      for (const [val, label] of opts) {
        const b = el(doc, "button", "archive-option", label);
        b.setAttribute("type", "button");
        b.setAttribute("aria-pressed", String(archiveScope === val));
        b.setAttribute("data-scope", val);
        filt.appendChild(b);
      }
      bar.appendChild(filt);
      const filtered = archive.filter((a) => a && typeof a === "object" && (archiveScope === "all" || (knownWorkspace && (a as { workspace?: unknown }).workspace === workspaceId)));
      bar.appendChild(el(doc, "p", "archive-count", filtered.length === 1 ? "1 finished task" : `${filtered.length} finished tasks`));
      sec.appendChild(bar);
      // A-U159: State the legacy count's source without changing its task-count unit.
      sec.appendChild(el(doc, "p", "archive-scope-note", archiveScope === "all"
        ? "Counts finished tasks in legacy archives across all workspaces. Plan task completion is shown in Swarm."
        : "Counts finished tasks in this workspace's legacy archive. Plan task completion is shown in Swarm."));
      const ul = el(doc, "ul", "archive-list");
      const wsName = new Map<string, string>();
      for (const w of workspaces) {
        if (w && typeof w === "object") wsName.set(asStr((w as { id?: unknown }).id), asStr((w as { name?: unknown }).name));
      }
      for (const a of filtered) {
        const item = a as ArchivedVM;
        const li = el(doc, "li", "archived");
        setSafeData(li, "data-accent", (item as { accent?: unknown }).accent);
        const head = el(doc, "p", "archived-head");
        const dot = el(doc, "span", "project-dot");
        dot.setAttribute("aria-hidden", "true");
        head.appendChild(dot);
        head.appendChild(el(doc, "span", "archived-project", asStr((item as { project?: unknown }).project)));
        if (archiveScope === "all") {
          const wid = asStr((item as { workspace?: unknown }).workspace);
          const name = wsName.get(wid) ?? wid;
          head.appendChild(el(doc, "span", "archived-ws", name));
        }
        head.appendChild(el(doc, "span", "archived-date", `Archived ${asStr((item as { archived?: unknown }).archived)}`));
        li.appendChild(head);
        li.appendChild(el(doc, "h2", "archived-title", asStr((item as { title?: unknown }).title)));
        li.appendChild(el(doc, "p", "archived-outcome", asStr((item as { outcome?: unknown }).outcome)));
        const meta = el(doc, "p", "archived-meta");
        const stepsN = (item as { steps?: unknown }).steps;
        const tookT = asStr((item as { took?: unknown }).took);
        const tookLabel = (tookT === "" || tookT === "unavailable") ? "Duration unknown" : tookT;
        meta.appendChild(el(doc, "span", "archived-steps", `${asStr(stepsN as unknown) === "" ? "0" : asStr(stepsN)} steps · ${tookLabel}`));
        meta.appendChild(sourcechip(doc, (item as { source?: unknown }).source));
        const rb = el(doc, "button", "archived-restore", "Restore");
        rb.setAttribute("type", "button");
        const aid = asStr((item as { id?: unknown }).id);
        rb.setAttribute("data-arch-id", aid);
        meta.appendChild(rb);
        li.appendChild(meta);
        ul.appendChild(li);
      }
      sec.appendChild(ul);
      viewWrap.appendChild(sec);
    }

    // ensure focus hidden property reflects (section.focus.hidden already set)
    try {
      const viewLabel = DESTINATIONS.find(([vid]) => vid === view)?.[1] ?? view;
      if (lastView === undefined || lastView !== view) {
        announcer.textContent = `${viewLabel} view`;
        lastLive = `${viewLabel} view`;
        lastView = view;
      }
    } catch { /* contained */ }
    try {
      const nextActs = new Map<string, string>();
      const transitions: string[] = [];
      const guidanceCopy = guidance?.room === workspaceId ? JSON.stringify(guidance) : "";
      if (guidanceCopy !== lastGuidanceCopy) {
        lastGuidanceCopy = guidanceCopy;
        if (guidance && guidance.room === workspaceId) transitions.push([
          `Workspace ${guidance.room}`, guidance.connected ? "Bridge connected" : "",
          guidance.heading, guidance.action, guidance.saved ? "Saved progress; connection unavailable" : "",
          guidance.error, ...guidance.notices.flatMap(item => [item.heading, item.action]),
        ].filter(Boolean).join(". "));
      }
      const record = (key: string, label: string, state: string): void => {
        nextActs.set(key, state);
        const previous = lastActivities.get(key);
        if (previous !== undefined && previous !== state) transitions.push(`${label}: ${ACTIVITY_LABEL[state]}`);
      };
      for (const t of wsTasksAll(workspaceId, false)) {
        const id = asStr(t.id) || asStr(t.taskId);
        if (!id) continue;
        const key = [workspaceId, id];
        const label = asStr(t.taskId) || id;
        record(JSON.stringify([...key, "task"]), `Task ${label}`,
          t.operatorQuestion != null ? "needs_you" : displayActivity(t.activity, input.syncStale === true));
        (Array.isArray(t.steps) ? t.steps : []).forEach((step, index) => {
          if (!step || typeof step !== "object") return;
          const microId = asStr(step.microId) || `${label}.M${String(index + 1).padStart(2, "0")}`;
          record(JSON.stringify([...key, "micro", microId]), `Microtask ${microId}`,
            displayActivity(step.activity, input.syncStale === true));
        });
      }
      lastActivities = nextActs;
      const lifecycleScope = JSON.stringify([workspaceId, input.swarm?.room ?? null]);
      const nextLifecycles = new Map<string, string>();
      for (const agent of input.swarm?.agents ?? []) {
        if (!agent.lifecycle) continue;
        const key = agent.agent;
        const state = JSON.stringify([agent.lifecycle, agent.run_id ?? null]);
        nextLifecycles.set(key, state);
        if (lastLifecycleScope === lifecycleScope && lastLifecycles.get(key) !== state) {
          transitions.push(`Agent ${agent.agent}: ${agent.lifecycle}`);
        }
      }
      lastLifecycles = nextLifecycles;
      lastLifecycleScope = lifecycleScope;
      // One polite-region update batches every changed identity. Beat/deadline
      // refreshes with unchanged semantic states remain silent.
      if (transitions.length > 0) announceLive(transitions.join("; "));
    } catch { /* contained */ }
    if (previousScope === swarmScope && previousTaskView === view) {
      for (const detail of host.querySelectorAll<HTMLDetailsElement>(".task-detail")) {
        const taskVmId = detail.querySelector(".task-detail-toggle")?.getAttribute("data-task-vm-id");
        if (taskVmId && openTaskDetails.has(taskVmId)) detail.open = true;
      }
    }
    restoreFocus(focusDesc);
    if (pendingFocusView !== null) {
      const target = host.querySelector<HTMLElement>(`[role="tab"][data-nav="${pendingFocusView}"]`);
      const panel = target?.closest(".navigation-panel");
      if (panel && doc.defaultView?.getComputedStyle(panel).display === "none") navigationToggle.focus();
      else target?.focus();
      pendingFocusView = null;
    }
    scheduleExpiry();
    try {
      for (const btn of host.querySelectorAll("button.step-row")) {
        const tid = btn.getAttribute("data-task-id");
        const idxS = btn.getAttribute("data-step-idx");
        if (tid === null || idxS === null) continue;
        const open = expanded.get(expKey(tid, Number(idxS))) === true;
        if (open) {
          btn.setAttribute("aria-expanded", "true");
          const li = btn.closest("li.step");
          if (li) {
            const panel = li.querySelector(".step-detail") as HTMLElement | null;
            if (panel) panel.hidden = false;
            li.toggleAttribute("data-open", true);
          }
        }
      }
    } catch { /* contained */ }
  }

  render(vm);

  const handle: WallMountHandle = {
    update(next: WallMountVM): void {
      if (destroyed) return;
      currentVm = next;
      render(next);
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      clearExpiry();
      try {
        doc.removeEventListener("keydown", onKey);
      } catch {
        /* ignore */
      }
      try {
        host.removeEventListener("click", onClick);
      } catch {
        /* ignore */
      }
      const swarmView = host.querySelector<HTMLElement>(".swarm-view");
      host.replaceChildren();
      disposeSwarm(swarmView);
    },
  };
  void currentVm;
  return handle;
}

export type {
  AccentVM,
  AgendaGroupVM,
  AgendaItemVM,
  ArchivedVM,
  AttentionVM,
  SourceKind,
  SourceVM,
  StepDetailVM,
  StepStateVM,
  StepVM,
  TaskStatusVM,
  TaskVM,
  PlanVM,
  ViewId,
  WallHandle,
  WallHandlers,
  WallVM,
  WorkspaceVM,
} from "./types";
