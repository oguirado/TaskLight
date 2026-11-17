import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountWall } from "../../../src/views";
import type { WallMountVM } from "../../../src/views";
import type { PlanVM, TaskVM } from "../../../src/views/types";
import { createModelSheet } from "../../../src/ui/model_selector";

const selectors = [
  ".app[data-view][data-workspace]", "button[data-nav]", "button[data-wsid]",
  "[data-task-id]", "[data-task-vm-id]", "button.step-row[data-micro-id]",
  "[data-phase-id]", "[data-plan-id]", 'button[aria-controls="model-sheet"]', '[id="step-T01.M01"]',
] as const;

function contract(): string {
  try { return readFileSync(resolve(__dirname, "../../../docs/MACHINE_OPERABILITY.md"), "utf8"); }
  catch (error) {
    // Missing required documentation is an assertion failure, not a module/file-loading error.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

describe("U153 A1-A3/A7 machine-operability documentation", () => {
  it.each(selectors)("A1 documents the exact public hook %s", selector => {
    expect(contract(), `docs/MACHINE_OPERABILITY.md must document ${selector}`).toContain(selector);
  });
  it("A2 explicitly states that hooks are not authentication", () => {
    expect(contract()).toMatch(/\bhooks?\b[^.!?]{0,180}\b(?:not|never|no|aren['’]t|isn['’]t)\b[^.!?]{0,80}\bauthenticat\w*/i);
  });
  it("A3 distinguishes raw CDP, pruned and AT-SPI receipts as separate evidence", () => {
    const text = contract();
    expect(text).toMatch(/\braw[\s-]+CDP\b/i);
    expect(text).toMatch(/\bpruned\b/i);
    expect(text).toMatch(/\bAT[\s-]SPI\b/i);
    expect(text).toMatch(/\breceipts?\b/i);
    expect(text).toMatch(/\b(?:separate\w*|distinct|independent\w*)\b[\s\S]{0,160}\breceipts?\b|\breceipts?\b[\s\S]{0,160}\b(?:separate\w*|distinct|independent\w*)\b/i);
  });
  it("A7 reports an empty accessibility tree as a failed precondition", () => {
    const text = contract().replace(/_/g, " ");
    expect(text).toMatch(/\bempty\b[^.!?]{0,100}\b(?:accessibility|AX)\b|\b(?:accessibility|AX)\b[^.!?]{0,100}\bempty\b/i);
    expect(text).toMatch(/\b(?:fail\w*|stop\w*|unmet)\b[^.!?]{0,100}\bprecondition\b|\bprecondition\b[^.!?]{0,100}\b(?:fail\w*|stop\w*|unmet)\b/i);
  });
});

function task(workspace: string): TaskVM {
  return {
    id: `plan:${workspace}:T01`, workspace, project: "contract-fixture", accent: "iris",
    title: "Repeated task title", summary: "Read-only fixture", status: "running", attention: "none",
    updated: "", source: { kind: "rules", ms: 0 }, next: "Inspect", taskId: "T01", phaseId: "P01",
    steps: [{ label: "Repeated step label", state: "active", microId: "T01.M01",
      detail: { outcome: `Evidence for ${workspace}`, evidence: ["docs/HEADLESS.md"], source: { kind: "rules", ms: 0 } } }],
  };
}
function plan(workspace: string): PlanVM {
  return {
    id: `plan-${workspace}`, title: `Plan ${workspace}`, templateId: "fixture", templateHash: "fixture",
    phaseId: "P01", phases: [{ id: "P01", label: "Build", active: true }],
    doneCount: 0, totalCount: 1, progressPct: 0, agents: [],
  };
}
const cleanups: (() => void)[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); });
afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers();
});

function mount() {
  const host = document.createElement("div"), modelsHost = document.createElement("div");
  document.body.append(host, modelsHost);
  const sheet = createModelSheet({ doc: document, mount: modelsHost, announcer: { say: vi.fn(), flushedCount: () => 0 }, onIntent: vi.fn() });
  let vm: WallMountVM = {
    now: "", model: { state: "ready", label: "On-device ready" }, network: "online",
    workspaces: [
      { id: "alpha", name: "Alpha", lens: "dev", accent: "iris" },
      { id: "beta", name: "Beta", lens: "dev", accent: "sky" },
    ], workspace: "alpha", view: "wall", archiveScope: "workspace", tasks: [task("alpha"), task("beta")],
    agenda: [], archive: [], plan: plan("alpha"),
  };
  const handle = mountWall(host, vm, {
    onOpenModels: trigger => sheet.open(trigger),
    onWorkspace: workspace => { vm = { ...vm, workspace, plan: plan(workspace) }; handle.update(vm); },
  });
  cleanups.push(() => { handle.destroy(); sheet.dispose(); });
  return { host, sheet, handle, vm };
}
function one(root: ParentNode, selector: string): HTMLElement {
  const found = root.querySelectorAll<HTMLElement>(selector);
  expect(found.length, `Expected a unique target for ${selector}`).toBe(1);
  return found[0]!;
}
function activeApp(host: ParentNode, workspace: string): HTMLElement {
  const app = one(host, selectors[0]);
  expect(app.dataset.view).toBe("wall"); expect(app.dataset.workspace).toBe(workspace);
  return app;
}
const ariaIdrefs = [
  "aria-activedescendant", "aria-controls", "aria-describedby", "aria-details",
  "aria-errormessage", "aria-flowto", "aria-labelledby", "aria-owns",
] as const;
function assertAriaReferences(doc: Document): void {
  const ids = [...doc.querySelectorAll<HTMLElement>("[id]")];
  for (const element of doc.querySelectorAll("*")) {
    for (const attr of ariaIdrefs) {
      if (!element.hasAttribute(attr)) continue;
      const value = element.getAttribute(attr)!.trim();
      expect(value, `${attr} must not be empty`).not.toBe("");
      for (const id of value.split(/\s+/)) {
        expect(ids.filter(target => target.id === id).length, `${attr}=${id} must resolve exactly once`).toBe(1);
      }
    }
  }
}
function assertTargets(app: HTMLElement, workspace: string): void {
  one(app, 'button[data-nav="wall"]');
  one(app, `button[data-wsid="${workspace}"]`);
  const card = one(app, '.task[data-task-id="T01"]');
  expect(one(app, `.task[data-task-vm-id="plan:${workspace}:T01"]`)).toBe(card);
  const micro = one(card, 'button.step-row[data-micro-id="T01.M01"]');
  one(app, 'button[data-phase-id="P01"]');
  one(app, `[data-plan-id="plan-${workspace}"]`);
  one(app, 'button[aria-controls="model-sheet"]');
  const panel = one(card, '[id="step-T01.M01"]');
  expect(micro.getAttribute("aria-controls")).toBe(panel.id);
}

describe("U153 A4-A6 existing renderer machine hooks", () => {
  it("A4 all documented hooks identify one qualified target in the active workspace", () => {
    const { host } = mount(); assertTargets(activeApp(host, "alpha"), "alpha");
  });
  it("A5 every ARIA ID reference resolves before and after opening the real Models sheet", () => {
    const { host, sheet } = mount();
    assertAriaReferences(document);
    one(host, 'button[aria-controls="model-sheet"]').click();
    expect(sheet.isOpen()).toBe(true); assertAriaReferences(document);
    sheet.close(); assertAriaReferences(document);
  });
  it("A6 hostile duplicate T01 in two workspaces is reacquired after each workspace switch", () => {
    const { host, vm } = mount();
    expect(vm.tasks.filter(value => value.taskId === "T01")).toHaveLength(2);
    for (const workspace of ["alpha", "beta", "alpha"]) {
      one(host, `button[data-wsid="${workspace}"]`).click();
      const app = activeApp(host, workspace);
      assertTargets(app, workspace); assertAriaReferences(document);
      expect(app.querySelector(`.task[data-task-vm-id="plan:${workspace === "alpha" ? "beta" : "alpha"}:T01"]`)).toBeNull();
      expect(one(app, '[id="step-T01.M01"]').textContent).toContain(`Evidence for ${workspace}`);
    }
  });
  it("A4/A5 negative calibration: duplicate selector targets and broken or duplicate ARIA IDs are rejected", () => {
    const { host } = mount(); const app = activeApp(host, "alpha");
    const card = one(app, '.task[data-task-id="T01"]');
    const duplicate = card.cloneNode(true) as HTMLElement; card.parentElement!.append(duplicate);
    expect(() => one(app, '.task[data-task-id="T01"]')).toThrow();
    expect(() => assertAriaReferences(document)).toThrow(); duplicate.remove();
    const micro = one(app, 'button.step-row[data-micro-id="T01.M01"]');
    micro.setAttribute("aria-controls", "missing-detail");
    expect(() => assertAriaReferences(document)).toThrow();
  });
});
