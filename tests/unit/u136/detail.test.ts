import { describe, expect, it, vi } from "vitest";
import { renderSwarmView } from "../../../src/views/swarm";
import type { SwarmViewModel } from "../../../src/app/swarm_vm";
import { agent, card, deterministic, freeze, HOSTILE, keyboardActivate, micro, mount, task, taskControl, text, viewModel, visibleText } from "./fixtures";

deterministic();
function detailFixture(): SwarmViewModel {
  const a = task("T01", { microtasks: [micro("T01.M01", { state: "done", outcome: "Outcome for T01.M01",
    evidence: [{ path: "evidence/T01.txt", sha256: "1".repeat(64) }] }), micro("T01.M02")] });
  const b = task("T02", { assignee: "executor-b", deps: ["T01"], ready: false,
    microtasks: [micro("T02.M01", { outcome: "Outcome for T02.M01",
      evidence: [{ path: "evidence/T02.txt", sha256: "2".repeat(64) }] })] });
  return viewModel([
    agent({ tasks: [a], activity: "unknown", active_micro_id: "T01.M02", micro_done: 1, micro_total: 2 }),
    agent({ agent: "executor-b", tasks: [b], current_task_id: "T02", active_micro_id: "T02.M01", activity: "waiting",
      waiting_on: [{ task_id: "T02", upstream_id: "T01", owner: "executor-a", missing: false }] }),
  ]);
}
function noWriteControls(root: HTMLElement): void {
  expect(root.querySelector("input, textarea, form, [contenteditable='true'], [role='textbox']")).toBeNull();
  for (const control of root.querySelectorAll("button, a, [role='button'], [role='link']")) {
    const label = `${text(control)} ${control.getAttribute("aria-label") ?? ""} ${control.getAttribute("title") ?? ""} ${control.getAttribute("href") ?? ""}`;
    expect(label).not.toMatch(/\b(chat|reply|send|composer|terminal|shell|execute|deploy|release|cancel|restart|terminate)\b/i);
  }
}
function expectDetail(taskId: "T01" | "T02"): void {
  const result = visibleText(document.body);
  for (const value of [`Task ${taskId}`, `Micro ${taskId}.M01`, `Outcome for ${taskId}.M01`, `evidence/${taskId}.txt`, (taskId === "T01" ? "1" : "2").repeat(64)]) expect(result).toContain(value);
  expect(result).not.toContain(taskId === "T01" ? "Outcome for T02.M01" : "Outcome for T01.M01");
}
function escape(): void {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

describe("A5 / M7 local read-only detail and focus", () => {
  it.each(["T01", "T02"] as const)("A5 clicking the %s card opens that selected task's microtasks, outcomes and evidence locally", taskId => {
    const root = mount(detailFixture()), before = document.body.innerHTML, location = window.location.href;
    const slug = taskId === "T01" ? "executor-a" : "executor-b";
    card(root, slug, taskId).click();
    expect(document.body.innerHTML, "Click must expose local task detail").not.toBe(before);
    expectDetail(taskId); noWriteControls(document.body); expect(window.location.href).toBe(location);
  });
  it.each(["Enter", " "] as const)("A5 focused task control activates with %s; Escape closes and restores focus", key => {
    const root = mount(detailFixture()), trigger = taskControl(card(root, "executor-b", "T02"));
    trigger.focus(); expect(document.activeElement).toBe(trigger);
    keyboardActivate(trigger, key); expectDetail("T02");
    escape();
    expect(visibleText(document.body)).not.toContain("Outcome for T02.M01");
    expect(visibleText(document.body)).not.toContain("evidence/T02.txt");
    expect(document.activeElement).toBe(trigger);
  });
  it("A5 b's local T02 detail names upstream T01 and current owner executor-a", () => {
    const root = mount(detailFixture()); card(root, "executor-b", "T02").click();
    expectDetail("T02");
    // Local detail may be inline or portalled; neither a dialog tag nor an outcome wrapper is prescribed.
    for (const value of ["T02", "T01", "executor-a", "evidence/T02.txt"]) expect(visibleText(document.body)).toContain(value);
  });
  it("M7 a card with multiple tasks opens its selected task, not the first owned task", () => {
    const early = task("T00", { state: "done", microtasks: [micro("T00.M01", { state: "done", outcome: "Unselected outcome" })] });
    const selected = task("T01", { microtasks: [micro("T01.M01", { outcome: "Selected outcome", evidence: [{ path: "evidence/selected.txt", sha256: "a".repeat(64) }] })] });
    const root = mount(viewModel([agent({ tasks: [early, selected] })]));
    card(root, "executor-a").click();
    expect(visibleText(document.body)).toContain("Selected outcome"); expect(visibleText(document.body)).toContain("evidence/selected.txt");
    expect(visibleText(document.body)).not.toContain("Unselected outcome");
  });
  // A-R40: registration-only agents expose collapsed metadata, but no task opening action, U138 M6 / Oracle amendments.
  it("M7 registration-only cards expose metadata but no keyboard or pointer task action", () => {
    const vm = viewModel([agent({ lifecycle: "deployed", tasks: [], current_task_id: null, active_micro_id: null,
      micro_done: null, micro_total: null, activity: "idle", last_beat_ts: null, last_beat_age_ms: null })]);
    const root = mount(vm), container = card(root, "executor-a", null);
    const focusable = [container, ...container.querySelectorAll<HTMLElement>("button, a[href], [role='button'], [tabindex]")].filter(el => el.tabIndex >= 0);
    const disclosure = container.querySelector<HTMLButtonElement>("button[aria-expanded]");
    expect(disclosure).not.toBeNull();
    expect(focusable).toEqual([disclosure]);
    expect(disclosure!.getAttribute("aria-expanded")).toBe("false");
    const before = document.body.innerHTML; container.click(); expect(document.body.innerHTML).toBe(before);
    disclosure!.focus(); expect(document.activeElement).toBe(disclosure);
    keyboardActivate(disclosure!, "Enter");
    expect(disclosure!.getAttribute("aria-expanded")).toBe("true");
    expect(visibleText(container)).toContain("Lifecycle");
    expect(root.querySelector(".swarm-detail")).toBeNull();
    noWriteControls(root);
  });
  it("M7 task activation never exposes composers, terminals, chat links or lifecycle mutation controls", () => {
    const root = mount(detailFixture()); noWriteControls(root);
    card(root, "executor-b", "T02").click(); noWriteControls(document.body);
  });
  it("M7 rendering and detail interactions preserve a frozen view model", () => {
    const vm = freeze(detailFixture()), before = structuredClone(vm), root = mount(vm);
    card(root, "executor-b", "T02").click(); escape(); expect(vm).toEqual(before);
  });
});

describe("A4-A5 / Amendment B detail XSS and narrator", () => {
  it.each(["title", "microtext", "outcome", "evidence", "blocked_reason"] as const)(
    "Amendment B detail %s stays literal and inert after activation", field => {
      const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined), errors: unknown[] = [];
      const onError = (event: ErrorEvent) => { errors.push(event.error); event.preventDefault(); };
      window.addEventListener("error", onError);
      try {
        const t = task("T01", { title: field === "title" ? HOSTILE : "Detail task",
          blocked_reason: field === "blocked_reason" ? HOSTILE : null,
          microtasks: [micro("T01.M01", { text: field === "microtext" ? HOSTILE : "Detail microtask",
            outcome: field === "outcome" ? HOSTILE : "Safe detail outcome",
            evidence: [{ path: field === "evidence" ? HOSTILE : "evidence/safe.txt", sha256: "a".repeat(64) }] })] });
        const root = mount(viewModel([agent({ tasks: [t] })])), before = document.body.innerHTML;
        card(root, "executor-a").click();
        expect(document.body.innerHTML, "A local detail must open before its content can be assessed").not.toBe(before);
        expect(visibleText(document.body)).toContain(HOSTILE);
        expect(document.body.querySelector("img, script, iframe, object, embed, [onerror], [onload], [onclick]")).toBeNull();
        expect(alert).not.toHaveBeenCalled(); expect(errors).toEqual([]);
      } finally { window.removeEventListener("error", onError); }
    });
  it("Amendment B hostile task identifiers and __proto__ slug cannot break task activation selectors", () => {
    const errors: unknown[] = [], onError = (event: ErrorEvent) => { errors.push(event.error); event.preventDefault(); };
    window.addEventListener("error", onError);
    try {
      const id = `T01["${HOSTILE}"]`, t = task(id, { assignee: "__proto__", microtasks: [micro(`${id}.M01`, { outcome: "Hostile-ID outcome" })] });
      const root = mount(viewModel([agent({ agent: "__proto__", tasks: [t], current_task_id: id, active_micro_id: `${id}.M01` })]));
      card(root, "__proto__", id).click();
      expect(visibleText(document.body)).toContain("Hostile-ID outcome"); expect(errors).toEqual([]); expect(document.body.querySelector("img, script, [onerror]")).toBeNull();
    } finally { window.removeEventListener("error", onError); }
  });
  it("A5 optional narrator node is mounted once inside a labelled narrator slot", () => {
    const narrator = document.createElement("p"); narrator.textContent = "Supplied narrator content"; narrator.dataset.oracleNarrator = "supplied";
    const render: (doc: Document, vm: SwarmViewModel, options?: { narrator?: HTMLElement }) => HTMLElement = renderSwarmView;
    const root = render(document, freeze(viewModel()), { narrator }); document.body.append(root);
    expect(root.contains(narrator), "The supplied node, rather than fabricated text, must be mounted").toBe(true);
    expect(root.querySelectorAll("[data-oracle-narrator='supplied']")).toHaveLength(1);
    const slot = narrator.closest("[aria-label], [aria-labelledby]"); expect(slot).not.toBeNull();
    const label = slot!.getAttribute("aria-label") ?? (slot!.getAttribute("aria-labelledby") ?? "").split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" ");
    expect(label).toMatch(/narrator/i);
  });
  it("A5 omitting narrator preserves the two-argument call and supplies no fabricated narration", () => {
    const render: (doc: Document, vm: SwarmViewModel, options?: { narrator?: HTMLElement }) => HTMLElement = renderSwarmView;
    const vm = freeze(viewModel()), normal = renderSwarmView(document, vm), optional = render(document, vm, {});
    expect(text(optional)).toBe(text(normal)); expect(optional.querySelector("[data-oracle-narrator]")).toBeNull();
    expect(text(optional)).not.toContain("Supplied narrator content");
  });
});
