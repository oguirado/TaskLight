import { describe, expect, it } from "vitest";
import { foldRoom, silentAgents, toTaskVM } from "../../../src/agents";
import type { AgentState, DriftVerdict, StepState } from "../../../src/agents/types";
import type { AccentVM, AttentionVM, TaskStatusVM, TaskVM } from "../../../src/views/types";
import { PLAN_V2, ROOM, ROOM_EVENTS, T0, deepFreeze, ev, hasLoneSurrogate, hex, mkState } from "./fixture";

const NOW = T0 + 100 * 60_000;
const FRESH = NOW - 60_000;
const STALE = NOW - 600_001;
const ACCENTS = ["rose", "iris", "sky", "slate", "lagoon", "saffron"];
const V = (verdict: DriftVerdict["verdict"]): DriftVerdict => ({ verdict, reason: "r", source: "rules" });
const Q = ev(3, "claude", "question", "Which database?");

describe("A7 silentAgents", () => {
  const st = (agent: string, lastSeen: number, closed = false): AgentState => mkState({ agent, lastSeen, closed });

  it("not closed and strictly older than 600,000 ms by default, sorted by agent", () => {
    const states = [st("zed", NOW - 600_001), st("fresh", NOW - 1000), st("edge", NOW - 600_000), st("amy", NOW - 700_000), st("done", NOW - 9_999_999, true)];
    expect(silentAgents(states, NOW)).toEqual(["amy", "zed"]);
  });

  it("boundary: exactly the threshold is not silent, one ms more is", () => {
    expect(silentAgents([st("a", 1000)], 1000 + 600_000)).toEqual([]);
    expect(silentAgents([st("a", 1000)], 1000 + 600_001)).toEqual(["a"]);
  });

  it("custom threshold, including 0", () => {
    const s = [st("a", 1000), st("b", 900)];
    expect(silentAgents(s, 1500, 600)).toEqual([]); // b is exactly 600 ms old: not silent (A7 strict >)
    expect(silentAgents(s, 1501, 600)).toEqual(["b"]);
    expect(silentAgents(s, 1500, 0)).toEqual(["a", "b"]);
    expect(silentAgents(s, 1500, 10_000)).toEqual([]);
  });

  it("closed agents are never silent; empty input; no mutation of input order; lastSeen in the future is not silent", () => {
    expect(silentAgents([], NOW)).toEqual([]);
    expect(silentAgents([st("c", 0, true)], NOW)).toEqual([]);
    expect(silentAgents([st("future", NOW + 5000)], NOW)).toEqual([]);
    const input = Object.freeze([st("b", 0), st("a", 0)]);
    expect(silentAgents(input, NOW)).toEqual(["a", "b"]);
    expect(input.map((s) => s.agent)).toEqual(["b", "a"]);
  });

  it("works on folded states and with hostile names", () => {
    const states = foldRoom(ROOM_EVENTS);
    expect(silentAgents(states, T0 + 17 * 60_000 + 600_001)).toEqual(["codex"]);
    expect(silentAgents([st("constructor", 0), st("__proto__", 0)], NOW)).toEqual(["__proto__", "constructor"]);
  });
});

describe("A8 toTaskVM: fields", () => {
  const opts = { workspace: "w1", nowMs: NOW };
  const state = mkState({ lastSeen: FRESH, lastText: "Working on step two" }, ["Read code", "Write tests", "Ship"]);
  state.stepStates = ["done", "active", "pending"];
  state.outcomes = ["Mapped 3 entry points", undefined, undefined];
  state.took = ["4m", undefined, undefined];
  const vm: TaskVM = toTaskVM(state, opts);

  it("id agent:<room>:<agent>, workspace, project = agent, title from the contract", () => {
    expect(vm.id).toBe(`agent:${ROOM}:claude`);
    expect(vm.workspace).toBe("w1");
    expect(vm.project).toBe("claude");
    expect(vm.title).toBe("Plan");
  });

  it("title falls back to '<agent> (no plan yet)'", () => {
    expect(toTaskVM(mkState({ agent: "codex", lastSeen: FRESH }), opts).title).toBe("codex (no plan yet)");
  });

  it("summary is the last event text, empty when there is none, capped at 240 characters", () => {
    expect(vm.summary).toBe("Working on step two");
    expect(toTaskVM(mkState({ lastSeen: FRESH }), opts).summary).toBe("");
    expect(toTaskVM(mkState({ lastSeen: FRESH, lastText: "x".repeat(240) }), opts).summary).toBe("x".repeat(240));
    const long = toTaskVM(mkState({ lastSeen: FRESH, lastText: "y".repeat(5000) }), opts).summary;
    expect(long.length).toBeLessThanOrEqual(240);
    expect(long.length).toBeGreaterThan(200);
    expect("y".repeat(5000).startsWith(long)).toBe(true);
  });

  it("J9 summary truncation never leaves a lone surrogate", () => {
    for (const pad of [0, 1]) {
      const s = toTaskVM(mkState({ lastSeen: FRESH, lastText: "a".repeat(pad) + "😀".repeat(500) }), opts).summary;
      expect(s.length).toBeLessThanOrEqual(240);
      expect(hasLoneSurrogate(s)).toBe(false);
    }
  });

  it("steps: label = step text, state from stepStates, one entry per step", () => {
    expect(vm.steps.map((s) => [s.label, s.state])).toEqual([["Read code", "done"], ["Write tests", "active"], ["Ship", "pending"]]);
  });

  it("done steps get detail.outcome with empty evidence and rules source ms 0; took is exposed", () => {
    expect(vm.steps[0]?.detail).toEqual({ outcome: "Mapped 3 entry points", evidence: [], source: { kind: "rules", ms: 0 } }); // U38 V3: no model ran
    expect(vm.steps[0]?.took).toBe("4m");
    expect(vm.steps[1]?.detail).toBeUndefined();
    expect(vm.steps[2]?.detail).toBeUndefined();
  });

  it("outcomes of non-done steps are not turned into detail", () => {
    const s = mkState({ lastSeen: FRESH, outcomes: ["leftover", "x"] }, ["a", "b"]);
    s.stepStates = ["active", "blocked"];
    expect(toTaskVM(s, opts).steps.every((x) => x.detail === undefined)).toBe(true);
  });

  it("accent: given value passes through; default is one of the six accents", () => {
    for (const a of ACCENTS) expect(toTaskVM(state, { ...opts, accent: a as AccentVM }).accent).toBe(a);
    expect(ACCENTS).toContain(vm.accent);
  });

  it("updated is a string and source is a valid SourceVM", () => {
    expect(typeof vm.updated).toBe("string");
    expect(["device", "cloud", "rules"]).toContain(vm.source.kind); // U38 V3 adds "rules"
    expect(typeof vm.source.ms).toBe("number");
  });

  it("is pure and JSON-serialisable: frozen input is untouched, two calls are equal", () => {
    const frozen = deepFreeze(structuredClone(state));
    const a = toTaskVM(frozen, opts);
    expect(toTaskVM(frozen, opts)).toEqual(a);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });

  it("the real fold of the fixture maps both agents", () => {
    const [claude, codex] = foldRoom(ROOM_EVENTS).map((s) => toTaskVM(s, { workspace: "w", nowMs: T0 + 17 * 60_000 + 1000 }));
    expect(claude?.id).toBe("agent:launch:claude");
    expect(claude?.title).toBe(PLAN_V2.title);
    expect(claude?.status).toBe("done");
    expect(claude?.steps).toHaveLength(5);
    expect(claude?.steps[3]?.detail?.outcome).toBe("5 tests");
    expect(codex?.id).toBe("agent:launch:codex");
    expect(codex?.status).toBe("waiting");
    expect(codex?.attention).toBe("high");
    expect(codex?.next).toBe("Run suite");
  });
});

describe("A8 toTaskVM: status and attention precedence", () => {
  const mk = (states: StepState[], over: Partial<AgentState> = {}): AgentState => {
    const s = mkState({ lastSeen: FRESH, ...over }, states.map((_, i) => `step ${i}`));
    s.stepStates = states;
    return s;
  };
  type Row = [string, AgentState, DriftVerdict | undefined, TaskStatusVM, AttentionVM];
  const ROWS: Row[] = [
    ["blocked step outranks open question, silence and close", mk(["blocked", "pending"], { openQuestions: [Q], lastSeen: STALE, closed: true }), undefined, "blocked", "now"],
    ["open question outranks silence and close", mk(["active"], { openQuestions: [Q], lastSeen: STALE, closed: true }), undefined, "waiting", "high"],
    ["open question, fresh", mk(["active"], { openQuestions: [Q] }), undefined, "waiting", "high"],
    ["silent (not closed) is idle", mk(["active", "pending"], { lastSeen: STALE }), undefined, "idle", "high"],
    ["silent outranks all-done", mk(["done", "done"], { lastSeen: STALE }), undefined, "idle", "high"],
    ["closed and long silent is done (closed agents are never silent)", mk(["active"], { lastSeen: STALE, closed: true }), undefined, "done", "none"],
    ["closed with unfinished steps is done", mk(["pending", "pending"], { closed: true }), undefined, "done", "none"],
    // Oracle amendment A-U42: "done" needs a close; all steps done but not closed is still in progress.
    ["all steps done, fresh, not closed is running (A-U42)", mk(["done", "done"]), undefined, "running", "low"],
    ["all steps done and closed is done (A-U42)", mk(["done", "done"], { closed: true }), undefined, "done", "none"],
    ["active step, fresh is running", mk(["done", "active", "pending"]), undefined, "running", "low"],
    ["only pending steps, fresh is running", mk(["pending"]), undefined, "running", "low"],
    ["J10 no plan, fresh, not closed is running (zero steps are not 'all done')", mk([]), undefined, "running", "low"],
    ["verdict needs_user while running -> now", mk(["active"]), V("needs_user"), "running", "now"],
    ["verdict needs_user while waiting -> now", mk(["active"], { openQuestions: [Q] }), V("needs_user"), "waiting", "now"],
    ["verdict needs_user while silent -> now", mk(["active"], { lastSeen: STALE }), V("needs_user"), "idle", "now"],
    ["verdict drift while running -> high", mk(["active"]), V("drift"), "running", "high"],
    ["verdict drift while blocked -> now (blocked wins)", mk(["blocked"]), V("drift"), "blocked", "now"],
    ["verdict drift while done -> high (literal order; A-U42: done = closed)", mk(["done"], { closed: true }), V("drift"), "done", "high"],
    ["verdict on_track changes nothing: running -> low", mk(["active"]), V("on_track"), "running", "low"],
    ["verdict on_track changes nothing: done -> none (A-U42: done = closed)", mk(["done"], { closed: true }), V("on_track"), "done", "none"],
    ["verdict on_track changes nothing: silent -> high", mk(["active"], { lastSeen: STALE }), V("on_track"), "idle", "high"],
    ["blocked with no verdict -> now", mk(["blocked"]), undefined, "blocked", "now"],
  ];

  it.each(ROWS)("%s", (_n, state, verdict, status, attention) => {
    const vm = toTaskVM(state, { workspace: "w", nowMs: NOW, ...(verdict ? { verdict } : {}) });
    expect(vm.status).toBe(status);
    expect(vm.attention).toBe(attention);
  });

  it("silentAfterMs option moves the silence line (default 600,000)", () => {
    const s = mk(["active"], { lastSeen: NOW - 5000 });
    expect(toTaskVM(s, { workspace: "w", nowMs: NOW }).status).toBe("running");
    expect(toTaskVM(s, { workspace: "w", nowMs: NOW, silentAfterMs: 4999 }).status).toBe("idle");
    expect(toTaskVM(s, { workspace: "w", nowMs: NOW, silentAfterMs: 5000 }).status).toBe("running");
    const old = mk(["active"], { lastSeen: NOW - 700_000 });
    expect(toTaskVM(old, { workspace: "w", nowMs: NOW }).status).toBe("idle");
    expect(toTaskVM(old, { workspace: "w", nowMs: NOW, silentAfterMs: 800_000 }).status).toBe("running");
  });

  it("status and attention only take view-model values", () => {
    for (const [, s, v] of ROWS) {
      const vm = toTaskVM(s, { workspace: "w", nowMs: NOW, ...(v ? { verdict: v } : {}) });
      expect(["blocked", "waiting", "running", "idle", "done", "failed"]).toContain(vm.status);
      expect(["now", "high", "low", "none"]).toContain(vm.attention);
    }
  });
});

describe("A8 toTaskVM: next", () => {
  const next = (states: StepState[], texts = states.map((_, i) => `step ${i}`)): string => {
    const s = mkState({ lastSeen: FRESH }, texts);
    s.stepStates = states;
    return toTaskVM(s, { workspace: "w", nowMs: NOW }).next;
  };

  it.each<[string, StepState[], string]>([
    ["first pending", ["pending", "pending"], "step 0"],
    ["skips done", ["done", "pending", "pending"], "step 1"],
    ["active counts as not done", ["done", "active", "pending"], "step 1"],
    ["blocked counts as not done", ["done", "done", "blocked", "active"], "step 2"],
  ])("%s", (_n, states, expected) => { expect(next(states)).toBe(expected); });

  it("no contract -> 'Waiting for a plan'", () => {
    expect(toTaskVM(mkState({ lastSeen: FRESH }), { workspace: "w", nowMs: NOW }).next).toBe("Waiting for a plan");
  });

  // Oracle amendment A-U42: "Waiting for a plan" only without a plan; all done but open waits for the next step.
  it("J11 all steps done, not closed -> 'Waiting for the next step' (A-U42)", () => {
    expect(next(["done", "done"])).toBe("Waiting for the next step");
  });
});

describe("A8/A9 toTaskVM hostile inputs", () => {
  it("hostile agent, room and texts are carried as literal data and never throw", () => {
    for (const name of ["__proto__", "constructor", "toString", "<img src=x onerror=1>", "😀".repeat(1000)]) {
      const s = mkState({ agent: name, room: name, lastText: name }, [name, "constructor"]);
      s.stepStates = ["done", "active"];
      s.outcomes = [name, undefined];
      const vm = toTaskVM(s, { workspace: name, nowMs: NOW });
      expect(vm.id).toBe(`agent:${name}:${name}`);
      expect(vm.project).toBe(name);
      expect(vm.workspace).toBe(name);
      expect(vm.steps[0]?.label).toBe(name);
      expect(vm.steps[0]?.detail?.outcome).toBe(name);
    }
  });

  it("huge strings stay bounded where the spec bounds them (summary) and do not throw", () => {
    const huge = "z".repeat(2_000_000);
    const s = mkState({ lastText: huge, lastSeen: FRESH }, [huge]);
    const vm = toTaskVM(s, { workspace: "w", nowMs: NOW });
    expect(vm.summary.length).toBeLessThanOrEqual(240);
  });

  it("inconsistent states (stepStates shorter or longer than the contract, NaN lastSeen, junk openQuestions) never throw", () => {
    const base = mkState({ lastSeen: FRESH }, ["a", "b", "c"]);
    const variants: AgentState[] = [
      { ...base, stepStates: [] }, { ...base, stepStates: ["done", "done", "done", "done", "done"] },
      { ...base, outcomes: [] }, { ...base, took: [] }, { ...base, lastSeen: Number.NaN }, { ...base, lastSeen: Number.POSITIVE_INFINITY },
      { ...base, openQuestions: [] }, { ...base, stepStates: ["bogus" as StepState, "done", "pending"] },
    ];
    for (const v of variants) {
      expect(() => toTaskVM(v, { workspace: "w", nowMs: NOW })).not.toThrow();
      expect(() => toTaskVM(v, { workspace: "w", nowMs: Number.NaN })).not.toThrow();
    }
  });

  it("wrong-typed verdict and accent never throw", () => {
    const s = mkState({ lastSeen: FRESH }, ["a"]);
    for (const verdict of [null, 5, "drift", { verdict: "constructor" }, { verdict: "__proto__", reason: "x", source: "rules" }]) {
      expect(() => toTaskVM(s, { workspace: "w", nowMs: NOW, verdict: verdict as never })).not.toThrow();
    }
    expect(() => toTaskVM(s, { workspace: "w", nowMs: NOW, accent: "constructor" as never })).not.toThrow();
  });
});
