import { describe, expect, it } from "vitest";
import type { SwarmAgentVM } from "../../../src/app/swarm_vm";
import { boot, agent, task, micro, vm, input, response, item, run, rules, bytes, promptData, strings } from "./fixtures";

function hardeningVM(reverse = false) {
  // Fifteen identities alone exceed the byte budget; no title/history payload can help them fit.
  const categories = ["needs_you", "failed", "blocked", "liveness_unknown", "waiting", "working", "finished"] as const;
  const agents: SwarmAgentVM[] = Array.from({ length: 15 }, (_, n) => {
    const category = categories[n % categories.length]!;
    const id = `agent-long-${String(n).padStart(2, "0")}-${"界😀".repeat(80)}`;
    const tasks = Array.from({ length: 40 }, (_, t) => task(`T${String(t + 1).padStart(2, "0")}`, id, {
      microtasks: Array.from({ length: 12 }, (_, m) => micro(`T${String(t + 1).padStart(2, "0")}.M${String(m + 1).padStart(2, "0")}`, {
        text: "MICRO_TITLE_MUST_NOT_LEAK", outcome: "EVIDENCE_BODY_MUST_NOT_LEAK",
      })),
    })).filter((_, t) => t % 15 === n);
    return agent(id, tasks[0]!.id, { tasks, active_micro_id: tasks[0]!.microtasks[0]!.id, micro_total: 12,
      lifecycle: category === "failed" ? "failed" : category === "finished" ? "finished" : "alive",
      activity: category === "liveness_unknown" ? "unknown" : category === "failed" ? "working" : category === "finished" ? "done" : category,
      unanswered_questions: category === "needs_you" ? 1 : 0 });
  });
  return vm(reverse ? agents.reverse() : agents);
}
function included(data: Record<string, unknown>, members: readonly SwarmAgentVM[]): string[] {
  const values = strings(data);
  return [...new Set(values.filter(value => members.some(a => a.agent === value)))];
}
function bound(prompt: string): void { expect(bytes(prompt)).toBeLessThanOrEqual(4096); }
const order = ["needs_you", "failed", "blocked", "liveness_unknown", "waiting", "working", "finished"];
function rank(a: SwarmAgentVM): number {
  if (a.activity === "needs_you" || a.unanswered_questions > 0) return 0;
  if (a.lifecycle === "failed") return 1;
  if (a.activity === "blocked" || a.waiting_on.length > 0) return 2;
  if (a.activity === "unknown") return 3;
  if (a.activity === "waiting") return 4;
  if (a.lifecycle === "finished" || a.activity === "done" || a.activity === "cancelled") return 6;
  return order.indexOf("working");
}

describe("narrator-context-budget", () => {
  it("M4 15 agents and 40 tasks by 12 microtasks obey the final UTF-8 bound pre-invocation", async () => {
    const fixture = hardeningVM();
    const r = boot(prompt => { bound(prompt); return response({ items: [] }); });
    const snapshot = await run(r, input({ vm: fixture }));
    expect(r.generate).toHaveBeenCalledTimes(1);
    const prompt = r.prompts[0]!; bound(prompt);
    const data = promptData(prompt); const present = included(data, fixture.agents);
    expect(present.length).toBeGreaterThan(0); expect(present.length).toBeLessThan(15);
    expect(data.omitted_agents).toBe(15 - present.length);
    expect(snapshot.text).toContain(`Omitted: ${15 - present.length}`);
    const expected = [...fixture.agents].sort((a, b) => rank(a) - rank(b) || (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));
    expect(present).toEqual(expected.slice(0, present.length).map(a => a.agent));
    for (const forbidden of ["TITLE_MUST_NOT_LEAK", "MICRO_TITLE_MUST_NOT_LEAK", "ACCEPT_MUST_NOT_LEAK",
      "EVIDENCE_BODY_MUST_NOT_LEAK", "HARNESS_MUST_NOT_LEAK"])
      expect(prompt).not.toContain(forbidden);
    for (const retained of strings(data).filter(s => s.startsWith("agent-long-")))
      expect(fixture.agents.map(a => a.agent)).toContain(retained);
    const current = new Set(fixture.agents.map(a => a.current_task_id));
    for (const t of fixture.agents.flatMap(a => a.tasks))
      if (!current.has(t.id)) expect(strings(data)).not.toContain(t.id);
  });

  it("C.M4 input permutations keep deterministic priority and codepoint omissions", async () => {
    const first = boot(() => response({ items: [] }));
    await run(first, input({ vm: hardeningVM() }));
    const second = boot(() => response({ items: [] }));
    await run(second, input({ vm: hardeningVM(true) }));
    const a = promptData(first.prompts[0]!); const b = promptData(second.prompts[0]!);
    expect(included(a, hardeningVM().agents)).toEqual(included(b, hardeningVM().agents));
    expect(a.omitted_agents).toBe(b.omitted_agents);
  });

  it("C.M4 tie-breaking uses codepoint order rather than input or locale order", async () => {
    const ids = ["z", "ä", "a", "Z", "A", "😀"].map(s => `${s}-${"界".repeat(250)}`);
    const fixture = vm(ids.map((id, n) => agent(id, `T${n + 1}`)));
    const r = boot(() => response({ items: [] })); await run(r, input({ vm: fixture }));
    const data = promptData(r.prompts[0]!); const present = included(data, fixture.agents);
    expect(present.length).toBeGreaterThan(0); expect(present.length).toBeLessThan(ids.length);
    expect(present).toEqual([...ids].sort((a, b) => a < b ? -1 : a > b ? 1 : 0).slice(0, present.length));
  });

  it.each([["CJK", "界".repeat(1500)], ["astral", "😀".repeat(1100)]])("M4 indivisible %s identifier that cannot fit stops pre-call", async (_name, id) => {
    const r = boot();
    rules(await run(r, input({ vm: vm([agent(id)]) })), "BODY_TOO_LARGE");
    expect(r.generate).not.toHaveBeenCalled(); expect(r.create).not.toHaveBeenCalled();
  });

  it("M5 known current but omitted agent cannot be cited by the model", async () => {
    const fixture = hardeningVM(); const probe = boot(() => response({ items: [] }));
    await run(probe, input({ vm: fixture }));
    const present = included(promptData(probe.prompts[0]!), fixture.agents);
    const omitted = fixture.agents.find(a => !present.includes(a.agent) && a.activity === "working" && a.lifecycle !== "failed")!;
    expect(omitted).toBeDefined();
    const r = boot(() => response({ items: [item({ kind: "working", agent: omitted.agent, task: omitted.current_task_id })] }));
    rules(await run(r, input({ vm: fixture })), "SCHEMA_REJECT");
  });

  it("M4 negative control catches character-count acceptance of an oversized UTF-8 prompt", async () => {
    const r = boot();
    const id = "界".repeat(1500);
    rules(await run(r, input({ vm: vm([agent(id)]) })), "BODY_TOO_LARGE");
    expect(r.generate).not.toHaveBeenCalled();
    const unsafe = `<untrusted_data>${JSON.stringify({ agents: [{ agent: id }], omitted_agents: 0 })}</untrusted_data>`;
    expect(unsafe.length).toBeLessThan(4096);
    expect(() => bound(unsafe)).toThrow();
  });
});
