import { agentGroups, agentState, hasAgentRegistration } from "./agent_strip";
import type { AgentInventoryRow, AgentInventoryTotals, SwarmAgentVM, SwarmViewModel } from "../app/swarm_vm";
import type { PlanTask } from "../plan/types";

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document, tag: K, className: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function field(doc: Document, list: HTMLDListElement, label: string, value: string): void {
  const group = element(doc, "div", "swarm-field");
  group.append(element(doc, "dt", "swarm-field-label", `${label}: `), element(doc, "dd", "swarm-field-value", value));
  list.append(group);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hasOpenWork(agent: SwarmAgentVM): boolean {
  return agent.tasks.some(task => task.state !== "done" && task.state !== "cancelled");
}

function status(agent: SwarmAgentVM, noPlan: boolean): string {
  if (agent.lifecycle === "failed") return hasOpenWork(agent) ? "Failed · open work" : "Failed · tasks released";
  if (agent.lifecycle === "finished") return hasOpenWork(agent) ? "Finished · open work" : "Finished";
  if (agent.lifecycle === "deployed" && noPlan) return "Deployed · no plan yet";
  if (agent.activity === "working" && !hasAgentRegistration(agent)) return "Working · not registered by a harness";
  return agentState(agent);
}

function renderAgent(doc: Document, agent: SwarmAgentVM, noPlan: boolean): HTMLElement {
  const card = element(doc, "div", "swarm-card");
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", `Agent · ${agent.agent} · ${agent.swarm ?? "Ungrouped"}`);
  const header = element(doc, "header", "swarm-card-header");
  const activity = element(doc, "span", "swarm-activity", status(agent, noPlan));
  activity.dataset.activity = agent.lifecycle === "failed" || agent.lifecycle === "finished"
    ? agent.lifecycle : agent.activity;
  header.append(element(doc, "h4", "swarm-agent-name", agent.agent), activity);
  card.append(header);

  const current = agent.tasks.find(task => task.id === agent.current_task_id);
  const micro = current?.microtasks.find(child => child.id === agent.active_micro_id);
  const work = element(doc, "dl", "swarm-work");
  field(doc, work, "Current task", current ? `${current.id} · ${current.title}` : "No current task");
  field(doc, work, "Active microtask", agent.active_micro_id === null
    ? "No active microtask" : `${agent.active_micro_id}${micro ? ` · ${micro.text}` : ""}`);
  field(doc, work, "Task progress", current && agent.micro_done !== null && agent.micro_total !== null
    ? `${agent.micro_done}/${agent.micro_total} microtasks done` : "No task progress");
  field(doc, work, "Last beat", agent.last_beat_age_ms === null ? "No beat observed" : `${Math.floor(agent.last_beat_age_ms / 1_000)}s ago`);
  card.append(work);

  const metadata = element(doc, "div", "swarm-metadata");
  const toggle = element(doc, "button", "swarm-metadata-toggle", `Agent details · ${agent.agent}`);
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  const contents = element(doc, "div", "swarm-metadata-content");
  // Encode the exact swarm and agent identity without delimiter collisions or render counters.
  contents.id = `swarm-metadata-${encodeURIComponent(JSON.stringify([agent.swarm ?? null, agent.agent]))}`;
  contents.hidden = true;
  toggle.setAttribute("aria-controls", contents.id);
  toggle.addEventListener("click", event => {
    event.stopPropagation();
    contents.hidden = !contents.hidden;
    toggle.setAttribute("aria-expanded", String(!contents.hidden));
  });
  metadata.append(toggle, contents);
  const registration = element(doc, "div", "swarm-registration");
  if (!hasAgentRegistration(agent)) {
    registration.append(element(doc, "p", "swarm-note", "Not registered by a harness"));
  } else {
    const fields = element(doc, "dl", "swarm-registration-fields");
    if (agent.harness) field(doc, fields, "Harness", agent.harness);
    if (agent.lifecycle) field(doc, fields, "Lifecycle", agent.lifecycle);
    if (agent.run_id) field(doc, fields, "Run", agent.run_id);
    if (agent.swarm) field(doc, fields, "Swarm", agent.swarm);
    registration.append(fields);
  }
  const reason = (agent as SwarmAgentVM & Readonly<{ reason?: string }>).reason;
  if (reason !== undefined) registration.append(element(doc, "p", "swarm-note", reason));
  contents.append(registration);

  const reasons = agent.tasks.filter(task => task.state !== "done" && task.state !== "cancelled"
    && task.blocked_reason !== null && task.blocked_reason !== "");
  if (agent.waiting_on.length > 0 || reasons.length > 0) {
    const blockers = element(doc, "section", "swarm-blockers");
    blockers.append(element(doc, "h4", "swarm-section-title", "Blocked on"));
    const list = element(doc, "ul", "swarm-blocker-list");
    for (const wait of agent.waiting_on) {
      const owner = wait.missing ? "Missing task" : wait.owner ?? "Unassigned";
      list.append(element(doc, "li", "swarm-dependency", `${wait.task_id} → ${wait.upstream_id} → ${owner}`));
    }
    for (const task of reasons) {
      list.append(element(doc, "li", "swarm-blocked-reason", `${task.id} · ${task.blocked_reason}`));
    }
    blockers.append(list);
    contents.append(blockers);
  }

  const counts = element(doc, "dl", "swarm-counts");
  field(doc, counts, "Owned tasks", String(agent.tasks.length));
  field(doc, counts, "Unanswered questions in loaded history", String(agent.unanswered_questions));
  contents.append(counts);
  card.append(metadata);
  return card;
}

/** A local snapshot of the selected task; evidence is text, never an executable link. */
function renderDetail(doc: Document, agent: SwarmAgentVM, task: PlanTask, tasks: ReadonlyMap<string, PlanTask>): HTMLElement {
  const detail = element(doc, "section", "swarm-detail");
  detail.setAttribute("role", "region");
  detail.setAttribute("aria-label", `Task details · ${task.id}`);
  detail.tabIndex = -1;
  detail.append(element(doc, "h3", "swarm-detail-title", `${task.id} · ${task.title}`));
  const fields = element(doc, "dl", "swarm-work");
  field(doc, fields, "Owner", agent.agent);
  field(doc, fields, "State", task.state);
  field(doc, fields, "Type", task.type);
  field(doc, fields, "Phase", task.phase);
  field(doc, fields, "Acceptance", task.accept);
  if (task.estimate !== null) field(doc, fields, "Estimate", task.estimate);
  if (task.blocked_reason !== null) field(doc, fields, "Blocked reason", task.blocked_reason);
  detail.append(fields, element(doc, "h4", "swarm-section-title", "Dependencies"));
  const dependencies = element(doc, "ul", "swarm-blocker-list");
  for (const id of [...task.deps].sort(compareIds)) {
    const wait = agent.waiting_on.find(item => item.task_id === task.id && item.upstream_id === id);
    const upstream = tasks.get(id);
    const owner = wait ? (wait.missing ? "Missing task" : wait.owner ?? "Unassigned")
      : upstream ? `${upstream.assignee ?? "Unassigned"} · ${upstream.state}` : "No open dependency reported";
    dependencies.append(element(doc, "li", "swarm-dependency", `${id}${upstream ? ` · ${upstream.title}` : ""} → ${owner}`));
  }
  if (task.deps.length === 0) dependencies.append(element(doc, "li", "swarm-note", "No dependencies"));
  detail.append(dependencies, element(doc, "h4", "swarm-section-title", "Microtasks"));
  const children = element(doc, "ol", "swarm-detail-microtasks");
  for (const micro of [...task.microtasks].sort((a, b) => compareIds(a.id, b.id))) {
    const child = element(doc, "li", "swarm-detail-microtask");
    child.append(element(doc, "h4", "swarm-section-title", `${micro.id} · ${micro.text}`));
    const values = element(doc, "dl", "swarm-work");
    field(doc, values, "State", micro.state);
    field(doc, values, "Acceptance", micro.accept);
    field(doc, values, "Outcome", micro.outcome ?? "No outcome recorded");
    if (micro.took !== null) field(doc, values, "Time taken", micro.took);
    child.append(values, element(doc, "h5", "swarm-section-title", "Evidence"));
    const evidence = element(doc, "ul", "swarm-detail-evidence");
    for (const item of micro.evidence) evidence.append(element(doc, "li", "swarm-evidence", `${item.path} · ${item.sha256}`));
    if (micro.evidence.length === 0) evidence.append(element(doc, "li", "swarm-note", "No evidence recorded"));
    child.append(evidence);
    children.append(child);
  }
  if (task.microtasks.length === 0) detail.append(element(doc, "p", "swarm-note", "No microtasks"));
  detail.append(children);
  return detail;
}

type SwarmRenderOptions = { narrator?: HTMLElement };

/**
 * Build an observational snapshot with local read-only task inspection.
 * Optional third argument: { narrator?: HTMLElement }. Keep the admitted
 * two-argument function type for callers that inspect its exact parameters.
 */
function renderLegacySwarmView(doc: Document, vm: SwarmViewModel, options: SwarmRenderOptions = {}): HTMLElement {
  const root = element(doc, "section", "swarm-view");
  root.setAttribute("aria-label", "Swarm");
  root.tabIndex = -1;
  const header = element(doc, "header", "swarm-header");
  header.append(element(doc, "h2", "swarm-title", "Swarm"), element(doc, "p", "swarm-room", `Room · ${vm.room}`));
  root.append(header);

  if (vm.progress !== null) {
    const progress = element(doc, "section", "swarm-plan-progress");
    progress.setAttribute("aria-label", "Plan progress");
    progress.append(element(doc, "h3", "swarm-section-title", "Plan progress"));
    progress.append(element(doc, "p", "swarm-progress-summary",
      `${vm.progress.tasks_done} of ${vm.progress.tasks_total} tasks done · ${vm.progress.micro_done} of ${vm.progress.micro_total} microtasks done · ${vm.progress.progress_pct}%`));
    const meter = element(doc, "progress", "swarm-progress");
    meter.setAttribute("aria-label", "Plan progress");
    meter.max = 100;
    meter.value = vm.progress.progress_pct;
    meter.textContent = `${vm.progress.progress_pct}%`;
    progress.append(meter);
    root.append(progress);
  }

  if (options.narrator) {
    const narrator = element(doc, "section", "swarm-narrator");
    narrator.setAttribute("aria-label", "Swarm narrator");
    narrator.append(options.narrator);
    root.append(narrator);
  }

  let openDetail: HTMLElement | null = null;
  let trigger: HTMLButtonElement | null = null;
  const closeDetail = (restoreFocus = true): void => {
    doc.removeEventListener("keydown", handleDetailKey);
    openDetail?.remove();
    openDetail = null;
    trigger?.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger?.focus({ preventScroll: true });
    trigger = null;
  };
  const handleDetailKey = (event: KeyboardEvent): void => {
    if (!root.isConnected) {
      closeDetail(false);
    } else if (event.key === "Escape" && openDetail) {
      event.preventDefault();
      closeDetail();
    }
  };

  if (vm.agents.length === 0) {
    const empty = element(doc, "div", "swarm-empty");
    empty.append(element(doc, "h3", "swarm-empty-title", "No agents in this room"),
      element(doc, "p", "swarm-note", "Connect your harness and assign work"));
    root.append(empty);
  } else {
    const tasks = new Map(vm.agents.flatMap(agent => agent.tasks.map(task => [task.id, task] as const)));
    for (const [key, rows] of agentGroups(vm.agents)) {
      const group = element(doc, "section", "swarm-group");
      const label = `${key ?? "Ungrouped"} (${new Set(rows.map(row => row.agent)).size})`;
      group.setAttribute("aria-label", label);
      group.append(element(doc, "h3", "swarm-group-title", label));
      const grid = element(doc, "div", "swarm-grid");
      for (const agent of rows) {
        const card = renderAgent(doc, agent, vm.progress === null);
        const selected = agent.tasks.find(task => task.id === agent.current_task_id);
        if (selected) {
          card.dataset.actionable = "true";
          const button = element(doc, "button", "swarm-task-open", `View task ${selected.id}`);
          button.type = "button";
          button.setAttribute("aria-expanded", "false");
          const open = (): void => {
            closeDetail(false);
            trigger = button;
            openDetail = renderDetail(doc, agent, selected, tasks);
            const close = element(doc, "button", "swarm-detail-close", "Close task details");
            close.type = "button";
            close.addEventListener("click", () => closeDetail());
            openDetail.prepend(close);
            root.append(openDetail);
            doc.addEventListener("keydown", handleDetailKey);
            button.setAttribute("aria-expanded", "true");
            openDetail.focus({ preventScroll: true });
            // Refreshes reopen details while detached and must retain scroll.
            if (openDetail.isConnected && typeof openDetail.scrollIntoView === "function") {
              openDetail.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" });
            }
          };
          card.addEventListener("click", event => {
            const target = event.target as Element | null;
            if (target?.closest(".swarm-metadata")) return;
            open();
          });
          button.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              open();
            }
          });
          card.insertBefore(button, card.querySelector(".swarm-metadata"));
        }
        grid.append(card);
      }
      group.append(grid);
      root.append(group);
    }
  }
  return root;
}


/** Additive inventory fields supplied by C2, without widening its legacy display contract. */
export type AgentBoardViewModel = SwarmViewModel & Readonly<{
  totals?: AgentInventoryTotals | undefined;
  sync_error?: string;
  unassigned?: readonly PlanTask[];
}>;
type InventoryAgent = SwarmAgentVM & Partial<AgentInventoryRow>;

function bubbleIndicator(doc: Document, state: string, done: number, total: number, task: boolean): HTMLElement {
  const node = element(doc, "span", `swarm-bubble ${task ? "swarm-bubble-task" : "swarm-bubble-micro"}`);
  node.setAttribute("aria-hidden", "true");
  node.dataset.state = state;
  const complete = total > 0 && done === total;
  node.dataset.complete = String(complete);
  node.style.setProperty("--swarm-fill", `${total > 0 ? done / total * 100 : 0}%`);
  if (complete) node.append(element(doc, "span", "swarm-bubble-mark", "✓"));
  
  return node;
}

function renderTaskBubble(doc: Document, room: string, task: PlanTask): HTMLElement {
  const item = element(doc, "div", "swarm-task");
  const done = task.microtasks.filter(micro => micro.state === "done").length;
  const total = task.microtasks.length;
  const key = encodeURIComponent(JSON.stringify([room, task.id]));
  const button = element(doc, "button", "swarm-task-bubble");
  button.type = "button";
  button.id = `swarm-task-${key}`;
  button.setAttribute("aria-label", `${task.title}, ${task.state}, ${done}/${total}`);
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", `swarm-micros-${key}`);
  button.append(bubbleIndicator(doc, task.state, done, total, true), element(doc, "span", "swarm-task-title", task.title));
  const children = element(doc, "div", "swarm-microtasks");
  children.id = `swarm-micros-${key}`;
  children.hidden = true;
  const setOpen = (open: boolean): void => {
    children.replaceChildren();
    if (open) {
      for (const micro of task.microtasks) {
        const row = element(doc, "div", "swarm-microtask");
        row.append(bubbleIndicator(doc, micro.state, micro.state === "done" ? 1 : 0, 1, false));
        const title = element(doc, "span", "swarm-microtask-title", micro.text);
        title.setAttribute("aria-hidden", "true");
        row.append(title, element(doc, "span", "swarm-sr-only",
          `${micro.text}, ${micro.state}, ${micro.state === "done" ? 1 : 0}/1`));
        children.append(row);
      }
      if (total === 0) children.append(element(doc, "p", "swarm-note", "No microtasks"));
    }
    children.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  };
  let suppressSpaceClick = false;
  button.addEventListener("pointerdown", () => { suppressSpaceClick = false; });
  // V1q: browsers that cancel the Space-synthesized click must not leave the next click suppressed.
  button.addEventListener("keyup", event => {
    if (event.key === " ") doc.defaultView?.setTimeout(() => { suppressSpaceClick = false; }, 0);
  });
  button.addEventListener("click", () => {
    if (suppressSpaceClick) {
      suppressSpaceClick = false;
      return;
    }
    setOpen(children.hidden === true);
  });
  button.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (event.key === " ") suppressSpaceClick = true;
      setOpen(children.hidden === true);
    }
  });
  item.addEventListener("keydown", event => {
    if (event.key === "Escape" && !children.hidden) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      button.focus({ preventScroll: true });
    }
  });
  item.append(button, children);
  return item;
}

/** The inventory is already ordered; parent links only determine DOM containment. */
export function renderSwarmView(doc: Document, vm: SwarmViewModel): HTMLElement {
  const snapshot = vm as AgentBoardViewModel;
  const options = (arguments[2] as SwarmRenderOptions | undefined) ?? {};
  // Existing integrations may still supply the older display-only snapshot.
  if ((vm.agents.some(agent => !("state" in agent)) || vm.agents.length === 0 && snapshot.totals === undefined) && snapshot.sync_error === undefined) {
    return renderLegacySwarmView(doc, vm, options);
  }
  const root = element(doc, "section", "swarm-view swarm-board");
  root.setAttribute("aria-label", "Agents");
  root.tabIndex = -1;
  const header = element(doc, "header", "swarm-header");
  const totals = snapshot.totals;
  const summary = element(doc, "p", "swarm-summary", totals
    ? `${totals.working} working · ${totals.waiting + totals.idle + totals.registered} waiting · ${totals.finished} finished`
      + (totals.failed ? ` · ${totals.failed} failed` : "") + (totals.unknown ? ` · ${totals.unknown} unknown` : "")
    : "Inventory unavailable");
  summary.setAttribute("aria-live", "polite");
  summary.setAttribute("aria-atomic", "true");
  header.append(summary);
  root.append(header, element(doc, "p", "swarm-room", `Room · ${vm.room}`));
  if (snapshot.sync_error !== undefined) {
    const error = element(doc, "p", "swarm-sync-error", `Can't read this workspace: ${snapshot.sync_error.trim() || "reason unknown"}`);
    error.setAttribute("role", "alert");
    root.append(error);
  }
  const lanes = element(doc, "div", "swarm-lanes");
  lanes.setAttribute("role", "group");
  lanes.setAttribute("aria-label", "Agent lanes");
  if (snapshot.sync_error !== undefined) lanes.dataset.stale = "true";
  root.append(lanes);
  const byAgent = new Map(vm.agents.map(agent => [agent.agent, agent as InventoryAgent]));
  const cards = new Map<string, HTMLElement>();
  const childLists = new Map<string, HTMLElement>();
  const tasks = new Map(vm.agents.flatMap(agent => agent.tasks.map(task => [task.id, task] as const)));
  let openDetail: HTMLElement | null = null;
  let detailTrigger: HTMLButtonElement | null = null;
  const closeDetail = (restore = true): void => {
    doc.removeEventListener("keydown", onDetailKey);
    openDetail?.remove();
    openDetail = null;
    detailTrigger?.setAttribute("aria-expanded", "false");
    if (restore && root.isConnected) detailTrigger?.focus({ preventScroll: true });
    detailTrigger = null;
  };
  const onDetailKey = (event: KeyboardEvent): void => {
    if (!root.isConnected) closeDetail(false);
    else if (event.key === "Escape" && openDetail) { event.preventDefault(); closeDetail(); }
  };
  for (const agent of vm.agents as readonly InventoryAgent[]) {
    const card = renderAgent(doc, agent, vm.progress === null);
    card.classList.add("swarm-lane");
    card.id = `swarm-lane-${encodeURIComponent(JSON.stringify([vm.room, agent.agent]))}`;
    card.tabIndex = 0;
    const heading = card.querySelector(".swarm-card-header")!;
    if (agent.state === "failed" || agent.state === "unknown") {
      heading.querySelector(".swarm-agent-name")!.after(
        element(doc, "span", "swarm-agent-marker", agent.state === "failed" ? "×" : "?"));
    }
    const state = agent.state || "unknown";
    const label = state === "unknown" && agent.activity === "unknown"
      ? "Liveness unknown" : state[0]!.toUpperCase() + state.slice(1);
    const deployment = agent.lifecycle === "deployed" && vm.progress === null ? " · Deployed · no plan yet" : "";
    heading.append(element(doc, "span", "swarm-agent-harness", agent.harness ?? "Harness unknown"),
      element(doc, "span", "swarm-inventory-state", label + deployment));
    const work = card.querySelector(".swarm-work");
    const metadata = card.querySelector(".swarm-metadata-content")!;
    const legacyActivity = heading.querySelector(".swarm-activity");
    if (legacyActivity) {
      if (legacyActivity.textContent === label) legacyActivity.remove();
      else metadata.prepend(legacyActivity);
    }
    const groupSummary = element(doc, "p", "swarm-note",
      `${agent.swarm ?? "Ungrouped"} (${vm.agents.filter(row => row.swarm === agent.swarm).length})`);
    metadata.append(groupSummary);
    if (work) metadata.prepend(work);
    const list = element(doc, "div", "swarm-task-list");
    for (const task of agent.tasks) list.append(renderTaskBubble(doc, vm.room, task));
    if (agent.tasks.length === 0) list.append(element(doc, "p", "swarm-note", "No tasks yet"));
    card.insertBefore(list, card.querySelector(".swarm-metadata"));
    // Keep the established read-only detail surface as secondary inspection.
    const selected = agent.tasks.find(task => task.id === agent.current_task_id);
    if (selected) {
      const button = element(doc, "button", "swarm-task-open", `View task ${selected.id}`);
      button.type = "button";
      button.setAttribute("aria-expanded", "false");
      const open = (): void => {
        closeDetail(false);
        detailTrigger = button;
        openDetail = renderDetail(doc, agent, selected, tasks);
        const close = element(doc, "button", "swarm-detail-close", "Close task details");
        close.type = "button";
        close.addEventListener("click", () => closeDetail());
        openDetail.prepend(close);
        root.append(openDetail);
        button.setAttribute("aria-expanded", "true");
        doc.addEventListener("keydown", onDetailKey);
        openDetail.focus({ preventScroll: true });
        if (openDetail.isConnected && typeof openDetail.scrollIntoView === "function") {
          openDetail.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" });
        }
      };
      button.addEventListener("click", open);
      button.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
      });
      card.insertBefore(button, card.querySelector(".swarm-metadata"));
    }
    cards.set(agent.agent, card);
    const children = element(doc, "div", "swarm-children");
    card.append(children);
    childLists.set(agent.agent, children);
  }
  for (const agent of vm.agents as readonly InventoryAgent[]) {
    const card = cards.get(agent.agent)!;
    const parent = agent.parent?.agent;
    // A malformed external cycle must not delete lanes or produce a DOM cycle.
    const visited = new Set([agent.agent]);
    let ancestor = parent;
    while (ancestor && !visited.has(ancestor)) { visited.add(ancestor); ancestor = byAgent.get(ancestor)?.parent?.agent; }
    const container = parent && ancestor === undefined && childLists.get(parent);
    (container || lanes).append(card);
  }
  if (vm.agents.length === 0 && snapshot.sync_error === undefined) {
    lanes.append(element(doc, "h3", "swarm-empty-title", "No agents in this room"),
      element(doc, "p", "swarm-note", "Connect your harness and assign work"));
  }
  if (snapshot.unassigned?.length) {
    const unassigned = element(doc, "section", "swarm-unassigned");
    unassigned.append(element(doc, "h3", "swarm-section-title", "Unassigned work"));
    for (const task of snapshot.unassigned) unassigned.append(renderTaskBubble(doc, vm.room, task));
    lanes.append(unassigned);
  }
  if (options.narrator) {
    const narrator = element(doc, "section", "swarm-narrator");
    narrator.setAttribute("aria-label", "Swarm narrator");
    narrator.append(options.narrator);
    root.append(narrator);
  }
  return root;
}
