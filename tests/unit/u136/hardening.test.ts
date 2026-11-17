import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { deriveSwarmViewModel } from "../../../src/app/swarm_vm";
import { beat, deterministic, freeze, input, micro, projection, registration, task } from "./fixtures";

deterministic();
it("Hardening correctness: frozen swarm-vm-derive fixture agrees with every projection task and selected-task count", () => {
  const slugs = Array.from({ length: 15 }, (_, i) => `executor-${String(i).padStart(2, "0")}`);
  const tasks = Array.from({ length: 40 }, (_, i) => {
    const id = `T${String(i + 1).padStart(2, "0")}`, owner = slugs[i % slugs.length]!;
    return task(id, { assignee: owner, microtasks: Array.from({ length: 12 }, (_, j) =>
      micro(`${id}.M${String(j + 1).padStart(2, "0")}`, j < 4 ? { state: "done" } : { live: beat({ agent: owner }) })) });
  });
  const p = projection(tasks, Object.fromEntries(slugs.map(s => [s, registration()]))), i = freeze(input({ projection: p }));
  const hash = createHash("sha256").update(JSON.stringify(i)).digest("hex");
  // This identifies the bounded correctness fixture; it is not a latency benchmark or ADMIT evidence.
  expect(hash).toBe("7d5c21afdd2fa6aae4e1fb05bdcd40b7b919648ebb871e833666a71e3cc93b19");
  const before = structuredClone(i), vm = deriveSwarmViewModel(i);
  expect(vm.agents.map(a => a.agent).sort()).toEqual(slugs); expect(vm.progress).toEqual(p.rollup);
  expect(p.rollup).toMatchObject({ tasks_total: 40, micro_total: 480, micro_done: 160 });
  for (const a of vm.agents) {
    const owned = tasks.filter(t => t.assignee === a.agent);
    expect(a.tasks).toEqual(owned);
    expect(a).toMatchObject({ lifecycle: "alive", current_task_id: owned[0]!.id,
      active_micro_id: `${owned[0]!.id}.M05`, micro_done: 4, micro_total: 12, activity: "working" });
  }
  expect(i).toEqual(before);
});
