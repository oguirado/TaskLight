// Wall mount: renders the U36 wall and the U35 agent chat from the store
// plus drift verdicts (SPEC_U37 "U37c"). The reviewer is re-asked on every
// refresh; silence re-renders every 30 s. No logging, no storage.
import { readTheme, writeTheme } from "../ui/theme_store";
import { mountAgentChat } from "../agentsui";
import type { AgentChatHandlers, AgentChatHandle, AgentChatVM, ChatMessageVM } from "../agentsui/types";
import { mountWall } from "../views";
import type { WallMountHandle, WallMountVM, WallViewId, WorkspaceGuidanceVM } from "../views";
import { deriveSwarmViewModel } from "./swarm_vm";
import type { AgentBoardViewModel } from "../views/swarm";
import type { WallVM } from "../views/types";
import type { AgentState, DriftVerdict, TemplateMemorySectionMeta } from "../agents/types";
import { toChatVM, toWallVM } from "./agent_store";
import type { AgentLink, RoomSyncErrorCode } from "./agent_link";
import type { AgentStore } from "./agent_store";
import type { DriftReviewer } from "./agent_drift";
import type { Clock, WallPortState } from "./types";
import type { PlanProjectionResult } from "./agent_store";
import type { PlanTask } from "../plan/types";

export interface WorkspaceStatus {
  link: WallPortState | null;
  rooms: readonly string[];
  synced: readonly string[];
  roomErrors?: Readonly<Partial<Record<string, RoomSyncErrorCode>>>;
}

interface AgentWallBaseDeps {
  wallHost: HTMLElement;
  chatHost: HTMLElement;
  link: Pick<AgentLink, "post" | "hasUnverifiedReplay"> & Partial<Pick<AgentLink, "state">>;
  store: AgentStore;
  reviewer: DriftReviewer;
  clock: Clock;
  userAgent: string;
  /** Escalation target agent; default "orchestrator". */
  orchestrator?: string | (() => string | undefined);
  initialView?: WallViewId;
  /** Current transport, hello membership and completed replay; absence is unknown. */
  workspaceStatus?: () => WorkspaceStatus;
  /** Read-only availability for the active workspace, independent of chat selection. */
  modelAvailability?: (room: string) => string;
  /** Undefined while the configured device model is still checking. */
  modelStatus?: () => WallVM["model"] | undefined;
  planVerdicts?: ReadonlyMap<string, DriftVerdict> | (() => ReadonlyMap<string, DriftVerdict>);
  planBriefs?: ReadonlyMap<string, { text: string; source: string }> | (() => ReadonlyMap<string, { text: string; source: string }>);
  templateMemorySections?: (templateId: string) => readonly TemplateMemorySectionMeta[] | undefined;
}
/** The Models integration is optional for standalone and legacy hosts. */
export type AgentWallDeps = AgentWallBaseDeps | (AgentWallBaseDeps & {
  onOpenModels(trigger: HTMLElement): void;
});
export interface AgentWall {
  /** Re-reads the store and re-renders (call after store.ingest). */
  refresh(): void;
  /** Repaint model health and availability without requesting a review. */
  refreshModels?(): void;
  /** Currently open plan-task drawer; legacy drawers have no plan selection. */
  selection(): { room: string; taskId: string; assignee: string | null } | null;
  /** Live S1 composer; unavailable after destruction. */
  chat(): AgentChatHandle | null;
  onSelection(listener: () => void): () => void;
  destroy(): void;
}
export const WALL_REFRESH_MS = 30_000 as const;

function readPlanFeed<T>(feed: ReadonlyMap<string, T> | (() => ReadonlyMap<string, T>) | undefined): ReadonlyMap<string, T> | undefined {
  const map = readPort(() => typeof feed === "function" ? feed() : feed, value =>
    value != null && typeof value.get === "function" && typeof value.has === "function"
    && typeof value[Symbol.iterator] === "function" && Number.isInteger(value.size) && value.size >= 0);
  // Copy a ReadonlyMap at the boundary; rendering only calls our local map.
  return map === undefined ? undefined : readPort(() => new Map(map), value => value instanceof Map);
}

function readPort<T>(read: () => T, valid: (value: T) => boolean): T | undefined {
  try {
    const value = read();
    if (valid(value)) return value;
    // A synchronous port may accidentally return an asynchronous failure. Observe
    // rejection without waiting, while still rejecting its invalid result type.
    if (value !== null && (typeof value === "object" || typeof value === "function")
      && typeof (value as { then?: unknown }).then === "function") {
      void Promise.resolve(value).catch(() => undefined);
    }
    return undefined;
  } catch { return undefined; }
}

const isVoid = (value: unknown): boolean => value === undefined;
const isTimerId = (value: number): boolean => Number.isFinite(value) && value >= 0;
const isMountHandle = (value: unknown): value is WallMountHandle => value !== null && typeof value === "object"
  && typeof (value as WallMountHandle).update === "function" && typeof (value as WallMountHandle).destroy === "function";
const isVerdict = (value: unknown): value is DriftVerdict => {
  if (value === null || typeof value !== "object") return false;
  const v = value as DriftVerdict;
  return (v.verdict === "on_track" || v.verdict === "drift" || v.verdict === "needs_user")
    && typeof v.reason === "string" && ["device", "cloud", "local", "remote", "rules"].includes(v.source);
};

const ESCALATE_TEXT = "Escalation: the user asks the orchestrator to step in.";
const CLOCK_UNAVAILABLE = "Clock unavailable. Your message was not sent. Please try again.";

const MODEL_TIMEOUT_MS = 10_000 as const;

function isWallView(value: unknown): value is WallViewId {
  return value === "wall" || value === "agenda" || value === "diary"
    || value === "archive" || value === "memory" || value === "swarm";
}

export function startAgentWall(d: AgentWallDeps): AgentWall {
  const { wallHost, chatHost, link, store, reviewer, clock, userAgent } = d;
  let destroyed = false;
  let sending = false;
  let currentTheme = readPort(readTheme, value => value === "light" || value === "dark") ?? "light";
  wallHost.ownerDocument.documentElement.dataset.theme = currentTheme;
  let modelTimedOut = false;
  let suggestNoticeMsg = "";
  let wallHandle: WallMountHandle | null = null;
  let swarmTimer: number | undefined;
  let swarmTimerGen = 0;
  const lastGoodBoards = new Map<string, AgentBoardViewModel>();
  let chatHandle: AgentChatHandle | null = null;
  const verdicts = new Map<string, DriftVerdict>();
  const accepted = new Map<string, DriftVerdict>();
  const reviewState = new Map<string, { gen: number; hash: string | undefined }>();
  let reviewGen = 0;

  let currentView: WallViewId = isWallView(d.initialView) ? d.initialView : "swarm";
  let currentWorkspace: string | undefined = undefined;
  let currentArchiveScope: "workspace" | "all" = "workspace";

  const verdictKey = (s: AgentState): string => `agent:${s.room}:${s.agent}`;
  // U42: the drawer is closed until the user opens a task (card click or its Chat button).
  // The chat follows the selected task; before any selection it follows the first agent.
  let selected: string | null = null;
  let drawerOpen = false;
  let invalidSelection = false;
  let lastWorkspace: string | undefined = undefined;
  let lastRenderedKey = "";
  const readStates = (): AgentState[] => (readPort(() => store.states(), Array.isArray) ?? []).filter(state =>
    typeof state?.room === "string" && typeof state?.agent === "string");
  const readEvents = (room: string) => readPort(() => store.events(room), Array.isArray);
  const readNow = (): number | undefined => readPort(() => clock.now(), now =>
    typeof now === "number" && Number.isFinite(now) && Number.isFinite(new Date(now).getTime()));
  const readModelStatus = (): WallVM["model"] | undefined => readPort(() => d.modelStatus?.(), status =>
    status != null && typeof status === "object" && typeof status.label === "string"
    && (status.state === "ready" || status.state === "downloading" || status.state === "unavailable"));

  const targetOf = (states: AgentState[]): AgentState | undefined =>
    selected !== null
      ? states.find((s) => s.agent !== userAgent && verdictKey(s) === selected)
      : states.find((s) => s.agent !== userAgent);

  const TASK_ID_RE = /^T[0-9]+$/;
  const ROOM_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

  const safePlan = (room: string): PlanProjectionResult | undefined => readPort(() => store.plan(room), value =>
    value != null && typeof value === "object" && typeof value.room === "string"
    && value.projection != null && typeof value.projection === "object");

  // Exact-membership resolution through the public projection seam only.
  // Array scanning never performs prototype-chain lookups.
  const resolvePlanTask = (room: string, taskId: string): PlanTask | undefined => {
    try {
      const res = safePlan(room);
      if (res === undefined) return undefined;
      const proj = res.projection;
      if (proj === undefined || proj === null) return undefined;
      const plan = proj.plan;
      if (plan === undefined || plan === null || (plan as { state?: unknown }).state !== "active") return undefined;
      const tasks = (proj as { tasks?: unknown }).tasks;
      if (!Array.isArray(tasks)) return undefined;
      for (const t of tasks) {
        if (t !== null && typeof t === "object" && (t as { id?: unknown }).id === taskId) {
          return t as PlanTask;
        }
      }
      return undefined;
    } catch { return undefined; }
  };

  type ParsedSelection =
    | { readonly kind: "plan"; readonly room: string; readonly taskId: string }
    | { readonly kind: "legacy"; readonly room: string; readonly agent: string }
    | { readonly kind: "invalid" };

  const parseSelection = (id: string): ParsedSelection => {
    try {
      if (typeof id !== "string" || id.length === 0) return { kind: "invalid" };
      if (id.startsWith("plan:")) {
        const parts = id.split(":");
        if (parts.length !== 3) return { kind: "invalid" };
        const room = parts[1] as string;
        const taskId = parts[2] as string;
        if (!ROOM_SLUG_RE.test(room) || !TASK_ID_RE.test(taskId)) return { kind: "invalid" };
        return { kind: "plan", room, taskId };
      }
      if (id.startsWith("agent:")) {
        const parts = id.split(":");
        if (parts.length !== 3) return { kind: "invalid" };
        const room = parts[1] as string;
        const agent = parts[2] as string;
        if (!ROOM_SLUG_RE.test(room) || agent.length === 0) return { kind: "invalid" };
        return { kind: "legacy", room, agent };
      }
      if (TASK_ID_RE.test(id)) {
        if (lastWorkspace === undefined || lastWorkspace.length === 0) return { kind: "invalid" };
        return { kind: "plan", room: lastWorkspace, taskId: id };
      }
      return { kind: "invalid" };
    } catch { return { kind: "invalid" }; }
  };

  const selectedPlan = (): { room: string; taskId: string } | null => {
    try {
      if (selected === null || !selected.startsWith("plan:")) return null;
      const parts = selected.split(":");
      if (parts.length !== 3) return null;
      const room = parts[1] as string;
      const taskId = parts[2] as string;
      if (!ROOM_SLUG_RE.test(room) || !TASK_ID_RE.test(taskId)) return null;
      return { room, taskId };
    } catch { return null; }
  };

  const selection: AgentWall["selection"] = () => {
    if (destroyed || !drawerOpen || invalidSelection) return null;
    const plan = selectedPlan();
    if (plan === null) return null;
    const task = resolvePlanTask(plan.room, plan.taskId);
    return task === undefined ? null : { ...plan, assignee: task.assignee };
  };
  const selectionListeners = new Set<() => void>();
  let notifiedSelection = "";
  const notifySelection = (): void => {
    const plan = selection();
    const key = !destroyed && drawerOpen
      ? JSON.stringify([selected, plan?.assignee ?? null]) : "";
    if (key === notifiedSelection) return;
    notifiedSelection = key;
    for (const listener of [...selectionListeners]) {
      readPort(listener, isVoid);
    }
  };

  const invalidateSelection = (): void => {
    selected = null;
    invalidSelection = true;
    drawerOpen = false;
    suggestNoticeMsg = "";
  };

  const rejectSelection = (): void => {
    invalidateSelection();
    render();
  };

  const resolveLegacyTarget = (): AgentState | undefined => {
    const target = targetOf(readStates());
    if (selected !== null && target === undefined) rejectSelection();
    return target;
  };

  const clearComposer = (): void => {
    suggestNoticeMsg = "";
    readPort(() => chatHandle?.setDraft(""), isVoid);
  };

  interface OutgoingRecord {
    clientId: string;
    taskKey: string;
    raw: string;
    seqAtSend: number;
    createdAt: string;
    room: string;
    to: string;
    text: string;
    status: "sending" | "delivered" | "failed" | "unknown";
    eventId?: string;
    lamport?: number;
    code?: string;
  }
  type TaskAssignment = Pick<PlanTask, "assignee" | "claim_lamport">;
  const assignmentChanged = (previous: TaskAssignment | undefined, task: PlanTask): boolean =>
    previous !== undefined && (previous.assignee !== task.assignee || previous.claim_lamport !== task.claim_lamport);

  interface TaskChatState {
    assignment?: TaskAssignment;
    draft: string | undefined;
    seq: number;
    records: OutgoingRecord[];
  }
  const taskStates = new Map<string, TaskChatState>();
  let clientSeq = 0;
  let lastKey: string | null = null;

  const stateFor = (key: string): TaskChatState => {
    let st = taskStates.get(key);
    if (st === undefined) {
      st = { draft: undefined, seq: 0, records: [] };
      taskStates.set(key, st);
    }
    return st;
  };

  const safeGetDraft = (): string => {
    return readPort(() => chatHandle?.getDraft(), value => typeof value === "string") ?? "";
  };

  let internalDraftWrite = false;
  const trySetDraft = (t: string): void => {
    const previous = internalDraftWrite;
    internalDraftWrite = true;
    try { readPort(() => chatHandle?.setDraft(t), isVoid); }
    finally { internalDraftWrite = previous; }
  };

  const noteDraftEdit = (): void => {
    if (!internalDraftWrite && lastKey !== null) stateFor(lastKey).seq += 1;
  };

  const onDraftInput = (event: Event): void => {
    if (event.target === chatHost.querySelector("textarea.chat-input")) noteDraftEdit();
  };

  const wrapSetDraft = (handle: AgentChatHandle | null): void => {
    if (handle === null) return;
    try {
      const orig = (handle as unknown as { setDraft?: (t: string) => void }).setDraft;
      if (typeof orig !== "function") return;
      (handle as unknown as { setDraft: (t: string) => void }).setDraft = (t: string): void => {
        noteDraftEdit();
        readPort(() => orig.call(handle, t), isVoid);
      };
    } catch { /* handle already settled */ }
  };

  // Syncs the mounted composer to a new key, saving the previous task's draft.
  const applyDraftForKey = (key: string | null): string | null => {
    if (lastKey === key) return null;
    if (lastKey !== null) stateFor(lastKey).draft = safeGetDraft();
    lastKey = key;
    if (key === null) return null;
    suggestNoticeMsg = "";
    return stateFor(key).draft ?? "";
  };

  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

  const mapResult = (value: unknown, failed: boolean): { status: OutgoingRecord["status"]; eventId?: string; lamport?: number; code?: string } => {
    if (!failed && isRecord(value)) {
      if (value["ok"] === true) {
        const id = value["id"];
        const lamport = value["lamport"];
        if (typeof id === "string" && id !== "" && typeof lamport === "number" && Number.isInteger(lamport) && (lamport as number) >= 1) {
          return { status: "delivered", eventId: id, lamport };
        }
      } else if (value["ok"] === false) {
        const code = value["code"];
        if (typeof code === "string" && code !== "") {
          if (code === "timeout" || code === "stopped" || code === "error") return { status: "unknown", code };
          return { status: "failed", code };
        }
      }
    }
    return { status: "unknown", code: "unexpected_result" };
  };

  const postRecord = (record: OutgoingRecord): void => {
    const result = readPort(() => Promise.resolve(link.post({ room: record.room, to: record.to, text: record.text })),
      value => value instanceof Promise);
    void Promise.resolve(result).then(
      (v) => { settleRecord(record, v, false); },
      () => { settleRecord(record, undefined, true); },
    );
  };

  const settleRecord = (record: OutgoingRecord, value: unknown, failed: boolean): void => {
    if (destroyed) return;
    const mapped = mapResult(value, failed);
    record.status = mapped.status;
    if (mapped.eventId !== undefined) record.eventId = mapped.eventId; else delete record.eventId;
    if (mapped.lamport !== undefined) record.lamport = mapped.lamport; else delete record.lamport;
    if (mapped.code !== undefined) record.code = mapped.code; else delete record.code;
    if (mapped.status === "delivered") {
      const st = stateFor(record.taskKey);
      if (record.taskKey === lastKey) {
        if (safeGetDraft() === record.raw && st.seq === record.seqAtSend) {
          st.draft = "";
          trySetDraft("");
        }
      } else if (st.draft === record.raw && st.seq === record.seqAtSend) {
        st.draft = "";
      }
    }
    if (record.taskKey === lastKey) {
      try { render(); } catch { /* the settled record survives a view failure */ }
    }
  };

  const submitRecord = (key: string, room: string, to: string, raw: string, text: string): void => {
    if (destroyed) return;
    const st = stateFor(key);
    if (st.records.some((r) => r.status === "sending" && r.text.trim() === text.trim())) return;
    const nowMs = readNow();
    if (nowMs === undefined) {
      suggestNoticeMsg = CLOCK_UNAVAILABLE;
      render();
      return;
    }
    if (suggestNoticeMsg === CLOCK_UNAVAILABLE) suggestNoticeMsg = "";
    clientSeq += 1;
    const record: OutgoingRecord = {
      clientId: `c${clientSeq}`, taskKey: key, raw, seqAtSend: st.seq,
      createdAt: new Date(nowMs).toISOString(), room, to, text, status: "sending",
    };
    st.records.push(record);
    render();
    postRecord(record);
  };

  const withLocal = (key: string, base: AgentChatVM): AgentChatVM => {
    const st = taskStates.get(key);
    const records = st?.records ?? [];
    if (records.length === 0) return base;
    const messages = [...base.messages];
    const journalPositions = new Map(base.messages.map((message, index) => [message.id, index]));
    for (const r of records) {
      const msg: ChatMessageVM = {
        id: `local:${r.clientId}`, from: "user", agent: r.to, text: r.text, at: r.createdAt,
        delivery: r.status === "sending"
          ? { client_id: r.clientId, state: "sending" }
          : r.status === "delivered"
            ? { client_id: r.clientId, state: "delivered", event_id: r.eventId ?? "", lamport: r.lamport ?? 0 }
            : r.status === "failed"
              ? { client_id: r.clientId, state: "failed", code: r.code ?? "unexpected_result" }
              : { client_id: r.clientId, state: "unknown", code: r.code ?? "unexpected_result" },
      };
      const position = r.status === "delivered" && r.eventId !== undefined
        ? journalPositions.get(r.eventId) : undefined;
      if (position === undefined) messages.push(msg);
      else messages[position] = msg;
    }
    const pending = records.some((r) => r.status === "sending");
    return { ...base, messages, sending: base.sending || pending };
  };

  const retryRecord = (clientId: string): void => {
    if (destroyed) return;
    const key = lastKey;
    if (key === null) return;
    const st = taskStates.get(key);
    const record = st?.records.find((r) => r.clientId === clientId);
    if (record === undefined || record.status !== "failed") return;
    const plan = selectedPlan();
    if (plan !== null) {
      const task = resolvePlanTask(plan.room, plan.taskId);
      if (task === undefined || task.assignee !== record.to || plan.room !== record.room) return;
    } else {
      const target = targetOf(readStates());
      if (target === undefined || target.agent !== record.to || target.room !== record.room) return;
    }
    record.status = "sending";
    delete record.eventId;
    delete record.lamport;
    delete record.code;
    render();
    postRecord(record);
  };

  let guidanceForView: WorkspaceGuidanceVM | undefined;
  const wallHandlers = {
    workspaceGuidance: () => guidanceForView,
    onOpenModels: (trigger: HTMLElement): void => {
      if (!destroyed && "onOpenModels" in d) readPort(() => d.onOpenModels?.(trigger), isVoid);
    },
    onOpenMessages: (): void => {
      if (destroyed) return;
      currentView = "wall";
      drawerOpen = true;
      render();
    },
    onOpenTask: (id: string): void => {
      if (destroyed) return;
      try {
        const parsed = parseSelection(id);
        if (parsed.kind === "plan") {
          if (resolvePlanTask(parsed.room, parsed.taskId) === undefined) { rejectSelection(); return; }
          selected = `plan:${parsed.room}:${parsed.taskId}`;
          currentView = "wall";
          invalidSelection = false;
          drawerOpen = true;
          render();
          return;
        }
        if (parsed.kind === "legacy") {
          const found = readStates().find((s) => s.agent !== userAgent && verdictKey(s) === id);
          if (found === undefined) { rejectSelection(); return; }
          selected = id;
          currentView = "wall";
          invalidSelection = false;
          drawerOpen = true;
          render();
          return;
        }
        rejectSelection();
      } catch { try { rejectSelection(); } catch { return; } }
    },
    onView: (v: WallViewId): void => {
      if (destroyed) return;
      try {
        if (isWallView(v)) {
          currentView = v;
          if (v !== "wall") drawerOpen = false;
          render();
        }
      } catch { return; }
    },
    onWorkspace: (id: string): void => {
      if (destroyed) return;
      try {
        if (typeof id === "string" && id.length > 0) {
          currentWorkspace = id;
          render();
        }
      } catch { return; }
    },
    onArchiveScope: (s: "workspace" | "all"): void => {
      if (destroyed) return;
      try {
        if (s === "workspace" || s === "all") {
          currentArchiveScope = s;
          render();
        }
      } catch { return; }
    },
    onThemeToggle: (): void => {
      if (destroyed) return;
      currentTheme = currentTheme === "dark" ? "light" : "dark";
      wallHost.ownerDocument.documentElement.dataset.theme = currentTheme;
      readPort(() => writeTheme(currentTheme), isVoid);
      render();
    },
    onSelectPhase: (phaseId: string): void => {
      if (destroyed) return;
      void phaseId;
      try { render(); } catch { return; }
    },
    onToggleMicroDetail: (taskId: string, microIndex: number): void => {
      if (destroyed) return;
      void taskId; void microIndex;
      try { render(); } catch { return; }
    },

  };

  // U38 V6: the chat host is a drawer (bottom sheet / right-side panel).
  chatHost.classList.add("chat-drawer");
  chatHost.setAttribute("role", "dialog");
  chatHost.setAttribute("aria-label", "Agent chat");
  chatHost.setAttribute("data-open", "false");

  let observationKey = "";
  const readWorkspaceStatus = (): WorkspaceStatus | undefined => readPort(() => {
    const status = d.workspaceStatus?.();
    if (status == null || !Array.isArray(status.rooms) || !Array.isArray(status.synced)
      || !status.rooms.every(room => typeof room === "string")
      || !status.synced.every(room => typeof room === "string")
      || (status.link !== null && !["connecting", "linked", "resyncing", "unreachable"].includes(status.link?.kind))) return undefined;
    return { link: status.link === null ? null : { ...status.link }, rooms: [...status.rooms], synced: [...status.synced],
      ...(status.roomErrors === undefined ? {} : { roomErrors: { ...status.roomErrors } }) };
  }, value => value !== undefined);

  const renderContent = (): void => {
    if (destroyed) return;
    const status = readWorkspaceStatus();
    observationKey = JSON.stringify(status ?? null);
    const states = readStates();
    const nowMs = readNow() ?? Number.NaN;
    const plans = readPort(() => store.plans(), Array.isArray);
    const planVerdicts = readPlanFeed(d.planVerdicts);
    const planBriefs = readPlanFeed(d.planBriefs);
    const unavailable = { state: "unavailable" as const, label: "Gemini Nano: not available on this device — enable the on-device model flags in Chrome. Rules is the active reviewer." };
    let model: WallVM["model"] = { state: "unavailable", label: "" };
    if (d.modelStatus !== undefined) {
      const status = readModelStatus();
      model = status ?? (modelTimedOut ? unavailable : { state: "unavailable", label: "Gemini Nano: checking…" });
    }
    // Select before conversion so a hello-only room cannot borrow another room's plan.
    const workspace = currentWorkspace ?? plans?.[0]?.room ?? states[0]?.room ?? status?.rooms[0] ?? "";
    if (workspace) currentWorkspace = workspace;
    const baseVm = toWallVM(states, verdicts, {
      nowMs,
      model,
      // Internet reachability is independent of the bridge and model availability.
      network: readPort(() => wallHost.ownerDocument.defaultView?.navigator.onLine, value => typeof value === "boolean") === false ? "offline" : "online",
      userAgent,
      view: currentView === "swarm" ? "wall" : currentView,
      workspace,
      archiveScope: currentArchiveScope,
      ...(planVerdicts !== undefined ? { planVerdicts } : {}),
      ...(planBriefs !== undefined ? { planBriefs } : {}),
      ...(d.templateMemorySections !== undefined ? {
        templateMemorySections: (templateId: string) => readPort(() => d.templateMemorySections?.(templateId), Array.isArray),
      } : {}),
    }, plans);
    const workspaces = [...baseVm.workspaces];
    for (const room of status?.rooms ?? []) {
      if (!workspaces.some(item => item.id === room)) workspaces.push({ id: room, name: room, lens: "dev", accent: "slate" });
    }
    const availability = readPort(() => d.modelAvailability?.(workspace), value => typeof value === "string")
      ?? "Models unavailable";
    const wallVm: WallMountVM = { ...baseVm, workspaces, view: currentView, workspace,
      archiveScope: currentArchiveScope, availability };
    if (baseVm.workspace !== workspace) {
      delete wallVm.plan;
      delete wallVm.memory;
      delete wallVm.diary;
    }
    let events: ReturnType<AgentStore["events"]> | undefined;
    let result: PlanProjectionResult | undefined;
    let readFailed: boolean;
    const readErrorReason = "Room data could not be read.";
    try {
      events = store.events(workspace);
      result = store.plan(workspace);
      readFailed = !Array.isArray(events) || events.some(event => event === null || typeof event !== "object")
        || (result === undefined
          ? events.some(event => event.act === "op")
          : result === null || result.room !== workspace || result.projection == null
            || !Array.isArray(result.projection.tasks) || result.projection.plan === undefined
            || result.invalidOps > 0 || (result.rejectedOps ?? 0) > 0
            || (result.errors?.length ?? 0) > 0 || (result.projection.rejected?.length ?? 0) > 0);
    } catch {
      readFailed = true;
    }
    const projection = readFailed ? null
      : result?.projection ?? plans?.find(item => item.room === workspace)?.projection ?? null;
    const roomError = status?.roomErrors?.[workspace];
    const roomErrorReason = roomError === "room_read_failed" ? readErrorReason
      : roomError === "room_sync_failed" ? "Room synchronization could not complete." : undefined;
    const connected = status?.link?.kind === "linked" && status.rooms.includes(workspace);
    const synced = connected && status?.synced.includes(workspace) === true;
    // Legacy hosts can omit replay status. If the port fails, leave the cache intact.
    const legacyReplayStatus = Symbol();
    const replayStatus = readPort(() => {
      const readReplayStatus = link.hasUnverifiedReplay;
      return readReplayStatus === undefined ? legacyReplayStatus : readReplayStatus.call(link, workspace);
    }, value => value === legacyReplayStatus || typeof value === "boolean");
    const canCacheBoard = replayStatus === false || replayStatus === legacyReplayStatus;
    const guidance: WorkspaceGuidanceVM = {
      room: workspace, heading: null, action: null, connected,
      saved: !connected && (wallVm.plan !== undefined || wallVm.tasks.some(task => task.workspace === workspace)
        || (events?.length ?? 0) > 0), notices: [],
    };
    const state = (heading: string, action: string): void => { guidance.heading = heading; guidance.action = action; };
    const roomReadError = roomErrorReason ?? (readFailed ? readErrorReason : undefined);
    if (roomErrorReason !== undefined) {
      state("Workspace unavailable", "Ask the harness to inspect the room");
      guidance.error = roomErrorReason;
    } else if (status?.link == null) state("Connection unknown", "Open workspace help");
    else if (status.link.kind === "connecting") state("Connecting to bridge", "Check workspace connection setup");
    else if (status.link.kind === "unreachable") state("Bridge disconnected", "Open workspace help");
    else if (!synced) state("Syncing workspace", "Wait for room replay");
    else if (readFailed || events === undefined) {
      state("Workspace unavailable", "Ask the harness to inspect the room");
      guidance.error = readErrorReason;
    } else if (events.length === 0 && !states.some(agent => agent.room === workspace)) {
      state("Empty workspace", "Open workspace help");
    } else if (result?.projection.plan === null && events.some(event => event.act === "op"
      && ["memory.set", "agent.lifecycle"].includes(event.op?.kind ?? ""))) {
      state("No plan yet", "Ask the harness to seed required memory and create a plan");
    } else if (result === undefined || result.source === "legacy" || result.projection.plan === null) {
      state("Legacy activity only", "Ask the harness to create a shared plan");
    } else if (result.projection.tasks.length === 0) state("No tasks yet", "Ask the harness to add work");
    if (["No plan yet", "Legacy activity only", "No tasks yet"].includes(guidance.heading ?? "")) {
      guidance.body = "Use the swarm_coordinator prompt in your harness to coordinate shared planning.";
    }
    // Registration and active deployment are independent, room-scoped observations.
    // Neither ownership, activity, nor a browser connection substitutes for a lifecycle map.
    if (synced && !readFailed && guidance.heading !== "Workspace unavailable") {
      // Completed replay with no planning projection has no lifecycle events;
      // an existing projection that omits the field still means unavailable data.
      const lifecycle = result === undefined ? {} : result.projection.agent_lifecycle;
      if (lifecycle === undefined || lifecycle === null || typeof lifecycle !== "object" || Array.isArray(lifecycle)) {
        guidance.notices.push({ heading: "Harness registration unknown", action: "Harness registration data is unavailable for this room" },
          { heading: "Agent deployment unknown", action: "Agent deployment data is unavailable for this room" });
      } else {
        const records = Object.values(lifecycle);
        if (!records.some(record => typeof record?.harness === "string" && record.harness.trim().length > 0)) {
          guidance.notices.push({ heading: "No harness connected", action: "No harness registration recorded here; live MCP connection status is unknown" });
        }
        if (!records.some(record => record?.lifecycle === "deployed" || record?.lifecycle === "alive")) {
          guidance.notices.push({ heading: "No agents deployed", action: "No active deployment recorded; ask your harness to deploy agents",
            body: "Ask your harness to follow the documented hook setup in docs/HARNESS_HOOKS.md." });
        }
      }
    }
    guidanceForView = guidance;
    const previousSwarmTimer = swarmTimer;
    swarmTimer = undefined;
    const timerGen = ++swarmTimerGen;
    if (previousSwarmTimer !== undefined) readPort(() => clock.clearTimeout(previousSwarmTimer), isVoid);
    const isWall = currentView === "wall";
    const isAgents = currentView === "swarm";
    const cacheable = synced && canCacheBoard;
    if (isWall || isAgents || cacheable) {
      // Preserve liveness in legacy hosts; this never certifies workspace connection.
      const activityConnected = d.workspaceStatus !== undefined ? connected : link.state === undefined
        || readPort(() => link.state?.(), value => value != null && typeof value === "object"
          && typeof value.kind === "string")?.kind === "linked";
      const previous = lastGoodBoards.get(workspace);
      const syncError = isWall || d.workspaceStatus === undefined || synced ? undefined
        : (status?.link?.kind === "unreachable" ? status.link.reason : guidance.heading) || "Workspace unavailable";
      // A pending replay can show current live data only when there is no verified snapshot to retain.
      const canPreview = connected && replayStatus === false && previous === undefined;
      let boardError = roomReadError ?? (canPreview ? undefined : syncError);
      if (boardError === undefined && events !== undefined) {
        try {
          const inventory = deriveSwarmViewModel({ room: workspace, projection, events, nowMs, connected: activityConnected });
          const progress = projection?.plan === null ? null : inventory.progress;
          if (isWall) wallVm.swarm = { ...inventory, progress };
          if (isAgents || cacheable) {
            const board: AgentBoardViewModel = {
              ...inventory,
              totals: (inventory as AgentBoardViewModel).totals,
              // The compatibility VM sorts task IDs; the board follows the plan.
              agents: inventory.agents.map(agent => ({ ...agent,
                tasks: projection?.tasks.filter(task => task.assignee === agent.agent) ?? agent.tasks })),
              progress,
              unassigned: projection?.tasks.filter(task => task.assignee == null) ?? [],
            };
            if (cacheable) lastGoodBoards.set(workspace, board);
            if (isAgents) {
              if (syncError === undefined) wallVm.swarm = board;
              else if (board.agents.length === 0) boardError = syncError;
              else wallVm.swarm = { ...board, sync_error: syncError,
                totals: board.totals?.total === 0 ? undefined : board.totals };
            }
          }
        } catch {
          // Agent data is optional on the secondary Wall.
          if (isAgents) boardError = readErrorReason;
        }
      }
      if (boardError !== undefined && (isAgents || (isWall && roomErrorReason !== undefined))) {
        const emptyBoard: AgentBoardViewModel = { room: workspace, agents: [], progress: null, refresh_at_ms: null };
        const board: AgentBoardViewModel = {
          ...(previous ?? emptyBoard),
          totals: previous?.totals?.total === 0 ? undefined : previous?.totals,
          sync_error: boardError,
          ...(previous === undefined ? {} : { stale: true }),
        };
        wallVm.swarm = board;
      }
      const deadline = wallVm.swarm?.sync_error === undefined ? wallVm.swarm?.refresh_at_ms : null;
      if (deadline !== undefined && deadline !== null && Number.isFinite(deadline) && Number.isFinite(nowMs)) swarmTimer = readPort(() => clock.setTimeout(() => {
        if (destroyed || timerGen !== swarmTimerGen) return;
        swarmTimer = undefined;
        if (!destroyed) {
          try { render(); } catch { /* A read port may fail during expiry. */ }
        }
      }, Math.max(0, deadline - nowMs)), isTimerId);
    }
    try {
      const ws = wallVm.workspace;
      if (typeof ws === "string" && ws.length > 0) lastWorkspace = ws;
    } catch { /* ignore */ }
    // Plan cards use task IDs that repeat between rooms. The plan band is
    // workspace-scoped, so its card list must use that same workspace.
    if (wallVm.plan !== undefined && currentView === "wall") {
      wallVm.tasks = wallVm.tasks.filter(task => task.workspace === wallVm.workspace);
    }
    if (wallHandle === null) {
      wallHandle = readPort(() => mountWall(wallHost, wallVm, wallHandlers), isMountHandle) ?? null;
    } else {
      readPort(() => wallHandle?.update(wallVm), isVoid);
    }

    const showChat = (vm: AgentChatVM, restoreDraft: string | null = null): void => {
      vm = { ...vm, deliveryAnnouncements: drawerOpen };
      chatHost.setAttribute("aria-label", vm.title);
      if (chatHandle === null) {
        const mounted = readPort(() => mountAgentChat(chatHost, vm, chatHandlers), isMountHandle);
        if (mounted !== undefined) {
          // The public composer handle must be as contained as controller-owned calls.
          chatHandle = {
            update: next => { readPort(() => mounted.update(next), isVoid); },
            destroy: () => { readPort(() => mounted.destroy(), isVoid); },
            getDraft: () => readPort(() => mounted.getDraft(), value => typeof value === "string") ?? "",
            setDraft: text => { readPort(() => mounted.setDraft(text), isVoid); },
          };
          // Track edits through the original adapter handle as well as our facade.
          // Legacy adapters may omit the draft seam; each use remains guarded.
          wrapSetDraft(mounted);
        }
      } else {
        readPort(() => chatHandle?.update(vm), isVoid);
      }
      if (restoreDraft !== null) trySetDraft(restoreDraft);
      // U42: open only after the user picked a task; Close returns it to closed.
      chatHost.setAttribute("data-open", drawerOpen ? "true" : "false");
    };

    const plan = selectedPlan();
    const target = plan === null ? targetOf(states) : undefined;
    // Retention may remove an explicitly selected legacy identity. Only startup
    // without a selection may follow the first available agent.
    if (selected !== null && plan === null && target === undefined) invalidateSelection();

    // A selected plan target that no longer resolves closes the drawer. This is
    // the refresh path for closed/missing plans, removed tasks and announcements
    // that the projection went unavailable; send-time checks use the same resolver.
    if (invalidSelection) {
      if ("invalid" !== lastRenderedKey) {
        if (lastKey !== null) { stateFor(lastKey).draft = safeGetDraft(); lastKey = null; }
        clearComposer();
      }
      lastRenderedKey = "invalid";
      showChat({ room: "", agent: "", title: "", messages: [], silent: false, sending: false });
      return;
    }

    if (plan !== null) {
      const task = resolvePlanTask(plan.room, plan.taskId);
      if (task === undefined) {
        selected = null;
        invalidSelection = true;
        drawerOpen = false;
        if ("invalid" !== lastRenderedKey) {
          if (lastKey !== null) { stateFor(lastKey).draft = safeGetDraft(); lastKey = null; }
          clearComposer();
        }
        lastRenderedKey = "invalid";
        showChat({ room: "", agent: "", title: "", messages: [], silent: false, sending: false });
        return;
      }
      const assignee = task.assignee;
      const planKey = `plan:${plan.room}:${plan.taskId}:${assignee ?? ""}`;
      const taskKey = `plan:${plan.room}:${plan.taskId}`;
      const st = stateFor(taskKey);
      let restoreDraft = applyDraftForKey(taskKey);
      if (assignmentChanged(st.assignment, task)) {
        st.draft = "";
        st.seq += 1;
        restoreDraft = "";
        suggestNoticeMsg = "";
      }
      st.assignment = { assignee, claim_lamport: task.claim_lamport };
      if (planKey !== lastRenderedKey) suggestNoticeMsg = "";
      lastRenderedKey = planKey;
      if (assignee === null) {
        showChat(withLocal(taskKey, {
          room: plan.room, agent: "", title: task.title,
          messages: [], silent: false, sending: false,
          task: { id: plan.taskId, assignee: null },
        }), restoreDraft);
        return;
      }
      const roomEvents = readEvents(plan.room) ?? [];
      const synthetic: AgentState = {
        room: plan.room, agent: assignee, stepStates: [], outcomes: [], took: [],
        lastSeen: nowMs, openQuestions: [], closed: false,
      };
      const base = toChatVM(synthetic, roomEvents, { userAgent, nowMs, sending });
      const vm: AgentChatVM = { ...base, room: plan.room, agent: assignee, title: task.title,
        silent: false, sending, task: { id: plan.taskId, assignee } };
      if (suggestNoticeMsg.length > 0) vm.suggestNotice = suggestNoticeMsg;
      showChat(withLocal(taskKey, vm), restoreDraft);
      return;
    }

    if (target === undefined) {
      chatHost.setAttribute("data-open", "false");
      return;
    }
    const legacyKey = verdictKey(target);
    const legacyTaskKey = selected !== null ? selected : legacyKey;
    const restoreDraftLegacy = applyDraftForKey(legacyTaskKey);
    if (restoreDraftLegacy !== null) suggestNoticeMsg = "";
    lastRenderedKey = `agent:${legacyKey}`;
    const key = legacyKey;
    const verdict = verdicts.get(key);
    const drift = verdict !== undefined && accepted.get(key) !== verdict ? verdict : undefined;
    const targetSending = sending || (taskStates.get(legacyTaskKey)?.records.some((r) => r.status === "sending") ?? false);
    const opts: { userAgent: string; nowMs: number; sending: boolean; drift?: DriftVerdict; suggestNotice?: string } =
      drift !== undefined ? { userAgent, nowMs, sending: targetSending, drift } : { userAgent, nowMs, sending: targetSending };
    if (suggestNoticeMsg.length > 0) opts.suggestNotice = suggestNoticeMsg;
    const vm: AgentChatVM = toChatVM(target, readEvents(target.room) ?? [], opts);
    showChat(withLocal(legacyTaskKey, vm), restoreDraftLegacy);
  };

  // Publish only once the selected task's composer has been updated/restored.
  const render = (): void => {
    try { renderContent(); } finally { notifySelection(); }
  };

  const postQuestion = (room: string, to: string, text: string): void => {
    if (destroyed) return;
    sending = true;
    render();
    const done = (): void => {
      if (destroyed) return;
      sending = false;
      try { render(); } catch { return; }
    };
    const result = readPort(() => Promise.resolve(link.post({ room, to, text })), value => value instanceof Promise);
    void Promise.resolve(result).then(done, done);
  };

  const resolveOrchestrator = (): string => {
    return readPort(() => {
      const o = d.orchestrator;
      return typeof o === "function" ? o() : o;
    }, value => typeof value === "string" && value.length > 0) ?? "orchestrator";
  };

  const chatHandlers: AgentChatHandlers = {
    onSuggest: () => {
      if (destroyed) return;
      if (invalidSelection) return;
      const plan = selectedPlan();
      if (plan !== null) {
        const task = resolvePlanTask(plan.room, plan.taskId);
        if (task === undefined || task.assignee === null) return;
      } else if (selected !== null && resolveLegacyTarget() === undefined) return;
      suggestNoticeMsg = "Gemini Nano is not available on this device — Rules is the active reviewer. Please type your message instead.";
      render();
    },
    onClose: () => {
      if (destroyed) return;
      drawerOpen = false;
      chatHost.setAttribute("data-open", "false");
      notifySelection();
    },
    onSend: (text) => {
      if (destroyed) return;
      if (invalidSelection) return;
      const plan = selectedPlan();
      if (plan !== null) {
        const task = resolvePlanTask(plan.room, plan.taskId);
        if (task === undefined) {
          selected = null;
          invalidSelection = true;
          drawerOpen = false;
          render();
          return;
        }
        if (task.assignee === null) {
          render();
          return;
        }
        const taskKey = `plan:${plan.room}:${plan.taskId}`;
        if (assignmentChanged(taskStates.get(taskKey)?.assignment, task)) {
          render();
          return;
        }
        submitRecord(taskKey, plan.room, task.assignee, safeGetDraft(), text);
        return;
      }
      const target = resolveLegacyTarget();
      if (target === undefined) return;
      submitRecord(selected !== null ? selected : verdictKey(target), target.room, target.agent, safeGetDraft(), text);
    },
    onRetry: (clientId) => {
      retryRecord(clientId);
    },
    onEscalate: () => {
      if (destroyed) return;
      if (invalidSelection) return;
      const plan = selectedPlan();
      if (plan !== null) {
        const task = resolvePlanTask(plan.room, plan.taskId);
        if (task === undefined || task.assignee === null) return;
        postQuestion(plan.room, resolveOrchestrator(), ESCALATE_TEXT);
        return;
      }
      const target = resolveLegacyTarget();
      if (target === undefined) return;
      postQuestion(target.room, resolveOrchestrator(), ESCALATE_TEXT);
    },
    onAcceptDrift: () => {
      if (destroyed) return;
      if (invalidSelection) return;
      if (selectedPlan() !== null) return;
      const target = resolveLegacyTarget();
      if (target !== undefined) {
        const key = verdictKey(target);
        const verdict = verdicts.get(key);
        if (verdict !== undefined) accepted.set(key, verdict);
      }
      render();
    },
  };

  const refresh = (): void => {
    if (destroyed) return;
    const states = readStates();
    const pending: Array<Promise<void>> = states.map((s) => {
      const key = verdictKey(s);
      reviewGen += 1;
      const gen = reviewGen;
      const hash = s.contract?.hash;
      reviewState.set(key, { gen, hash });
      const review = readPort(() => Promise.resolve(reviewer.review(s)), value => value instanceof Promise);
      return Promise.resolve(review).then((v) => {
        if (!isVerdict(v)) return;
        const current = reviewState.get(key);
        if (current === undefined || current.gen !== gen || current.hash !== hash) return;
        const fresh = readStates().find((x) => verdictKey(x) === key);
        if (fresh === undefined || fresh.contract?.hash !== hash) return;
        verdicts.set(key, v);
      });
    });
    void Promise.allSettled(pending).then(() => {
      try { render(); } catch { return; }
    });
    render();
  };

  let interval: number | undefined;
  let workspaceTimer: number | undefined;
  let modelTimer: number | undefined;
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    const attempt = (cleanup: () => void): void => { readPort(cleanup, isVoid); };
    // Retire ownership before invoking cleanup; every resource gets an attempt.
    const oldInterval = interval, oldWorkspaceTimer = workspaceTimer, oldModelTimer = modelTimer, oldSwarmTimer = swarmTimer;
    interval = undefined; workspaceTimer = undefined; modelTimer = undefined; swarmTimer = undefined;
    swarmTimerGen += 1;
    const oldWall = wallHandle, oldChat = chatHandle;
    wallHandle = null; chatHandle = null;
    if (oldInterval !== undefined) readPort(() => clock.clearInterval(oldInterval), isVoid);
    if (oldWorkspaceTimer !== undefined) readPort(() => clock.clearInterval(oldWorkspaceTimer), isVoid);
    if (oldModelTimer !== undefined) readPort(() => clock.clearTimeout(oldModelTimer), isVoid);
    if (oldSwarmTimer !== undefined) readPort(() => clock.clearTimeout(oldSwarmTimer), isVoid);
    readPort(() => oldWall?.destroy(), isVoid);
    readPort(() => oldChat?.destroy(), isVoid);
    notifySelection();
    selectionListeners.clear();
    attempt(() => chatHost.removeEventListener("input", onDraftInput, true));
    attempt(() => { chatHost.classList.remove("chat-drawer"); });
    attempt(() => { chatHost.removeAttribute("data-open"); });
    attempt(() => { chatHost.removeAttribute("role"); });
    attempt(() => { chatHost.removeAttribute("aria-label"); });
  };

  chatHost.addEventListener("input", onDraftInput, true);
  interval = readPort(() => clock.setInterval(refresh, WALL_REFRESH_MS), isTimerId);
  if (d.workspaceStatus !== undefined) workspaceTimer = readPort(() => clock.setInterval(() => {
    if (destroyed) return;
    const next = readWorkspaceStatus();
    if (JSON.stringify(next ?? null) !== observationKey) {
      // M4: transport-only changes repaint without asking the reviewer or a provider.
      try { render(); } catch { /* Observation failure is represented as unknown. */ }
    }
  }, 500), isTimerId);
  if (d.modelStatus !== undefined) modelTimer = readPort(() => clock.setTimeout(() => {
    modelTimer = undefined;
    if (destroyed || readModelStatus() !== undefined) return;
    modelTimedOut = true;
    render();
  }, MODEL_TIMEOUT_MS), isTimerId);
  refresh();

  return {
    refresh, destroy, selection, refreshModels: () => { if (!destroyed) render(); },
    chat: () => destroyed ? null : chatHandle,
    onSelection: (listener) => {
      if (destroyed) return () => undefined;
      selectionListeners.add(listener);
      return () => { selectionListeners.delete(listener); };
    },
  };
}
