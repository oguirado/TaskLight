import { agentGroups, agentState, hasAgentRegistration } from "./agent_strip";
import type { SwarmAgentVM, SwarmViewModel } from "../app/swarm_vm";
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
export function renderSwarmView(doc: Document, vm: SwarmViewModel): HTMLElement {
  const options = (arguments[2] as SwarmRenderOptions | undefined) ?? {};
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
    if (restoreFocus) trigger?.focus();
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
            openDetail.focus();
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
