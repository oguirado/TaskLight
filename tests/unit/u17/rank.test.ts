import { describe, expect, test } from "vitest";
import { rankNeedsYou } from "../../../src/digest";
import type { DigestItem } from "../../../src/schema";
import { NOW, cap, pid, shuffled } from "./helpers";

const it = (projectId: string, attention: DigestItem["attention"], reason = "r-" + projectId): DigestItem => ({ projectId, reason, attention });

describe("rankNeedsYou (B9, B10)", () => {
  const caps = () => [
    cap("p1", { status: "running", waiting: 1000 }), cap("p2", { status: "running", waiting: 1000 }), cap("p3", { status: "running", waiting: 1000 }),
    cap("p4", { status: "blocked", waiting: 100 }), cap("p5", { status: "waiting_input", waiting: 100 }),
    cap("p6", { status: "running", waiting: 9000 }), cap("p7", { status: "running", waiting: 9000 }),
  ];
  const model = () => [it("p3", "low"), it("p1", "now"), it("p2", "high"), it("p4", "high"), it("p5", "high"), it("p6", "high"), it("p7", "high")];
  const EXPECT = ["p1", "p4", "p5", "p6", "p7", "p2", "p3"];

  test("O7 exact order: attention, then status, then waiting_ms desc, then projectId asc; ranks 1..n", () => {
    const r = rankNeedsYou(model(), caps(), NOW);
    expect(r.map((x) => x.projectId)).toEqual(EXPECT);
    expect(r.map((x) => x.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  test("O7 identical across 5 shuffles of model and capsule order", () => {
    for (let s = 1; s <= 5; s++) {
      const r = rankNeedsYou(shuffled(model(), s), shuffled(caps(), s + 10), NOW);
      expect(r.map((x) => x.projectId), "shuffle " + s).toEqual(EXPECT);
    }
  });
  test("status priority is blocked > failed > waiting_input > running > idle > done", () => {
    const sts = ["done", "idle", "running", "waiting_input", "failed", "blocked"];
    const cs = sts.map((s, i) => cap(pid(i + 1), { status: s, waiting: 500 }));
    const m = cs.map((c) => it(c.projectId, "high"));
    expect(rankNeedsYou(m, cs, NOW).map((x) => x.projectId)).toEqual([pid(6), pid(5), pid(4), pid(3), pid(2), pid(1)]);
  });
  test("by is 'model' for model items and reasons pass through", () => {
    const r = rankNeedsYou([it("p1", "high", "needs review")], [cap("p1")], NOW);
    expect(r).toEqual([{ projectId: "p1", reason: "needs review", attention: "high", rank: 1, by: "model" }]);
  });
  test("effective attention is the higher of the model item and the capsule", () => {
    const r = rankNeedsYou([it("p1", "low"), it("p2", "high")], [cap("p1", { attention: "now" }), cap("p2", { attention: "low" })], NOW);
    expect(r.map((x) => x.projectId)).toEqual(["p1", "p2"]);
    expect(r[0]!.attention).toBe("now");
    expect(r[1]!.attention).toBe("high");
  });
  test("non-floor items with effective attention none are dropped; the rest stay", () => {
    const r = rankNeedsYou([it("p1", "none"), it("p2", "low")], [cap("p1"), cap("p2")], NOW);
    expect(r.map((x) => x.projectId)).toEqual(["p2"]);
  });
  test("O8 rule floor: blocked p2 appears with by:'rule' and reason 'status: blocked' when the model returns []", () => {
    const cs = [cap("p1", { status: "running" }), cap("p2", { status: "blocked" }), cap("p3", { status: "running" })];
    const r = rankNeedsYou([], cs, NOW);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ projectId: "p2", by: "rule", reason: "status: blocked", rank: 1 });
  });
  test("O8 neg: with no floor capsule an empty model output stays empty", () => {
    expect(rankNeedsYou([], [cap("p1"), cap("p2", { status: "idle" }), cap("p3", { status: "done", attention: "low" })], NOW)).toEqual([]);
  });
  test("floor members: attention now/high or status blocked/failed/waiting_input, all by rule when omitted", () => {
    const cs = [cap("a", { attention: "now" }), cap("b", { attention: "high" }), cap("c", { status: "failed" }),
      cap("d", { status: "waiting_input" }), cap("e", { attention: "low" }), cap("f", { status: "idle" })];
    const r = rankNeedsYou(null, cs, NOW);
    expect(r.map((x) => x.projectId).sort()).toEqual(["a", "b", "c", "d"]);
    for (const x of r) expect(x.by).toBe("rule");
    expect(r.find((x) => x.projectId === "a")!.reason).toBe("status: running");
  });
  test("a floor capsule the model listed with attention none is kept (floor beats the none-drop)", () => {
    const r = rankNeedsYou([it("p2", "none", "model says none")], [cap("p2", { status: "blocked" })], NOW);
    expect(r.map((x) => x.projectId)).toEqual(["p2"]);
    expect(r[0]!.by).toBe("model");
  });
  test("model null (call failed) yields the floor only", () => {
    const r = rankNeedsYou(null, [cap("p1", { status: "blocked" }), cap("p2")], NOW);
    expect(r.map((x) => x.projectId)).toEqual(["p1"]);
  });
  test("items for unknown projects are dropped (no cross-project mix-up)", () => {
    const r = rankNeedsYou([it("ghost", "now"), it("p1", "high")], [cap("p1")], NOW);
    expect(r.map((x) => x.projectId)).toEqual(["p1"]);
  });
  test("duplicate model items for one project collapse to a single entry", () => {
    const r = rankNeedsYou([it("p1", "low"), it("p1", "now")], [cap("p1")], NOW);
    expect(r).toHaveLength(1);
    expect(r[0]!.attention).toBe("now");
  });
  test("private capsule in the floor: id, status and rule reason only, no text anywhere", () => {
    const r = rankNeedsYou([], [cap("p1", { tier: "private", status: "blocked", headline: "PRIV-HL" })], NOW);
    expect(JSON.stringify(r)).not.toContain("PRIV-HL");
    expect(r[0]).toMatchObject({ projectId: "p1", by: "rule", reason: "status: blocked" });
  });
  test("O9 cap_12: 15 floor capsules -> 12 items, ranks 1..12, the 3 lowest-priority dropped", () => {
    const cs = Array.from({ length: 15 }, (_, k) => cap(pid(k + 1), { status: "blocked", attention: "now", waiting: (16 - (k + 1)) * 1000 }));
    const r = rankNeedsYou([], shuffled(cs, 3), NOW);
    expect(r).toHaveLength(12);
    expect(r.map((x) => x.rank)).toEqual(Array.from({ length: 12 }, (_, k) => k + 1));
    expect(r.map((x) => x.projectId)).toEqual(Array.from({ length: 12 }, (_, k) => pid(k + 1)));
  });
  test("cross-lens: a study capsule with attention now is in the floor; a study 'stuck' status alone is not (not a U17 floor status)", () => {
    const cs = [cap("s1", { lens: "study", status: "reading", attention: "now" }), cap("s2", { lens: "study", status: "stuck", attention: "none" })];
    const r = rankNeedsYou([], cs, NOW);
    expect(r.map((x) => x.projectId)).toEqual(["s1"]);
  });
  test("pure: does not mutate its inputs", () => {
    const m = model(); const c = caps(); const a = JSON.stringify([m, c]);
    rankNeedsYou(m, c, NOW);
    expect(JSON.stringify([m, c])).toBe(a);
  });
});
