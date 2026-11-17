import type { SwarmAgentVM, SwarmViewModel } from "../app/swarm_vm";

const ACTIVITY_LABEL: Readonly<Record<SwarmAgentVM["activity"], string>> = {
  working: "Working", unknown: "Liveness unknown", waiting: "Waiting", blocked: "Blocked",
  needs_you: "Needs you", idle: "Idle", done: "Done", cancelled: "Cancelled",
};

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document, tag: K, className: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function hasAgentRegistration(agent: SwarmAgentVM): boolean {
  return Boolean(agent.lifecycle || agent.run_id || agent.swarm || agent.harness);
}

/** Lifecycle authority takes precedence over activity evidence. */
export function agentState(agent: SwarmAgentVM): string {
  if (agent.lifecycle === "failed") return "Failed";
  if (agent.lifecycle === "finished") return "Finished";
  return Object.prototype.hasOwnProperty.call(ACTIVITY_LABEL, agent.activity)
    ? ACTIVITY_LABEL[agent.activity] : ACTIVITY_LABEL.unknown;
}

function bucket(agent: SwarmAgentVM): number {
  if (agent.lifecycle === "failed") return 1;
  if (agent.lifecycle === "finished") return 7;
  if (!Object.prototype.hasOwnProperty.call(ACTIVITY_LABEL, agent.activity)) return 3;
  switch (agent.activity) {
    case "needs_you": return 0;
    case "blocked": return 2;
    case "unknown": return 3;
    case "waiting": case "idle": return 4;
    case "working": return 5;
    case "done": case "cancelled": return 7;
    default: return 3;
  }
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Preserve exact group identities, including absent versus literal Ungrouped. */
export function agentGroups(agents: readonly SwarmAgentVM[]): ReadonlyArray<
  readonly [string | undefined, readonly SwarmAgentVM[]]
> {
  const groups = new Map<string | undefined, SwarmAgentVM[]>();
  for (const agent of agents) {
    const rows = groups.get(agent.swarm) ?? [];
    rows.push(agent);
    groups.set(agent.swarm, rows);
  }
  return [...groups].sort(([a], [b]) => a === undefined ? 1 : b === undefined ? -1 : compareIds(a, b))
    .map(([key, rows]) => [key, rows.sort((a, b) => bucket(a) - bucket(b) || compareIds(a.agent, b.agent))] as const);
}

/** Match Swarm's lifecycle wording without confusing agent and task activity. */
function status(agent: SwarmAgentVM, noPlan: boolean): string {
  const openWork = agent.tasks.some(task => task.state !== "done" && task.state !== "cancelled");
  if (agent.lifecycle === "failed") return openWork ? "Failed · open work" : "Failed · tasks released";
  if (agent.lifecycle === "finished") return openWork ? "Finished · open work" : "Finished";
  if (agent.lifecycle === "deployed" && noPlan) return "Deployed · no plan yet";
  if (agent.activity === "working" && !hasAgentRegistration(agent)) return "Working · not registered by a harness";
  return agentState(agent);
}

function stateLabel(doc: Document, agent: SwarmAgentVM, noPlan = agent.tasks.length === 0): HTMLElement {
  const state = element(doc, "span", "wall-agent-state");
  state.dataset.activity = agent.lifecycle === "failed" || agent.lifecycle === "finished"
    ? agent.lifecycle
    : Object.prototype.hasOwnProperty.call(ACTIVITY_LABEL, agent.activity) ? agent.activity : "unknown";
  const dot = element(doc, "span", "wall-agent-dot");
  dot.setAttribute("aria-hidden", "true");
  state.append(dot, doc.createTextNode(status(agent, noPlan)));
  return state;
}

/** This is agent evidence; the adjacent task ring still describes the task. */
export function renderAgentChip(doc: Document, agent: SwarmAgentVM | undefined, owner = agent?.agent ?? ""): HTMLElement {
  const chip = element(doc, "span", "wall-agent-chip");
  chip.dataset.agentId = agent?.agent ?? owner;
  chip.append(element(doc, "span", "wall-agent-name", owner));
  if (agent === undefined) {
    chip.append(doc.createTextNode(" · "), element(doc, "span", "wall-agent-unavailable", "Agent status unavailable"));
    return chip;
  }
  if (agent.harness) chip.append(doc.createTextNode(" · "), element(doc, "span", "wall-agent-harness", agent.harness));
  chip.append(doc.createTextNode(" · "), stateLabel(doc, agent));
  if (!hasAgentRegistration(agent)) {
    chip.append(doc.createTextNode(" · "), element(doc, "span", "wall-agent-registration", "Not registered by a harness"));
  }
  return chip;
}

/** Render only the supplied selected-room snapshot; navigation stays wall-owned. */
export function renderAgentStrip(doc: Document, vm: SwarmViewModel): HTMLElement {
  const root = element(doc, "section", "agent-strip");
  root.setAttribute("aria-label", "Agents");
  const header = element(doc, "header", "agent-strip-header");
  header.append(element(doc, "h2", "agent-strip-title", "Agents"));
  const showAll = element(doc, "button", "nav-item agent-strip-all", "Show all in Swarm");
  showAll.type = "button";
  showAll.dataset.nav = "swarm";
  header.append(showAll);
  root.append(header);

  let remaining = 5;
  for (const [key, agents] of agentGroups(vm.agents)) {
    if (remaining === 0) break;
    const group = element(doc, "div", "agent-strip-group");
    group.append(element(doc, "h3", "agent-strip-group-title", key ?? "Ungrouped"));
    const list = element(doc, "ul", "agent-strip-list");
    list.setAttribute("role", "list");
    list.setAttribute("aria-label", `Agents · ${key ?? "Ungrouped"}`);
    for (const agent of agents.slice(0, remaining)) {
      const row = element(doc, "li", "agent-strip-row");
      row.dataset.agentId = agent.agent;
      // Keep absent and literal swarm names distinct without positional identities.
      row.dataset.agentKey = JSON.stringify([key ?? null, agent.agent]);
      const field = (label: string, value: HTMLElement): void => {
        if (row.childNodes.length > 0) row.append(doc.createTextNode(" · "));
        const record = element(doc, "span", "agent-strip-field");
        record.append(element(doc, "span", "agent-strip-field-label", `${label}: `), value);
        row.append(record);
      };
      field("State", stateLabel(doc, agent, vm.progress === null));
      field("Agent", element(doc, "span", "wall-agent-name", agent.agent));
      field("Harness", element(doc, "span", "wall-agent-harness", agent.harness
        || (hasAgentRegistration(agent) ? "Not recorded" : "Not registered by a harness")));
      field("Current task", element(doc, "span", "agent-strip-work", agent.current_task_id === null
        ? "No current task" : agent.current_task_id));
      field("Active microtask", element(doc, "span", "agent-strip-work", agent.active_micro_id === null
        ? "No active microtask" : agent.active_micro_id));
      const age = agent.last_beat_age_ms;
      field("Last beat", element(doc, "span", "agent-strip-beat", age === null || !Number.isFinite(age)
        ? "No beat observed" : `${Math.floor(Math.max(0, age) / 1_000)}s ago`));
      list.append(row);
      remaining -= 1;
    }
    group.append(list);
    root.append(group);
  }
  if (vm.agents.length === 0) {
    root.append(element(doc, "p", "agent-strip-empty", "Connect your harness and assign work"));
  }
  return root;
}
