import { describe, expect, it } from "vitest";
import { deriveSwarmViewModel } from "../../../src/app/swarm_vm";
import type { RoomEvent } from "../../../src/agents/types";
import { deterministic, event, freeze, input, projection, row, task } from "./fixtures";

deterministic();
const q = event(1);
const ack = event(2, { act: "ack", agent: "executor-a", re: q.id });
const answer = event(3, { act: "answer", agent: "executor-a", re: ack.id });
function count(events: readonly RoomEvent[]): number {
  return row(deriveSwarmViewModel(freeze(input({ events })))).unanswered_questions;
}
describe("A4 / M7 loaded-history questions", () => {
  it("A4 distinct addressed question IDs count once on duplicate delivery", () => {
    expect(count([q, q, { ...q }, event(4)])).toBe(2);
  });
  it("A4 an addressee's ack alone does not clear a question", () => { expect(count([q, ack])).toBe(1); });
  it("A4 addressee answer referencing its ack clears the question", () => { expect(count([q, ack, answer])).toBe(0); });
  it("A4 direct addressee answer clears the question", () => { expect(count([q, { ...answer, re: q.id }])).toBe(0); });
  it("A4 wrong-author answer through an ack leaves the question unanswered", () => {
    expect(count([q, ack, { ...answer, agent: "executor-b" }])).toBe(1);
  });
  it("A4 foreign-room answer through an ack leaves the question unanswered", () => {
    expect(count([q, ack, { ...answer, room: "other" }])).toBe(1);
  });
  it("A4 a chain crossing a foreign-room intermediary cannot clear the question", () => {
    expect(count([q, { ...ack, room: "other" }, answer])).toBe(1);
  });
  it("A4 dangling references leave the question unanswered", () => {
    expect(count([q, { ...answer, re: "missing-id" }])).toBe(1);
  });
  it.each(["ack", "heartbeat", "handoff", "verdict", "close", "step", "op"] as const)(
    "Amendment B %s is never a clearing act", act => { expect(count([q, { ...answer, act, re: q.id }])).toBe(1); });
  it("A4 cyclic references terminate without clearing an unrelated question", () => {
    const a = event(8, { act: "ack", re: event(9).id });
    const b = event(9, { act: "ack", re: a.id });
    expect(count([q, a, b, { ...answer, re: a.id }])).toBe(1);
  });
  it("A4 self-reference terminates without clearing a question", () => {
    expect(count([q, { ...answer, re: answer.id }])).toBe(1);
  });
  it("A4 finite indirect reference chain is followed without a shallow arbitrary cutoff", () => {
    const chain: RoomEvent[] = [q];
    for (let n = 2; n <= 65; n++) chain.push(event(n, { act: "ack", agent: "executor-a", re: chain.at(-1)!.id }));
    chain.push(event(66, { act: "answer", agent: "executor-a", re: chain.at(-1)!.id }));
    expect(count(chain)).toBe(0);
  });
  it("A4 history arrival order does not change a resolvable chain", () => { expect(count([answer, ack, q])).toBe(0); });
  it("M7 ignores foreign-room questions and unaddressed questions", () => {
    const unaddressed = event(4); delete unaddressed.to;
    expect(count([q, event(5, { room: "other" }), event(6, { to: "executor-b" }), unaddressed])).toBe(1);
  });
  it("M7 duplicate answers and duplicate questions cannot yield a negative count", () => {
    expect(count([q, q, ack, answer, answer, event(7, { act: "answer", agent: "executor-a", re: q.id })])).toBe(0);
  });
  it("M7 questions are attributed independently to each existing member", () => {
    const vm = deriveSwarmViewModel(input({ projection: projection([task(), task("T02", { assignee: "executor-b" })]),
      events: [q, event(4, { to: "executor-b" }), event(5, { to: "executor-b" }), event(6, { to: "phantom" })] }));
    expect(vm.agents.map(a => [a.agent, a.unanswered_questions])).toEqual([["executor-a", 1], ["executor-b", 2]]);
  });
  it("M7 registration-only members receive loaded-history counts without task inference", () => {
    const vm = deriveSwarmViewModel(input({ projection: null, agents: { "executor-a": {} }, events: [q] }));
    expect(row(vm)).toMatchObject({ tasks: [], current_task_id: null, unanswered_questions: 1, activity: "idle" });
  });
  it("Amendment B foreign-room duplicate IDs cannot shadow same-room reference links", () => {
    expect(count([q, ack, { ...ack, room: "other", re: "missing-id" }, answer])).toBe(0);
  });
  it("Amendment B __proto__ event IDs are inert map keys", () => {
    const protoQuestion = { ...q, id: "__proto__" };
    expect(count([protoQuestion, { ...answer, re: protoQuestion.id }])).toBe(0);
  });
});
