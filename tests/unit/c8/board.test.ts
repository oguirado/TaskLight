import { expect, it } from "vitest";
import { deriveSwarmViewModel } from "../../../src/app/swarm_vm";
import { foldPlan } from "../../../src/plan/reducer";
import { renderSwarmView } from "../../../src/views/swarm";
import { deterministic, NOW } from "../c7/support";
import { replay, trace } from "./support";

deterministic();

function render(mark: Parameters<typeof replay>[1], ordinaryEdit = false) {
  const data = trace();
  const { events, projection: checkpoint } = replay(data, mark, true);
  let projection = checkpoint;
  if (ordinaryEdit) {
    const previous = events.at(-1)!;
    events.push({
      id: "e-ffffffffffffffff", room: previous.room, lamport: previous.lamport + 1,
      ts: previous.ts + 1, act: "op", agent: "orchestrator", text: "",
      op: { kind: "micro.set", op_id: "c8-ordinary-edit", micro_id: "T01.M02", state: "done" },
    });
    projection = foldPlan(events, data.template).projection;
  }
  const board = renderSwarmView(document, deriveSwarmViewModel({
    room: "demo", events, projection, nowMs: NOW, connected: true,
  }));
  document.body.replaceChildren(board);
  const task = [...board.querySelectorAll<HTMLButtonElement>("button[aria-controls]")]
    .find(button => button.textContent?.includes(data.title));
  expect(task, "the unit has an expandable task bubble").toBeDefined();
  const lane = task!.closest(".swarm-lane");
  expect(lane?.querySelector(".swarm-agent-name")?.textContent).toBe("orchestrator");
  task!.click();
  const detail = document.getElementById(task!.getAttribute("aria-controls")!);
  expect(detail?.hidden).toBe(false);
  const rows = [...detail!.querySelectorAll<HTMLElement>(".swarm-microtask")];
  expect(rows.map(row => row.querySelector(".swarm-microtask-title")?.textContent))
    .toEqual(data.steps);
  return { board, task: task!, detail: detail!, rows };
}

function fill(container: HTMLElement, marker: string): number {
  const bubble = container.querySelector<HTMLElement>(marker);
  expect(bubble, "the board renders a progress bubble").not.toBeNull();
  return Number.parseFloat(getComputedStyle(bubble!).getPropertyValue("--swarm-fill"));
}

const unitFill = (unit: HTMLElement) => fill(unit, ".swarm-bubble-task");
const stepFill = (step: HTMLElement) => fill(step, ".swarm-bubble-micro");

it("m6_ordered_bubbles_show_pending_bound_finished_and_accepted_progress", () => {
  const pending = render("pending");
  expect(pending.rows.map(stepFill)).toEqual(Array(7).fill(0));
  expect(unitFill(pending.task)).toBe(0);

  const bound = render("bound");
  expect(bound.rows[0]!.textContent).toContain("worker-diagnose");
  expect(stepFill(bound.rows[0]!)).toBeGreaterThan(0);
  expect(stepFill(bound.rows[0]!)).toBeLessThan(100);
  expect(unitFill(bound.task)).toBe(0);

  const finished = render("finished");
  expect(stepFill(finished.rows[0]!)).toBeLessThan(100);
  expect(unitFill(finished.task)).toBe(0);

  const accepted = render("accepted");
  expect(accepted.rows.map(stepFill)).toEqual([100, 0, 0, 0, 0, 0, 0]);
  expect(unitFill(accepted.task)).toBeCloseTo(100 / 7, 0);

  const ordinaryEdit = render("accepted", true);
  expect(stepFill(ordinaryEdit.rows[1]!)).toBe(0);
  expect(unitFill(ordinaryEdit.task)).toBeCloseTo(100 / 7, 0);
});

it("m6_failed_and_blocked_attempts_are_text_and_hostile_title_is_literal", () => {
  const failed = render("failed");
  expect(failed.detail.textContent).toMatch(/\bfail(?:ed)?\b/i);
  expect(stepFill(failed.rows[1]!)).toBeLessThan(100);

  const held = render("held");
  expect(held.detail.textContent).toMatch(/\b(?:hold|held|blocked)\b/i);
  expect(stepFill(held.rows[1]!)).toBeLessThan(100);
  expect(held.task.textContent).toContain(trace().title);
  for (const board of [failed.board, held.board]) {
    expect(board.querySelector("img, script, [onerror], [onload], [onclick]")).toBeNull();
  }
});

it("m6_repair_restores_the_accepted_prefix_fraction", () => {
  const complete = render("complete");
  expect(unitFill(complete.task)).toBe(100);
  const repaired = render("repaired");
  expect(repaired.rows.map(stepFill)).toEqual([100, 100, 100, 0, 0, 0, 0]);
  expect(unitFill(repaired.task)).toBeCloseTo(300 / 7, 0);
});
