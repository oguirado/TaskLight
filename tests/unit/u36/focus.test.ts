import { afterEach, describe, expect, it } from "vitest";
import { mkStep, mkTask, vm, withTasks } from "./fixture";
import { ALL_VIEWS, attr, cleanup, mount, nth, q, qa, txt } from "./helpers";

afterEach(cleanup);

const focus = (host: ParentNode) => q<HTMLElement>(host, "section.focus");
const items = (host: ParentNode) => qa(focus(host), "ul.focus-list > li.focus-item");

describe("B7 focus index", () => {
  it("visible with '1 task needs you' and one item for w1 (t1 blocked/now)", () => {
    const { host } = mount();
    expect(focus(host).hidden).toBe(false);
    expect(txt(q(focus(host), "p.focus-eyebrow"))).toBe("1 task needs you");
    expect(items(host).length).toBe(1);
  });

  it("item structure: li.focus-item[data-status] > a.focus-link[href=#id] > span.focus-project + span.focus-step", () => {
    const { host } = mount();
    const li = nth(items(host), 0);
    expect(attr(li, "data-status")).toBe("blocked");
    const a = q(li, ":scope > a.focus-link");
    expect(attr(a, "href")).toBe("#t1");
    expect(txt(q(a, ":scope > span.focus-project"))).toBe("Payments gateway");
    expect(txt(q(a, ":scope > span.focus-step"))).toBe("Deploy to staging — blocked");
  });

  it("the href target is the task article", () => {
    const { host } = mount();
    const href = attr(q(host, "a.focus-link"), "href") ?? "";
    expect(document.getElementById(href.slice(1))).toBe(q(host, "article.task"));
  });

  it("waiting task: first blocked/active step label plus ' — needs input' (status label lower-case)", () => {
    const { host } = mount(vm({ workspace: "w2" }));
    expect(txt(q(focus(host), "p.focus-eyebrow"))).toBe("1 task needs you");
    const li = nth(items(host), 0);
    expect(attr(li, "data-status")).toBe("waiting");
    expect(txt(q(li, ".focus-step"))).toBe("Choose the conflict strategy — needs input");
    expect(attr(q(li, "a.focus-link"), "href")).toBe("#t2");
  });

  it("'<n> tasks need you' for several, items in wall order (attention sorted)", () => {
    const tasks = [
      mkTask("c", { status: "waiting", attention: "low", steps: [mkStep("Step c", "active")] }),
      mkTask("a", { status: "running", attention: "now", steps: [mkStep("Step a", "active")] }),
      mkTask("b", { status: "blocked", attention: "high", steps: [mkStep("Step b", "blocked")] }),
      mkTask("n", { status: "running", attention: "high" }),
    ];
    const { host } = mount(withTasks(tasks));
    expect(txt(q(focus(host), "p.focus-eyebrow"))).toBe("3 tasks need you");
    expect(items(host).map((li) => attr(q(li, "a"), "href"))).toEqual(["#a", "#b", "#c"]);
    expect(txt(q(items(host)[0] as HTMLElement, ".focus-step"))).toBe("Step a — in progress");
  });

  it("the step shown is the FIRST blocked/active step, skipping done and pending ones", () => {
    const steps = [mkStep("d", "done"), mkStep("p", "pending"), mkStep("first-active", "active"), mkStep("later-blocked", "blocked")];
    const { host } = mount(withTasks([mkTask("a", { status: "blocked", attention: "now", steps })]));
    expect(txt(q(focus(host), ".focus-step"))).toBe("first-active — blocked");
  });

  it("attention now alone qualifies (status running)", () => {
    const { host } = mount(withTasks([mkTask("a", { status: "running", attention: "now" })]));
    expect(focus(host).hidden).toBe(false);
    expect(items(host).length).toBe(1);
  });

  it("status waiting alone qualifies (attention none); idle/done/failed/running do not", () => {
    const { host } = mount(withTasks([mkTask("a", { status: "waiting", attention: "none" })]));
    expect(items(host).length).toBe(1);
    cleanup();
    const quiet = (["running", "idle", "done", "failed"] as const).map((s, i) => mkTask(`q${i}`, { status: s, attention: "high" }));
    const { host: h2 } = mount(withTasks(quiet));
    expect(focus(h2).hidden).toBe(true);
  });

  it("hidden (and empty) when nothing needs you", () => {
    const { host } = mount(vm({ workspace: "w3" }));
    expect(focus(host).hidden).toBe(true);
    expect(host.querySelector(".focus-item")).toBeNull();
    expect(host.querySelector(".focus-eyebrow")).toBeNull();
  });

  it("archived tasks and other workspaces are never listed", () => {
    const tasks = [mkTask("a", { status: "blocked", attention: "now", archived: true }), mkTask("b", { status: "blocked", attention: "now", workspace: "w2" })];
    const { host } = mount(withTasks(tasks));
    expect(focus(host).hidden).toBe(true);
  });

  it.each(["agenda", "diary", "archive"] as const)("hidden outside the Wall (%s) even when tasks need you", (view) => {
    const { host } = mount(vm({ view }));
    expect(focus(host).hidden).toBe(true);
    expect(host.querySelector(".focus-item")).toBeNull();
  });

  it("becomes visible again when update() returns to the Wall, hidden again afterwards", () => {
    const { host, handle } = mount(vm({ view: "agenda" }));
    expect(focus(host).hidden).toBe(true);
    handle.update(vm({ view: "wall" }));
    expect(focus(host).hidden).toBe(false);
    handle.update(vm({ view: "diary" }));
    expect(focus(host).hidden).toBe(true);
  });

  it("task without blocked/active step: focus-step still renders text (the status) and no 'undefined'", () => {
    const { host } = mount(withTasks([mkTask("a", { status: "waiting", attention: "high", steps: [mkStep("p", "pending")] })]));
    const t = txt(q(focus(host), ".focus-step"));
    expect(t).not.toBe("");
    expect(t).not.toMatch(/undefined/);
    expect(t.toLowerCase()).toContain("needs input");
  });

  it("only the Wall hides/shows it: the section element exists in every view", () => {
    for (const view of ALL_VIEWS) {
      const { host, handle } = mount(vm({ view }));
      expect(host.querySelectorAll("section.focus").length).toBe(1);
      handle.destroy();
    }
  });

  it("data-attention on section.focus mirrors the first (top) task's attention when visible", () => {
    const tasks = [mkTask("a", { status: "waiting", attention: "low" }), mkTask("b", { status: "blocked", attention: "high" })];
    const { host } = mount(withTasks(tasks));
    expect(attr(focus(host), "data-attention")).toBe("high");
  });
});
