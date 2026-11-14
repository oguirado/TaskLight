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
  ViewId,
  WallHandle,
  WallHandlers,
  WallVM,
  WorkspaceVM,
} from "./types";

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

const ATT_ORDER: Record<string, number> = { now: 0, high: 1, low: 2, none: 3 };

const VIEWS: [ViewId, string][] = [
  ["wall", "Wall"],
  ["agenda", "Agenda"],
  ["diary", "Diary"],
  ["archive", "Archive"],
];

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
  const label = kind === "device" ? "Gemini Nano · on device" : "Gemini · cloud fallback";
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

export function mountWall(host: HTMLElement, vm: WallVM, handlers?: WallHandlers): WallHandle {
  const doc: Document = host.ownerDocument;
  const instanceId = `u36-${++mountSeq}`;
  const expanded = new Map<string, boolean>();
  let destroyed = false;
  let currentHandlers = handlers;
  let currentVm: WallVM = vm;

  function expKey(taskId: unknown, idx: number): string {
    return `${asStr(taskId)}:${idx}`;
  }

  function onKey(e: KeyboardEvent): void {
    if (destroyed) return;
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
    const idx = ["1", "2", "3", "4"].indexOf(e.key);
    if (idx < 0) return;
    const entry = VIEWS[idx];
    if (!entry) return;
    if (currentHandlers?.onView) currentHandlers.onView(entry[0]);
  }

  function onClick(e: MouseEvent): void {
    if (destroyed) return;
    const target = e.target as Element | null;
    if (!target || typeof (target as Element).closest !== "function") return;
    const btn = (target as Element).closest("button");
    if (!btn || !host.contains(btn)) {
      // U42: a click on a task card (outside its buttons) opens that task's chat.
      const card = (target as Element).closest("article.task");
      if (card && host.contains(card) && currentHandlers?.onOpenTask) {
        const id = card.getAttribute("data-task-id");
        if (id !== null) currentHandlers.onOpenTask(id);
      }
      return;
    }
    if (btn.classList.contains("task-chat")) {
      const id = btn.getAttribute("data-task-id");
      if (id !== null && currentHandlers?.onOpenTask) currentHandlers.onOpenTask(id);
      return;
    }
    if (btn.classList.contains("nav-item")) {
      const v = btn.getAttribute("data-nav") as ViewId | null;
      if (v && currentHandlers?.onView) currentHandlers.onView(v);
      return;
    }
    if (btn.classList.contains("workspace")) {
      const id = btn.getAttribute("data-wsid");
      if (id !== null && currentHandlers?.onWorkspace) currentHandlers.onWorkspace(id);
      return;
    }
    if (btn.classList.contains("ws-new")) {
      if (currentHandlers?.onNewWorkspace) currentHandlers.onNewWorkspace();
      return;
    }
    if (btn.classList.contains("theme-toggle")) {
      if (currentHandlers?.onThemeToggle) currentHandlers.onThemeToggle();
      return;
    }
    if (btn.classList.contains("archive-option")) {
      const s = btn.getAttribute("data-scope") as "workspace" | "all" | null;
      if (s && currentHandlers?.onArchiveScope) currentHandlers.onArchiveScope(s);
      return;
    }
    if (btn.classList.contains("archived-restore")) {
      const id = btn.getAttribute("data-arch-id");
      if (id !== null && currentHandlers?.onRestore) currentHandlers.onRestore(id);
      return;
    }
    if (btn.classList.contains("step-row")) {
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
      return;
    }
  }

  doc.addEventListener("keydown", onKey);
  host.addEventListener("click", onClick);

  function render(rawVm: WallVM): void {
    if (destroyed) return;
    host.replaceChildren();
    const input = (rawVm && typeof rawVm === "object" ? rawVm : {}) as Partial<WallVM>;
    const workspaces: WorkspaceVM[] = Array.isArray(input.workspaces) ? (input.workspaces as WorkspaceVM[]) : [];
    const tasks: TaskVM[] = Array.isArray(input.tasks) ? (input.tasks as TaskVM[]) : [];
    const agenda: AgendaGroupVM[] = Array.isArray(input.agenda) ? (input.agenda as AgendaGroupVM[]) : [];
    const archive: ArchivedVM[] = Array.isArray(input.archive) ? (input.archive as ArchivedVM[]) : [];
    const workspaceId = asStr((input as { workspace?: unknown }).workspace);
    const view = ((input.view as unknown) === "wall" || (input.view as unknown) === "agenda" || (input.view as unknown) === "diary" || (input.view as unknown) === "archive"
      ? input.view
      : "wall") as ViewId;
    const archiveScope = (input.archiveScope as unknown) === "all" ? "all" : "workspace";
    const nowText = asStr(input.now);
    const model = (input.model && typeof input.model === "object" ? input.model : {}) as { state?: unknown; label?: unknown };
    const modelState = asStr(model.state);
    // U38 V5: never an empty model status label when the state is unknown.
    const modelLabel = asStr(model.label) || "Gemini Nano: checking…";
    const network = asStr(input.network);

    // .app root
    const app = el(doc, "div", "app");
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
    const rail = el(doc, "aside", "rail");
    const brand = el(doc, "div", "brand");
    const brandMark = el(doc, "span", "brand-mark");
    brandMark.setAttribute("aria-hidden", "true");
    brand.appendChild(brandMark);
    brand.appendChild(el(doc, "span", "brand-name", "TaskLight"));
    rail.appendChild(brand);

    const nav = el(doc, "nav", "nav");
    nav.setAttribute("aria-label", "Views");
    VIEWS.forEach(([vid, label], i) => {
      const b = el(doc, "button", "nav-item");
      b.setAttribute("type", "button");
      b.setAttribute("data-nav", vid);
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
      nav.appendChild(b);
    });
    rail.appendChild(nav);

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
      const openCount = tasks.filter((t) => t && (t as TaskVM).workspace === wid && !(t as TaskVM).archived).length;
      const lensWord = (w as { lens?: unknown }).lens === "study" ? "Study" : "Development";
      txtWrap.appendChild(el(doc, "span", "ws-lens", `${lensWord} · ${openCount} open`));
      b.appendChild(txtWrap);
      const badges = el(doc, "span", "ws-badges");
      const wsTasks = tasks.filter((t) => t && (t as TaskVM).workspace === wid && !(t as TaskVM).archived);
      const run = wsTasks.filter((t) => (t as TaskVM).status === "running").length;
      const need = wsTasks.filter((t) => (t as TaskVM).attention === "now" || (t as TaskVM).status === "waiting" || (t as TaskVM).status === "blocked").length;
      if (run > 0) {
        const r = el(doc, "span", "ws-running", String(run));
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

    const railStatus = el(doc, "div", "rail-status");
    const modelLine = el(doc, "div", "status-line");
    setSafeData(modelLine, "data-model", modelState);
    const mDot = el(doc, "span", "status-dot");
    mDot.setAttribute("aria-hidden", "true");
    modelLine.appendChild(mDot);
    modelLine.appendChild(el(doc, "span", "status-text", modelLabel));
    railStatus.appendChild(modelLine);
    const netLine = el(doc, "div", "status-line");
    setSafeData(netLine, "data-network", network);
    const nDot = el(doc, "span", "status-dot");
    nDot.setAttribute("aria-hidden", "true");
    netLine.appendChild(nDot);
    netLine.appendChild(el(doc, "span", "status-text", network === "offline" ? "Offline" : "Online · cloud fallback available"));
    railStatus.appendChild(netLine);
    const theme = el(doc, "button", "theme-toggle", "Toggle theme");
    theme.setAttribute("type", "button");
    railStatus.appendChild(theme);
    rail.appendChild(railStatus);

    app.appendChild(rail);

    const main = el(doc, "main", "main");
    // topbar
    const topbar = el(doc, "header", "topbar");
    const titles = el(doc, "div", "topbar-titles");
    titles.appendChild(el(doc, "p", "view-eyebrow", effWs ? asStr((effWs as { name?: unknown }).name) : ""));
    const viewTitle = VIEWS.find((v) => v[0] === view)?.[1] ?? view;
    titles.appendChild(el(doc, "h1", "view-title", viewTitle));
    const knownWorkspace = workspaces.some((w) => w && typeof w === "object" && (w as { id?: unknown }).id === workspaceId);
    const openForRaw = knownWorkspace ? tasks.filter((t) => t && (t as TaskVM).workspace === workspaceId && !(t as TaskVM).archived).length : 0;
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
    const needs = sortByAttention(wsTasksAll(workspaceId, false)).filter(
      (t) => (t as TaskVM).attention === "now" || (t as TaskVM).status === "waiting" || (t as TaskVM).status === "blocked",
    );
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
        a.appendChild(el(doc, "span", "focus-project", asStr((t as { project?: unknown }).project)));
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

    function renderStep(doc: Document, step: StepVM, taskId: string, idx: number): HTMLElement {
      const li = el(doc, "li", "step");
      setSafeData(li, "data-state", (step as { state?: unknown }).state);
      const st = (step as { state?: unknown }).state as StepStateVM;
      const detail = (step as { detail?: unknown }).detail as StepVM["detail"];
      const hasDetail = st === "done" && detail != null && typeof detail === "object";
      let row: HTMLElement;
      if (hasDetail) {
        const btn = el(doc, "button", "step-row");
        btn.setAttribute("type", "button");
        const key = expKey(taskId, idx);
        const isOpen = expanded.get(key) === true;
        btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
        btn.setAttribute("aria-controls", `${instanceId}-${taskId}-s${idx}`);
        btn.setAttribute("data-task-id", taskId);
        btn.setAttribute("data-step-idx", String(idx));
        row = btn;
      } else {
        row = el(doc, "div", "step-row");
      }
      const ind = el(doc, "span", "step-indicator");
      ind.setAttribute("aria-hidden", "true");
      row.appendChild(ind);
      const stxt = el(doc, "span", "step-text");
      stxt.appendChild(el(doc, "span", "step-label", asStr((step as { label?: unknown }).label)));
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

    // ---- view content ----
    if (view === "wall") {
      const board = el(doc, "section", "board");
      board.setAttribute("aria-label", "Tasks");
      const list = sortByAttention(wsTasksAll(workspaceId, false));
      for (const t of list) {
        const task = t as TaskVM;
        const tid = asStr((task as { id?: unknown }).id);
        const art = el(doc, "article", "task");
        (art as HTMLElement).id = tid;
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
        if (currentHandlers?.onOpenTask) {
          // U42: chat affordance; the drawer opens only on user action.
          art.setAttribute("data-task-id", tid);
          const chatBtn = el(doc, "button", "task-chat", "Chat");
          chatBtn.setAttribute("type", "button");
          chatBtn.setAttribute("data-task-id", tid);
          chatBtn.setAttribute("aria-label", `Open chat: ${asStr((task as { title?: unknown }).title)}`);
          foot.appendChild(chatBtn);
        }
        art.appendChild(foot);
        board.appendChild(art);
      }
      viewWrap.appendChild(board);
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
        meta.appendChild(el(doc, "span", "archived-steps", `${asStr(stepsN as unknown) === "" ? "0" : asStr(stepsN)} steps · ${tookT}`));
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

    host.appendChild(app);
    // ensure focus hidden property reflects (section.focus.hidden already set)
  }

  render(vm);

  const handle: WallHandle = {
    update(next: WallVM): void {
      if (destroyed) return;
      currentVm = next;
      render(next);
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
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
      host.replaceChildren();
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
  ViewId,
  WallHandle,
  WallHandlers,
  WallVM,
  WorkspaceVM,
} from "./types";
