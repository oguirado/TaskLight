import { describe, expect, it } from "vitest";
import { renderNarrator } from "../../../src/views/narrator";
import { boot, allCategories, CATEGORY_ITEMS, item, response, input, vm, agent,
  run, rules, HOSTILE, MARKUP, promptData, strings, mounted } from "./fixtures";
import type { Item } from "./fixtures";

describe("A4 grounded structured output", () => {
  it.each([
    ["non-JSON", "I think everyone is working"],
    ["null", "null"], ["array root", []], ["missing items", {}], ["items not array", { items: {} }],
    ["free prose", { items: [item()], text: "UNRESTRICTED_PROSE" }],
    ["item prose", { items: [{ ...item(), text: "UNRESTRICTED_PROSE" }] }],
    ["legacy blocked spelling", { items: [{ kind: "blocked", agent: "executor-b", task: "T02", blocked: "T01", owner: "executor-a" }] }],
    ["six items", { items: Array.from({ length: 6 }, () => item()) }],
    ["unknown kind", { items: [{ ...item(), kind: "probably_alive" }] }],
    ["non-string agent", { items: [{ ...item(), agent: 7 }] }],
    ["non-string task", { items: [{ ...item(), task: 7 }] }],
    ["missing owner", { items: [{ kind: "working", agent: "executor-a", task: "T01", blocked_on: null }] }],
    ["missing blocker", { items: [{ kind: "working", agent: "executor-a", task: "T01", owner: null }] }],
  ])("M5 rejects malformed %s without a generated flash", async (_label, body) => {
    const r = boot(() => response(body)); const seen: string[] = [];
    r.controller.subscribe(() => seen.push(r.controller.snapshot().kind));
    const snapshot = await run(r, input({ vm: allCategories() }));
    rules(snapshot, "SCHEMA_REJECT"); expect(seen).not.toContain("generated");
    expect(snapshot.text).not.toContain("UNRESTRICTED_PROSE");
  });

  it.each([
    ["fabricated agent and task", item({ agent: "mallory", task: "T99" })],
    ["fabricated task", item({ task: "T99" })],
    ["valid agent wrong owner task", item({ agent: "executor-a", task: "T02" })],
    ["swapped existing agent", item({ agent: "executor-b", task: "T01" })],
    ["existing wrong blocker", item({ kind: "blocked", agent: "executor-b", task: "T02", blocked_on: "T03", owner: "executor-c" })],
    ["existing wrong blocker owner", item({ kind: "blocked", agent: "executor-b", task: "T02", blocked_on: "T01", owner: "executor-c" })],
    ["fabricated owner", item({ kind: "blocked", agent: "executor-b", task: "T02", blocked_on: "T01", owner: "mallory" })],
    ["fabricated blocker", item({ kind: "blocked", agent: "executor-b", task: "T02", blocked_on: "T99", owner: "executor-a" })],
    ["invented waiting relationship", item({ kind: "blocked", blocked_on: "T03", owner: "executor-c" })],
    ["false failure", item({ kind: "failed" })],
    ["false unknown liveness", item({ kind: "liveness_unknown" })],
    ["unknown agent falsely working", item({ agent: "executor-c", task: "T03" })],
    ["failed but freshly beating agent falsely working", item({ agent: "executor-d", task: "T04" })],
    ["unsupported operator need", item({ kind: "needs_you" })],
  ] satisfies Array<[string, Item]>)("A4 rejects %s against current and transmitted VM", async (_label, bad) => {
    const r = boot(() => response({ items: [bad] }));
    const snapshot = await run(r, input({ vm: allCategories() }));
    rules(snapshot, "SCHEMA_REJECT");
    expect(snapshot.text).not.toContain("mallory"); expect(snapshot.text).not.toContain("T99");
  });

  it.each(["working", "liveness_unknown"] as const)("M5 terminal lifecycle forbids %s", async kind => {
    const r = boot(() => response({ items: [item({ kind })] }));
    rules(await run(r, input({ vm: vm([agent("executor-a", "T01", {
      lifecycle: "finished", activity: kind === "working" ? "working" : "unknown",
    })]) })), "SCHEMA_REJECT");
  });

  it.each([
    { activity: "needs_you" as const, unanswered_questions: 0 },
    { activity: "working" as const, unanswered_questions: 1 },
  ])("M5 needs_you is grounded by activity OR unanswered count: %j", async extra => {
    const r = boot(() => response({ items: [item({ kind: "needs_you" })] }));
    expect((await run(r, input({ vm: vm([agent("executor-a", "T01", extra)]) }))).kind).toBe("generated");
  });

  it("C.M5 category coverage is prompt-only, so one valid category is accepted", async () => {
    const r = boot(() => response({ items: [CATEGORY_ITEMS[0]] }));
    expect((await run(r, input({ vm: allCategories() }))).kind).toBe("generated");
  });

  it("M5 nullable work identifiers are accepted for a failed deployed member without tasks", async () => {
    const r = boot(() => response({ items: [item({ kind: "failed", task: null })] }));
    const snapshot = await run(r, input({ vm: vm([agent("executor-a", "T01", { lifecycle: "failed",
      tasks: [], current_task_id: null, active_micro_id: null, micro_done: null, micro_total: null, activity: "idle" })]) }));
    expect(snapshot.kind).toBe("generated"); expect(snapshot.text).toMatch(/failed/i);
  });

  it("A4 hostile titles are omitted while retained IDs round-trip safely inside one fence", async () => {
    const id = `retained-${HOSTILE}-${MARKUP}`;
    const a = agent(id, "T01");
    const hostile = { ...a, tasks: a.tasks.map(t => ({ ...t, title: HOSTILE })),
      history: [{ text: "CONVERSATION_MUST_NOT_LEAK" }], evidence: "EVIDENCE_BODY_MUST_NOT_LEAK" };
    const r = boot(() => response({ items: [item({ agent: id })] }));
    const snapshot = await run(r, input({ vm: vm([hostile]) }));
    const prompt = r.prompts[0]!; const data = promptData(prompt);
    expect(strings(data)).toContain(id);
    expect(strings(data)).not.toContain(HOSTILE);
    expect(prompt).not.toContain("CONVERSATION_MUST_NOT_LEAK");
    expect(prompt).not.toContain("EVIDENCE_BODY_MUST_NOT_LEAK");
    expect(prompt).not.toContain(HOSTILE);
    expect(prompt.split("<untrusted_data>")[0]).not.toContain("retained-");
    expect(prompt.split("</untrusted_data>")[1]).not.toContain("retained-");
    expect(snapshot.kind).toBe("generated");
    const { root } = mounted(snapshot, renderNarrator);
    expect(root.textContent).toContain(id); expect(root.querySelector("img, system, script")).toBeNull();
  });

  it("A4 retained task IDs cannot break fences or create markup", async () => {
    const id = `T-${HOSTILE}-${MARKUP}`;
    const r = boot(() => response({ items: [item({ task: id })] }));
    const snapshot = await run(r, input({ vm: vm([agent("executor-a", id)]) }));
    expect(strings(promptData(r.prompts[0]!))).toContain(id);
    expect(r.prompts[0]).not.toContain(HOSTILE);
    expect(snapshot.kind).toBe("generated");
    const { root } = mounted(snapshot, renderNarrator);
    expect(root.textContent).toContain(id); expect(root.querySelector("img, system, script")).toBeNull();
  });

  it("A4 reference-validation negative control rejects a fabricated success snapshot", async () => {
    const r = boot(() => response({ items: [item({ agent: "mallory", task: "T99" })] }));
    rules(await run(r), "SCHEMA_REJECT");
    // Model a disabled reference gate at the public result boundary; the same oracle must reject it.
    expect(() => rules({ kind: "generated", source: "ON_DEVICE", text: "mallory is working on T99." }, "SCHEMA_REJECT")).toThrow();
  });
});
