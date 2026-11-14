import { describe, expect, it } from "vitest";
import { contractHash, foldRoom, foldRoomWithStats } from "../../../src/agents";
import type { AgentState, RoomEvent } from "../../../src/agents/types";
import { PLAN_V1, PLAN_V2, ROOM, ROOM_EVENTS, T0, deepFreeze, ev, eventById, hex, prng, shuffled } from "./fixture";

const by = (states: AgentState[], agent: string): AgentState => {
  const s = states.find((x) => x.agent === agent);
  if (!s) throw new Error(`no state for ${agent}`);
  return s;
};

describe("A1 foldRoom: realistic room", () => {
  const states = foldRoom(ROOM_EVENTS);

  it("one state per agent, sorted by agent name, all in the room", () => {
    expect(states.map((s) => s.agent)).toEqual(["claude", "codex"]);
    expect(states.every((s) => s.room === ROOM)).toBe(true);
  });

  it("claude: contract v2 with previous v1, carried and new step states", () => {
    const c = by(states, "claude");
    expect(c.contract).toEqual({ title: PLAN_V2.title, steps: PLAN_V2.steps, hash: contractHash(PLAN_V2), version: 2, lamport: 12 });
    expect(c.previous).toEqual({ title: PLAN_V1.title, steps: PLAN_V1.steps, hash: contractHash(PLAN_V1), version: 1, lamport: 2 });
    expect(c.stepStates).toEqual(["done", "done", "active", "done", "pending"]);
    expect(c.closed).toBe(true);
    expect(c.openQuestions).toEqual([]);
    expect(c.lastText).toBe("Auth refactor shipped");
    expect(c.lastSeen).toBe(T0 + 17 * 60_000);
  });

  it("J2 outcomes and took follow the carried step text (v2 index 3 is the new step done by event 15)", () => {
    const c = by(states, "claude");
    expect(c.outcomes).toEqual(["Mapped 3 entry points", "12 tests red", undefined, "5 tests", undefined]);
    expect(c.took).toEqual(["4m", "9m", undefined, "6m", undefined]);
  });

  it("codex: single plan (no previous), its own step states, the unanswered question stays open", () => {
    const x = by(states, "codex");
    expect(x.contract?.version).toBe(1);
    expect(x.contract?.title).toBe("Review harness");
    expect(x.previous).toBeUndefined();
    expect(x.stepStates).toEqual(["done", "active"]);
    expect(x.outcomes).toEqual(["Fixtures ready", undefined]);
    expect(x.took).toEqual(["2m", undefined]);
    expect(x.closed).toBe(false);
    expect(x.openQuestions).toEqual([eventById(hex(16))]);
    expect(x.lastText).toBe("Do I need staging credentials?");
    expect(x.lastSeen).toBe(T0 + 16 * 60_000);
  });

  it("stepStates/outcomes/took always have one slot per contract step", () => {
    for (const s of states) {
      const n = s.contract?.steps.length ?? 0;
      expect(s.stepStates).toHaveLength(n);
      expect(s.outcomes).toHaveLength(n);
      expect(s.took).toHaveLength(n);
    }
  });

  it("does not mutate frozen input and returns fresh arrays each call", () => {
    const frozen = deepFreeze(structuredClone(ROOM_EVENTS));
    const a = foldRoom(frozen);
    const b = foldRoom(frozen);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
  });

  it("empty input gives no states", () => {
    expect(foldRoom([])).toEqual([]);
    expect(foldRoomWithStats([])).toEqual({ states: [], invalid: 0 });
  });
});

describe("A1 fold determinism under permutations (seeded PRNG)", () => {
  const base = foldRoom(ROOM_EVENTS);

  it("60 seeded permutations of the fixture fold to a deep-equal result", () => {
    const rnd = prng(0x34a1);
    for (let i = 0; i < 60; i++) {
      const p = shuffled(ROOM_EVENTS, rnd);
      expect(foldRoom(p), `permutation ${i}`).toEqual(base);
    }
  });

  it("reverse order and lamport-descending order give the same result", () => {
    expect(foldRoom(ROOM_EVENTS.slice().reverse())).toEqual(base);
    expect(foldRoom(ROOM_EVENTS.slice().sort((a, b) => b.lamport - a.lamport))).toEqual(base);
  });

  it("permutations that also contain invalid junk and an exact duplicate agree with each other and with the clean fold", () => {
    const junk: unknown[] = [null, 7, "x", [], { id: "e-1" }, { ...ROOM_EVENTS[0], act: "explode" }];
    const withJunk = [...ROOM_EVENTS, ...junk];
    const rnd = prng(0xbeef);
    for (let i = 0; i < 50; i++) {
      expect(foldRoom(shuffled(withJunk, rnd)), `junk permutation ${i}`).toEqual(base);
    }
  });

  it("exact duplicate events are idempotent for every permutation (same multiset => same output)", () => {
    const dup = [...ROOM_EVENTS, ROOM_EVENTS[4] as RoomEvent];
    const rnd = prng(7);
    const first = foldRoom(shuffled(dup, rnd));
    for (let i = 0; i < 50; i++) expect(foldRoom(shuffled(dup, rnd))).toEqual(first);
  });

  it("lamport ties are ordered by id ascending: the greater id is applied last, in any input order", () => {
    const events = [
      ev(1, "a1", "plan", "p", { plan: { title: "T", steps: [{ text: "s" }] } }),
      ev(2, "a1", "step", "x", { step: { index: 0, state: "done", outcome: "from-02" } }, "e-0000000000000002"),
      ev(2, "a1", "step", "y", { step: { index: 0, state: "blocked", outcome: "from-03" } }, "e-0000000000000003"),
    ];
    for (const p of [events, events.slice().reverse(), [events[2] as RoomEvent, events[0] as RoomEvent, events[1] as RoomEvent]]) {
      const s = by(foldRoom(p), "a1");
      expect(s.stepStates).toEqual(["blocked"]);
      expect(s.outcomes).toEqual(["from-03"]);
    }
  });

  it("order is by lamport, not by ts or array position: a step stamped later in ts but earlier in lamport than its plan is dropped", () => {
    const events = [
      { ...ev(1, "a1", "step", "early", { step: { index: 0, state: "done" } }), ts: T0 + 999_999 },
      { ...ev(2, "a1", "plan", "p", { plan: { title: "T", steps: [{ text: "s" }] } }), ts: T0 },
    ];
    expect(by(foldRoom(events), "a1").stepStates).toEqual(["pending"]);
    expect(by(foldRoom(events.slice().reverse()), "a1").stepStates).toEqual(["pending"]);
  });
});

describe("A1 contract versioning and step-state carry-over", () => {
  const plan = (lamport: number, texts: string[], title = "T"): RoomEvent =>
    ev(lamport, "a1", "plan", `plan ${lamport}`, { plan: { title, steps: texts.map((text) => ({ text })) } });
  const step = (lamport: number, index: number, state: "done" | "active" | "blocked" | "pending", outcome?: string): RoomEvent =>
    ev(lamport, "a1", "step", "s", { step: { index, state, ...(outcome === undefined ? {} : { outcome }) } });

  it("first plan is version 1 with no previous, all steps pending", () => {
    const s = by(foldRoom([plan(1, ["a", "b"])]), "a1");
    expect(s.contract?.version).toBe(1);
    expect(s.contract?.lamport).toBe(1);
    expect(s.previous).toBeUndefined();
    expect(s.stepStates).toEqual(["pending", "pending"]);
  });

  it("each plan increments the version and the previous contract is the one just replaced (v3 keeps v2, not v1)", () => {
    const s = by(foldRoom([plan(1, ["a"]), plan(2, ["a", "b"]), plan(3, ["c"], "T3")]), "a1");
    expect(s.contract?.version).toBe(3);
    expect(s.contract?.title).toBe("T3");
    expect(s.previous?.version).toBe(2);
    expect(s.previous?.steps.map((x) => x.text)).toEqual(["a", "b"]);
  });

  it("contract.hash equals contractHash of the plan body", () => {
    const s = by(foldRoom([plan(1, ["a", "b"], "Hashed")]), "a1");
    expect(s.contract?.hash).toBe(contractHash({ title: "Hashed", steps: [{ text: "a" }, { text: "b" }] }));
  });

  it("identical text keeps its state (even when it moves), new and edited text resets to pending", () => {
    const s = by(foldRoom([
      plan(1, ["a", "b", "c", "d"]),
      step(2, 0, "done"), step(3, 1, "active"), step(4, 2, "blocked"), step(5, 3, "done"),
      plan(6, ["d", "x", "a", "B", "c"]),
    ]), "a1");
    expect(s.stepStates).toEqual(["done", "pending", "done", "pending", "blocked"]);
  });

  it("a removed-then-re-added step does not resurrect old state across two plan changes", () => {
    const s = by(foldRoom([plan(1, ["a", "b"]), step(2, 0, "done"), plan(3, ["b"]), plan(4, ["a", "b"])]), "a1");
    expect(s.stepStates).toEqual(["pending", "pending"]);
  });

  it("step updates apply to the current contract only", () => {
    const s = by(foldRoom([plan(1, ["a", "b"]), plan(2, ["a", "b", "c"]), step(3, 2, "active")]), "a1");
    expect(s.stepStates).toEqual(["pending", "pending", "active"]);
  });

  it("step with out-of-range index, or before any plan, is ignored and does not corrupt later state", () => {
    const s = by(foldRoom([
      step(1, 0, "done"),
      plan(2, ["a", "b"]),
      step(3, 2, "done"), step(4, 99, "done"),
      step(5, 1, "done", "ok"),
    ]), "a1");
    expect(s.stepStates).toEqual(["pending", "done"]);
    expect(s.stepStates).toHaveLength(2);
    expect(s.outcomes).toEqual([undefined, "ok"]);
  });

  it("step carries outcome and took into the same index", () => {
    const e = ev(2, "a1", "step", "s", { step: { index: 0, state: "done", outcome: "shipped", took: "3m" } });
    const s = by(foldRoom([plan(1, ["a"]), e]), "a1");
    expect(s.outcomes).toEqual(["shipped"]);
    expect(s.took).toEqual(["3m"]);
  });

  it("agents are independent: another agent's plan and steps never touch this agent's state", () => {
    const events = [plan(1, ["a"]), ev(2, "b1", "plan", "p", { plan: { title: "B", steps: [{ text: "a" }, { text: "z" }] } }),
      ev(3, "b1", "step", "s", { step: { index: 0, state: "done" } })];
    const out = foldRoom(events);
    expect(by(out, "a1").stepStates).toEqual(["pending"]);
    expect(by(out, "b1").stepStates).toEqual(["done", "pending"]);
    expect(by(out, "a1").contract?.version).toBe(1);
  });

  it("an agent that only posted non-plan events has a state with no contract", () => {
    const s = by(foldRoom([ev(1, "a1", "heartbeat", "hi")]), "a1");
    expect(s.contract).toBeUndefined();
    expect(s.stepStates).toEqual([]);
    expect(s.lastText).toBe("hi");
    expect(s.closed).toBe(false);
  });
});

describe("A1 questions and close", () => {
  const q = (lamport: number, agent = "a1") => ev(lamport, agent, "question", `q${lamport}`);

  it("a question stays open without a later answer", () => {
    const s = by(foldRoom([q(1)]), "a1");
    expect(s.openQuestions.map((e) => e.id)).toEqual([hex(1)]);
  });

  it("an answer (re) from another agent closes the asker's question; answerer state does not list it", () => {
    const out = foldRoom([q(1), ev(2, "b1", "answer", "yes", { re: hex(1) })]);
    expect(by(out, "a1").openQuestions).toEqual([]);
    expect(by(out, "b1").openQuestions).toEqual([]);
  });

  it("an answer by the same agent also closes it", () => {
    expect(by(foldRoom([q(1), ev(2, "a1", "answer", "self", { re: hex(1) })]), "a1").openQuestions).toEqual([]);
  });

  it("an answer with an earlier lamport than the question does not close it", () => {
    const out = foldRoom([ev(1, "b1", "answer", "early", { re: hex(2) }), q(2)]);
    expect(by(out, "a1").openQuestions.map((e) => e.id)).toEqual([hex(2)]);
  });

  it("an answer whose re points elsewhere leaves the question open; several open questions keep lamport order", () => {
    const out = foldRoom([q(3), q(1), q(2), ev(4, "b1", "answer", "x", { re: "e-ffffffffffffffff" })]);
    expect(by(out, "a1").openQuestions.map((e) => e.id)).toEqual([hex(1), hex(2), hex(3)]);
  });

  it("only the answered question closes", () => {
    const out = foldRoom([q(1), q(2), ev(3, "b1", "answer", "x", { re: hex(1) })]);
    expect(by(out, "a1").openQuestions.map((e) => e.id)).toEqual([hex(2)]);
  });

  it("close marks the agent closed and updates lastText/lastSeen", () => {
    const s = by(foldRoom([ev(1, "a1", "open", "go"), ev(2, "a1", "close", "bye")]), "a1");
    expect(s.closed).toBe(true);
    expect(s.lastText).toBe("bye");
    expect(s.lastSeen).toBe(T0 + 2 * 60_000);
  });

  it("closing one agent does not close the other", () => {
    const out = foldRoom([ev(1, "a1", "close", "bye"), ev(2, "b1", "open", "hi")]);
    expect(by(out, "a1").closed).toBe(true);
    expect(by(out, "b1").closed).toBe(false);
  });

  it("every act updates lastSeen and lastText (open handoff ack heartbeat verdict too)", () => {
    for (const act of ["open", "handoff", "heartbeat", "verdict"] as const) {
      const s = by(foldRoom([ev(5, "a1", act, `text-${act}`)]), "a1");
      expect(s.lastText).toBe(`text-${act}`);
      expect(s.lastSeen).toBe(T0 + 5 * 60_000);
    }
  });
});

describe("A1 invalid events: ignored and counted", () => {
  const good = ROOM_EVENTS;
  const clean = foldRoom(good);
  const BAD: [string, unknown][] = [
    ["null", null], ["undefined", undefined], ["number", 42], ["string", "event"], ["array", [1, 2]], ["empty object", {}],
    ["missing id", { ...good[0], id: undefined }],
    ["id not a string", { ...good[0], id: 5 }],
    ["lamport as string", { ...good[0], lamport: "3" }],
    ["lamport NaN", { ...good[0], lamport: Number.NaN }],
    ["lamport Infinity", { ...good[0], lamport: Number.POSITIVE_INFINITY }],
    ["lamport fractional", { ...good[0], lamport: 1.5 }],
    ["lamport missing", { ...good[0], lamport: undefined }],
    ["ts as string", { ...good[0], ts: "now" }],
    ["room not a string", { ...good[0], room: 1 }],
    ["agent missing", { ...good[0], agent: undefined }],
    ["agent object", { ...good[0], agent: {} }],
    ["act unknown", { ...good[0], act: "explode" }],
    ["act case-sensitive", { ...good[0], act: "PLAN" }],
    ["act inherited key constructor", { ...good[0], act: "constructor" }],
    ["act inherited key __proto__", { ...good[0], act: "__proto__" }],
    ["act inherited key toString", { ...good[0], act: "toString" }],
    ["text not a string", { ...good[0], text: 5 }],
    ["plan act without plan body", { ...ev(40, "zz", "plan", "p") }],
    ["plan with empty steps", ev(40, "zz", "plan", "p", { plan: { title: "T", steps: [] } })],
    ["plan steps not an array", { ...ev(40, "zz", "plan", "p"), plan: { title: "T", steps: "abc" } }],
    ["plan step without text", { ...ev(40, "zz", "plan", "p"), plan: { title: "T", steps: [{}] } }],
    ["plan title not a string", { ...ev(40, "zz", "plan", "p"), plan: { title: 3, steps: [{ text: "a" }] } }],
    ["step act without step body", ev(40, "zz", "step", "s")],
    ["step with unknown state", { ...ev(40, "zz", "step", "s"), step: { index: 0, state: "paused" } }],
    ["step with negative index", { ...ev(40, "zz", "step", "s"), step: { index: -1, state: "done" } }],
    ["step with fractional index", { ...ev(40, "zz", "step", "s"), step: { index: 0.5, state: "done" } }],
    ["step with string index", { ...ev(40, "zz", "step", "s"), step: { index: "0", state: "done" } }],
  ];

  it.each(BAD)("%s is ignored: result equals the clean fold and invalid === 1", (_n, bad) => {
    const r = foldRoomWithStats([...good, bad]);
    expect(r.states).toEqual(clean);
    expect(r.invalid).toBe(1);
  });

  it("counts every invalid event, none for valid ones", () => {
    const r = foldRoomWithStats([...good, ...BAD.map(([, b]) => b)]);
    expect(r.states).toEqual(clean);
    expect(r.invalid).toBe(BAD.length);
    expect(foldRoomWithStats(good).invalid).toBe(0);
  });

  it("an agent whose only events are invalid gets no state", () => {
    const r = foldRoomWithStats([{ ...ev(1, "ghost", "open", "x"), act: "nope" }]);
    expect(r.states).toEqual([]);
    expect(r.invalid).toBe(1);
  });

  it("J3 optional fields of the wrong type invalidate the event (re/to must be strings)", () => {
    const r = foldRoomWithStats([...good, { ...ev(40, "zz", "heartbeat", "x"), re: 5 }, { ...ev(41, "zz", "heartbeat", "x"), to: {} }]);
    expect(r.invalid).toBe(2);
    expect(r.states.map((s) => s.agent)).toEqual(["claude", "codex"]);
  });

  it("foldRoom and foldRoomWithStats agree on states", () => {
    const junk = [...good, 1, null];
    expect(foldRoomWithStats(junk).states).toEqual(foldRoom(junk));
  });
});

describe("A9 hostile inputs never throw", () => {
  it("inherited-key lookups: agent names constructor/toString/hasOwnProperty are ordinary agents, Object.prototype stays clean", () => {
    const names = ["constructor", "toString", "hasOwnProperty", "valueOf"];
    const events = names.flatMap((n, i) => [ev(i * 2 + 1, n, "plan", "p", { plan: { title: n, steps: [{ text: "s" }] } }), ev(i * 2 + 2, n, "step", "s", { step: { index: 0, state: "done" } })]);
    const out = foldRoom(events);
    expect(out.map((s) => s.agent)).toEqual([...names].sort());
    for (const s of out) expect(s.stepStates).toEqual(["done"]);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });

  it("__proto__ as agent, room, id, act or plan keys does not throw or pollute; other agents are intact", () => {
    const evil = JSON.parse(
      '{"id":"__proto__","lamport":1,"ts":1,"room":"__proto__","agent":"__proto__","act":"plan","text":"t",' +
      '"plan":{"title":"__proto__","steps":[{"text":"__proto__","__proto__":{"polluted":true}}],"__proto__":{"polluted":true}},"__proto__":{"polluted":true}}',
    );
    const out = foldRoom([evil, ...ROOM_EVENTS, { ...evil, act: "__proto__" }, { ...evil, agent: "constructor", act: "constructor" }]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(out.filter((s) => s.agent === "claude" || s.agent === "codex")).toEqual(foldRoom(ROOM_EVENTS));
  });

  it("huge strings (1 MB text, 1 MB title, 100k step text) are accepted or rejected without throwing", () => {
    const huge = "😀x".repeat(500_000);
    const e1 = ev(1, "a1", "plan", huge, { plan: { title: huge, steps: [{ text: huge }] } });
    const e2 = ev(2, "a1", "step", huge, { step: { index: 0, state: "done", outcome: huge, took: huge } });
    expect(() => foldRoom([e1, e2])).not.toThrow();
    expect(() => foldRoomWithStats([e1, e2])).not.toThrow();
  });

  it("10,000 junk entries are all counted and nothing throws", () => {
    const junk = Array.from({ length: 10_000 }, (_, i) => (i % 3 === 0 ? null : i % 3 === 1 ? { act: "x", i } : [i]));
    const r = foldRoomWithStats(junk);
    expect(r).toEqual({ states: [], invalid: 10_000 });
  });

  it("J4 non-array input yields an empty fold instead of throwing", () => {
    for (const bad of [null, undefined, 5, "events", {}, { length: 3 }]) {
      expect(() => foldRoom(bad as unknown as unknown[])).not.toThrow();
      expect(foldRoom(bad as unknown as unknown[])).toEqual([]);
    }
  });

  it("deeply nested and cyclic payload objects do not throw", () => {
    const cyc: Record<string, unknown> = {}; cyc["self"] = cyc;
    expect(() => foldRoom([{ ...ev(1, "a1", "plan", "x"), plan: cyc }, { ...ev(2, "a1", "heartbeat", "x"), evidence: cyc }, cyc])).not.toThrow();
  });
});
