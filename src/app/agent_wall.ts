// Wall mount: renders the U36 wall and the U35 agent chat from the store
// plus drift verdicts (SPEC_U37 "U37c"). The reviewer is re-asked on every
// refresh; silence re-renders every 30 s. No logging, no storage.
import { readTheme, writeTheme } from "../ui/theme_store";
import { mountAgentChat } from "../agentsui";
import type { AgentChatHandlers, AgentChatHandle, AgentChatVM, ChatMessageVM } from "../agentsui/types";
import { mountWall } from "../views";
import type { WallHandle, ViewId, WallVM } from "../views/types";
import type { AgentState, DriftVerdict, TemplateMemorySectionMeta } from "../agents/types";
import { toChatVM, toWallVM } from "./agent_store";
import type { AgentLink } from "./agent_link";
import type { AgentStore } from "./agent_store";
import type { DriftReviewer } from "./agent_drift";
import type { Clock } from "./types";
import type { PlanProjectionResult } from "./agent_store";
import type { PlanTask } from "../plan/types";

export interface AgentWallDeps {
  wallHost: HTMLElement;
  chatHost: HTMLElement;
  link: Pick<AgentLink, "post">;
  store: AgentStore;
  reviewer: DriftReviewer;
  clock: Clock;
  userAgent: string;
  /** Escalation target agent; default "orchestrator". */
  orchestrator?: string | (() => string | undefined);
  initialView?: ViewId;
  /** Undefined while the configured device model is still checking. */
  modelStatus?: () => WallVM["model"] | undefined;
  planVerdicts?: ReadonlyMap<string, DriftVerdict> | (() => ReadonlyMap<string, DriftVerdict>);
  planBriefs?: ReadonlyMap<string, { text: string; source: string }> | (() => ReadonlyMap<string, { text: string; source: string }>);
  templateMemorySections?: (templateId: string) => readonly TemplateMemorySectionMeta[] | undefined;
}
export interface AgentWall {
  /** Re-reads the store and re-renders (call after store.ingest). */
  refresh(): void;
  /** Currently open plan-task drawer; legacy drawers have no plan selection. */
  selection(): { room: string; taskId: string; assignee: string | null } | null;
  /** Live S1 composer; unavailable after destruction. */
  chat(): AgentChatHandle | null;
  onSelection(listener: () => void): () => void;
  destroy(): void;
}
export const WALL_REFRESH_MS = 30_000 as const;

function readPlanFeed<T>(feed: ReadonlyMap<string, T> | (() => ReadonlyMap<string, T>) | undefined): ReadonlyMap<string, T> | undefined {
  try { return typeof feed === "function" ? feed() : feed; } catch { return undefined; }
}

const ESCALATE_TEXT = "Escalation: the user asks the orchestrator to step in.";

const MODEL_TIMEOUT_MS = 10_000 as const;

export function startAgentWall(d: AgentWallDeps): AgentWall {
  const { wallHost, chatHost, link, store, reviewer, clock, userAgent } = d;
  let destroyed = false;
  let sending = false;
  let currentTheme = readTheme();
  wallHost.ownerDocument.documentElement.dataset.theme = currentTheme;
  let modelTimedOut = false;
  let suggestNoticeMsg = "";
  let wallHandle: WallHandle | null = null;
  let chatHandle: AgentChatHandle | null = null;
  const verdicts = new Map<string, DriftVerdict>();
  const accepted = new Map<string, DriftVerdict>();
  const reviewState = new Map<string, { gen: number; hash: string | undefined }>();
  let reviewGen = 0;

  let currentView: ViewId = d.initialView ?? "wall";
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
  let lastPlanAssignee: string | null | undefined = undefined;
  const targetOf = (states: AgentState[]): AgentState | undefined =>
    selected !== null
      ? states.find((s) => s.agent !== userAgent && verdictKey(s) === selected)
      : states.find((s) => s.agent !== userAgent);

  const TASK_ID_RE = /^T[0-9]+$/;
  const ROOM_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

  const safePlan = (room: string): PlanProjectionResult | undefined => {
    try {
      const cand = (store as unknown as Record<string, unknown>)["plan"];
      if (typeof cand !== "function") return undefined;
      return store.plan(room);
    } catch { return undefined; }
  };

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
      try { listener(); } catch { /* isolate selection subscribers */ }
    }
  };

  const invalidateSelection = (): void => {
    selected = null;
    invalidSelection = true;
    drawerOpen = false;
    suggestNoticeMsg = "";
    lastPlanAssignee = undefined;
  };

  const rejectSelection = (): void => {
    invalidateSelection();
    render();
  };

  const resolveLegacyTarget = (): AgentState | undefined => {
    const target = targetOf(store.states());
    if (selected !== null && target === undefined) rejectSelection();
    return target;
  };

  const clearComposer = (): void => {
    suggestNoticeMsg = "";
    try {
      const setDraft = (chatHandle as unknown as { setDraft?: (t: string) => void } | null)?.setDraft;
      if (typeof setDraft === "function") setDraft.call(chatHandle, "");
    } catch { /* composing without a mounted handle is fine */ }
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
  interface TaskChatState {
    draft: string | undefined;
    seq: number;
    records: OutgoingRecord[];
  }
  const taskStates = new Map<string, TaskChatState>();
  let clientSeq = 0;
  let lastKey: string | null = null;

  const currentKey = (): string | null => (selected !== null ? selected : lastKey);

  const stateFor = (key: string): TaskChatState => {
    let st = taskStates.get(key);
    if (st === undefined) {
      st = { draft: undefined, seq: 0, records: [] };
      taskStates.set(key, st);
    }
    return st;
  };

  const safeGetDraft = (): string => {
    try {
      const g = (chatHandle as unknown as { getDraft?: () => string } | null)?.getDraft;
      const v = typeof g === "function" ? g.call(chatHandle) : "";
      return typeof v === "string" ? v : "";
    } catch { return ""; }
  };

  let internalDraftWrite = false;
  const trySetDraft = (t: string): void => {
    const previous = internalDraftWrite;
    internalDraftWrite = true;
    try {
      const s = (chatHandle as unknown as { setDraft?: (t: string) => void } | null)?.setDraft;
      if (typeof s === "function") s.call(chatHandle, t);
    } catch { /* composing without a mounted handle is fine */ }
    finally { internalDraftWrite = previous; }
  };

  const wrapSetDraft = (): void => {
    if (chatHandle === null) return;
    try {
      const orig = (chatHandle as unknown as { setDraft?: (t: string) => void }).setDraft;
      if (typeof orig !== "function") return;
      (chatHandle as unknown as { setDraft: (t: string) => void }).setDraft = (t: string): void => {
        const key = currentKey();
        if (!internalDraftWrite && key !== null) stateFor(key).seq += 1;
        try { orig.call(chatHandle, t); } catch { /* inert */ }
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
    let result: Promise<unknown>;
    try {
      result = link.post({ room: record.room, to: record.to, text: record.text }) as Promise<unknown>;
    } catch {
      result = Promise.reject(new Error("post failed"));
    }
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
    clientSeq += 1;
    const record: OutgoingRecord = {
      clientId: `c${clientSeq}`, taskKey: key, raw, seqAtSend: st.seq,
      createdAt: new Date(clock.now()).toISOString(), room, to, text, status: "sending",
    };
    st.records.push(record);
    render();
    postRecord(record);
  };

  const withLocal = (key: string, base: AgentChatVM): AgentChatVM => {
    const st = taskStates.get(key);
    const records = st?.records ?? [];
    if (records.length === 0) return base;
    const deliveredIds = new Set<string>();
    for (const r of records) {
      if (r.status === "delivered" && r.eventId !== undefined) deliveredIds.add(r.eventId);
    }
    const journal = base.messages.filter((m) => !deliveredIds.has(m.id));
    const locals: ChatMessageVM[] = records.map((r) => {
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
      return msg;
    });
    const pending = records.some((r) => r.status === "sending");
    return { ...base, messages: [...journal, ...locals], sending: base.sending || pending };
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
      const target = targetOf(store.states());
      if (target === undefined || target.agent !== record.to || target.room !== record.room) return;
    }
    record.status = "sending";
    delete record.eventId;
    delete record.lamport;
    delete record.code;
    render();
    postRecord(record);
  };

  const wallHandlers = {
    onOpenTask: (id: string): void => {
      if (destroyed) return;
      try {
        const parsed = parseSelection(id);
        if (parsed.kind === "plan") {
          if (resolvePlanTask(parsed.room, parsed.taskId) === undefined) { rejectSelection(); return; }
          selected = `plan:${parsed.room}:${parsed.taskId}`;
          invalidSelection = false;
          drawerOpen = true;
          render();
          return;
        }
        if (parsed.kind === "legacy") {
          const found = store.states().find((s) => s.agent !== userAgent && verdictKey(s) === id);
          if (found === undefined) { rejectSelection(); return; }
          selected = id;
          invalidSelection = false;
          drawerOpen = true;
          render();
          return;
        }
        rejectSelection();
      } catch { try { rejectSelection(); } catch { return; } }
    },
    onView: (v: ViewId): void => {
      if (destroyed) return;
      try {
        if (v === "wall" || v === "agenda" || v === "diary" || v === "archive" || v === "memory") {
          currentView = v;
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
      writeTheme(currentTheme);
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

  const renderContent = (): void => {
    if (destroyed) return;
    const states = store.states();
    const nowMs = clock.now();
    let plans: import("./agent_store").PlanProjectionResult[] | undefined;
    try {
      const cand = (store as unknown as Record<string, unknown>)["plans"];
      if (typeof cand === "function") plans = (store as AgentStore).plans();
    } catch { plans = undefined; }
    const planVerdicts = readPlanFeed(d.planVerdicts);
    const planBriefs = readPlanFeed(d.planBriefs);
    const unavailable = { state: "unavailable" as const, label: "Gemini Nano: not available on this device — enable the on-device model flags in Chrome. Rules is the active reviewer." };
    let model: WallVM["model"] = { state: "unavailable", label: "" };
    if (d.modelStatus !== undefined) {
      let status: WallVM["model"] | undefined;
      try { status = d.modelStatus(); } catch { /* no verdict yet */ }
      model = status ?? (modelTimedOut ? unavailable : { state: "unavailable", label: "Gemini Nano: checking…" });
    }
    const wallVm = toWallVM(states, verdicts, {
      nowMs,
      model,
      network: "online",
      userAgent,
      view: currentView,
      ...(currentWorkspace !== undefined ? { workspace: currentWorkspace } : {}),
      archiveScope: currentArchiveScope,
      ...(planVerdicts !== undefined ? { planVerdicts } : {}),
      ...(planBriefs !== undefined ? { planBriefs } : {}),
      ...(d.templateMemorySections !== undefined ? { templateMemorySections: d.templateMemorySections } : {}),
    } as import("./agent_store").PlanWallOpts, plans);
    // Preserve caller-requested workspace if the vm chose a different one but user explicitly selected
    if (currentWorkspace !== undefined && wallVm.workspace !== currentWorkspace) {
      try { (wallVm as unknown as Record<string, unknown>)["workspace"] = currentWorkspace; } catch { /* ignore */ }
    }
    try { (wallVm as unknown as Record<string, unknown>)["view"] = currentView; } catch { /* ignore */ }
    try { (wallVm as unknown as Record<string, unknown>)["archiveScope"] = currentArchiveScope; } catch { /* ignore */ }
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
      wallHandle = mountWall(wallHost, wallVm, wallHandlers);
    } else {
      wallHandle.update(wallVm);
    }

    const showChat = (vm: AgentChatVM, restoreDraft: string | null = null): void => {
      vm = { ...vm, deliveryAnnouncements: drawerOpen };
      chatHost.setAttribute("aria-label", vm.title);
      if (chatHandle === null) {
        chatHandle = mountAgentChat(chatHost, vm, chatHandlers);
        wrapSetDraft();
      } else {
        chatHandle.update(vm);
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
        lastPlanAssignee = undefined;
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
      const assigneeChanged = lastKey === taskKey && lastPlanAssignee !== undefined && lastPlanAssignee !== assignee;
      let restoreDraft = applyDraftForKey(taskKey);
      if (assigneeChanged) {
        const st = stateFor(taskKey);
        st.draft = "";
        st.seq += 1;
        restoreDraft = "";
      }
      if (planKey !== lastRenderedKey) suggestNoticeMsg = "";
      lastRenderedKey = planKey;
      lastPlanAssignee = assignee;
      if (assignee === null) {
        showChat(withLocal(taskKey, {
          room: plan.room, agent: "", title: task.title,
          messages: [], silent: false, sending: false,
          task: { id: plan.taskId, assignee: null },
        }), restoreDraft);
        return;
      }
      let roomEvents: import("../agents/types").RoomEvent[] = [];
      try {
        const ev = store.events(plan.room);
        roomEvents = Array.isArray(ev) ? ev : [];
      } catch { roomEvents = []; }
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
    lastPlanAssignee = undefined;
    const key = legacyKey;
    const verdict = verdicts.get(key);
    const drift = verdict !== undefined && accepted.get(key) !== verdict ? verdict : undefined;
    const targetSending = sending || (taskStates.get(legacyTaskKey)?.records.some((r) => r.status === "sending") ?? false);
    const opts: { userAgent: string; nowMs: number; sending: boolean; drift?: DriftVerdict; suggestNotice?: string } =
      drift !== undefined ? { userAgent, nowMs, sending: targetSending, drift } : { userAgent, nowMs, sending: targetSending };
    if (suggestNoticeMsg.length > 0) opts.suggestNotice = suggestNoticeMsg;
    const vm: AgentChatVM = toChatVM(target, store.events(target.room), opts);
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
    let result: Promise<unknown>;
    try {
      result = link.post({ room, to, text });
    } catch {
      result = Promise.resolve(undefined);
    }
    void Promise.resolve(result).then(done, done);
  };

  const resolveOrchestrator = (): string => {
    const o = d.orchestrator;
    if (typeof o === "function") return (o as () => string | undefined)() ?? "orchestrator";
    if (typeof o === "string" && o.length > 0) return o;
    return "orchestrator";
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
          lastPlanAssignee = undefined;
          render();
          return;
        }
        if (task.assignee === null) {
          render();
          return;
        }
        if (lastPlanAssignee !== undefined && lastPlanAssignee !== task.assignee) {
          render();
          return;
        }
        submitRecord(`plan:${plan.room}:${plan.taskId}`, plan.room, task.assignee, safeGetDraft(), text);
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
    const states = store.states();
    const pending: Array<Promise<void>> = states.map((s) => {
      const key = verdictKey(s);
      reviewGen += 1;
      const gen = reviewGen;
      const hash = s.contract?.hash;
      reviewState.set(key, { gen, hash });
      let review: Promise<DriftVerdict | undefined>;
      try {
        review = reviewer.review(s);
      } catch {
        review = Promise.resolve(undefined);
      }
      return review.then((v) => {
        if (v === undefined) return;
        const current = reviewState.get(key);
        if (current === undefined || current.gen !== gen || current.hash !== hash) return;
        const fresh = store.states().find((x) => verdictKey(x) === key);
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
  let modelTimer: number | undefined;
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    let failed = false;
    let firstError: unknown;
    const attempt = (cleanup: () => void): void => {
      try { cleanup(); } catch (error) {
        if (!failed) { failed = true; firstError = error; }
      }
    };
    // Each resource gets a cleanup attempt even if a previous port throws.
    attempt(() => { if (interval !== undefined) clock.clearInterval(interval); });
    attempt(() => { if (modelTimer !== undefined) clock.clearTimeout(modelTimer); });
    attempt(() => { wallHandle?.destroy(); });
    attempt(() => { chatHandle?.destroy(); });
    wallHandle = null;
    chatHandle = null;
    notifySelection();
    selectionListeners.clear();
    attempt(() => { chatHost.classList.remove("chat-drawer"); });
    attempt(() => { chatHost.removeAttribute("data-open"); });
    attempt(() => { chatHost.removeAttribute("role"); });
    attempt(() => { chatHost.removeAttribute("aria-label"); });
    if (failed) throw firstError;
  };

  try {
    interval = clock.setInterval(refresh, WALL_REFRESH_MS);
    if (d.modelStatus !== undefined) modelTimer = clock.setTimeout(() => {
      if (destroyed) return;
      try { if (d.modelStatus?.() !== undefined) return; } catch { /* no verdict yet */ }
      modelTimedOut = true;
      render();
    }, MODEL_TIMEOUT_MS);
    refresh();
  } catch (error) {
    // Preserve the startup error after best-effort rollback.
    try { destroy(); } catch { /* all cleanup steps were attempted */ }
    throw error;
  }

  return {
    refresh, destroy, selection,
    chat: () => destroyed ? null : chatHandle,
    onSelection: (listener) => {
      if (destroyed) return () => undefined;
      selectionListeners.add(listener);
      return () => { selectionListeners.delete(listener); };
    },
  };
}
