import { describe, expect, it, vi } from "vitest";
import { activate, announcements, controlledPanel, disclosure, expectActivity as legacyExpectActivity, labels, mount, plan, q, setup, source, states,
  step, task, text, visibleText, wall, workingWall } from "./fixtures";

// A-Q1: U148 keeps task and microtask state distinct; exclude children from task text checks.
function expectActivity(scope: HTMLElement, state: Parameters<typeof legacyExpectActivity>[1]): void {
  const own = scope.cloneNode(true) as HTMLElement;
  if (scope.matches(".task[data-task-id]")) own.querySelectorAll(".steps").forEach(n => n.remove());
  legacyExpectActivity(own, state);
}

// A-Q1: U148 non-article task roots retain .task/data-task-id; keep identity checks.
function card(root: ParentNode, id = "T01"): HTMLElement {
  const matches = [...root.querySelectorAll<HTMLElement>(".task[data-task-id]")].filter(n => n.dataset.taskId === id);
  expect(matches, `Required unique task card: ${id}`).toHaveLength(1);
  return matches[0]!;
}



setup();
describe("A4 phase selection", () => {
  it.each(["Enter", " "] as const)("A4 %j immediately filters and selects while preserving the current phase", key => {
    const onSelectPhase = vi.fn(); const vm = wall({ tasks: [task(), task({ id: "plan:room-a:T02", taskId: "T02", phaseId: "build", title: "Build parser" })] });
    const { host } = mount(vm, { onSelectPhase });
    activate(q(host, 'button.phase-chip[data-phase-id="build"]'), key);
    expect(q(host, 'button.phase-chip[data-phase-id="build"]').getAttribute("aria-pressed")).toBe("true");
    expect(q(host, 'button.phase-chip[data-phase-id="discovery"]').getAttribute("aria-current")).toBe("step");
    expect(q(host, 'button.phase-chip[data-phase-id="build"]').getAttribute("aria-current")).not.toBe("step");
    expect([...host.querySelectorAll(".task[data-task-id]")].map(n => n.getAttribute("data-task-id"))).toEqual(["T02"]);
    expect(onSelectPhase).toHaveBeenCalledExactlyOnceWith("build");
    expect(q(host, '[aria-live="polite"]').textContent).toMatch(/build.*selected|selected.*build/i);
    expect(vm.plan?.phaseId).toBe("discovery");
  });
  it("A4 the selection handler and polite announcement run once per activation", async () => {
    const onSelectPhase = vi.fn(); const { host } = mount(wall(), { onSelectPhase });
    const observed = announcements(host);
    activate(q(host, 'button.phase-chip[data-phase-id="build"]'));
    await Promise.resolve(); observed.stop();
    expect(onSelectPhase).toHaveBeenCalledExactlyOnceWith("build");
    expect(observed.messages).toHaveLength(1);
  });
  it("A4 Show all phases clears viewing selection without changing canonical current phase", () => {
    const vm = wall({ tasks: [task(), task({ id: "plan:room-a:T02", taskId: "T02", phaseId: "build" })] });
    const onSelectPhase = vi.fn(); const { host } = mount(vm, { onSelectPhase });
    activate(q(host, 'button.phase-chip[data-phase-id="build"]'));
    const showAll = [...host.querySelectorAll<HTMLButtonElement>("button")].find(n => /Show all phases/i.test(text(n)));
    expect(showAll).toBeDefined(); activate(showAll!, " ");
    expect(host.querySelector('button.phase-chip[aria-pressed="true"]')).toBeNull();
    expect(host.querySelectorAll(".task[data-task-id]")).toHaveLength(2);
    expect(q(host, 'button.phase-chip[data-phase-id="discovery"]').getAttribute("aria-current")).toBe("step");
    expect(vm.plan?.phaseId).toBe("discovery");
    expect(onSelectPhase.mock.calls.filter(call => call[0] === "build")).toHaveLength(1);
  });
  it("A4 current and selected phase are named as separate concepts", () => {
    const { host } = mount(wall()); activate(q(host, 'button.phase-chip[data-phase-id="build"]'));
    const current = q(host, 'button.phase-chip[data-phase-id="discovery"]');
    const selected = q(host, 'button.phase-chip[data-phase-id="build"]');
    expect(`${text(current)} ${current.getAttribute("aria-label") ?? ""} ${current.getAttribute("title") ?? ""}`).toMatch(/current/i);
    expect(`${text(selected)} ${selected.getAttribute("aria-label") ?? ""} ${selected.getAttribute("title") ?? ""}`).toMatch(/selected|viewing|viewed/i);
  });
});

describe("A5 acceptance and conversation controls", () => {
  it.each(states)("A5 nonempty acceptance is available for %s, without detail or fabricated evidence", state => {
    const committed = state === "done" ? "done" : state === "working" || state === "unknown" ? "active" : state === "blocked" ? "blocked" : "pending";
    const { host } = mount(wall({ tasks: [task({ activity: { state }, steps: [step({ state: committed, activity: { state } })] })] }));
    const button = disclosure(card(host)); expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("aria-expanded")).toBe("false"); activate(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const panel = controlledPanel(button); expect(panel.hidden).toBe(false);
    expect(visibleText(panel)).toContain("CSV preserves headers");
    const label = panel.getAttribute("aria-label") ?? "";
    const labelledBy = panel.getAttribute("aria-labelledby");
    expect(label || (labelledBy ? text(document.getElementById(labelledBy) ?? panel) : "")).toMatch(/accept/i);
    expect(text(panel)).toContain("No evidence recorded"); expect(text(panel)).not.toContain("Evidence recorded");
  });
  it.each(["Enter", " "] as const)("A5 %j toggles once through delegation and retains available outcome", key => {
    const onToggleMicroDetail = vi.fn();
    const { host } = mount(wall({ tasks: [task({ steps: [step({ state: "done", detail: { outcome: "Headers retained", evidence: ["reports/headers.txt"], source } })] })] }), { onToggleMicroDetail });
    const button = disclosure(host); activate(button, key);
    expect(button.getAttribute("aria-expanded")).toBe("true"); expect(onToggleMicroDetail).toHaveBeenCalledExactlyOnceWith("T01", 0);
    const panel = controlledPanel(button); expect(visibleText(panel)).toContain("Headers retained");
    expect(visibleText(panel)).toContain("reports/headers.txt");
    activate(button, key); expect(button.getAttribute("aria-expanded")).toBe("false"); expect(panel.hidden).toBe(true);
    expect(onToggleMicroDetail).toHaveBeenCalledTimes(2);
  });
  it("A5 beat refresh preserves open acceptance and logical keyboard focus", () => {
    const vm = workingWall(); const { host, handle } = mount(vm);
    const before = disclosure(host); activate(before); before.focus();
    handle.update(workingWall(190100));
    const after = disclosure(host); expect(after.getAttribute("aria-expanded")).toBe("true");
    expect(visibleText(controlledPanel(after))).toContain("CSV preserves headers");
    expect(document.activeElement).toBe(after); expect(after.dataset.microId).toBe(before.dataset.microId);
  });
  it("A5 existing completion details retain expansion and focus during refresh", () => {
    const vm = wall({ tasks: [task({ steps: [step({ state: "done", detail: { outcome: "Recorded", evidence: [], source } })] })] });
    const { host, handle } = mount(vm); const before = disclosure(host); activate(before); before.focus();
    handle.update(structuredClone(vm)); const after = disclosure(host);
    expect(after.getAttribute("aria-expanded")).toBe("true"); expect(document.activeElement).toBe(after);
  });
  it("A5 expiry preserves acceptance expansion and focus at the failing interleaving", () => {
    const { host } = mount(workingWall()); const button = disclosure(host); activate(button); button.focus();
    vi.advanceTimersByTime(2);
    const after = disclosure(host); expectActivity(card(host), "unknown");
    expect(after.getAttribute("aria-expanded")).toBe("true"); expect(document.activeElement).toBe(after);
    expect(visibleText(controlledPanel(after))).toContain("CSV preserves headers");
  });
  // A-R41: keyboard conversation activation moves into collapsed legacy Messages.
  it.each(["Enter", " "] as const)("A5 keyboard Messages %j routes the VM id with recoverable trigger identity", key => {
    const onOpenTask = vi.fn(); const vm = wall(); const { host, handle } = mount(vm, { onOpenTask });
    activate(q(host, ".messages-toggle"));
    const chat = q(host, ".messages-open");
    expect(chat, "Native keyboard Chat action").toBeDefined();
    expect(chat!.dataset.taskId).toBeTruthy(); activate(chat!, key);
    expect(onOpenTask).toHaveBeenCalledTimes(1); expect(onOpenTask.mock.calls[0]?.[0]).toBe(vm.tasks[0]?.id);
    const extra = (onOpenTask.mock.calls[0] as unknown[] | undefined)?.slice(1) ?? [];
    // The amendment freezes recoverable identity, not the options/argument layout.
    const identities = extra.flatMap(value => typeof value === "string" ? [value]
      : value !== null && typeof value === "object" ? Object.values(value).filter((v): v is string => typeof v === "string") : []);
    function resolves(value: unknown): boolean {
      if (typeof value !== "string") return false;
      if (document.getElementById(value) === chat) return true;
      try { return host.querySelector(value) === chat; } catch { return false; }
    }
    expect(identities.some(resolves), "onOpenTask carries a recoverable trigger selector/id").toBe(true);
    const stable = { id: chat!.id, task: chat!.dataset.taskId, micro: chat!.dataset.microId };
    handle.update(structuredClone(vm));
    const rebound = q(host, ".messages-open");
    expect(rebound).toBeDefined(); expect({ id: rebound!.id, task: rebound!.dataset.taskId, micro: rebound!.dataset.microId }).toEqual(stable);
    expect(document.activeElement).toBe(rebound);
  });
});

describe("A7 authority boundary", () => {
  it("A7 explicit supplied task question creates Needs you and a keyboard conversation action", () => {
    const t = task({ operatorQuestion: { eventId: "question-1", text: "Which CSV format should be accepted?" }, activity: { state: "needs_you" } });
    const before = structuredClone(t); const onOpenTask = vi.fn(); const { host } = mount(wall({ tasks: [t] }), { onOpenTask });
    expectActivity(card(host), "needs_you"); expect(text(card(host))).toContain(t.operatorQuestion!.text);
    // A-R41: task questions retain a keyboard conversation route only in Messages.
    activate(q(host, ".messages-toggle"));
    const action = q(host, ".messages-open");
    expect(action).toBeDefined(); activate(action!); expect(onOpenTask).toHaveBeenCalledTimes(1);
    expect(onOpenTask.mock.calls[0]?.[0]).toBe(t.id); expect(t).toEqual(before);
  });
  it("A7 reviewer needs_user is Review request with its reason, without operator authority", () => {
    const t = task({ activity: { state: "idle" }, nanoVerdict: { verdict: "needs_user", reason: "Review the CSV dialect", source } });
    const before = structuredClone(t); const { host } = mount(wall({ tasks: [t] }));
    expect(text(card(host))).toContain("Review request"); expect(text(card(host))).toContain("Review the CSV dialect");
    expect(text(card(host))).not.toContain(labels.needs_you); expectActivity(card(host), "idle"); expect(t).toEqual(before);
  });
  it("A7 unrelated room questions cannot create a task association or change ownership", () => {
    const t = task({ activity: { state: "idle" } });
    const vm = { ...wall({ tasks: [t] }), questions: [{ eventId: "room-question", text: "@owner which file?", room: "room-a" }] };
    const before = structuredClone(vm); const { host } = mount(vm);
    expect(text(card(host))).not.toContain("@owner which file?"); expect(text(card(host))).not.toContain("Needs you");
    expect(t.operatorQuestion).toBeUndefined(); expect(vm).toEqual(before);
  });
});
