// U42 items 2, 3, 6 (view model): human close summary, raw verdict kept in step detail, "Next" line, in-progress status.
import { describe, expect, it } from "vitest";
import { classifyClose, foldRoom, toTaskVM } from "../../../src/agents";
import type { AgentState } from "../../../src/agents/types";
import { T0, close, ev, finished, plan, step } from "./fixtures";

const vmOf = (events: unknown[], agent: string) => {
  const st = foldRoom(events).find((s) => s.agent === agent) as AgentState;
  return toTaskVM(st, { workspace: "viewpoint", nowMs: T0 + 1000 });
};

describe("classifyClose", () => {
  it("rc 0 / *_VERIFIED -> Completed; blocked -> Stopped; else Failed (<code>)", () => {
    expect(classifyClose("BROWSER_BOUNDED_ACTIONS_VERIFIED (rc 0)", false)?.summary).toBe("Completed — all steps verified");
    expect(classifyClose("PASS (rc 0)", false)?.kind).toBe("completed");
    expect(classifyClose("X_VERIFIED (rc 2)", false)?.kind).toBe("completed");
    expect(classifyClose("BROWSER_STEP_BLOCKED (rc 1)", false)?.summary).toBe("Stopped — a step was blocked");
    expect(classifyClose("FAIL_X (rc 3)", true)?.summary).toBe("Stopped — a step was blocked");
    expect(classifyClose("FAIL_X (rc 3)", false)?.summary).toBe("Failed (FAIL_X)");
    expect(classifyClose(" (rc 4)", false)?.summary).toBe("Failed (rc 4)");
  });
  it("plain human close texts are not verdicts (agents keep their own words)", () => {
    for (const t of ["bye", "Done, wrote the summary", "", "PASS rc 0", "pass (rc zero)"]) expect(classifyClose(t, false)).toBeUndefined();
  });
});

describe("card summary is human; the raw verdict code stays in the step detail", () => {
  it("verified run: summary 'Completed — all steps verified', raw code in the last step's detail only", () => {
    const vm = vmOf(finished("chatgpt-agent", "ChatGPT · Ask", 4, "BROWSER_BOUNDED_ACTIONS_VERIFIED (rc 0)"), "chatgpt-agent");
    expect(vm.summary).toBe("Completed — all steps verified");
    expect(vm.summary).not.toContain("BROWSER_");
    expect(vm.steps[3]!.detail?.outcome).toBe("verified · BROWSER_BOUNDED_ACTIONS_VERIFIED (rc 0)");
    expect(vm.steps[0]!.detail?.outcome).toBe("verified");
    expect(vm.status).toBe("done");
    expect(vm.next).toBe("Completed");
  });
  it("blocked run: summary 'Stopped — a step was blocked', raw code as the blocked step's note, Next 'Stopped'", () => {
    const evs = [
      plan("arxiv-agent", "arXiv · Find", ["a", "b", "c"]),
      step("arxiv-agent", 0, "done", "verified"), step("arxiv-agent", 1, "done", "verified"),
      step("arxiv-agent", 2, "blocked", "blocked: target not visible"),
      close("arxiv-agent", "BROWSER_STEP_BLOCKED (rc 1)"),
    ];
    const vm = vmOf(evs, "arxiv-agent");
    expect(vm.summary).toBe("Stopped — a step was blocked");
    expect(vm.steps[2]!.note).toBe("blocked: target not visible · BROWSER_STEP_BLOCKED (rc 1)");
    expect(vm.status).toBe("blocked");
    expect(vm.next).toBe("Stopped");
    expect(vm.next).not.toBe("Waiting for a plan");
  });
  it("failed run without a blocked step: 'Failed (<code>)', Next 'Stopped'", () => {
    const vm = vmOf(finished("gemini-agent", "Gemini · x", 2, "MODEL_TIMEOUT (rc 2)"), "gemini-agent");
    expect(vm.summary).toBe("Failed (MODEL_TIMEOUT)");
    expect(vm.steps[1]!.detail?.outcome).toBe("verified · MODEL_TIMEOUT (rc 2)");
    expect(vm.next).toBe("Stopped");
  });
  it("a human close text is shown as is and no step detail changes", () => {
    const vm = vmOf(finished("helper", "[ChatGPT] Summarise", 2, "All done, summary posted"), "helper");
    expect(vm.summary).toBe("All done, summary posted");
    expect(vm.steps[1]!.detail?.outcome).toBe("verified");
    expect(vm.next).toBe("Completed");
  });
  it("a verdict-looking text from an open (not closed) agent is left alone", () => {
    const evs = [plan("w", "t", ["a", "b"]), step("w", 0, "done", "verified"), ev("w", "heartbeat", "PASS (rc 0)")];
    expect(vmOf(evs, "w").summary).toBe("PASS (rc 0)");
  });
});

describe("Next line", () => {
  it("'Waiting for a plan' only when the agent has no plan yet", () => {
    expect(vmOf([ev("w", "open", "hi")], "w").next).toBe("Waiting for a plan");
    const vm = vmOf([plan("w", "t", ["a", "b"]), step("w", 0, "done", "ok"), step("w", 1, "done", "ok")], "w");
    expect(vm.next).not.toBe("Waiting for a plan");
    expect(vm.next).toBe("Waiting for the next step");
  });
  it("open task with a pending step shows that step", () => {
    expect(vmOf([plan("w", "t", ["a", "b"]), step("w", 0, "done", "ok")], "w").next).toBe("b");
  });
  it("closed task: Completed, or Stopped when a step is blocked", () => {
    expect(vmOf(finished("w", "t", 2, "bye"), "w").next).toBe("Completed");
    const evs = [plan("z", "t", ["a"]), step("z", 0, "blocked", "nope"), close("z", "bye")];
    expect(vmOf(evs, "z").next).toBe("Stopped");
  });
});

describe("in-progress status (rail running counter input)", () => {
  it("all steps done but not closed is still running; closing makes it done", () => {
    const open = [plan("w", "t", ["a", "b"]), step("w", 0, "done", "ok"), step("w", 1, "done", "ok")];
    expect(vmOf(open, "w").status).toBe("running");
    expect(vmOf([...open, close("w", "PASS (rc 0)")], "w").status).toBe("done");
  });
});

describe("fold: a plan after close starts a new task (slug reused by a later run)", () => {
  it("closed is cleared, step states start fresh, no drift baseline", () => {
    const evs = [...finished("chatgpt-agent", "ChatGPT · first", 2, "PASS (rc 0)"), plan("chatgpt-agent", "ChatGPT · second", ["step 1", "step 2"])];
    const st = foldRoom(evs).find((s) => s.agent === "chatgpt-agent")!;
    expect(st.closed).toBe(false);
    expect(st.stepStates).toEqual(["pending", "pending"]);
    expect(st.previous).toBeUndefined();
    expect(st.contract?.version).toBe(1);
    const vm = toTaskVM(st, { workspace: "viewpoint", nowMs: T0 + 1000 });
    expect(vm.title).toBe("ChatGPT · second");
    expect(vm.status).toBe("running");
  });
});
