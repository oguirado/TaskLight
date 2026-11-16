import { describe, expect, it, vi } from "vitest";
import { computeProgressPct, formatWaitsFor, groupTasksByPhase, renderPlanBand, renderPhaseTaskCards, PLAN_VIEW_LIMITS } from "../../../src/views/plan";
import { activate, all, disclosure, hostile, mount, phases, plan, q, safeDOM, setup, source, step, task, text, visibleText, wall } from "./helpers";

setup();
describe("O1 progress", () => {
  it("O1 published limits are frozen and match the spec", () => {
    expect(PLAN_VIEW_LIMITS).toEqual({ TASKS_MAX: 40, MICRO_MAX: 12, PHASES_MAX: 8, DEPS_MAX: 8,
      EVIDENCE_MAX: 8, TITLE_MAX: 120, STEP_TEXT_MAX: 80, ACCEPT_MAX: 160, OUTCOME_MAX: 240,
      ESTIMATE_MAX: 32, TOOK_MAX: 32, PROGRESS_MIN: 0, PROGRESS_MAX: 100 });
    expect(Object.isFrozen(PLAN_VIEW_LIMITS)).toBe(true);
  });
  it.each([
    [0, 0, 0], [0, 5, 0], [NaN, 5, 0], [3, -1, 0], [10, 4, 100],
    [Infinity, 5, 0], [1, Infinity, 0], [-1, 5, 0], [1, NaN, 0], [1, 4, 25],
  ])("O1 computeProgressPct(%s, %s) = %s", (done, total, expected) => {
    expect(computeProgressPct(done, total)).toBe(expected);
  });
  it("O1 empty plan band shows 0% rather than supplied progress", () => {
    const root = renderPlanBand(document, plan({ doneCount: 0, totalCount: 0, progressPct: 99 }));
    expect(text(q(root, ".progress"))).toContain("0%");
  });
});
describe("O2 plan and task anatomy", () => {
  it("O2 band includes ordered active phases, computed progress, agents, brief and findings", () => {
    const p = plan(); const root = renderPlanBand(document, p);
    for (const s of [p.title, "Discover", "Build", p.brief!, p.conformanceFindings![0]!]) expect(text(root)).toContain(s);
    expect(text(root).indexOf("Discover")).toBeLessThan(text(root).indexOf("Build"));
    expect(text(q(root, ".progress"))).toContain("25%");
    expect(all(root, '[aria-current="step"], [data-active="true"]').some(n => text(n).includes("Build"))).toBe(true);
    const dots = all(root, ".agent-dot"); expect(dots).toHaveLength(2);
    expect(dots[0]!.outerHTML === dots[1]!.outerHTML).toBe(false);
  });
  it("O2 band appears above grouped task cards in mountWall", () => {
    const expected = renderPlanBand(document, plan());
    const { host } = mount(); const card = q(host, ".task");
    expect(text(host)).toContain(plan().title);
    const title = all(host, "*").find(e => e.childElementCount === 0 && text(e) === plan().title);
    expect(title).toBeDefined();
    expect(title!.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(text(expected)).toContain(plan().title);
    expect(text(host)).toContain("Discover"); expect(text(host)).toContain("Build");
  });
  it("O2 empty tasks retain phase chips without fabricated cards", () => {
    const root = renderPhaseTaskCards(document, groupTasksByPhase([], phases));
    expect(all(root, ".task")).toHaveLength(0);
    const band = renderPlanBand(document, plan());
    for (const p of phases) expect(text(band)).toContain(p.label);
  });
  it("O2 declared phase order and trailing unknown/unassigned group preserve tasks", () => {
    const tasks = [task({ id: "T01", phaseId: "build" }), task({ id: "T02", phaseId: "unknown" }),
      task({ id: "T03", phaseId: "discover" }), task({ id: "T04", phaseId: "" })];
    const groups = groupTasksByPhase(tasks, phases);
    expect(groups.slice(0, 2).map(g => g.phaseId)).toEqual(["discover", "build"]);
    expect(groups.at(-1)!.label).toMatch(/Other|Unassigned/i);
    expect(groups.at(-1)!.tasks.map(t => t.id)).toEqual(["T02", "T04"]);
    expect(groups.flatMap(g => g.tasks).map(t => t.id).sort()).toEqual(tasks.map(t => t.id).sort());
  });
  it.each(["on_track", "drift", "needs_user"] as const)("O2 task states and %s verdict reason/source", verdict => {
    const tasks = [task({ status: "running", nanoVerdict: { verdict, reason: "Review result", source } }),
      task({ id: "T02", taskId: "T02", status: "blocked", blockedReason: "Missing permission" }),
      task({ id: "T03", taskId: "T03", waitsFor: ["T01"], steps: [{ label: "Waiting microtask", state: "pending" }] }),
      task({ id: "T04", taskId: "T04", status: "done" })];
    const root = renderPhaseTaskCards(document, groupTasksByPhase(tasks, phases));
    const cards = all(root, ".task"); expect(cards).toHaveLength(4);
    for (const s of ["T01", "Build release", "implementation", "builder", "20 min", "Review result", "Missing permission", "Waits for T01"]) expect(text(root)).toContain(s);
    expect(text(q(cards[0]!, ".status"))).toMatch(/running|progress|active/i);
    expect(text(q(cards[1]!, ".status"))).toMatch(/blocked/i);
    expect(cards[2]!.getAttribute("data-ready")).toBe("false");
    expect(text(q(cards[3]!, ".status"))).toMatch(/done/i);
    expect(text(root).toLowerCase().replaceAll("_", " ")).toContain(verdict.replaceAll("_", " "));
    expect(cards[0]!.querySelector(".source")).not.toBeNull();
    expect(all(root, ".steps .step-row")).toHaveLength(4);
    safeDOM(root);
  });
  it.each(["device", "cloud", "local", "remote", "rules"] as const)("O2 verdict provenance preserves %s", kind => {
    const root = renderPhaseTaskCards(document, groupTasksByPhase([task({ nanoVerdict: {
      verdict: "on_track", reason: "Reviewed", source: { kind, ms: 12 },
    } })], phases));
    const labels: Record<typeof kind, RegExp> = { device: /device|nano/i, cloud: /cloud/i, local: /local/i, remote: /remote|network/i, rules: /rules/i };
    expect(all(root, ".source").some(n => labels[kind].test(text(n)) || n.getAttribute("data-source") === kind)).toBe(true);
  });
  it("O2 dependency line handles missing/empty and multiple dependencies", () => {
    expect(formatWaitsFor(undefined)).toBe(""); expect(formatWaitsFor([])).toBe("");
    expect(formatWaitsFor(["T03", "T04"])).toBe("Waits for T03, T04");
  });
  it("O2 plan card opens the task through onOpenTask", () => {
    const onOpenTask = vi.fn();
    const root = renderPhaseTaskCards(document, groupTasksByPhase([task()], phases), { onOpenTask });
    q(root, ".task").click(); expect(onOpenTask).toHaveBeenCalledWith("T01");
  });
});
describe("O3 outcome disclosure", () => {
  it.each(["click", "Enter", " "])("O3 %j expands and collapses done outcome with evidence/source and announcements", method => {
    const announce = vi.fn(); const onToggleMicroDetail = vi.fn();
    const root = renderPhaseTaskCards(document, groupTasksByPhase([task()], phases), { announce, onToggleMicroDetail });
    document.body.append(root); const row = disclosure(root);
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(visibleText(root)).not.toContain("Release verified");
    activate(row, method); expect(row.getAttribute("aria-expanded")).toBe("true");
    for (const s of ["Release verified", "reports/check.txt", "src/release.ts"]) expect(visibleText(root)).toContain(s);
    expect(root.querySelector(".source")).not.toBeNull();
    expect(announce).toHaveBeenLastCalledWith("Expanded outcome for T01.M01");
    activate(row, method); expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(visibleText(root)).not.toContain("Release verified");
    expect(announce).toHaveBeenLastCalledWith("Collapsed outcome for T01.M01");
  });
  it("O3 mountWall announces done-detail expansion and collapse politely", () => {
    const reference = renderPhaseTaskCards(document, groupTasksByPhase([task()], phases));
    expect(disclosure(reference).getAttribute("aria-expanded")).toBe("false");
    const { host } = mount();
    disclosure(host).click();
    expect(disclosure(host).getAttribute("aria-expanded")).toBe("true");
    expect(text(q(host, '[aria-live="polite"]'))).toBe("Expanded outcome for T01.M01");
    disclosure(host).click();
    expect(disclosure(host).getAttribute("aria-expanded")).toBe("false");
    expect(text(q(host, '[aria-live="polite"]'))).toBe("Collapsed outcome for T01.M01");
  });
  it.each(["pending", "active", "blocked", "done"] as const)("O3 %s without detail never opens an empty drawer", state => {
    const root = renderPhaseTaskCards(document, groupTasksByPhase([task({ steps: [{ label: "No detail", state }] })], phases));
    for (const row of all(root, ".step-row")) row.click();
    expect(root.querySelector('[aria-expanded="true"]')).toBeNull();
  });
});
describe("O8 bounded and hostile plan inputs", () => {
  it("O8 title, labels, brief and findings are literal text", () => {
    const root = renderPlanBand(document, plan({ title: hostile, brief: hostile, conformanceFindings: [hostile],
      phases: [{ id: "build", label: hostile, active: true }] }));
    expect(text(root).split(hostile).length - 1).toBeGreaterThanOrEqual(4); safeDOM(root);
  });
  it("O8 task strings and done outcome/evidence contain no executable markup", () => {
    const root = renderPhaseTaskCards(document, groupTasksByPhase([task({ title: hostile, assignee: hostile,
      estimate: hostile, status: "blocked", blockedReason: hostile, nanoVerdict: { verdict: "drift", reason: hostile, source },
      steps: [step({ label: hostile, detail: { outcome: hostile, evidence: [hostile], source } })],
    })], phases));
    disclosure(root).click(); expect(visibleText(root).split(hostile).length - 1).toBeGreaterThanOrEqual(7); safeDOM(root);
  });
  it("O8 fifty tasks and twenty microtasks truncate deterministically across phase groups", () => {
    const tasks = Array.from({ length: 50 }, (_, i) => task({ id: `T${i + 1}`, taskId: `T${i + 1}`,
      phaseId: i % 2 ? "discover" : "build", title: `Task ${i + 1}`,
      steps: Array.from({ length: 20 }, (_, j) => ({ label: `Micro ${j + 1}`, state: "pending" as const })),
    }));
    const render = () => renderPhaseTaskCards(document, groupTasksByPhase(tasks, phases));
    const a = render(); const b = render();
    expect(all(a, ".task")).toHaveLength(PLAN_VIEW_LIMITS.TASKS_MAX);
    for (const card of all(a, ".task")) expect(all(card, ".steps .step-row")).toHaveLength(PLAN_VIEW_LIMITS.MICRO_MAX);
    expect(all(a, ".task").map(text)).toEqual(all(b, ".task").map(text));
  });
  it("O8 fifteen phases retain the declared first eight with overflow tasks in Other", () => {
    const ps = Array.from({ length: 15 }, (_, i) => ({ id: `phase${i}`, label: `Phase ${i}`, active: i === 0 }));
    const root = renderPlanBand(document, plan({ phaseId: "phase0", phases: ps }));
    for (let i = 0; i < 8; i++) expect(text(root)).toContain(`Phase ${i}`);
    for (let i = 8; i < 15; i++) expect(text(root)).not.toContain(`Phase ${i}`);
    const groups = groupTasksByPhase([task({ phaseId: "phase14" })], ps);
    expect(groups.flatMap(g => g.tasks)).toHaveLength(1);
    expect(groups.at(-1)!.label).toMatch(/Other|Unassigned/i);
  });
  it("O8 dependency and evidence lists stop at eight, estimates at thirty-two", () => {
    const deps = Array.from({ length: 10 }, (_, i) => `T${String(i + 2).padStart(2, "0")}`);
    expect(formatWaitsFor(deps)).toBe(`Waits for ${deps.slice(0, 8).join(", ")}`);
    const evidence = Array.from({ length: 10 }, (_, i) => `reports/evidence-${i}.txt`);
    const root = renderPhaseTaskCards(document, groupTasksByPhase([task({ estimate: "e".repeat(80),
      steps: [step({ detail: { outcome: "Verified", evidence, source } })],
    })], phases));
    disclosure(root).click();
    for (const s of evidence.slice(0, 8)) expect(visibleText(root)).toContain(s);
    for (const s of evidence.slice(8)) expect(text(root)).not.toContain(s);
    expect(text(root)).not.toContain("e".repeat(33));
  });
  it("O8 long plan titles stop at the display safety limit", () => {
    const root = renderPlanBand(document, plan({ title: "x".repeat(150) }));
    expect(text(root)).toContain("x".repeat(120)); expect(text(root)).not.toContain("x".repeat(121));
  });
  it.each([null, undefined, {}, { phases: "invalid", agents: null, doneCount: {}, totalCount: [] }])("O8 malformed plan %j does not throw", value => {
    expect(() => renderPlanBand(document, value as unknown as Parameters<typeof renderPlanBand>[1])).not.toThrow();
  });
  it.each([null, undefined, {}])("O8 malformed phase groups %j do not throw", value => {
    expect(() => renderPhaseTaskCards(document, value as unknown as Parameters<typeof renderPhaseTaskCards>[1])).not.toThrow();
  });
  it("O8 malformed nested tasks and details do not throw", () => {
    const groups = [{ phaseId: "build", label: null, active: true, tasks: [null, { steps: [null, { state: "done", detail: { outcome: {}, evidence: [null, {}], source: null } }] }] }];
    expect(() => renderPhaseTaskCards(document, groups as unknown as Parameters<typeof renderPhaseTaskCards>[1])).not.toThrow();
  });
});
