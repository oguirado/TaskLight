import { afterEach, describe, expect, it } from "vitest";
import type { AttentionVM, TaskStatusVM } from "../../../src/views/types";
import { mkDone, mkStep, mkTask, ms, vm, withTasks } from "./fixture";
import { attr, cardIds, cards, cleanup, mount, nth, q, qa, txt } from "./helpers";

afterEach(cleanup);

describe("B5 wall: selection and order", () => {
  it("shows only non-archived tasks of vm.workspace (w1: t1, t3)", () => {
    const { host } = mount();
    expect(cardIds(host)).toEqual(["t1", "t3"]);
  });

  it.each([["w2", ["t2"]], ["w3", ["t5", "t6"]]] as const)("workspace %s shows %j", (workspace, ids) => {
    const { host } = mount(vm({ workspace }));
    expect(cardIds(host)).toEqual([...ids]);
  });

  it("board is a section.board with an aria-label, children are article.task", () => {
    const { host } = mount();
    const board = q(host, "div.view > section.board");
    expect(attr(board, "aria-label")).toBeTruthy();
    expect(Array.from(board.children).every((c) => c.tagName === "ARTICLE" && c.classList.contains("task"))).toBe(true);
  });

  it("sorts by attention now > high > low > none, stable for ties", () => {
    const att: AttentionVM[] = ["none", "low", "high", "now", "low", "now", "high", "none", "now"];
    const tasks = att.map((a, i) => mkTask(`k${i}`, { attention: a }));
    const { host } = mount(withTasks(tasks));
    expect(cardIds(host)).toEqual(["k3", "k5", "k8", "k2", "k6", "k1", "k4", "k0", "k7"]);
  });

  it("stable order when every task has the same attention (input order preserved)", () => {
    const tasks = ["z", "a", "m", "b", "y", "c", "x", "d", "w", "e", "v", "f"].map((id) => mkTask(id, { attention: "high" }));
    const { host } = mount(withTasks(tasks));
    expect(cardIds(host)).toEqual(tasks.map((t) => t.id));
  });

  it("does not mutate the VM task array while sorting", () => {
    const tasks = [mkTask("b", { attention: "none" }), mkTask("a", { attention: "now" })];
    const copy = tasks.slice();
    mount(withTasks(tasks));
    expect(tasks).toEqual(copy);
  });

  it("archived tasks and other workspaces are excluded; zero tasks gives an empty board", () => {
    const tasks = [mkTask("a", { archived: true }), mkTask("b", { workspace: "w2" })];
    const { host } = mount(withTasks(tasks));
    expect(cards(host).length).toBe(0);
    q(host, "section.board");
  });
});

describe("B5 wall: article.task markup", () => {
  it("carries data-status, data-attention, data-accent and is labelled by its title", () => {
    const { host } = mount();
    const a = nth(cards(host), 0);
    expect(a.id).toBe("t1");
    expect(attr(a, "data-status")).toBe("blocked");
    expect(attr(a, "data-attention")).toBe("now");
    expect(attr(a, "data-accent")).toBe("rose");
    const title = q(a, "h2.task-title");
    const lb = attr(a, "aria-labelledby");
    expect(lb).toBeTruthy();
    expect(document.getElementById(lb ?? "")).toBe(title);
  });

  it("header.task-head: project dot + project name, status pill", () => {
    const { host } = mount();
    const a = nth(cards(host), 0);
    expect(txt(q(a, "header.task-head > p.task-project > span.project-name"))).toBe("Payments gateway");
    q(a, "header.task-head > p.task-project > span.project-dot");
    const st = q(a, "header.task-head > span.status");
    expect(attr(st, "data-status")).toBe("blocked");
    q(st, ".status-icon");
    expect(txt(q(st, ".status-label"))).toBe("Blocked");
  });

  it.each([
    ["blocked", "Blocked"], ["waiting", "Needs input"], ["running", "In progress"], ["idle", "Idle"], ["done", "Done"], ["failed", "Failed"],
  ] as [TaskStatusVM, string][])("status %s has the pill label %s", (status, label) => {
    const { host } = mount(withTasks([mkTask("a", { status })]));
    const st = q(host, "article.task span.status");
    expect(attr(st, "data-status")).toBe(status);
    expect(txt(q(st, ".status-label"))).toBe(label);
  });

  it("title, summary, next, provenance render from the VM", () => {
    const { host } = mount();
    const a = nth(cards(host), 0);
    expect(txt(q(a, "h2.task-title"))).toBe("Webhook migration is waiting for the staging signing key");
    expect(txt(q(a, "p.task-summary"))).toMatch(/^All 14 handlers use the v2 schema/);
    expect(txt(q(a, "footer.task-foot .next > p.next-label"))).toBe("Next");
    expect(txt(q(a, "footer.task-foot .next > p.next-text"))).toBe("Add the test signing key to the staging config and redeploy.");
    expect(txt(q(a, "footer.task-foot p.provenance > span.updated"))).toBe("Updated 09:42");
    q(a, "footer.task-foot p.provenance > span.source");
  });

  it("steps list: ol.steps with one li.step per step carrying data-state", () => {
    const { host } = mount();
    const a = nth(cards(host), 0);
    const li = qa(a, "ol.steps > li.step");
    expect(li.map((x) => attr(x, "data-state"))).toEqual(["done", "done", "blocked", "pending", "pending"]);
    expect(attr(q(a, "ol.steps"), "aria-label")).toBeTruthy();
  });
});

describe("B5 progress", () => {
  const prog = (steps: ReturnType<typeof mkStep>[]) => {
    const { host } = mount(withTasks([mkTask("a", { steps })]));
    const p = q(host, ".progress");
    return { label: txt(q(p, ".progress-label")), bar: q(p, ".progress-track"), fill: p.querySelector<HTMLElement>(".progress-track > .progress-fill") as HTMLElement };
  };
  const d = (n: number) => mkDone(`s${n}`, "Today 10:00", ms(13, 10, 0), "Today");

  it("'<done> of <total> steps' and aria-valuenow = round(done/total*100)", () => {
    const r = prog([d(1), d(2), mkStep("c", "active"), mkStep("d", "pending")]);
    expect(r.label).toBe("2 of 4 steps");
    expect(attr(r.bar, "role")).toBe("progressbar");
    expect(attr(r.bar, "aria-valuenow")).toBe("50");
    expect(attr(r.bar, "aria-valuemin")).toBe("0");
    expect(attr(r.bar, "aria-valuemax")).toBe("100");
    expect(attr(r.bar, "aria-label")).toBeTruthy();
  });

  it("rounds: 1/3 -> 33, 2/3 -> 67, 1/8 -> 13 (12.5 rounds half up)", () => {
    expect(attr(prog([d(1), mkStep("b", "pending"), mkStep("c", "pending")]).bar, "aria-valuenow")).toBe("33");
    cleanup();
    expect(attr(prog([d(1), d(2), mkStep("c", "pending")]).bar, "aria-valuenow")).toBe("67");
    cleanup();
    const eight = [d(1), ...Array.from({ length: 7 }, (_, i) => mkStep(`p${i}`, "pending"))];
    expect(attr(prog(eight).bar, "aria-valuenow")).toBe("13");
  });

  it("0 steps: '0 of 0 steps', aria-valuenow 0 (never NaN)", () => {
    const r = prog([]);
    expect(r.label).toBe("0 of 0 steps");
    expect(attr(r.bar, "aria-valuenow")).toBe("0");
    expect(r.bar.outerHTML).not.toMatch(/NaN/);
    expect(r.fill).toBeNull(); // U38 V2: a task with no steps shows no bar fill
  });

  it("all done: 100", () => {
    const r = prog([d(1), d(2)]);
    expect(attr(r.bar, "aria-valuenow")).toBe("100");
    expect(r.label).toBe("2 of 2 steps");
  });

  it("only state=done counts (blocked/active/pending do not)", () => {
    const r = prog([mkStep("a", "blocked"), mkStep("b", "active"), mkStep("c", "pending")]);
    expect(r.label).toBe("0 of 3 steps");
  });

  it("progress fill takes its width from the --p custom property equal to the percentage", () => {
    const r = prog([d(1), mkStep("b", "pending")]);
    const p = r.fill.style.getPropertyValue("--p");
    expect(p).toBe("50%");
  });
});
