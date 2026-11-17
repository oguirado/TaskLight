import { describe, expect, it, vi } from "vitest";
import { renderSwarmView } from "../../../src/views/swarm";
import type { SwarmAgentVM, SwarmViewModel } from "../../../src/app/swarm_vm";
import {
  HOSTILE, NOW, accessibleName, activate, agent, cleanup, control, deterministic,
  disclosure, expanded, freeze, groupOrder, key, micro, noExecutableLabels, noNewControls,
  registrationOnly, task, text, viewModel, visibleText,
} from "./helpers";

deterministic();

// A-U146: A1 named non-article cards replace the legacy helper's article requirement.
function agentCard(root: HTMLElement, slug: string): HTMLElement {
  const name = [...root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6,[role=heading]")]
    .find(node => text(node) === slug);
  expect(name, `Agent identity ${slug}`).toBeDefined();
  const card = name!.closest<HTMLElement>(".swarm-card");
  expect(card, `Existing agent card ${slug}`).not.toBeNull(); return card!;
}

function sample(extra: Partial<SwarmAgentVM> = {}): SwarmAgentVM {
  return agent({ harness: "Visible supplied harness", run_id: "metadata-run", unanswered_questions: 3,
    waiting_on: [{ task_id: "T01", upstream_id: "T02", owner: "executor-b", missing: false }],
    tasks: [task("T01", { deps: ["T02"], blocked_reason: "Literal blocked reason <approval>",
      microtasks: [micro("T01.M01", { outcome: "Local outcome", evidence: [{ path: "evidence/fixture.txt", sha256: "b".repeat(64) }] })] })],
    ...extra });
}
function mount(vm: SwarmViewModel = viewModel([sample()])): HTMLElement {
  const root = renderSwarmView(document, freeze(vm)); document.body.append(root); return root;
}
function expandedCard(root: HTMLElement, slug = "executor-a"): HTMLElement {
  const card = agentCard(root, slug), toggle = disclosure(card);
  expect(expanded(toggle)).toBe(false); activate(toggle);
  expect(expanded(toggle)).toBe(true); return card;
}

describe("U138 A2 A3 / M6 dense Swarm and keyboard disclosures", () => {
  it("M6 two-argument renderer shows identity, state, work, progress and floored beat before metadata", () => {
    const doc = document.implementation.createHTMLDocument("U138 fixture"), vm = freeze(viewModel([sample({ last_beat_age_ms: 1_999 })]));
    const root = renderSwarmView(doc, vm); doc.body.append(root);
    expect(root.ownerDocument).toBe(doc);
    for (const value of ["executor-a", "Working", "T01", "T01.M01", "0/1", "1s"]) expect(visibleText(root)).toContain(value);
    expect(visibleText(root)).not.toContain("metadata-run");
    expect(visibleText(root)).not.toContain("Literal blocked reason <approval>");
    expect(visibleText(root)).not.toContain("Unanswered questions in loaded history");
    const toggle = disclosure(agentCard(root, "executor-a")); expect(expanded(toggle)).toBe(false);
  });
  it.each(["Enter", " "] as const)("M6 %j opens labelled metadata without opening task details", keyValue => {
    const root = mount(), card = agentCard(root, "executor-a"), toggle = disclosure(card);
    expect(expanded(toggle)).toBe(false); activate(toggle, keyValue); expect(expanded(toggle)).toBe(true);
    for (const value of ["Visible supplied harness", "metadata-run", "T02", "executor-b", "Literal blocked reason <approval>", "Unanswered questions in loaded history"]) expect(visibleText(card)).toContain(value);
    expect(visibleText(card)).toMatch(/Unanswered questions in loaded history:?\s*3/);
    expect(visibleText(root)).not.toContain("Local outcome"); expect(visibleText(root)).not.toContain("evidence/fixture.txt");
    activate(toggle, keyValue); expect(expanded(toggle)).toBe(false);
    expect(visibleText(card)).not.toContain("metadata-run");
  });
  it("M6 pointer disclosure activation cannot bubble into card-level task opening", () => {
    const root = mount(), card = agentCard(root, "executor-a"), toggle = disclosure(card);
    toggle.click(); expect(expanded(toggle)).toBe(true);
    expect(visibleText(root)).not.toContain("Local outcome"); expect(visibleText(root)).not.toContain("evidence/fixture.txt");
  });
  it("M6 registration-only cards expose metadata through a collapsed disclosure without a task action", () => {
    const root = mount(viewModel([registrationOnly("registered-only", { run_id: "registration-only-run", harness: "Registration harness" })]));
    const card = agentCard(root, "registered-only");
    for (const value of ["registered-only", "Idle", "No current task", "No beat observed"]) expect(visibleText(card)).toContain(value);
    expect(visibleText(card)).not.toContain("registration-only-run"); expandedCard(root, "registered-only");
    expect(visibleText(card)).toContain("registration-only-run"); expect(visibleText(card)).toContain("Registration harness");
    expect([...card.querySelectorAll<HTMLElement>("button,a,[role=button]")].some(el => /^View task/.test(accessibleName(el)))).toBe(false);
    expect(visibleText(card)).not.toMatch(/0\s*\/\s*0|0s ago/);
  });
  it.each(["Enter", " "] as const)("M6 task activation with %j exposes read-only detail; Escape returns focus", keyValue => {
    const root = mount(), button = control(root, "View task T01"); activate(button, keyValue);
    for (const value of ["Local outcome", "evidence/fixture.txt", "b".repeat(64), "Dependencies", "T02", "executor-b"]) expect(visibleText(root)).toContain(value);
    noNewControls(root); key(document.activeElement ?? document.body, "Escape");
    expect(visibleText(root)).not.toContain("Local outcome"); expect(visibleText(root)).not.toContain("evidence/fixture.txt");
    expect(document.activeElement).toBe(button);
  });
  it("M6 task-bearing card pointer activation preserves local inspection", () => {
    const root = mount(); agentCard(root, "executor-a").click(); expect(visibleText(root)).toContain("Local outcome");
    key(document.body, "Escape"); expect(visibleText(root)).not.toContain("Local outcome");
  });
  it("M6 metadata disclosure and task opening remain independently operable", () => {
    const root = mount(), card = expandedCard(root), toggle = disclosure(card);
    const button = control(card, "View task T01"); activate(button);
    expect(visibleText(root)).toContain("Local outcome"); key(document.body, "Escape");
    expect(document.activeElement).toBe(button); expect(expanded(toggle)).toBe(true);
  });
  it.each(["failed", "finished"] as const)("A2 M6 %s lifecycle overrides fresh working activity in summary and detail", lifecycle => {
    const root = mount(viewModel([sample({ lifecycle, activity: "working", last_beat_ts: NOW, last_beat_age_ms: 0 })]));
    const card = agentCard(root, "executor-a"); expect(visibleText(card)).toContain(lifecycle === "failed" ? "Failed" : "Finished");
    expect(visibleText(card)).not.toContain("Working"); expandedCard(root);
    expect(visibleText(card)).not.toContain("Working"); expect(visibleText(root)).not.toMatch(/process (?:terminated|exited)|killed/i);
  });
  it("M6 grouping preserves exact labels, missing versus literal Ungrouped, urgency and tie ordering", () => {
    const { swarm: _missing, ...missing } = registrationOnly("missing-group");
    const rows = [
      registrationOnly("literal-group", { swarm: "Ungrouped" }),
      registrationOnly("working", { swarm: "alpha", activity: "working" }),
      registrationOnly("finished", { swarm: "alpha", lifecycle: "finished" }),
      registrationOnly("waiting-b", { swarm: "alpha", activity: "waiting" }),
      registrationOnly("waiting-a", { swarm: "alpha", activity: "idle" }),
      registrationOnly("unknown", { swarm: "alpha", activity: "unknown" }),
      registrationOnly("blocked", { swarm: "alpha", activity: "blocked" }),
      registrationOnly("failed", { swarm: "alpha", lifecycle: "failed" }),
      registrationOnly("needs-you", { swarm: "alpha", activity: "needs_you" }), missing,
    ];
    const root = mount(viewModel(rows));
    expect(groupOrder(root, rows.map(a => a.agent))).toEqual(["literal-group", "needs-you", "failed", "blocked", "unknown", "waiting-a", "waiting-b", "working", "finished", "missing-group"]);
    expect([...root.querySelectorAll("h3")].filter(el => text(el) === "Ungrouped (1)")).toHaveLength(2);
  });
  it("M6 optional narrator node is retained once in its labelled slot", () => {
    const narrator = document.createElement("p"); narrator.textContent = "Supplied narrator";
    const render: (doc: Document, vm: SwarmViewModel, options?: { narrator?: HTMLElement }) => HTMLElement = renderSwarmView;
    const root = render(document, freeze(viewModel()), { narrator }); document.body.append(root);
    expect(root.contains(narrator)).toBe(true); expect(root.querySelectorAll("p")).toContain(narrator);
    const label = narrator.closest<HTMLElement>("[aria-label],[aria-labelledby]");
    expect(label).not.toBeNull(); expect(accessibleName(label!)).toMatch(/narrator/i);
    expect([...root.querySelectorAll("p")].filter(p => p === narrator)).toHaveLength(1);
  });
  it("M6 omitted narrator supplies no fabricated narration", () => {
    const render: (doc: Document, vm: SwarmViewModel, options?: { narrator?: HTMLElement }) => HTMLElement = renderSwarmView;
    const vm = freeze(viewModel()); expect(text(render(document, vm, {}))).toBe(text(renderSwarmView(document, vm)));
    expect(text(renderSwarmView(document, vm))).not.toContain("Supplied narrator");
  });
  it("M7 rendering, disclosure and task detail preserve the frozen model and perform no network request", () => {
    const vm = freeze(viewModel([sample()])), before = structuredClone(vm), root = mount(vm);
    expandedCard(root); activate(control(root, "View task T01")); key(document.body, "Escape");
    expect(vm).toEqual(before); noNewControls(root); expect(fetch).not.toHaveBeenCalled();
    expect(WebSocket).not.toHaveBeenCalled(); expect(XMLHttpRequest).not.toHaveBeenCalled();
  });
});

describe("U138 A4 / M7 hostile values before and after disclosure/detail", () => {
  it.each(["agent", "harness", "swarm", "run_id", "room", "task_id", "micro_id", "title", "blocked_reason", "reason", "outcome", "evidence"])(
    "A4 hostile %s remains literal through metadata and local task activation", field => {
      const id = field === "task_id" ? `T01["${HOSTILE}"]` : "T01";
      const mid = field === "micro_id" ? `${HOSTILE}.M01` : `${id}.M01`;
      const owner = field === "agent" ? HOSTILE : "executor-a";
      const t = task(id, { assignee: owner, title: field === "title" ? HOSTILE : "Hostile fixture task",
        blocked_reason: field === "blocked_reason" ? HOSTILE : "Literal blocker",
        microtasks: [micro(mid, { outcome: field === "outcome" ? HOSTILE : "Local outcome",
          evidence: [{ path: field === "evidence" ? HOSTILE : "evidence/fixture.txt", sha256: "b".repeat(64) }] })] });
      const a = sample({ agent: owner, tasks: [t], current_task_id: id, active_micro_id: mid,
        ...(field === "harness" || field === "swarm" || field === "run_id" ? { [field]: HOSTILE } : {}),
      });
      const withReason = { ...a, ...(field === "reason" ? { reason: HOSTILE } : {}) };
      const vm = { ...viewModel([withReason]), ...(field === "room" ? { room: HOSTILE } : {}) };
      const errors: unknown[] = [], onError = (e: ErrorEvent) => { errors.push(e.error); e.preventDefault(); };
      window.addEventListener("error", onError); cleanup.push(() => window.removeEventListener("error", onError));
      const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined), root = mount(vm);
      noExecutableLabels(root); expandedCard(root, owner); noExecutableLabels(root);
      activate(control(root, `View task ${id}`));
      expect(visibleText(root)).toContain(HOSTILE); noExecutableLabels(root);
      expect(errors).toEqual([]); expect(alert).not.toHaveBeenCalled(); key(document.body, "Escape"); noExecutableLabels(root);
    });
  it.each(["__proto__", "constructor", "toString"])("A4 %s identity and grouping use safe lookups through activation", value => {
    const before = Object.getOwnPropertyDescriptors(Object.prototype), id = `T01["${value}"]`;
    const a = sample({ agent: value, swarm: value, harness: value, tasks: [task(id, { assignee: value,
      blocked_reason: value, microtasks: [micro(`${id}.M01`, { outcome: "Prototype-safe outcome" })] })],
      current_task_id: id, active_micro_id: `${id}.M01` });
    const root = mount(viewModel([a])); expandedCard(root, value); activate(control(root, `View task ${id}`));
    expect(visibleText(root)).toContain("Prototype-safe outcome"); expect(visibleText(root)).toContain(value);
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(before); noExecutableLabels(root); key(document.body, "Escape");
  });
  it("A4 registration-only hostile metadata remains inert after disclosure", () => {
    const root = mount(viewModel([registrationOnly("registration-only", { harness: HOSTILE, swarm: HOSTILE, run_id: HOSTILE })]));
    expandedCard(root, "registration-only"); expect(visibleText(root)).toContain(HOSTILE); noExecutableLabels(root); noNewControls(root);
  });
});
