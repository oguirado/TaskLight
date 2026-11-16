import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createAgentStore } from "../../../src/app/agent_store";
import { resolveStarterTemplate } from "../../../src/app/starter_templates";
import { buildPlanSnapshots } from "../../../src/app/plan_snapshots";
import { createPlanWiring, type RoomPlanSnapshot } from "../../../src/app/plan_wiring";
import { fakeClock, snapshot, task } from "../u64/helpers";

function hosted(getSnapshots: () => readonly RoomPlanSnapshot[]) {
  const time = fakeClock();
  let received = new Map<string, { text: string; source: string }>();
  const wiring = createPlanWiring({
    clock: time.clock, getSnapshots,
    getServices: () => null, getDriftFactory: () => null,
    driftPortFromFactory: () => { throw new Error("No model"); },
    adaptDriftPort: port => port,
    onUpdate: () => {
      received = new Map([...wiring.planBriefs()].map(([room, value]) => [room, { text: value.brief, source: value.source }]));
    },
  });
  return { ...time, wiring, brief: (room: string) => received.get(room)?.text };
}

it("refreshes the wall feed after an empty plan gains tasks at a higher revision", async () => {
  let current = { ...snapshot([], "demo"), doneMicrotasks: 0 };
  const h = hosted(() => [current]);
  try {
    h.wiring.notifyChange();
    await h.advance();
    expect(h.brief("demo")).toBe("Next: none; 0 blocked");
    current = { ...current, rev: 5, totalMicrotasks: 3, tasks: [
      { ...task("T01", 2), title: "Read report module", status: "pending" },
      { ...task("T02", 3), status: "pending", deps: ["T01"] },
      { ...task("T03", 4), status: "pending", deps: ["T02"] },
    ] };
    h.wiring.notifyChange();
    await h.advance();
    expect(h.brief("demo")).toContain("Next: T01 Read report module");
  } finally { h.wiring.dispose(); }
});

it("refreshes the wall brief while real MCP events arrive incrementally", async () => {
  const events = readFileSync("fixtures/plan/capsule_c2b.events.jsonl", "utf8").trim().split("\n").map(line => JSON.parse(line));
  const store = createAgentStore({ templates: resolveStarterTemplate });
  const h = hosted(() => buildPlanSnapshots(store.plans()));
  let emptyBrief = false;
  try {
    for (const event of events) {
      expect(store.ingest(event)).toBe(true);
      h.wiring.notifyChange();
      await h.advance();
      if (event.op?.kind === "plan.open") {
        expect(h.brief("demo")).toBe("Next: none; 0 blocked");
        emptyBrief = true;
      }
    }
    expect(emptyBrief).toBe(true);
    expect(h.brief("demo")).toContain("Next: T01 Write the product brief");
    expect(h.brief("demo")).toContain("T02 waits for T01");
    expect(h.brief("demo")).toContain("T03 waits for T02");
  } finally { h.wiring.dispose(); }
});
