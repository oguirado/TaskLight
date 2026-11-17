import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PlanTask } from "../../../src/plan/types";
import type { SwarmAgentVM, SwarmViewModel } from "../../../src/app/swarm_vm";
import { renderSwarmView } from "../../../src/views/swarm";
import { clone, deterministic, fixture, fold, root, view } from "./support";

const HOSTILE = "<img src=x onerror=alert(1)>";
type Result = { verdict: string; summary?: string; receipt?: string; evidence?: { path: string; sha256: string }[] };
function task(verdict?: string, reason = "Decision reason"): PlanTask {
  const t = clone(fold(fixture.seed).tasks[0]!);
  const decision = verdict === undefined ? undefined : { verdict, reason, evidence: [
    { path: `artifacts/${HOSTILE}.json`, sha256: "a".repeat(64) },
  ] };
  return Object.assign(t, decision ? { last_decision: decision, decisions: [decision] } : {});
}
function vm(result: Result | null, tasks: PlanTask[] = [], state: "finished" | "failed" = "finished"): SwarmViewModel {
  const agent: SwarmAgentVM = Object.assign({ agent: "worker", lifecycle: state, run_id: "r1",
    tasks, current_task_id: null, active_micro_id: null, micro_done: null, micro_total: null,
    activity: "idle" as const, last_beat_ts: null, last_beat_age_ms: null,
    waiting_on: [], unanswered_questions: 0 }, { state, last_result: result, harness: "test",
    parent: null, children: [], last_seen_lamport: 5, last_seen_ts: 1800000000005,
    current: null, counts: { tasks_owned: tasks.length,
      micros_done: tasks.flatMap(t => t.microtasks).filter(m => m.state === "done").length,
      micros_total: tasks.flatMap(t => t.microtasks).length } });
  const totals = { working: 0, waiting: 0, idle: 0, registered: 0,
    finished: state === "finished" ? 1 : 0, failed: state === "failed" ? 1 : 0, unknown: 0, total: 1 };
  return Object.assign({ room: "demo", agents: [agent], progress: null, refresh_at_ms: null }, { totals });
}
function mount(model: SwarmViewModel): HTMLElement {
  const element = renderSwarmView(document, model); document.body.append(element); return element;
}
function visibleText(root: HTMLElement): string {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let parent = node.parentElement, visible = true;
    while (parent) {
      const style = getComputedStyle(parent);
      if (parent.hidden || parent.getAttribute("aria-hidden") === "true" || parent.tagName === "SCRIPT"
        || style.display === "none" || style.visibility === "hidden"
        || /(?:^|\s)(?:swarm-sr-only|sr-only|visually-hidden)(?:\s|$)/.test(parent.className)) visible = false;
      if (parent === root) break;
      parent = parent.parentElement;
    }
    if (visible) parts.push(node.textContent ?? "");
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
function safe(root: HTMLElement): void {
  expect(root.querySelector("img,script,iframe,object,embed,[onerror],[onload],[onclick]")).toBeNull();
  for (const el of root.querySelectorAll("a[href], [src], [srcdoc]")) {
    expect(el.getAttribute("href") ?? el.getAttribute("src") ?? el.getAttribute("srcdoc") ?? "").not.toMatch(/^\s*(?:javascript|data):/i);
  }
}
function name(node: HTMLElement): string {
  const refs = node.getAttribute("aria-labelledby");
  if (refs) return refs.split(/\s+/).map(id => node.ownerDocument.getElementById(id)?.textContent ?? "").join(" ");
  return node.getAttribute("aria-label") ?? node.textContent ?? "";
}
function taskButton(root: HTMLElement): HTMLButtonElement {
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("button")].filter(button => name(button).includes("First task"));
  expect(buttons).toHaveLength(1);
  return buttons[0]!;
}
function loadStyles(): void {
  const style = document.createElement("style"); style.dataset.c7Style = "true";
  // A concrete sentinel lets jsdom compare theme paint without choosing a new theme.
  style.textContent = readFileSync(join(root, "styles/swarm.css"), "utf8")
    .replaceAll("var(--c-st-done)", "rgb(12, 123, 45)");
  document.head.append(style);
}
function donePaint(element: HTMLElement): string[] {
  const result: string[] = [];
  for (const node of [element, ...element.querySelectorAll<HTMLElement>("*")]) {
    const style = getComputedStyle(node);
    const fill = style.getPropertyValue("--swarm-fill").trim();
    if (style.backgroundColor === "rgb(12, 123, 45)" || style.fill === "rgb(12, 123, 45)"
      || (style.color === "rgb(12, 123, 45)" && fill === "100%")) result.push("done");
  }
  return result;
}
deterministic();

describe("C7 M6 terminal results are visible escaped text", () => {
  for (const state of ["finished", "failed"] as const) for (const verdict of ["ADMIT", "HOLD", "NO_PUDE", "OK", "FAIL"]) {
    it(`m6_${state}_${verdict.toLowerCase()}_badge_and_summary_are_visible`, () => {
      const summary = "Visible worker summary";
      const model = vm({ verdict, summary }, [], state), before = clone(model), element = mount(model);
      expect(visibleText(element)).toContain(verdict);
      expect(visibleText(element)).toContain(summary);
      const badges = [...element.querySelectorAll<HTMLElement>("*")].filter(node => {
        const text = visibleText(node); return text.includes(verdict) && !text.includes(summary);
      });
      expect(badges.length, "verdict is a distinct text badge, separate from the summary").toBeGreaterThan(0);
      expect(model).toEqual(before); safe(element);
    });
  }
  it("m6_hostile_summary_is_visible_text_never_markup", () => {
    const element = mount(vm({ verdict: "HOLD", summary: HOSTILE, receipt: `artifacts/${HOSTILE}.json`,
      evidence: [{ path: `artifacts/${HOSTILE}.json`, sha256: "a".repeat(64) }] }));
    expect(visibleText(element)).toContain(HOSTILE); safe(element);
  });
  it("m6_long_summary_is_truncated_to_200_characters", () => {
    const summary = "summary-word ".repeat(20), element = mount(vm({ verdict: "OK", summary }));
    expect(visibleText(element)).toContain(summary.slice(0, 200).trim());
    expect(visibleText(element)).not.toContain(summary.slice(0, 201));
  });
  it("m6_verdict_only_result_is_renderable", () => {
    const element = mount(vm({ verdict: "NO_PUDE" }));
    expect(visibleText(element)).toContain("NO_PUDE");
    expect(visibleText(element)).not.toMatch(/undefined|null/); safe(element);
  });
  it("m6_legacy_terminal_without_result_has_no_fabricated_verdict", () => {
    const element = mount(vm(null));
    for (const verdict of ["ADMIT", "HOLD", "NO_PUDE", "OK", "FAIL"]) expect(visibleText(element)).not.toContain(verdict);
    safe(element);
  });
  it("m6_real_journal_to_vm_to_board_keeps_unbound_result_visible", () => {
    const events = clone(fixture.seed).filter(item => !["plan.open", "task.add"].includes(item.op.kind));
    events.forEach((item, index) => { item.lamport = index + 1; });
    const element = mount(view(events));
    expect(visibleText(element)).toContain("ADMIT");
    expect(visibleText(element)).toContain("Result summary"); safe(element);
  });
});

describe("C7 M6 task decisions have accessible non-colour verdicts", () => {
  for (const verdict of ["ADMIT", "HOLD", "REJECT"]) it(`m6_task_${verdict.toLowerCase()}_in_accessible_name_and_visible_text`, () => {
    const element = mount(vm(null, [task(verdict, HOSTILE)])), button = taskButton(element);
    expect(name(button)).toContain(verdict);
    if (verdict !== "ADMIT") expect(visibleText(button)).toContain(verdict);
    button.click(); safe(element);
  });
  it("m6_hostile_reason_and_path_remain_passive_after_expansion", () => {
    const element = mount(vm({ verdict: "HOLD", summary: HOSTILE }, [task("HOLD", HOSTILE)]));
    expect(name(taskButton(element))).toContain("HOLD");
    taskButton(element).click(); safe(element);
    taskButton(element).click(); safe(element);
  });
  it("m6_admit_task_reuses_existing_done_fill_even_while_work_is_pending", () => {
    loadStyles();
    const completed = task(); completed.state = "done";
    completed.microtasks = completed.microtasks.map(micro => ({ ...micro, state: "done" as const }));
    const reference = taskButton(mount(vm(null, [completed])));
    expect(donePaint(reference).length, "positive done-fill reference must be observable").toBeGreaterThan(0);
    const target = taskButton(mount(vm(null, [task("ADMIT")])));
    expect(name(target)).toContain("ADMIT");
    expect(donePaint(target).length).toBeGreaterThan(0);
  });
  for (const verdict of ["ADMIT", "OK"]) it(`m6_result_${verdict.toLowerCase()}_uses_done_fill`, () => {
    loadStyles();
    const element = mount(vm({ verdict, summary: "Successful result" }));
    expect(visibleText(element)).toContain(verdict);
    expect(donePaint(element).length, "successful result reuses the existing done theme fill").toBeGreaterThan(0);
  });
});
