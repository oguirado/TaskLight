import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createAgentStore, toWallVM } from "../../../src/app/agent_store";
import { resolveStarterTemplate } from "../../../src/app/starter_templates";
import type { PlanProjection } from "../../../src/plan";
import { groupTasksByPhase, renderPhaseTaskCards, renderPlanBand } from "../../../src/views/plan";
import { mountWall } from "../../../src/views/index";
import { python, template } from "../u67/helpers";

const events = readFileSync("fixtures/plan/persona_junior.events.jsonl", "utf8")
  .trim().split("\n").map(line => JSON.parse(line));

function replay() {
  const store = createAgentStore({ templates: resolveStarterTemplate });
  for (const event of events) expect(store.ingest(event), event.id).toBe(true);
  return store;
}

it("folds the completed MCP microtask and matches Python task states and rollup", () => {
  const expected = python<PlanProjection>([
    "import json, sys", "from bridge.plan.fold import fold_plan",
    "x = json.load(sys.stdin)",
    "print(json.dumps(fold_plan(x['events'], templates={x['template']['id']: x['template']})))",
  ].join("\n"), { events, template: template() });
  expect(expected.tasks[0]!.microtasks[0]!.state).toBe("done");
  expect(expected.rollup.micro_done).toBe(1);
  const actual = replay().plan("demo")!.projection;
  expect(actual.tasks[0]!.microtasks[0]!.state).toBe("done");
  expect(actual.rollup.micro_done).toBe(1);
  expect(actual.tasks).toEqual(expected.tasks);
  expect(actual.rollup).toEqual(expected.rollup);
  expect(actual.rejected).toEqual(expected.rejected);
});

it("shows completion and progress after replay and excludes the microtask from Agenda Next", () => {
  const store = replay();
  const vm = toWallVM(store.states(), new Map(), {
    nowMs: events.at(-1)!.ts,
    model: { state: "ready", label: "Test" }, network: "online",
  }, store.plans());
  const task = vm.tasks.find(task => task.taskId === "T01")!;
  expect(task.steps.find(step => step.microId === "T01.M01")!.state).toBe("done");
  expect(vm.plan!.progressPct).toBeGreaterThan(0);
  expect(vm.agenda.find(group => group.group === "Next")!.items
    .some(item => item.microId === "T01.M01")).toBe(false);
  const cards = renderPhaseTaskCards(document, groupTasksByPhase(vm.tasks, vm.plan!.phases));
  expect(cards.querySelector('[data-micro-id="T01.M01"]')!.closest(".step")!
    .getAttribute("data-state")).toBe("done");
  const band = renderPlanBand(document, vm.plan!);
  expect(Number(band.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")))
    .toBeGreaterThan(0);
});

it("updates the mounted wall and Agenda as the real completion event arrives", () => {
  const store = createAgentStore({ templates: resolveStarterTemplate });
  const completion = events.findIndex(event => event.op?.kind === "micro.set");
  expect(completion).toBeGreaterThan(0);
  for (const event of events.slice(0, completion)) expect(store.ingest(event)).toBe(true);
  const vm = () => toWallVM(store.states(), new Map(), {
    nowMs: events.at(-1)!.ts,
    model: { state: "ready" as const, label: "Test" }, network: "online" as const,
  }, store.plans());
  const label = vm().tasks.find(task => task.taskId === "T01")!.steps[0]!.label;
  const host = document.createElement("div");
  const handle = mountWall(host, vm());
  try {
    handle.update({ ...vm(), view: "agenda" });
    expect(host.querySelector(".agenda-next")!.textContent).toContain(label);
    for (const event of events.slice(completion)) expect(store.ingest(event)).toBe(true);
    handle.update({ ...vm(), view: "agenda" });
    expect(host.querySelector(".agenda-next")!.textContent).not.toContain(label);
    handle.update(vm());
    expect(host.querySelector('[data-micro-id="T01.M01"]')!.closest(".step")!
      .getAttribute("data-state")).toBe("done");
    expect(host.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("10");
  } finally { handle.destroy(); }
});
