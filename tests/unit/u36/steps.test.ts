import { afterEach, describe, expect, it } from "vitest";
import { mkDone, mkStep, mkTask, ms, vm, withTasks } from "./fixture";
import { attr, cleanup, click, mount, nth, q, qa, txt } from "./helpers";

afterEach(cleanup);

const stepsOf = (host: ParentNode, taskId = "t1") => qa(q(host, `article.task[id="${taskId}"]`), "ol.steps > li.step");
const hiddenText = (li: Element) => txt(q(li, ".step-text > .visually-hidden"));

describe("B6 step rows", () => {
  it("done step with detail: button.step-row[aria-expanded=false][aria-controls] with the full child structure", () => {
    const { host } = mount();
    const li = nth(stepsOf(host), 0);
    const row = q<HTMLButtonElement>(li, "button.step-row");
    expect(row.parentElement).toBe(li);
    expect(attr(row, "type")).toBe("button");
    expect(attr(row, "aria-expanded")).toBe("false");
    expect(attr(row, "aria-controls")).toBeTruthy();
    q(row, ":scope > .step-indicator");
    expect(txt(q(row, ":scope > .step-text > .step-label"))).toBe("Port handlers to the v2 schema");
    q(row, ":scope > .step-chevron");
    expect(txt(q(row, ":scope > .step-time"))).toContain("17:10");
  });

  it("aria-controls points at the hidden div.step-detail of that step", () => {
    const { host } = mount();
    const li = nth(stepsOf(host), 1);
    const row = q(li, "button.step-row");
    const detail = document.getElementById(attr(row, "aria-controls") ?? "");
    expect(detail).not.toBeNull();
    expect(detail?.tagName).toBe("DIV");
    expect(detail?.classList.contains("step-detail")).toBe(true);
    expect(li.contains(detail)).toBe(true);
    expect(detail?.hidden).toBe(true);
  });

  it("every aria-controls in the document resolves and is unique across tasks and steps", () => {
    const { host } = mount(vm({ view: "wall", workspace: "w1" }));
    const ids = qa(host, "[aria-controls]").map((e) => attr(e, "aria-controls") ?? "");
    expect(ids.length).toBe(4); // t1: 2 done, t3: 2 done
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(document.getElementById(id)?.classList.contains("step-detail")).toBe(true);
  });

  it("non-done steps render div.step-row (not a button) with no chevron, no aria-expanded", () => {
    const { host } = mount();
    for (const i of [2, 3, 4]) {
      const li = nth(stepsOf(host), i);
      const row = q(li, ".step-row");
      expect(row.tagName).toBe("DIV");
      expect(row.hasAttribute("aria-expanded")).toBe(false);
      expect(li.querySelector(".step-chevron")).toBeNull();
      expect(li.querySelector("button")).toBeNull();
      expect(li.querySelector(".step-detail")).toBeNull();
      q(row, ":scope > .step-indicator");
      expect(txt(q(row, ":scope > .step-text > .step-label"))).not.toBe("");
    }
  });

  it("p.step-note renders only when the step has a note", () => {
    const { host } = mount();
    expect(txt(q(nth(stepsOf(host), 2), "p.step-note"))).toBe("Missing STAGING_SIGNING_KEY — deploy stopped at 09:42.");
    expect(nth(stepsOf(host), 3).querySelector("p.step-note")).toBeNull();
    expect(nth(stepsOf(host), 4).querySelector("p.step-note")).toBeNull();
  });

  it.each([
    ["done", "Done"], ["active", "In progress"], ["blocked", "Blocked"], ["pending", "To do"],
  ] as const)("state %s has visually-hidden text containing %s", (state, label) => {
    const steps = [state === "done" ? mkDone("s", "Today 10:00", ms(13, 10, 0), "Today") : mkStep("s", state)];
    const { host } = mount(withTasks([mkTask("a", { steps })]));
    const li = nth(stepsOf(host, "a"), 0);
    expect(attr(li, "data-state")).toBe(state);
    expect(hiddenText(li)).toContain(label);
    expect(hiddenText(li)).not.toContain("undefined");
  });

  it("the state text is a sibling of .step-label inside .step-text, in order label then hidden text", () => {
    const { host } = mount();
    const t = q(nth(stepsOf(host), 0), ".step-text");
    // A-U91b: visible activity text accompanies the committed step state, U91 M2/M8.
    expect(Array.from(t.children).map((c) => c.className)).toEqual(["step-label", "step-activity-label", "visually-hidden"]);
  });

  it("no step-time on non-done steps without 'at'", () => {
    const { host } = mount();
    expect(nth(stepsOf(host), 3).querySelector(".step-time")).toBeNull();
  });
});

describe("B6 step detail", () => {
  it("detail content: outcome, Finished/Took pairs, Evidence list, source chip", () => {
    const { host } = mount();
    const d = q(nth(stepsOf(host), 0), "div.step-detail");
    expect(txt(q(d, "p.detail-outcome"))).toBe("14 handlers moved to the v2 event schema; the v1 adapter is kept for replay.");
    const pairs = qa(d, "dl.detail-meta > div.detail-pair");
    expect(pairs.map((p) => txt(q(p, "dt")))).toEqual(["Finished", "Took"]);
    expect(txt(q(nth(pairs, 0), "dd"))).toContain("Yesterday 17:10");
    expect(txt(q(nth(pairs, 1), "dd"))).toBe("2 h 05 min");
    expect(txt(q(d, "p.detail-heading"))).toBe("Evidence");
    expect(qa(d, "ul.detail-evidence > li").map(txt)).toEqual(["handlers/*.ts — 14 files changed", "schema/v2.json — new", "git: 3 commits on feat/webhooks-v2"]);
    const chip = q(d, "span.source");
    expect(attr(chip, "data-source")).toBe("device");
    expect(txt(q(chip, ".source-ms"))).toBe("131 ms");
  });

  it("Took pair omitted when the step has no 'took'", () => {
    const step = mkDone("s", "Today 10:00", ms(13, 10, 0), "Today");
    const { took: _took, ...noTook } = step;
    const { host } = mount(withTasks([mkTask("a", { steps: [noTook] })]));
    const d = q(host, "div.step-detail");
    expect(qa(d, "dl.detail-meta dt").map(txt)).toEqual(["Finished"]);
  });

  it("Finished pair omitted when the step has no 'at'", () => {
    const step = mkDone("s", "Today 10:00", ms(13, 10, 0), "Today", { took: "7 min" });
    const { at: _at, ...noAt } = step;
    const { host } = mount(withTasks([mkTask("a", { steps: [noAt] })]));
    const d = q(host, "div.step-detail");
    expect(qa(d, "dl.detail-meta dt").map(txt)).toEqual(["Took"]);
    expect(txt(q(d, "dl.detail-meta dd"))).toBe("7 min");
  });

  it("neither at nor took: no Finished/Took labels at all", () => {
    const step = mkDone("s", "Today 10:00", ms(13, 10, 0), "Today");
    const { at: _a, took: _t, ...bare } = step;
    const { host } = mount(withTasks([mkTask("a", { steps: [bare] })]));
    const d = q(host, "div.step-detail");
    expect(d.textContent).not.toMatch(/Finished|Took/);
  });

  it("step-time shows the HH:MM of 'at' (also for a prefixed day label)", () => {
    const { host } = mount();
    expect(txt(q(nth(stepsOf(host, "t3"), 0), ".step-time"))).toContain("16:02");
    expect(txt(q(nth(stepsOf(host, "t3"), 1), ".step-time"))).toContain("18:12");
  });

  it("a done step without detail never exposes a control for a missing panel", () => {
    const step = mkDone("s", "Today 10:00", ms(13, 10, 0), "Today");
    const { detail: _d, ...noDetail } = step;
    const { host } = mount(withTasks([mkTask("a", { steps: [noDetail] })]));
    const li = nth(stepsOf(host, "a"), 0);
    expect(li.querySelector(".step-detail")).toBeNull();
    for (const e of qa(li, "[aria-controls]")) expect(document.getElementById(attr(e, "aria-controls") ?? "")).not.toBeNull();
    expect(hiddenText(li)).toContain("Done");
  });
});

describe("B6 expand / collapse", () => {
  it("click toggles aria-expanded, hidden and data-open on the li; second click reverts", () => {
    const { host } = mount();
    const li = nth(stepsOf(host), 0);
    const row = q(li, "button.step-row");
    const d = q<HTMLElement>(li, "div.step-detail");
    click(row);
    expect(attr(row, "aria-expanded")).toBe("true");
    expect(d.hidden).toBe(false);
    expect(li.hasAttribute("data-open")).toBe(true);
    click(row);
    expect(attr(row, "aria-expanded")).toBe("false");
    expect(d.hidden).toBe(true);
    expect(li.hasAttribute("data-open")).toBe(false);
  });

  it("collapsed by default: no data-open, detail hidden", () => {
    const { host } = mount();
    for (const li of qa(host, "li.step")) expect(li.hasAttribute("data-open")).toBe(false);
    for (const d of qa<HTMLElement>(host, "div.step-detail")) expect(d.hidden).toBe(true);
  });

  it("expanding one step does not touch its siblings or other tasks", () => {
    const { host } = mount();
    click(q(nth(stepsOf(host, "t1"), 0), "button.step-row"));
    expect(qa(host, "li.step[data-open]").length).toBe(1);
    expect(qa(host, "button.step-row[aria-expanded='true']").length).toBe(1);
  });

  it("click on the label inside the button toggles once", () => {
    const { host } = mount();
    const li = nth(stepsOf(host), 1);
    click(q(li, ".step-label"));
    expect(attr(q(li, "button.step-row"), "aria-expanded")).toBe("true");
  });

  it("toggling never calls any handler", () => {
    const { host } = mount();
    expect(() => click(q(host, "button.step-row"))).not.toThrow();
  });

  it("the row is a native button (keyboard activation comes from the platform)", () => {
    const { host } = mount();
    expect(q(host, "button.step-row").tagName).toBe("BUTTON");
  });
});

describe("B6 expansion state survives update()", () => {
  const open = (host: ParentNode, taskId: string, i: number) => click(q(nth(stepsOf(host, taskId), i), "button.step-row"));
  const isOpen = (host: ParentNode, taskId: string, i: number) => {
    const li = nth(stepsOf(host, taskId), i);
    const row = q(li, "button.step-row");
    const d = q<HTMLElement>(li, "div.step-detail");
    const a = attr(row, "aria-expanded") === "true", b = !d.hidden, c = li.hasAttribute("data-open");
    expect(a === b && b === c, "aria-expanded / hidden / data-open must agree").toBe(true);
    return a;
  };

  it("same task id and step index stays expanded after update with an equal VM", () => {
    const { host, handle } = mount();
    open(host, "t1", 1);
    handle.update(vm());
    expect(isOpen(host, "t1", 1)).toBe(true);
    expect(isOpen(host, "t1", 0)).toBe(false);
  });

  it("stays expanded after update with a structurally cloned VM and changed text", () => {
    const { host, handle } = mount();
    open(host, "t3", 0);
    const next = structuredClone(vm());
    const t = next.tasks.map((x) => (x.id === "t3" ? { ...x, title: "Renamed title" } : x));
    handle.update({ ...next, tasks: t });
    expect(txt(q(host, "article#t3 h2.task-title"))).toBe("Renamed title");
    expect(isOpen(host, "t3", 0)).toBe(true);
  });

  it("several updates in a row keep the state; collapsing is also remembered", () => {
    const { host, handle } = mount();
    open(host, "t1", 0);
    open(host, "t1", 1);
    handle.update(vm());
    handle.update(vm());
    open(host, "t1", 0); // collapse
    handle.update(vm());
    expect(isOpen(host, "t1", 0)).toBe(false);
    expect(isOpen(host, "t1", 1)).toBe(true);
  });

  it("state is keyed by task id and index: another task with the same index is unaffected", () => {
    const { host, handle } = mount();
    open(host, "t1", 0);
    handle.update(vm());
    expect(isOpen(host, "t3", 0)).toBe(false);
  });

  it("a task that moves position (sort change) keeps its expansion", () => {
    const a = mkTask("a", { attention: "none", steps: [mkDone("s0", "Today 10:00", ms(13, 10, 0), "Today")] });
    const b = mkTask("b", { attention: "low", steps: [mkDone("s0", "Today 10:00", ms(13, 10, 0), "Today")] });
    const { host, handle } = mount(withTasks([a, b]));
    open(host, "a", 0);
    handle.update(withTasks([{ ...a, attention: "now" }, b]));
    expect(qa(host, "article.task").map((x) => x.id)).toEqual(["a", "b"]);
    handle.update(withTasks([a, { ...b, attention: "now" }]));
    expect(qa(host, "article.task").map((x) => x.id)).toEqual(["b", "a"]);
    expect(isOpen(host, "a", 0)).toBe(true);
    expect(isOpen(host, "b", 0)).toBe(false);
  });

  it("a task with another id does not inherit expansion", () => {
    const { host, handle } = mount();
    open(host, "t1", 0);
    const renamed = vm().tasks.map((t) => (t.id === "t1" ? { ...t, id: "t1b" } : t));
    handle.update(vm({ tasks: renamed }));
    expect(isOpen(host, "t1b", 0)).toBe(false);
  });

  it("expansion survives a round trip through another view (same task id and step index)", () => {
    const { host, handle } = mount();
    open(host, "t1", 0);
    handle.update(vm({ view: "agenda" }));
    expect(host.querySelector("article.task")).toBeNull();
    handle.update(vm({ view: "wall" }));
    expect(isOpen(host, "t1", 0)).toBe(true);
  });

  it("updated aria-expanded of a step whose detail disappeared does not throw and leaves no dangling aria-controls", () => {
    const { host, handle } = mount();
    open(host, "t1", 0);
    const stripped = vm().tasks.map((t) => (t.id === "t1" ? { ...t, steps: t.steps.map((s, i) => (i === 0 ? mkStep(s.label, "pending") : s)) } : t));
    expect(() => handle.update(vm({ tasks: stripped }))).not.toThrow();
    for (const e of qa(host, "[aria-controls]")) expect(document.getElementById(attr(e, "aria-controls") ?? "")).not.toBeNull();
  });
});
