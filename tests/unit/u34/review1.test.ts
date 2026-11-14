import { describe, expect, it } from "vitest";
import { buildDriftPrompt, diffPlans, foldRoom, foldRoomWithStats, silentAgents } from "../../../src/agents";
import type { Contract, RoomEvent } from "../../../src/agents/types";
import { PLAN_V1, ROOM_EVENTS, T0, ev, mkState } from "./fixture";

const bad = (e: RoomEvent, extra: Record<string, unknown>): RoomEvent => ({ ...e, ...extra }) as unknown as RoomEvent;

describe("REVIEW_1 B1: malformed optional payload never throws", () => {
  const base: RoomEvent[] = [
    ev(1, "claude", "open", "start"),
    ev(2, "claude", "plan", "Plan", { plan: PLAN_V1 }),
    ev(3, "claude", "step", "go", { step: { index: 0, state: "done" } }),
  ];
  const malformed: [string, RoomEvent][] = [
    ["question with evidence {}", bad(ev(10, "claude", "question", "Q?"), { evidence: {} })],
    ["question with evidence string", bad(ev(10, "claude", "question", "Q?"), { evidence: "x" })],
    ["question with evidence null", bad(ev(10, "claude", "question", "Q?"), { evidence: null })],
    ["question with plan {title, steps:1}", bad(ev(10, "claude", "question", "Q?"), { plan: { title: "T", steps: 1 } })],
    ["question with plan null", bad(ev(10, "claude", "question", "Q?"), { plan: null })],
    ["plan act with steps:1", bad(ev(10, "claude", "plan", "P"), { plan: { title: "T", steps: 1 } })],
    ["plan act with steps:{}", bad(ev(10, "claude", "plan", "P"), { plan: { title: "T", steps: {} } })],
    ["plan act with step entries null", bad(ev(10, "claude", "plan", "P"), { plan: { title: "T", steps: [null] } })],
    ["question with step wrong types", bad(ev(10, "claude", "question", "Q?"), { step: { index: "0", state: 5 } })],
    ["question with step null", bad(ev(10, "claude", "question", "Q?"), { step: null })],
    ["step act with step string", bad(ev(10, "claude", "step", "S"), { step: "done" })],
    ["step act with index string", bad(ev(10, "claude", "step", "S"), { step: { index: "0", state: "done" } })],
    ["step act with state number", bad(ev(10, "claude", "step", "S"), { step: { index: 0, state: 1 } })],
    ["step act with step missing", bad(ev(10, "claude", "step", "S"), { step: undefined })],
  ];

  for (const [name, e] of malformed) {
    it(`${name}: no throw in foldRoom / foldRoomWithStats; valid events still fold`, () => {
      const input = [...base, e, ev(20, "claude", "close", "done")];
      expect(() => foldRoom(structuredClone(input))).not.toThrow();
      expect(() => foldRoomWithStats(structuredClone(input))).not.toThrow();
      const { states } = foldRoomWithStats(structuredClone(input));
      expect(states).toHaveLength(1);
      expect(states[0]!.contract?.title).toBe(PLAN_V1.title);
      expect(states[0]!.stepStates[0]).toBe("done");
      expect(states[0]!.closed).toBe(true);
    });
  }

  it("a JSON.parse round trip of such events behaves the same", () => {
    const input = JSON.parse(JSON.stringify([...ROOM_EVENTS, bad(ev(40, "claude", "question", "Q?"), { evidence: {} })])) as RoomEvent[];
    expect(() => foldRoom(input)).not.toThrow();
    expect(foldRoom(input).map((s) => s.agent)).toEqual(["claude", "codex"]);
  });
});

describe("REVIEW_1 B2: state keys do not collide on NUL", () => {
  it("(room 'a\\0b', agent 'c') and (room 'a', agent 'b\\0c') stay two states", () => {
    const events = [
      ev(1, "c", "open", "x", {}, "e-1", "a\u0000b"),
      ev(2, "b\u0000c", "open", "y", {}, "e-2", "a"),
    ];
    const states = foldRoom(events);
    expect(states).toHaveLength(2);
    expect(states.map((s) => `${s.room}|${s.agent}`).sort()).toEqual(["a\u0000b|c", "a|b\u0000c"].sort());
  });

  it("holds in either input order", () => {
    const events = [
      ev(1, "c", "open", "x", {}, "e-1", "a\u0000b"),
      ev(2, "b\u0000c", "open", "y", {}, "e-2", "a"),
    ];
    expect(foldRoom(events.slice().reverse())).toHaveLength(2);
  });
});

describe("REVIEW_1 B3: equal lamport and id with different payloads fold deterministically", () => {
  const planA = { title: "A", steps: [{ text: "one" }, { text: "two" }] };
  const planB = { title: "B", steps: [{ text: "uno" }] };
  const open = ev(1, "claude", "open", "s");

  it("two plan events, same lamport and id: both orders give identical states", () => {
    const p1 = ev(2, "claude", "plan", "p", { plan: planA }, "e-dup");
    const p2 = ev(2, "claude", "plan", "p", { plan: planB }, "e-dup");
    expect(foldRoom([open, p1, p2])).toEqual(foldRoom([open, p2, p1]));
    expect(foldRoom([p2, open, p1])).toEqual(foldRoom([p1, p2, open]));
  });

  it("two step events, same lamport and id, different payloads: identical for both orders", () => {
    const plan = ev(2, "claude", "plan", "p", { plan: planA });
    const s1 = ev(3, "claude", "step", "s", { step: { index: 0, state: "done", outcome: "X" } }, "e-dup");
    const s2 = ev(3, "claude", "step", "s", { step: { index: 0, state: "blocked", outcome: "Y" } }, "e-dup");
    const s3 = ev(3, "claude", "step", "s", { step: { index: 1, state: "active" } }, "e-dup");
    for (const [a, b] of [[s1, s2], [s1, s3], [s2, s3]]) {
      expect(foldRoom([open, plan, a, b])).toEqual(foldRoom([open, plan, b, a]));
    }
    expect(foldRoomWithStats([open, plan, s1, s2]).states).toEqual(foldRoomWithStats([open, plan, s2, s1]).states);
  });
});

describe("REVIEW_1 B4: buildDriftPrompt truncates fields individually", () => {
  const mk = (title: string, steps: { text: string; accept?: string }[]): Contract => ({ title, steps, hash: "00000000", version: 1, lamport: 1 });
  const prev = mk("T".repeat(10_000), [
    { text: "shared one" },
    { text: "PREVIOUS_SENTINEL step", accept: "a".repeat(2000) },
    { text: "shared two" },
  ]);
  const next = mk("Next title", [
    { text: "shared one" },
    { text: "NEXT_SENTINEL step", accept: "b".repeat(2000) },
    { text: "shared two" },
  ]);
  const { prompt } = buildDriftPrompt(prev, next, diffPlans(prev, next));

  it("prompt <= 6000 characters", () => expect(prompt.length).toBeLessThanOrEqual(6000));
  it("contains PREVIOUS_SENTINEL", () => expect(prompt).toContain("PREVIOUS_SENTINEL"));
  it("contains NEXT_SENTINEL", () => expect(prompt).toContain("NEXT_SENTINEL"));
  it("still contains the untrusted-data wrapping line", () => {
    const line = prompt.split("\n").find((l) => /untrusted/i.test(l));
    expect(line, "untrusted line missing").toBeDefined();
    expect(line).toMatch(/data/i);
    expect(line).toMatch(/instruction/i);
  });
  it("long-title previous with 10,000 chars and short steps keeps every step text", () => {
    const p = mk("T".repeat(10_000), [{ text: "PREVIOUS_SENTINEL" }]);
    const n = mk("T".repeat(10_000), [{ text: "NEXT_SENTINEL" }]);
    const out = buildDriftPrompt(p, n, diffPlans(p, n)).prompt;
    expect(out.length).toBeLessThanOrEqual(6000);
    expect(out).toContain("PREVIOUS_SENTINEL");
    expect(out).toContain("NEXT_SENTINEL");
  });
});

describe("REVIEW_1 B5: silentAgents threshold is strictly greater, also for 0", () => {
  const NOW = T0 + 1_000_000;
  it("threshold 0, lastSeen === now: not silent", () => {
    expect(silentAgents([mkState({ agent: "a", lastSeen: NOW })], NOW, 0)).toEqual([]);
  });
  it("threshold 0, lastSeen === now - 1: silent", () => {
    expect(silentAgents([mkState({ agent: "a", lastSeen: NOW - 1 })], NOW, 0)).toEqual(["a"]);
  });
  it("explicit threshold equals default semantics at the boundary", () => {
    expect(silentAgents([mkState({ agent: "a", lastSeen: NOW - 5 })], NOW, 5)).toEqual([]);
    expect(silentAgents([mkState({ agent: "a", lastSeen: NOW - 6 })], NOW, 5)).toEqual(["a"]);
  });
});
