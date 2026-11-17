import { describe, expect, it, vi } from "vitest";
import { PLAN_VIEW_LIMITS } from "../../../src/views/plan";
import type { StepVM, TaskVM } from "../../../src/views/types";
import { elementsAfterOpaqueArticlePruning } from "../u153/pruning_fixture";
import { agent, task as planTask, viewModel } from "../u136/fixtures";
import { frozenPlan, swarmVM, wallVM } from "../u138/helpers";
import {
  LABEL, TITLE, accessibleName, activate, card, completionRun, controlledPanel, description, deterministic,
  expectIndependentStates, expectReadOnlyDetail, mount, mountVM, q, render, rows, task, titleControl, visible, visibleText,
} from "./helpers";

deterministic();
const ownerVM = () => viewModel([agent({ harness: "Harness A", tasks: [planTask("T01")] })]);

describe("U148 A1-A3 task card and title", () => {
  it.each(["renderer", "mounted Wall"] as const)("A1 %s retains a named non-article task identity", mode => {
    const root = mode === "renderer" ? render() : mount().host;
    const node = card(root);
    expect(node.tagName.toLowerCase(), "Opaque article roots hide nested controls").not.toBe("article");
    expect(node.getAttribute("role")?.split(/\s+/) ?? []).not.toContain("article");
    expect(node.classList.contains("task")).toBe(true);
    expect(node.dataset.taskId).toBe("T01");
    const named = node.hasAttribute("aria-label") || node.hasAttribute("aria-labelledby");
    expect(named, "The non-article container must be explicitly named").toBe(true);
    expect(accessibleName(node)).toContain("T01");
  });

  it("A2 header reads id then title then persisted done/total then ring beside one owner chip", () => {
    const root = render([task()], ownerVM()), header = q(card(root), ".task-head");
    const id = q(header, ".task-id"), title = q(header, ".task-title");
    const [countStart, countEnd] = completionRun(header, 1, 3);
    const ring = q(header, ".status-icon"), chip = q(header, ".wall-agent-chip");
    for (const [before, after] of [[id, title], [title, countStart], [countEnd, ring], [ring, chip]] as const) {
      expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    }
    expect(header.querySelectorAll(".wall-agent-chip")).toHaveLength(1);
    expect(visibleText(header).match(/executor-a/g)).toHaveLength(1);
    let common = ring.parentElement!;
    while (!common.contains(chip) && common !== header) common = common.parentElement!;
    expect(common.contains(chip), "Ring and owner must share their header group").toBe(true);
    const siblings = [...common.children];
    const ringSibling = siblings.find(node => node === ring || node.contains(ring));
    const ownerSibling = siblings.find(node => node === chip || node.contains(chip));
    expect(siblings.indexOf(ownerSibling!)).toBe(siblings.indexOf(ringSibling!) + 1);
  });

  it("A2 completion count uses done state rather than volatile done activity", () => {
    const input = task({ steps: [
      { microId: "T01.M01", label: LABEL, state: "done", activity: { state: "unknown" } },
      { microId: "T01.M02", label: LABEL, state: "pending", activity: { state: "done" } },
    ] });
    completionRun(q(card(render([input])), ".task-head"), 1, 2);
  });

  it.each(["click", "Enter", " "] as const)("A3 mounted title %j opens read-only task detail without chat", method => {
    const onOpenTask = vi.fn(), onOpenMessages = vi.fn();
    const { host } = mount([task()], ownerVM(), { onOpenTask, onOpenMessages });
    const control = titleControl(card(host));
    expect(accessibleName(control)).toContain(TITLE);
    expect(control.getAttribute("aria-expanded")).not.toBe("true");
    expect(control.closest("details")?.hasAttribute("open") ?? false).toBe(false);
    const previouslyVisible = new Set([...document.querySelectorAll<HTMLElement>("*")].filter(visible));
    activate(control, method);
    expectReadOnlyDetail(control, host, previouslyVisible);
    expect(onOpenTask).not.toHaveBeenCalled(); expect(onOpenMessages).not.toHaveBeenCalled();
  });

  it("A3 identical task titles have distinct detail-control names carrying task identity", () => {
    const root = render([task(), task({ id: "T02", taskId: "T02",
      steps: [{ microId: "T02.M01", label: LABEL, state: "pending" }] })]);
    const controls = ["T01", "T02"].map(id => titleControl(card(root, id)));
    const names = controls.map(accessibleName);
    expect(new Set(names).size).toBe(2);
    names.forEach((name, index) => { expect(name).toContain(`T0${index + 1}`); expect(name).toContain(TITLE); });
  });
});

describe("U148 A4-A6 microtask identity and opaque-article pruning", () => {
  it("A4 both disclosure and plain microtask branches expose exact dotted IDs", () => {
    const list = rows(card(render()));
    expect(list).toHaveLength(3);
    expect(list[0]!.matches("button[aria-expanded]")).toBe(true);
    expect(list[1]!.hasAttribute("aria-expanded")).toBe(false);
    expect(list.map(node => node.getAttribute("data-micro-id"))).toEqual(["T01.M01", "T01.M02", "T01.M03"]);
  });

  it("A5 repeated microtask labels have distinct names carrying their IDs across both branches", () => {
    const list = rows(card(render()));
    expect(list).toHaveLength(3);
    const names = list.map(accessibleName);
    list.forEach((_node, index) => {
      expect(names[index]).toContain(`T01.M0${index + 1}`);
      expect(names[index]).toContain(LABEL);
    });
    expect(new Set(names).size).toBe(3);
  });

  it("A5 same-state duplicate labels on separate tasks remain independently named", () => {
    const first = task({ steps: [{ microId: "T01.M01", label: LABEL, state: "pending", accept: "Check first" }] });
    const second = task({ id: "T02", taskId: "T02", steps: [{
      microId: "T02.M01", label: LABEL, state: "pending", accept: "Check second",
    }] });
    const root = render([first, second]);
    const names = ["T01", "T02"].map(id => accessibleName(q(card(root, id), "button.step-row")));
    expect(new Set(names).size, "Activity and label are identical; identity must distinguish controls").toBe(2);
    expect(names[0]).toContain("T01.M01"); expect(names[1]).toContain("T02.M01");
  });

  it.each(["disclosure", "plain"] as const)("A5 %s name stays stable while Working moves to the description", branch => {
    const create = (state: "working" | "waiting") => {
      const step: StepVM = { microId: "T01.M01", label: LABEL, state: "active", activity: { state },
        ...(branch === "disclosure" ? { accept: "Keep replay identity" } : {}) };
      return rows(card(render([task({ steps: [step] })])))[0]!;
    };
    const working = create("working"), waiting = create("waiting");
    expect(accessibleName(working)).toBe(accessibleName(waiting));
    expect(accessibleName(working)).toContain("T01.M01"); expect(accessibleName(working)).toContain(LABEL);
    expect(accessibleName(working)).not.toMatch(/Working|Waiting/);
    expect(description(working)).toContain("Working"); expect(description(waiting)).toContain("Waiting");
  });

  it("A6 pruning preserves every existing microtask disclosure on the mounted Wall", () => {
    const { host } = mount(), root = card(host);
    const disclosures = root.querySelectorAll("button.step-row[aria-expanded]");
    expect(disclosures.length, "Nonempty fixture is a precondition; empty output cannot pass").toBeGreaterThan(0);
    const pruned = elementsAfterOpaqueArticlePruning(host);
    for (const disclosure of disclosures) expect(pruned).toContain(disclosure);
  });

  it("A6 pruning preserves the task-title detail control", () => {
    const { host } = mount(), control = titleControl(card(host));
    expect(elementsAfterOpaqueArticlePruning(host)).toContain(control);
  });

  it("A6 negative calibration: opaque article pruning actually removes nested disclosures", () => {
    const article = document.createElement("article"), button = document.createElement("button");
    article.append(button);
    const pruned = elementsAfterOpaqueArticlePruning(article);
    expect(pruned).toContain(article); expect(pruned).not.toContain(button);
  });

  it.each(["click", "Enter", " "] as const)("A6 mounted dotted-ID disclosure %j reveals local evidence and never chat", method => {
    const onOpenTask = vi.fn(), onOpenMessages = vi.fn(), onToggleMicroDetail = vi.fn();
    const { host } = mount([task()], ownerVM(), { onOpenTask, onOpenMessages, onToggleMicroDetail });
    const root = card(host), control = q(root, "button.step-row[aria-expanded]");
    const panel = controlledPanel(control);
    expect(panel.id).toBe("step-T01.M01"); expect(visible(panel)).toBe(false);
    activate(control, method);
    expect(control.getAttribute("aria-expanded")).toBe("true"); expect(visible(panel)).toBe(true);
    expect(visibleText(panel)).toContain("Release verified");
    expect(visibleText(panel)).toContain("reports/check.txt");
    expect(onToggleMicroDetail).toHaveBeenCalledExactlyOnceWith("T01", 0);
    activate(control, method);
    expect(control.getAttribute("aria-expanded")).toBe("false"); expect(visible(panel)).toBe(false);
    root.click(); q(root, ".task-title").click();
    expect(onOpenTask).not.toHaveBeenCalled(); expect(onOpenMessages).not.toHaveBeenCalled();
  });

  it("A6 identical labels and dotted IDs disclose only their own task's panel", () => {
    const duplicate = task({ id: "T02", taskId: "T02", steps: [{
      microId: "T02.M01", label: LABEL, state: "done", accept: "Second acceptance",
      detail: { outcome: "Second outcome", evidence: ["reports/second.txt"], source: { kind: "rules", ms: 0 } },
    }] });
    const { host } = mount([task(), duplicate]);
    const first = q(card(host), "button.step-row"), second = q(card(host, "T02"), "button.step-row");
    const firstPanel = controlledPanel(first), secondPanel = controlledPanel(second);
    expect(firstPanel).not.toBe(secondPanel);
    activate(second, "Enter");
    expect(visible(secondPanel)).toBe(true); expect(visibleText(secondPanel)).toContain("Second outcome");
    expect(first.getAttribute("aria-expanded")).toBe("false"); expect(visible(firstPanel)).toBe(false);
  });

  it("A6 preserved card-background activation is read-only with a live legacy callback", () => {
    const onOpenTask = vi.fn(), onOpenMessages = vi.fn();
    const { host } = mount([task()], ownerVM(), { onOpenTask, onOpenMessages });
    card(host).click();
    expect(onOpenTask).not.toHaveBeenCalled(); expect(onOpenMessages).not.toHaveBeenCalled();
    expect(card(host).querySelector(".task-chat")).toBeNull();
  });
});

describe("U148 A7-A8 task truth and adversarial lifecycle", () => {
  it("A7 blockers preserve upstream identity, unassigned and Missing task without cross-task leakage", () => {
    const p = frozenPlan(), root = mountVM(wallVM(p, swarmVM(p)));
    expect(visibleText(card(root))).toContain("Waiting on T02 · executor-a");
    expect(visibleText(card(root))).not.toContain("T404");
    expect(visibleText(card(root, "T07"))).toContain("Waiting on T08 · unassigned");
    expect(visibleText(card(root, "T09"))).toContain("Waiting on T404 · Missing task");
    expect(visibleText(card(root, "T03"))).toContain("Waiting on T90 · executor-c");
    expect(visibleText(card(root, "T02"))).not.toContain("Waiting on T90");
  });

  it("A7 Waiting task ring remains separate from its Working multi-task owner chip", () => {
    const p = frozenPlan(), root = mountVM(wallVM(p, swarmVM(p)));
    expectIndependentStates(card(root, "T03"));
  });

  it.each([["task", "working"], ["agent", "waiting"]] as const)(
    "A8 negative calibration rejects collapsing %s state to %s", (side, state) => {
      const p = frozenPlan(), root = mountVM(wallVM(p, swarmVM(p)));
      const bad = card(root, "T03").cloneNode(true) as HTMLElement;
      expectIndependentStates(bad);
      if (side === "task") q(bad, ".status-icon").setAttribute("data-activity", state);
      else q(bad, ".wall-agent-chip").textContent = "executor-a · Harness A · Waiting";
      expect(() => expectIndependentStates(bad)).toThrow();
    });

  it.each([["T04", "Failed"], ["T05", "Finished"]] as const)(
    "A8 %s fresh working activity never replaces %s lifecycle", (id, lifecycle) => {
      const p = frozenPlan(), admitted = swarmVM(p);
      // Hostile input at the admitted view seam: terminal lifecycle plus fresh Working evidence.
      // The projection's own terminal normalization is outside the plan-card surface.
      const swarm = { ...admitted, agents: admitted.agents.map(owner => owner.tasks.some(t => t.id === id)
        ? { ...owner, activity: "working" as const } : owner) };
      const vm = wallVM(p, swarm);
      vm.tasks = vm.tasks.map(t => t.taskId === id ? { ...t, activity: { state: "working" as const } } : t);
      const root = mountVM(vm);
      const node = card(root, id), chip = q(node, ".wall-agent-chip");
      expect(visibleText(chip)).toContain(lifecycle); expect(visibleText(chip)).not.toContain("Working");
      expect(q(node, ".status-icon").dataset.activity).toBe("working");
    });
});

describe("U148 A9 carried dependency and question debt", () => {
  it("A9 dependency owner lines obey the published DEPS_MAX bound", () => {
    const waits = Array.from({ length: PLAN_VIEW_LIMITS.DEPS_MAX + 3 }, (_, i) => `T${10 + i}`);
    const node = card(render([task({ waitsFor: waits })], ownerVM()));
    const lines = [...node.querySelectorAll(".waits-for")];
    expect(lines).toHaveLength(PLAN_VIEW_LIMITS.DEPS_MAX);
    waits.slice(0, PLAN_VIEW_LIMITS.DEPS_MAX).forEach(id => expect(visibleText(node)).toContain(`Waiting on ${id} · unassigned`));
    waits.slice(PLAN_VIEW_LIMITS.DEPS_MAX).forEach(id => expect(visibleText(node)).not.toContain(`Waiting on ${id}`));
  });

  it("A9 asStr normalization precedes dependency ownership lookup", () => {
    const upstream = planTask("7", { assignee: "executor-seven" });
    const swarm = viewModel([agent({ agent: "executor-seven", tasks: [upstream] })]);
    const waits = [7] as unknown as readonly string[];
    expect(visibleText(card(render([task({ waitsFor: waits })], swarm)))).toContain("Waiting on 7 · executor-seven");
  });

  it("A9 non-string dependency objects remain passive rather than becoming fabricated IDs", () => {
    const waits = [null, undefined, {}, "T02"] as unknown as readonly string[];
    const node = card(render([task({ waitsFor: waits })], ownerVM()));
    expect(visibleText(node)).not.toMatch(/Waiting on (?:null|undefined|\[object Object\])/);
    expect(visibleText(node)).toContain("Waiting on T02 · unassigned");
  });

  it("A9 empty-string upstream owner renders unassigned", () => {
    const downstream = task({ waitsFor: ["T02"] });
    const vm = viewModel([agent({ tasks: [planTask("T01"), planTask("T02", { assignee: "" })],
      waiting_on: [{ task_id: "T01", upstream_id: "T02", owner: "", missing: false }] })]);
    expect(visibleText(card(render([downstream], vm)))).toContain("Waiting on T02 · unassigned");
  });

  it.each([undefined, null, false, 0, "Old question"])(
    "A9 non-object operatorQuestion %j cannot manufacture Needs you", raw => {
      const input = { ...task({ activity: { state: "waiting" } }), operatorQuestion: raw } as unknown as TaskVM;
      const node = card(render([input], ownerVM()));
      expect(q(node, ".status-icon").dataset.activity).toBe("waiting");
      expect(node.querySelector(".operator-question")).toBeNull();
    });

  it("A9 a valid operatorQuestion preserves Needs you and its literal read-only prompt", () => {
    const input = task({ operatorQuestion: { eventId: "question-1", text: "Approval <pending> & unchanged" } });
    const node = card(render([input], ownerVM()));
    expect(q(node, ".status-icon").dataset.activity).toBe("needs_you");
    expect(visibleText(q(node, ".operator-question"))).toContain("Approval <pending> & unchanged");
    expect(node.querySelector("input,textarea,[contenteditable='true'],script,img")).toBeNull();
  });
});
