import { renderPhaseTaskCards } from "../../../src/views/plan";
import { renderAgentStrip } from "../../../src/views/agent_strip";
import type { ActivityStateVM, TaskVM } from "../../../src/views/types";
import type { SwarmAgentVM } from "../../../src/app/swarm_vm";
import { pseudoLayers } from "./css_probe";

export const states: readonly ActivityStateVM[] = ["working", "idle", "done", "blocked", "waiting", "needs_you", "unknown", "cancelled"];
export const longSlug = "a".repeat(200);

function task(id: string, done = false): TaskVM {
  return {
    id: `plan:fixture:${id}`, taskId: id, workspace: "fixture", project: "Density fixture", accent: "sky",
    title: longSlug, summary: "Read-only CSS fixture", status: done ? "done" : "running", attention: "none",
    updated: "09:00", source: { kind: "rules", ms: 0 }, next: "", phaseId: "build", assignee: longSlug,
    activity: { state: done ? "done" : "working" },
    steps: states.map((activity, index) => ({
      microId: `${id}.M0${index + 1}`, label: `Step ${index + 1}`,
      state: activity === "done" ? "done" : activity === "working" ? "active" : activity === "blocked" ? "blocked" : "pending",
      activity: { state: activity },
      ...(index % 2 === 0 ? { accept: "An existing read-only disclosure" } : {}),
    })),
  };
}

export function fixture(): { wall: HTMLElement; strip: HTMLElement; legacy: HTMLElement } {
  const wall = document.createElement("section");
  wall.className = "plan-wall";
  wall.append(renderPhaseTaskCards(document, [{ phaseId: "build", label: "Build", active: true, tasks: [task("T01"), task("T02", true)] }]));
  const agent: SwarmAgentVM = {
    agent: longSlug, harness: "Codex", lifecycle: "alive", activity: "working", tasks: [],
    current_task_id: "T01", active_micro_id: "T01.M01", micro_done: 0, micro_total: 8,
    last_beat_ts: null, last_beat_age_ms: null, waiting_on: [], unanswered_questions: 0,
  };
  const strip = renderAgentStrip(document, {
    room: "fixture", agents: [agent, { ...agent, agent: "completed-agent", lifecycle: "finished", activity: "done" }],
    progress: null, refresh_at_ms: null,
  });
  const legacy = document.createElement("section");
  legacy.innerHTML = '<div class="task"><div class="task-head"><h3 class="task-title">Legacy title</h3></div>'
    + '<ol class="steps"><li class="step" data-activity="working"><button class="step-row">Legacy row</button></li></ol></div>'
    + '<p class="agent-strip-row"><span class="wall-agent-name">Legacy identity</span></p>'
    + '<span class="ws-running" data-activity="working">Workspace activity</span>';
  document.body.append(wall, strip, legacy);
  pseudoLayers(wall); pseudoLayers(strip); pseudoLayers(legacy);
  return { wall, strip, legacy };
}
