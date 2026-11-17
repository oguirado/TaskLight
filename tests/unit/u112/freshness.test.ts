import { describe, expect, it } from "vitest";
import { deriveSwarmViewModel } from "../../../src/app/swarm_vm";
import type { SwarmViewModel } from "../../../src/app/swarm_vm";
import type { PlanMicrotask } from "../../../src/plan/types";
import { beat, deterministic, freeze, input, micro, NOW, projection, row, task } from "./fixtures";
import type { Input } from "./fixtures";

deterministic();
type Live = NonNullable<PlanMicrotask["live"]>;
const withLive = (live: Live | undefined, connected = true): Input => input({ connected,
  projection: projection([task("T01", { microtasks: [live === undefined ? micro() : micro("T01.M01", { live })] })]) });
function assertUnknown(vm: SwarmViewModel): void {
  expect(row(vm).activity).toBe("unknown"); expect(vm.refresh_at_ms).toBeNull();
}
const invalid: { name: string; live: Live | undefined }[] = [
  { name: "absent beat", live: undefined },
  { name: "future timestamp", live: beat({ beat_ts: NOW + 1 }) },
  { name: "foreign owner", live: beat({ agent: "phantom" }) },
  { name: "empty run ID", live: beat({ run_id: "" }) },
  { name: "space in run ID", live: beat({ run_id: "bad run" }) },
  { name: "newline in run ID", live: beat({ run_id: "run\n" }) },
  { name: "oversized run ID", live: beat({ run_id: "a".repeat(65) }) },
  { name: "non-string run ID", live: { ...beat(), run_id: 1 } as unknown as Live },
  { name: "missing run ID", live: { agent: "executor-a", beat_ts: NOW, beat_lamport: 1 } as Live },
  { name: "negative timestamp", live: beat({ beat_ts: -1 }) },
  { name: "NaN timestamp", live: beat({ beat_ts: NaN }) },
  { name: "infinite timestamp", live: beat({ beat_ts: Infinity }) },
  { name: "string timestamp", live: { ...beat(), beat_ts: String(NOW) } as unknown as Live },
  { name: "missing timestamp", live: { agent: "executor-a", run_id: "run", beat_lamport: 1 } as Live },
  { name: "zero Lamport", live: beat({ beat_lamport: 0 }) },
  { name: "negative Lamport", live: beat({ beat_lamport: -1 }) },
  { name: "fractional Lamport", live: beat({ beat_lamport: 1.5 }) },
  { name: "unsafe Lamport", live: beat({ beat_lamport: Number.MAX_SAFE_INTEGER + 1 }) },
  { name: "NaN Lamport", live: beat({ beat_lamport: NaN }) },
  { name: "missing Lamport", live: { agent: "executor-a", run_id: "run", beat_ts: NOW } as Live },
];
describe("A2 / M5 inclusive freshness and structural validation", () => {
  it.each([0, 89_999, 90_000])("A2 beat age %i is Working through the inclusive boundary", age => {
    const vm = deriveSwarmViewModel(withLive(beat({ beat_ts: NOW - age })));
    expect(row(vm)).toMatchObject({ activity: "working", last_beat_ts: NOW - age, last_beat_age_ms: age });
    expect(vm.refresh_at_ms).toBe(NOW - age + 90_001);
  });
  it("A2 stale structurally valid beat is retained as evidence but cannot show Working", () => {
    const vm = deriveSwarmViewModel(withLive(beat({ beat_ts: NOW - 90_001 })));
    assertUnknown(vm); expect(row(vm)).toMatchObject({ last_beat_ts: NOW - 90_001, last_beat_age_ms: 90_001 });
  });
  it.each(invalid)("A2 rejects $name and keeps absent last-beat evidence null", ({ live }) => {
    const vm = deriveSwarmViewModel(freeze(withLive(live)));
    assertUnknown(vm); expect(row(vm).last_beat_ts).toBeNull(); expect(row(vm).last_beat_age_ms).toBeNull();
  });
  it("A2 disconnected active work is unknown with no refresh but retains valid beat evidence", () => {
    const vm = deriveSwarmViewModel(withLive(beat(), false));
    assertUnknown(vm); expect(row(vm)).toMatchObject({ last_beat_ts: NOW - 1_000, last_beat_age_ms: 1_000 });
  });
  it("A2 rederivation at refresh_at_ms expires freshness without new events or timers", () => {
    const i = freeze(withLive(beat({ beat_ts: NOW - 90_000 })));
    const first = deriveSwarmViewModel(i);
    expect(row(first).activity).toBe("working"); expect(first.refresh_at_ms).toBe(NOW + 1);
    const expired = deriveSwarmViewModel({ ...i, nowMs: first.refresh_at_ms! });
    assertUnknown(expired); expect(row(expired).last_beat_age_ms).toBe(90_001);
    expect(expired.progress).toEqual(first.progress); expect(row(expired).tasks).toEqual(row(first).tasks);
  });
  it("M5 last beat is latest valid selected-task evidence, including non-active microtasks", () => {
    const vm = deriveSwarmViewModel(input({ projection: projection([
      task("T01", { microtasks: [
        micro("T01.M01", { live: beat({ beat_ts: NOW - 10_000 }) }),
        micro("T01.M02", { state: "done", live: beat({ beat_ts: NOW - 100 }) }),
        micro("T01.M03", { live: beat({ agent: "other", beat_ts: NOW - 1 }) }),
        micro("T01.M04", { live: beat({ beat_ts: NOW + 1 }) }),
      ] }), task("T02", { microtasks: [micro("T02.M01", { live: beat({ beat_ts: NOW }) })] }),
    ]) }));
    expect(row(vm)).toMatchObject({ current_task_id: "T01", last_beat_ts: NOW - 100, last_beat_age_ms: 100 });
    expect(vm.refresh_at_ms).toBe(NOW + 80_001);
  });
  it("M5 another owned task's beat cannot lend liveness to the selected task", () => {
    const vm = deriveSwarmViewModel(input({ projection: projection([
      task("T01", { microtasks: [micro()] }), task("T02"),
    ]) }));
    assertUnknown(vm); expect(row(vm)).toMatchObject({ current_task_id: "T01", last_beat_ts: null, last_beat_age_ms: null });
  });
  it("M5 selects earliest active-beat expiry across Working agents only", () => {
    const vm = deriveSwarmViewModel(input({ projection: projection([
      task("T01", { microtasks: [micro("T01.M01", { live: beat({ beat_ts: NOW - 20_000 }) }), micro("T01.M02", { live: beat() })] }),
      task("T02", { assignee: "executor-b", microtasks: [micro("T02.M01", { live: beat({ agent: "executor-b", beat_ts: NOW - 30_000 }) })] }),
      task("T03", { assignee: "executor-c", explicit_state: "blocked", blocked_reason: "Stopped", microtasks: [micro("T03.M01", { live: beat({ agent: "executor-c", beat_ts: NOW - 90_000 }) })] }),
      task("T04", { assignee: "executor-d", microtasks: [micro("T04.M01", { state: "pending", live: beat({ agent: "executor-d", beat_ts: NOW - 90_000 }) })] }),
    ]) }));
    expect(vm.agents.map(a => a.activity)).toEqual(["working", "working", "blocked", "idle"]);
    expect(vm.refresh_at_ms).toBe(NOW + 60_001);
  });
  it("Amendment B disconnect removes all scheduled refreshes", () => {
    const vm = deriveSwarmViewModel(input({ connected: false }));
    expect(vm.refresh_at_ms).toBeNull(); expect(row(vm).activity).toBe("unknown");
  });
});

describe("A7 negative control", () => {
  it("A7 the same A2 assertions reject an any-beat-means-Working mutant", () => {
    // Corrupt observable liveness only; no source edits or replacement product implementation.
    for (const live of [beat({ beat_ts: NOW - 90_001 }), beat({ beat_ts: NOW + 1 }), beat({ agent: "other" })]) {
      const actual = deriveSwarmViewModel(withLive(live));
      assertUnknown(actual);
      const mutant: SwarmViewModel = { ...actual, agents: actual.agents.map(a => ({ ...a, activity: "working" })) };
      expect(() => assertUnknown(mutant)).toThrow();
    }
  });
});
