// @vitest-environment node
import { expect, it } from "vitest";
import { createAgentStore, toWallVM } from "../../../src/app/agent_store";
import { foldPlan } from "../../../src/plan";
import { roomEvent } from "../u37c/harness";
import { fixture, NOW } from "../u86/helpers";

it("retains a valid terminal result with large evidence", () => {
  const store = createAgentStore();
  const op = { kind: "agent.lifecycle", run_id: "build-run" };
  const deployed = roomEvent(1, "demo", { act: "op", text: "",
    op: { ...op, state: "deployed", op_id: "deploy-build" } });
  const evidence = Array.from({ length: 20 }, (_, i) => ({
    path: `artifacts/${i}/${"segment/".repeat(49)}result.json`, sha256: "b".repeat(64),
  }));
  const terminal = roomEvent(2, "demo", { act: "op", text: "",
    op: { ...op, state: "finished", op_id: "finish-build", result: { verdict: "OK", evidence } } });
  const expected = foldPlan([deployed, terminal]);
  expect(expected.stats.rejected).toBe(0);
  expect(expected.projection.agent_lifecycle?.["worker-1"]?.lifecycle).toBe("finished");
  expect(store.ingestChecked(deployed)).toBe("accepted");
  expect(store.ingestChecked(terminal)).toBe("accepted");
  expect(store.plan("demo")?.projection).toEqual(expected.projection);
});

it("diary follows the selected workspace", () => {
  const f = fixture();
  for (const room of ["design", "release"]) {
    f.op(room, { kind: "memory.set", section: "notes", text: room + " review", base_rev: 0 });
  }
  const plans = f.store.plans();
  for (const room of ["design", "release"]) {
    const vm = toWallVM([], undefined, { nowMs: NOW, workspace: room, view: "diary",
      model: { state: "unavailable", label: "" }, network: "online" }, plans);
    expect(vm.workspace).toBe(room);
    expect(vm.diary?.map(entry => entry.outcome)).toEqual([room + " review"]);
  }
});

it("imports a journal question with a null reply reference", () => {
  const store = createAgentStore();
  const question = roomEvent(1, "demo", { act: "question", text: "Ready to ship?", re: null });
  const summary = store.ingestJsonl(JSON.stringify(question) + "\n");
  expect(summary).toEqual({ accepted: 1, duplicate: 0, malformed: 0, torn: false });
  expect(store.states()[0]?.openQuestions.map(row => row.text)).toEqual(["Ready to ship?"]);
});
