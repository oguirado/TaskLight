import { describe, expect, it, vi } from "vitest";
import { renderSwarmView } from "../../../src/views/swarm";
import type { SwarmAgentVM } from "../../../src/app/swarm_vm";
import { agentVM, card, deterministic, fixedInput, freeze, HOSTILE, micro, NOW, projection, task, text, viewModel } from "./fixtures";

deterministic();
function mount(agents: readonly SwarmAgentVM[] = [agentVM()]): HTMLElement {
  const root = renderSwarmView(document, freeze(viewModel(agents)));
  document.body.append(root); return root;
}
function safe(root: HTMLElement): void {
  expect(root.querySelector("img, script, iframe, object, embed, [onerror], [onload], [onclick]")).toBeNull();
}
describe("A1 / M8 independent renderer fixture", () => {
  it("A1 renders exactly the fixed-fixture cards with task, microtask, progress, state and cross-task blocker", () => {
    const p = fixedInput().projection!;
    const a = agentVM({ tasks: p.tasks.filter(t => t.assignee === "executor-a"), waiting_on: [
      { task_id: "T04", upstream_id: "T03", owner: "executor-c", missing: false },
    ] });
    const b = agentVM({ agent: "executor-b", tasks: p.tasks.filter(t => t.assignee === "executor-b"),
      current_task_id: "T02", active_micro_id: "T02.M01", micro_done: 0, micro_total: 1, last_beat_age_ms: 2_000 });
    const c = agentVM({ agent: "executor-c", tasks: p.tasks.filter(t => t.assignee === "executor-c"),
      current_task_id: "T03", active_micro_id: "T03.M01", micro_done: 0, micro_total: 1, activity: "unknown",
      last_beat_ts: NOW - 90_001, last_beat_age_ms: 90_001 });
    const vm = freeze({ room: "demo", agents: [a, b, c], progress: p.rollup, refresh_at_ms: NOW + 88_001 });
    const before = structuredClone(vm), root = renderSwarmView(document, vm);
    expect(root).toBeInstanceOf(HTMLElement); expect(root.ownerDocument).toBe(document);
    const aText = text(card(root, "executor-a", ["executor-a", "executor-b"]));
    for (const s of ["T01", "Task T01", "T01.M02", "T04", "T03", "executor-c", "Working"]) expect(text(root)).toContain(s);
    expect(aText).toMatch(/1\s*\/\s*2/);
    expect((text(root).match(/Working/g) ?? [])).toHaveLength(2);
    expect((text(root).match(/Liveness unknown/g) ?? [])).toHaveLength(1);
    expect(text(root)).not.toContain("Task T00"); expect(vm).toEqual(before);
  });
  it.each([
    ["working", "Working"], ["unknown", "Liveness unknown"], ["waiting", "Waiting"], ["blocked", "Blocked"],
    ["needs_you", "Needs you"], ["idle", "Idle"], ["done", "Done"], ["cancelled", "Cancelled"],
  ] as const)("M8 maps %s to the existing literal label %s", (activity, label) => {
    const root = mount([agentVM({ activity })]); expect(text(root)).toContain(label);
  });
  it("M8 renders observed beat age rather than an absence placeholder", () => {
    const root = mount([agentVM({ last_beat_ts: NOW, last_beat_age_ms: 0 })]);
    expect(text(root)).not.toContain("No beat observed");
    // The specification leaves units and punctuation open; zero or 'now' conveys age zero.
    expect(text(root)).toMatch(/(?:\b0\b|\bnow\b|just\s+now)/i);
  });
  it("M8 renders missing evidence as No beat observed", () => {
    const root = mount([agentVM({ activity: "unknown", last_beat_ts: null, last_beat_age_ms: null })]);
    expect(text(root)).toContain("No beat observed");
  });
  it("M7 renders loaded-history count with its exact scope label and no question content", () => {
    const root = mount([agentVM({ unanswered_questions: 7 })]);
    expect(text(root)).toContain("Unanswered questions in loaded history"); expect(text(root)).toMatch(/\b7\b/);
    expect(root.querySelector("textarea, [contenteditable='true'], [role='textbox']")).toBeNull();
  });
  it("M7 renders zero unanswered questions truthfully", () => {
    const root = mount([agentVM({ unanswered_questions: 0 })]);
    expect(text(root)).toContain("Unanswered questions in loaded history"); expect(text(root)).toMatch(/\b0\b/);
  });
  it("M8 uses the supplied Document rather than the ambient document", () => {
    const doc = document.implementation.createHTMLDocument("Oracle fixture");
    const root = renderSwarmView(doc, viewModel()); expect(root.ownerDocument).toBe(doc);
  });
});

describe("A3 renderer blockers", () => {
  it("A3 shows distinct missing and unassigned upstreams with downstream identifiers", () => {
    const root = mount([agentVM({ activity: "waiting", waiting_on: [
      { task_id: "T01", upstream_id: "T-missing", owner: null, missing: true },
      { task_id: "T04", upstream_id: "T-unassigned", owner: null, missing: false },
    ] })]);
    for (const s of ["T01", "T04", "T-missing", "T-unassigned", "Missing task", "Unassigned", "Waiting"]) expect(text(root)).toContain(s);
  });
  it("A3 renders explicit blocked_reason verbatim on any owned task", () => {
    const root = mount([agentVM({ tasks: [task(), task("T04", {
      state: "blocked", explicit_state: "blocked", blocked_reason: "Waiting for literal approval <pending>",
    })] })]);
    expect(text(root)).toContain("Waiting for literal approval <pending>"); safe(root);
  });
});

describe("A5 renderer registration and empty state", () => {
  it("A5 empty membership shows both guidance strings with null progress", () => {
    const root = renderSwarmView(document, { room: "empty", agents: [], progress: null, refresh_at_ms: null });
    expect(text(root)).toContain("No agents in this room"); expect(text(root)).toContain("Connect your harness and assign work");
  });
  it.each([null, projection().rollup])("A5 zero-task registered card says No current task with progress %#", progress => {
    const a = agentVM({ agent: "registered", harness: "Fixture Harness", tasks: [], current_task_id: null, active_micro_id: null,
      micro_done: null, micro_total: null, activity: "idle", last_beat_ts: null, last_beat_age_ms: null });
    const root = renderSwarmView(document, { room: "demo", agents: [a], progress, refresh_at_ms: null });
    for (const s of ["registered", "Fixture Harness", "No current task", "No task progress", "No beat observed", "Idle"]) expect(text(root)).toContain(s);
    expect(text(root)).not.toContain("Not registered by a harness"); expect(text(root)).not.toMatch(/0\s*\/\s*0/);
  });
  it("A5 W1 owner shows Not registered by a harness", () => {
    expect(text(mount())).toContain("Not registered by a harness");
  });
  it("Amendment B all empty registration strings still mean Not registered by a harness", () => {
    expect(text(mount([agentVM({ run_id: "", swarm: "", harness: "" })]))).toContain("Not registered by a harness");
  });
  it.each([
    { lifecycle: "alive" } as const, { run_id: "run-only" }, { swarm: "swarm-only" }, { harness: "harness-only" },
  ])("Amendment B any supplied registration field suppresses the unregistered label %#", registration => {
    const root = mount([agentVM(registration)]);
    expect(text(root)).not.toContain("Not registered by a harness");
    for (const value of Object.values(registration)) expect(text(root).toLowerCase()).toContain(value.toLowerCase());
  });
  it("M4 lifecycle and activity are both visible without lifecycle overriding Working", () => {
    const root = mount([agentVM({ lifecycle: "failed", run_id: "registered-run", swarm: "registered-swarm", harness: "Fixture Harness" })]);
    expect(text(root)).toMatch(/failed/i);
    // A-U136a: U136 M4 - failed lifecycle always displays Failed, never Working
    for (const s of ["registered-run", "registered-swarm", "Fixture Harness"]) expect(text(root)).toContain(s);
  });
});

describe("A6 hostile strings and read-only DOM", () => {
  it.each(["title", "harness", "blocked_reason", "agent", "task_id", "micro_id", "swarm", "run_id"] as const)(
    "A6 hostile %s stays literal without executable elements or handlers", field => {
      let a = agentVM();
      if (field === "title" || field === "blocked_reason") {
        const t = task("T01", { [field]: HOSTILE,
          ...(field === "blocked_reason" ? { state: "blocked", explicit_state: "blocked" } : {}) });
        a = agentVM({ tasks: [t], ...(field === "blocked_reason" ? { activity: "blocked" } : {}) });
      } else if (field === "task_id") {
        a = agentVM({ tasks: [task(HOSTILE)], current_task_id: HOSTILE, active_micro_id: `${HOSTILE}.M01` });
      } else if (field === "micro_id") {
        a = agentVM({ tasks: [task("T01", { microtasks: [micro(HOSTILE)] })], active_micro_id: HOSTILE });
      } else a = agentVM({ [field]: HOSTILE });
      const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
      const root = mount([a]); expect(text(root)).toContain(HOSTILE); safe(root); expect(alert).not.toHaveBeenCalled();
    });
  it("Amendment B __proto__ identity and blocked reason remain literal text", () => {
    const root = mount([agentVM({ agent: "__proto__", harness: "constructor", tasks: [task("T01", {
      blocked_reason: HOSTILE, explicit_state: "blocked", state: "blocked" })], activity: "blocked" })]);
    for (const s of ["__proto__", "constructor", HOSTILE]) expect(text(root)).toContain(s); safe(root);
  });
  it("A6 has no message input, composer, chat, reply or terminal action", () => {
    const root = mount([agentVM({ unanswered_questions: 2 })]);
    expect(root.querySelector("input, textarea, [contenteditable='true'], [role='textbox'], form")).toBeNull();
    for (const control of root.querySelectorAll("button, a, [role='button'], [role='link']")) {
      const label = `${text(control)} ${control.getAttribute("aria-label") ?? ""} ${control.getAttribute("title") ?? ""} ${control.getAttribute("href") ?? ""}`;
      expect(label).not.toMatch(/\b(chat|reply|compose|send|terminal|shell|execute)\b/i);
    }
  });
});
