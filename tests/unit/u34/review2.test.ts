import { describe, expect, it } from "vitest";
import { contractHash, diffPlans, driftRules, foldRoom, foldRoomWithStats, toTaskVM } from "../../../src/agents";
import type { AgentState, RoomEvent, StepState } from "../../../src/agents/types";
import { PLAN_V1, T0, contract, ev, mkState } from "./fixture";

const bad = (e: RoomEvent, extra: Record<string, unknown>): RoomEvent => ({ ...e, ...extra }) as unknown as RoomEvent;

const deepObject = (levels: number): unknown => {
  let o: unknown = "leaf";
  for (let i = 0; i < levels; i++) o = { k: o };
  return o;
};

describe("REVIEW_2 B1: non-string plan accept is invalid and never crashes", () => {
  const accepts: [string, unknown][] = [
    ["number", 42],
    ["small object", { a: 1 }],
    ["array", ["x", "y"]],
    ["boolean", true],
    ["null", null],
    ["object nested 10,000 levels", deepObject(10_000)],
  ];
  const base: RoomEvent[] = [
    ev(1, "claude", "open", "start"),
    ev(2, "claude", "plan", "Plan", { plan: PLAN_V1 }),
    ev(3, "claude", "step", "go", { step: { index: 0, state: "done" } }),
  ];

  for (const [name, accept] of accepts) {
    it(`accept ${name}: event ignored and counted, fold / contractHash do not throw`, () => {
      const badPlan = bad(ev(10, "claude", "plan", "P"), { plan: { title: "T", steps: [{ text: "s", accept }] } });
      const input = [...base, badPlan, ev(20, "claude", "close", "done")];
      let res: ReturnType<typeof foldRoomWithStats> | undefined;
      expect(() => { res = foldRoomWithStats(input); }).not.toThrow();
      expect(() => foldRoom(input)).not.toThrow();
      const { states, invalid } = res!;
      expect(invalid).toBe(1);
      expect(states).toHaveLength(1);
      expect(states[0]!.contract?.title).toBe(PLAN_V1.title);
      expect(states[0]!.contract?.version).toBe(1);
      expect(states[0]!.stepStates[0]).toBe("done");
      expect(states[0]!.closed).toBe(true);
      for (const s of states) {
        if (s.contract) expect(() => contractHash(s.contract!)).not.toThrow();
        if (s.previous) expect(() => contractHash(s.previous!)).not.toThrow();
      }
    });

    it(`accept ${name}: lone invalid plan creates no state contract`, () => {
      const badPlan = bad(ev(10, "claude", "plan", "P"), { plan: { title: "T", steps: [{ text: "s", accept }] } });
      let res: ReturnType<typeof foldRoomWithStats> | undefined;
      expect(() => { res = foldRoomWithStats([badPlan]); }).not.toThrow();
      expect(res!.invalid).toBe(1);
      for (const s of res!.states) expect(s.contract).toBeUndefined();
    });
  }

  it("contractHash does not throw on shallow non-string accept values", () => {
    for (const accept of [42, { a: 1 }, ["x"], true, null]) {
      const c = { title: "T", steps: [{ text: "s", accept }] } as unknown as { title: string; steps: { text: string }[] };
      expect(() => contractHash(c)).not.toThrow();
    }
  });
});

describe("REVIEW_2 B2: tie-break covers the full canonical JSON of the event", () => {
  const q = (payload: unknown): RoomEvent =>
    bad(ev(5, "claude", "question", "Q?", {}, "q-same"), { payload });

  const pairs: [string, unknown, unknown][] = [
    ["deep nested leaf", { a: { b: { c: { d: { e: { f: "A" } } } } } }, { a: { b: { c: { d: { e: { f: "B" } } } } } }],
    ["shallow value", { a: "A" }, { a: "B" }],
    ["very deep (50 levels) leaf", (() => { let o: unknown = "A"; for (let i = 0; i < 50; i++) o = { k: o }; return o; })(),
      (() => { let o: unknown = "B"; for (let i = 0; i < 50; i++) o = { k: o }; return o; })()],
    ["array element", { l: [1, 2, [3, [4, [5, [6, "A"]]]]] }, { l: [1, 2, [3, [4, [5, [6, "B"]]]]] }],
  ];

  for (const [name, pa, pb] of pairs) {
    it(`identical id + lamport, differing extra field (${name}): same output for both input orders`, () => {
      const a = q(pa);
      const b = q(pb);
      const forward = foldRoom(structuredClone([ev(1, "claude", "open", "x"), a, b]));
      const reverse = foldRoom(structuredClone([b, a, ev(1, "claude", "open", "x")]));
      expect(reverse).toEqual(forward);
      const f2 = foldRoomWithStats(structuredClone([a, b]));
      const r2 = foldRoomWithStats(structuredClone([b, a]));
      expect(r2).toEqual(f2);
    });
  }

  it("permutations of three colliding events fold identically", () => {
    const evs = [q({ a: { b: { c: { d: { e: { f: "A" } } } } } }), q({ a: { b: { c: { d: { e: { f: "B" } } } } } }), q({ a: { b: { c: { d: { e: { f: "C" } } } } } })];
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const outs = perms.map((p) => foldRoom(structuredClone(p.map((i) => evs[i]!))));
    for (const o of outs) expect(o).toEqual(outs[0]);
  });
});

describe("REVIEW_2 B3: edits of active / done steps are drift", () => {
  const prev = contract("Plan", ["Prepare build", "Ship reviewed build", "Announce"]);
  const next = contract("Plan", ["Prepare build", "Ship unreviewed build", "Announce"]);
  const stateWith = (stepStates: StepState[]): AgentState => mkState({ contract: prev, stepStates });

  it("diffPlans reports exactly one edit and nothing else", () => {
    const d = diffPlans(prev, next);
    expect(d.edited).toEqual([{ from: "Ship reviewed build", to: "Ship unreviewed build" }]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.reordered).toBe(false);
  });

  it("single-step plan: edit of an active step is drift", () => {
    const p = contract("P", ["Ship reviewed build"]);
    const n = contract("P", ["Ship unreviewed build"]);
    const v = driftRules(diffPlans(p, n), mkState({ contract: p, stepStates: ["active"] }));
    expect(v.verdict).toBe("drift");
    expect(v.source).toBe("rules");
  });

  it("single-step plan: edit of a done step is drift", () => {
    const p = contract("P", ["Ship reviewed build"]);
    const n = contract("P", ["Ship unreviewed build"]);
    expect(driftRules(diffPlans(p, n), mkState({ contract: p, stepStates: ["done"] })).verdict).toBe("drift");
  });

  for (const st of ["active", "done"] as const) {
    it(`edit of the ${st} middle step is drift (other steps pending / done)`, () => {
      const v = driftRules(diffPlans(prev, next), stateWith(["done", st, "pending"]));
      expect(v.verdict).toBe("drift");
      expect(v.source).toBe("rules");
      expect(v.reason.length).toBeGreaterThan(0);
      expect(v.reason.length).toBeLessThanOrEqual(140);
    });
  }

  it("edit of a pending step stays on_track even when other steps are done or active", () => {
    expect(driftRules(diffPlans(prev, next), stateWith(["done", "pending", "pending"])).verdict).toBe("on_track");
    expect(driftRules(diffPlans(prev, next), stateWith(["active", "pending", "active"])).verdict).toBe("on_track");
    expect(driftRules(diffPlans(prev, next), stateWith(["pending", "pending", "pending"])).verdict).toBe("on_track");
  });

  it("edit of an active/done step is never on_track, regardless of other edits of pending steps", () => {
    const n2 = contract("Plan", ["Prepare build", "Ship unreviewed build", "Announce widely"]);
    const v = driftRules(diffPlans(prev, n2), stateWith(["pending", "active", "pending"]));
    expect(v.verdict).not.toBe("on_track");
    expect(v.verdict).toBe("drift");
  });
});

describe("REVIEW_2 B4: toTaskVM survives timestamps outside the Date range", () => {
  const base = mkState({ contract: contract("Plan", ["a", "b"]), lastSeen: T0 });
  const nows: [string, number][] = [
    ["Number.MAX_VALUE", Number.MAX_VALUE],
    ["-Number.MAX_VALUE", -Number.MAX_VALUE],
    ["8.64e15 + 1", 8.64e15 + 1],
    ["-8.64e15 - 1", -8.64e15 - 1],
  ];

  for (const [name, nowMs] of nows) {
    it(`nowMs = ${name}: no throw, TaskVM returned`, () => {
      let vm: ReturnType<typeof toTaskVM> | undefined;
      expect(() => { vm = toTaskVM(base, { workspace: "w", nowMs }); }).not.toThrow();
      expect(vm).toBeDefined();
      expect(typeof vm!.id).toBe("string");
      expect(typeof vm!.title).toBe("string");
      expect(typeof vm!.updated).toBe("string");
      expect(Array.isArray(vm!.steps)).toBe(true);
    });
  }

  const lastSeens: [string, number][] = [
    ["Number.MAX_VALUE", Number.MAX_VALUE],
    ["-Number.MAX_VALUE", -Number.MAX_VALUE],
    ["8.64e15 + 1", 8.64e15 + 1],
    ["-8.64e15 - 1", -8.64e15 - 1],
  ];

  for (const [name, lastSeen] of lastSeens) {
    it(`lastSeen = ${name}: no throw, TaskVM returned`, () => {
      const s = mkState({ contract: contract("Plan", ["a"]), lastSeen });
      let vm: ReturnType<typeof toTaskVM> | undefined;
      expect(() => { vm = toTaskVM(s, { workspace: "w", nowMs: T0 }); }).not.toThrow();
      expect(vm).toBeDefined();
      expect(typeof vm!.updated).toBe("string");
    });
  }

  it("both extremes together, with and without a plan", () => {
    for (const s of [mkState({ lastSeen: Number.MAX_VALUE }), mkState({ contract: contract("P", ["a"]), lastSeen: -Number.MAX_VALUE })]) {
      expect(() => toTaskVM(s, { workspace: "w", nowMs: Number.MAX_VALUE })).not.toThrow();
      expect(() => toTaskVM(s, { workspace: "w", nowMs: -Number.MAX_VALUE, silentAfterMs: 0 })).not.toThrow();
    }
  });
});
