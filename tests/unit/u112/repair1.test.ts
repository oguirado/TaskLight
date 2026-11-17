import { describe, expect, it } from "vitest";
import { deriveSwarmViewModel } from "../../../src/app/swarm_vm";
import { renderSwarmView } from "../../../src/views/swarm";
import type { PlanTask } from "../../../src/plan/types";
import type { RoomEvent } from "../../../src/agents/types";
import { deterministic, event, freeze, input, projection, row, task, text } from "./fixtures";

deterministic();

function count(events: readonly RoomEvent[]): number {
  return row(deriveSwarmViewModel(freeze(input({ events })))).unanswered_questions;
}

describe("U112 repair: answers in loaded history", () => {
  it.each([false, true])("clears a follow-up with a trimmed ancestor, through ack: %s", throughAck => {
    const question = event(1, { re: "trimmed-ancestor" });
    const ack = event(2, { act: "ack", agent: "executor-a", re: question.id });
    const answer = event(3, { act: "answer", agent: "executor-a", re: throughAck ? ack.id : question.id });
    expect(count([question, ack])).toBe(1);
    expect(count([question, ack, answer])).toBe(0);
  });

  it("clears a reached question even when its older ancestor is outside the room", () => {
    const ancestor = event(1, { room: "other" });
    const question = event(2, { re: ancestor.id });
    const answer = event(3, { act: "answer", agent: "executor-a", re: question.id });
    expect(count([ancestor, question, answer])).toBe(0);
  });

  it("does not clear through a dangling or foreign-room link before the question", () => {
    const question = event(1);
    const link = event(2, { act: "ack", room: "other", re: question.id });
    const answer = event(3, { act: "answer", agent: "executor-a", re: link.id });
    expect(count([question, answer])).toBe(1);
    expect(count([question, link, answer])).toBe(1);
  });

  it("does not clear a reached question when the chain is cyclic", () => {
    const question = event(1, { re: event(2).id });
    const link = event(2, { act: "ack", re: question.id });
    const answer = event(3, { act: "answer", agent: "executor-a", re: question.id });
    expect(count([question, link, answer])).toBe(1);
  });

  it.each(["ack", "wrong-author", "foreign-room"])("does not clear a trimmed follow-up with %s", invalid => {
    const question = event(1, { re: "trimmed-ancestor" });
    const answer = event(2, { act: invalid === "ack" ? "ack" : "answer",
      agent: invalid === "wrong-author" ? "executor-b" : "executor-a",
      room: invalid === "foreign-room" ? "other" : "demo", re: question.id });
    expect(count([question, answer])).toBe(1);
  });
});

describe("U112 repair: malformed ownership", () => {
  it.each([false, true])("ignores an omitted assignee without phantom membership, with valid peer: %s", withPeer => {
    const malformed: PlanTask = JSON.parse(JSON.stringify(task("T00")), (key, value) =>
      key === "assignee" ? undefined : value);
    expect(Object.hasOwn(malformed, "assignee")).toBe(false);
    const vm = deriveSwarmViewModel(freeze(input({
      projection: projection(withPeer ? [malformed, task()] : [malformed]),
    })));
    expect(vm.agents.map(agent => agent.agent)).toEqual(withPeer ? ["executor-a"] : []);
    const root = renderSwarmView(document, vm);
    expect(text(root)).not.toContain("undefined");
    expect(text(root)).not.toContain("Task T00");
    if (!withPeer) expect(text(root)).toContain("No agents in this room");
  });
});

describe("U112 repair: obsolete block reasons", () => {
  it.each(["done", "cancelled"] as const)("hides stale blockers on %s tasks while retaining the task", state => {
    const vm = deriveSwarmViewModel(freeze(input({ projection: projection([
      task("T01", { state, blocked_reason: "Old block", microtasks: [] }),
    ]) })));
    const root = renderSwarmView(document, vm);
    expect(text(root)).toContain("T01");
    expect(text(root)).toContain(state === "done" ? "Done" : "Cancelled");
    expect(text(root)).not.toContain("Blocked on");
    expect(text(root)).not.toContain("Old block");
  });

  it("retains current blockers when finished owned tasks also have stale reasons", () => {
    const vm = deriveSwarmViewModel(freeze(input({ projection: projection([
      task("T00", { state: "done", blocked_reason: "Old block" }),
      task("T01", { state: "blocked", blocked_reason: "Current block" }),
    ]) })));
    const root = renderSwarmView(document, vm);
    expect(text(root)).toContain("Blocked on");
    expect(text(root)).toContain("Current block");
    expect(text(root)).not.toContain("Old block");
  });
});
