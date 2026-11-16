import { describe, expect, it, vi } from "vitest";
import { deriveActivity } from "../../../src/app/activity";
import type { PlanTask } from "../../../src/plan/types";
import { live, micro, requireClaimOnlyIdle, task } from "./support";
import type { ActivityMicro } from "./support";

type Options = { connected?: boolean; needsYou?: boolean };
type Case = { name: string; task: PlanTask; selected?: ActivityMicro; now?: number; opts?: Options; expected: string };
const active = micro({ live });
const done = micro({ id: "T01.M04", state: "done" });
const pending = micro({ id: "T01.M02", state: "pending" });
const blocked = micro({ id: "T01.M03", state: "blocked", live });
const cases: Case[] = [
  { name: "cancelled outranks done blocked waiting attention and connection", task: task([done], { state: "cancelled", explicit_state: "cancelled", ready: false }), selected: done, opts: { needsYou: true, connected: false }, expected: "cancelled" },
  { name: "selected done outranks parent blocked waiting and attention", task: task([done, blocked], { state: "blocked", ready: false }), selected: done, opts: { needsYou: true }, expected: "done" },
  { name: "parent entirely done outranks waiting attention and connection", task: task([done], { state: "done", ready: false }), opts: { needsYou: true, connected: false }, expected: "done" },
  { name: "task blocked outranks waiting attention and active live", task: task([active], { state: "blocked", explicit_state: "blocked", ready: false }), selected: active, opts: { needsYou: true }, expected: "blocked" },
  { name: "micro blocked outranks waiting and attention", task: task([blocked], { state: "blocked", ready: false }), selected: blocked, opts: { needsYou: true }, expected: "blocked" },
  { name: "dependency waiting outranks attention and working", task: task([active], { ready: false }), selected: active, opts: { needsYou: true }, expected: "waiting" },
  { name: "attention outranks working", task: task([active]), selected: active, opts: { needsYou: true }, expected: "needs_you" },
  { name: "attention outranks idle", task: task([pending], { state: "pending" }), selected: pending, opts: { needsYou: true }, expected: "needs_you" },
  { name: "pending micro is idle even with live", task: task([micro({ state: "pending", live })]), selected: micro({ state: "pending", live }), expected: "idle" },
  { name: "no active work is idle even disconnected", task: task([pending], { state: "pending" }), opts: { connected: false }, expected: "idle" },
  { name: "empty parent is idle", task: task([], { state: "pending" }), expected: "idle" },
  { name: "partly done plus pending parent is idle", task: task([done, pending]), expected: "idle" },
  { name: "claim alone cannot imply working", task: task([pending], { state: "active" }), expected: "idle" },
  { name: "active without live is unknown", task: task(), selected: micro(), expected: "unknown" },
  { name: "parent active without live is unknown", task: task(), expected: "unknown" },
  { name: "disconnected selected live is unknown", task: task([active]), selected: active, opts: { connected: false }, expected: "unknown" },
  { name: "disconnected parent live is unknown", task: task([active]), opts: { connected: false }, expected: "unknown" },
  { name: "owner mismatch is unknown", task: task([active], { assignee: "mallory" }), selected: active, expected: "unknown" },
  { name: "missing owner is unknown", task: task([active], { assignee: null }), selected: active, expected: "unknown" },
  { name: "working at age zero", task: task([active]), selected: active, now: 1000, expected: "working" },
  { name: "working at inclusive 90000 ms edge A6", task: task([active]), selected: active, now: 91000, expected: "working" },
  { name: "unknown at 90001 ms A6", task: task([active]), selected: active, now: 91001, expected: "unknown" },
  { name: "future beat at now 999 A6", task: task([active]), selected: active, now: 999, expected: "unknown" },
  { name: "NaN now is unknown", task: task([active]), selected: active, now: Number.NaN, expected: "unknown" },
  { name: "infinite now is unknown", task: task([active]), selected: active, now: Number.POSITIVE_INFINITY, expected: "unknown" },
  { name: "negative infinite now is unknown", task: task([active]), selected: active, now: Number.NEGATIVE_INFINITY, expected: "unknown" },
  { name: "parent working child wins over unknown child", task: task([micro({ id: "T01.M02" }), active]), now: 91000, expected: "working" },
  { name: "parent stale children give unknown", task: task([active, done]), now: 91001, expected: "unknown" },
  { name: "parent dependency guards working children", task: task([active], { ready: false }), expected: "waiting" },
  { name: "parent attention guards working children", task: task([active]), opts: { needsYou: true }, expected: "needs_you" },
  { name: "parent blocked guards working child", task: task([active, blocked], { state: "blocked" }), expected: "blocked" },
  { name: "parent mixed done active blocked obeys block guard", task: task([done, micro({ id: "T01.M02", live }), micro({ id: "T01.M03", state: "blocked" })], { state: "blocked" }), expected: "blocked" },
  { name: "selected pending ignores active sibling", task: task([active, pending]), selected: pending, expected: "idle" },
];
for (const [label, value] of [["NaN", Number.NaN], ["infinite", Infinity], ["missing", undefined], ["string", "1000"], ["null", null]] as const) {
  const m = micro({ live: { ...live, beat_ts: value } as unknown as typeof live });
  cases.push({ name: `${label} beat timestamp is unknown`, task: task([m]), selected: m, expected: "unknown" });
}

describe("A6 / M8 activity precedence", () => {
  it.each(cases)("$name", (c) => {
    expect(deriveActivity(c.task, c.selected, c.now === undefined ? 1000 : c.now, c.opts)).toBe(c.expected);
  });

  it("is pure, accepts frozen inputs and never reads the clock", () => {
    const m = micro({ live: { ...live } });
    Object.freeze(m.live);
    Object.freeze(m.evidence);
    Object.freeze(m);
    const t = task([m]);
    Object.freeze(t.deps);
    Object.freeze(t.microtasks);
    Object.freeze(t);
    const opts = Object.freeze({ connected: true, needsYou: false });
    const before = JSON.stringify(t);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("clock read forbidden"); });
    try {
      expect(deriveActivity(t, m, 91000, opts)).toBe("working");
      expect(deriveActivity(t, m, 91001, opts)).toBe("unknown");
      expect(JSON.stringify(t)).toBe(before);
      expect(clock).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it("A7 detects the task-status-only working mutant", () => {
    requireClaimOnlyIdle(deriveActivity);
    expect(() => requireClaimOnlyIdle(() => "working")).toThrow();
  });
});
