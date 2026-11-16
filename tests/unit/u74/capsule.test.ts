import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { createAgentStore, toWallVM } from "../../../src/app/agent_store";
import { resolveStarterTemplate } from "../../../src/app/starter_templates";
import { buildPlanSnapshots } from "../../../src/app/plan_snapshots";
import { createPlanWiring } from "../../../src/app/plan_wiring";
import { mountWall } from "../../../src/views";
import { fakeClock } from "../u64/helpers";
import type { DriftVerdict } from "../../../src/agents/types";

const events = readFileSync("fixtures/plan/capsule_c2b.events.jsonl", "utf8").trim().split("\n").map(line => JSON.parse(line));
afterEach(() => document.body.replaceChildren());
function storeForCapsule() {
  const store = createAgentStore({ templates: resolveStarterTemplate });
  for (const e of events) expect(store.ingest(e)).toBe(true);
  return store;
}
async function hosted(store = storeForCapsule()) {
  const time = fakeClock();
  const wiring = createPlanWiring({
    clock: time.clock, getSnapshots: () => buildPlanSnapshots(store.plans()),
    getServices: () => null, getDriftFactory: () => null,
    driftPortFromFactory: () => { throw new Error("No model"); },
    adaptDriftPort: p => p, onUpdate: () => {},
  });
  wiring.notifyChange(); await time.advance();
  const verdicts = new Map<string, DriftVerdict>();
  for (const [key, value] of wiring.taskVerdicts()) verdicts.set(`plan:${key}`, value);
  const briefs = new Map([...wiring.planBriefs()].map(([room, value]) => [room, { text: value.brief, source: value.source }]));
  const vm = toWallVM(store.states(), new Map(), {
    nowMs: events.at(-1).ts, model: { state: "unavailable", label: "" }, network: "online",
    userAgent: "human", planVerdicts: verdicts, planBriefs: briefs,
  }, store.plans());
  wiring.dispose();
  return { vm, verdicts, briefs };
}
it("the real hosted rules brief names ready T01 and both waiting dependencies", async () => {
  const { vm, briefs } = await hosted();
  expect(briefs.get("demo")?.source).toBe("rules");
  expect(vm.plan?.brief).toContain("Next: T01 Write the product brief");
  expect(vm.plan?.brief).toContain("T02 waits for T01");
  expect(vm.plan?.brief).toContain("T03 waits for T02");
});
it("focus includes each task only once and only for a needs_user verdict", async () => {
  const { vm, verdicts } = await hosted();
  expect([...verdicts].filter(([, v]) => v.verdict === "needs_user").map(([key]) => key)).toEqual(["plan:demo:T03"]);
  const host = document.createElement("div"); document.body.append(host);
  const wall = mountWall(host, vm);
  expect([...host.querySelectorAll(".focus-link")].map(a => a.getAttribute("href"))).toEqual(["#plan:demo:T03"]);
  expect(host.querySelector(".focus-project")?.textContent).toBe("T03 Build the metrics API");
  expect(host.querySelector(".focus-eyebrow")?.textContent).toBe("1 task needs you");
  expect(host.querySelector(".ws-needs")?.textContent).toBe("1");
  wall.update({ ...vm, tasks: [...vm.tasks, ...vm.tasks] });
  expect(host.querySelectorAll(".focus-link")).toHaveLength(1);
  wall.destroy();
});
it("completed dependencies stop being waits in the hosted brief", async () => {
  const store = storeForCapsule();
  for (const [i, micro_id] of ["T01.M01", "T01.M02"].entries()) {
    expect(store.ingest({ act: "op", agent: "claude-code", room: "demo", text: "", id: `e-${(100 + i).toString(16).padStart(16, "0")}`, lamport: 13 + i,
      ts: events.at(-1).ts + i + 1, op: { kind: "micro.set", micro_id, state: "done", outcome: "Verified" } })).toBe(true);
  }
  const { vm } = await hosted(store);
  expect(vm.plan?.brief).toContain("Next: T02");
  expect(vm.plan?.brief).not.toContain("T02 waits for T01");
  expect(vm.plan?.brief).toContain("T03 waits for T02");
});

it("plan focus follows verdict changes, including idle needs_user and no pending verdict", async () => {
  const { vm } = await hosted();
  const host = document.createElement("div"); document.body.append(host);
  const tasks = vm.tasks.filter(t => t.taskId);
  const wall = mountWall(host, { ...vm, tasks: tasks.map(t => ({ ...t, nanoVerdict: { verdict: "on_track", reason: "Reviewed", source: { kind: "rules", ms: 0 } } })) });
  expect(host.querySelectorAll(".focus-link")).toHaveLength(0);
  expect(host.querySelector(".ws-needs")).toBeNull();
  wall.update({ ...vm, tasks: tasks.map(t => ({ ...t, status: "idle", nanoVerdict: { verdict: "needs_user", reason: "Clarify acceptance", source: { kind: "rules", ms: 0 } } })) });
  expect(host.querySelectorAll(".focus-link")).toHaveLength(3);
  wall.update({ ...vm, tasks: tasks.map(({ nanoVerdict: _verdict, ...t }) => t) });
  expect(host.querySelectorAll(".focus-link")).toHaveLength(0);
  wall.destroy();
});
