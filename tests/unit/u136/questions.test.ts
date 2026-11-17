import { describe, expect, it } from "vitest";
import { deriveSwarmViewModel } from "../../../src/app/swarm_vm";
import type { RoomEvent } from "../../../src/agents/types";
import { deterministic, event, freeze, input, mount, projection, registration, row, text } from "./fixtures";

deterministic();
const q = event(1), ack = event(2, { act: "ack", agent: "executor-a", re: q.id });
const answer = event(3, { act: "answer", agent: "executor-a", re: ack.id });
function vm(events: readonly RoomEvent[]) { return deriveSwarmViewModel(freeze(input({ events }))); }
function count(events: readonly RoomEvent[]): number { return row(vm(events)).unanswered_questions; }

describe("A4 / M6 loaded-history scope and answer-chain rules", () => {
  it("A4 duplicate question IDs count once and ack alone never answers", () => {
    expect(count([q, q, { ...q }, ack])).toBe(1);
    const rendered = text(mount(vm([q, ack])));
    expect(rendered).toContain("Unanswered questions in loaded history"); expect(rendered).toMatch(/\b1\b/);
  });
  it("A4 a current addressee answer through its ack clears the question regardless of arrival order", () => {
    expect(count([answer, ack, q])).toBe(0); expect(count([q, { ...answer, re: q.id }])).toBe(0);
  });
  it.each([
    ["wrong answer author", [q, ack, { ...answer, agent: "someone-else" }]],
    ["foreign answer", [q, ack, { ...answer, room: "other" }]],
    ["foreign intermediary", [q, { ...ack, room: "other" }, answer]],
    ["dangling chain", [q, { ...answer, re: "not-loaded" }]],
  ] as const)("A4 %s cannot imply an answered question", (_name, events) => { expect(count(events)).toBe(1); });
  it("A4 foreign-room authors, heartbeat and question recipients never add members or change room counts", () => {
    const baseline = vm([q]);
    const foreign = [event(9, { room: "other", to: "ghost", agent: "foreign-author" }),
      event(10, { room: "other", act: "heartbeat", agent: "foreign-author" }),
      event(11, { to: "recipient-only", agent: "event-author" })];
    expect(vm([q, ...foreign])).toEqual(baseline);
  });
  it("A4 foreign duplicate IDs cannot shadow same-room answer-chain events", () => {
    expect(count([{ ...ack, room: "other", re: "missing" }, q, ack, answer])).toBe(0);
  });
  it("Amendment B cyclic re containing a question and answer terminates without clearing the question", () => {
    const cyclicQ = { ...q, re: ack.id }, cyclicAck = { ...ack, re: cyclicQ.id };
    expect(count([cyclicQ, cyclicAck, answer])).toBe(1);
  });
  it("Amendment B answer self-reference terminates without clearing an unrelated question", () => {
    expect(count([q, { ...answer, re: answer.id }])).toBe(1);
  });
  it("Amendment B __proto__ is a safe question ID and can be answered through a complete chain", () => {
    expect(count([{ ...q, id: "__proto__" }, { ...answer, re: "__proto__" }])).toBe(0);
  });
  it("M6 follows a bounded complete answer chain without an arbitrary shallow cutoff", () => {
    const chain: RoomEvent[] = [q];
    for (let n = 2; n <= 65; n++) chain.push(event(n, { act: "ack", agent: "executor-a", re: chain.at(-1)!.id }));
    chain.push(event(66, { act: "answer", agent: "executor-a", re: chain.at(-1)!.id }));
    expect(count(chain)).toBe(0);
  });
  it("M6 question counts do not infer operator attention, complete history, registration or cancellation", () => {
    const v = vm([q, event(4)]), a = row(v);
    expect(a.unanswered_questions).toBe(2); expect(a.activity).toBe("working"); expect(a.lifecycle).toBeUndefined();
    expect(a.tasks[0]!.state).toBe("active");
  });
  it("M6 counts loaded questions for committed registration-only members", () => {
    const v = deriveSwarmViewModel(input({ projection: projection([], { "executor-a": registration({ lifecycle: "deployed" }) }), events: [q] }));
    expect(row(v)).toMatchObject({ tasks: [], unanswered_questions: 1 });
  });
});
