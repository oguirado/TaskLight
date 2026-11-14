import { afterEach, describe, expect, it } from "vitest";
import { mkDone, mkStep, mkTask, ms, vm, withTasks } from "./fixture";
import { attr, cleanup, mount, nth, q, qa, txt, txts } from "./helpers";

afterEach(cleanup);

const groups = (host: ParentNode) => qa(host, "section.agenda > .agenda-group");
const gShape = (host: ParentNode) => groups(host).map((g) => ({ h: txt(q(g, "h2.agenda-heading")), what: qa(g, "ul.agenda-list > li.agenda-item .agenda-what").map(txt) }));

describe("B8 agenda", () => {
  it("w1: items of w1's non-archived tasks, groups in VM order", () => {
    const { host } = mount(vm({ view: "agenda", workspace: "w1" }));
    expect(gShape(host)).toEqual([
      { h: "Waiting on you", what: ["Add the staging signing key"] },
      { h: "Next up", what: ["Review the JavaScript example"] },
      { h: "Tomorrow", what: ["Replay yesterday's failed events"] },
    ]);
  });

  it("w2: empty groups omitted entirely (no heading without items)", () => {
    const { host } = mount(vm({ view: "agenda", workspace: "w2" }));
    expect(gShape(host)).toEqual([{ h: "Waiting on you", what: ["Choose the conflict strategy"] }]);
    expect(qa(host, "h2.agenda-heading").length).toBe(1);
  });

  it("w3: Next up and Tomorrow", () => {
    const { host } = mount(vm({ view: "agenda", workspace: "w3" }));
    expect(gShape(host)).toEqual([
      { h: "Next up", what: ["Outline section 3.4"] },
      { h: "Tomorrow", what: ["Hypothesis testing practice set 4"] },
    ]);
  });

  it("items of archived tasks are excluded (and the group vanishes when it only held those)", () => {
    const agenda = [...vm().agenda, { group: "Cleanup", items: [{ when: "Now", task: "t4", what: "Archive-only item" }] }];
    const { host } = mount(vm({ view: "agenda", agenda }));
    expect(txt(host)).not.toContain("Archive-only item");
    expect(gShape(host).map((g) => g.h)).not.toContain("Cleanup");
  });

  it("group order and item order follow the VM, not the clock", () => {
    const tasks = [mkTask("a"), mkTask("b"), mkTask("c")];
    const agenda = [
      { group: "Z last alphabetically, first in VM", items: [{ when: "23:00", task: "c", what: "third" }, { when: "01:00", task: "a", what: "first" }] },
      { group: "A", items: [{ when: "12:00", task: "b", what: "second group item" }] },
    ];
    const { host } = mount(withTasks(tasks, { view: "agenda", agenda }));
    expect(gShape(host)).toEqual([
      { h: "Z last alphabetically, first in VM", what: ["third", "first"] },
      { h: "A", what: ["second group item"] },
    ]);
  });

  it("item markup: data-accent/data-attention from the task, when, what + project, status pill", () => {
    const { host } = mount(vm({ view: "agenda", workspace: "w1" }));
    const li = q(host, "li.agenda-item");
    expect(attr(li, "data-accent")).toBe("rose");
    expect(attr(li, "data-attention")).toBe("now");
    expect(txt(q(li, ":scope > span.agenda-when"))).toBe("Now");
    expect(txt(q(li, ":scope > span.agenda-body > span.agenda-what"))).toBe("Add the staging signing key");
    expect(txt(q(li, ":scope > span.agenda-body > span.agenda-task"))).toBe("Payments gateway");
    const st = q(li, ":scope > span.status");
    expect(attr(st, "data-status")).toBe("blocked");
    expect(txt(q(st, ".status-label"))).toBe("Blocked");
  });

  it("status pill labels per item follow the task status (waiting -> Needs input, running -> In progress)", () => {
    const { host } = mount(vm({ view: "agenda", workspace: "w2" }));
    expect(txt(q(host, "li.agenda-item .status-label"))).toBe("Needs input");
    cleanup();
    const { host: h1 } = mount(vm({ view: "agenda", workspace: "w1" }));
    expect(txts(h1, "li.agenda-item .status-label")).toEqual(["Blocked", "In progress", "Blocked"]);
  });

  it("section.agenda > .agenda-group > h2 + ul.agenda-list structure", () => {
    const { host } = mount(vm({ view: "agenda" }));
    const g = nth(groups(host), 0);
    expect(Array.from(g.children).map((c) => c.tagName.toLowerCase())).toEqual(["h2", "ul"]);
    expect(attr(q(host, "section.agenda"), "aria-label")).toBeTruthy();
  });

  it("no groups at all gives an empty section.agenda", () => {
    const { host } = mount(vm({ view: "agenda", agenda: [] }));
    expect(qa(host, "section.agenda > *").length).toBe(0);
  });
});

/* ---------------------------------------------------------------------------------------- */

const entries = (host: ParentNode) => qa(host, "section.diary > .diary-day").map((d) => ({
  day: txt(q(d, "h2.diary-heading")),
  e: qa(d, "ol.timeline > li.entry").map((li) => ({ t: txt(q(li, "time.entry-time")), title: txt(q(li, ".entry-title")) })),
}));

describe("B9 diary", () => {
  it("w1: archived task history included, days grouped, entries by descending at_ms", () => {
    const { host } = mount(vm({ view: "diary", workspace: "w1" }));
    expect(entries(host)).toEqual([
      { day: "Today", e: [{ t: "18:12", title: "Python example" }, { t: "09:20", title: "Run contract tests locally" }] },
      { day: "Yesterday", e: [
        { t: "17:10", title: "Port handlers to the v2 schema" }, { t: "12:20", title: "Run all suites" },
        { t: "11:52", title: "Remove and regenerate lockfile" }, { t: "11:30", title: "Find unused packages" } ] },
      { day: "Wed 11 Nov", e: [{ t: "16:02", title: "Reference pages for /v2" }] },
    ]);
  });

  it("w3: only w3's done steps with detail", () => {
    const { host } = mount(vm({ view: "diary", workspace: "w3" }));
    expect(entries(host)).toEqual([
      { day: "Today", e: [{ t: "16:40", title: "Draft sections 3.1–3.3" }, { t: "15:50", title: "Distributions review" }] },
      { day: "Thu 12 Nov", e: [{ t: "19:00", title: "Probability review" }] },
    ]);
  });

  it("entry markup: data-accent, time, title, outcome, project, took, source chip", () => {
    const { host } = mount(vm({ view: "diary", workspace: "w1" }));
    const li = q(host, "li.entry");
    expect(attr(li, "data-accent")).toBe("sky");
    expect(txt(q(li, ":scope > time.entry-time"))).toBe("18:12");
    const body = q(li, ":scope > div.entry-body");
    expect(txt(q(body, ":scope > p.entry-title"))).toBe("Python example");
    expect(txt(q(body, ":scope > p.entry-outcome"))).toBe("Cursor loop with retry; runs against the sandbox.");
    expect(txt(q(body, ":scope > p.entry-meta > span.entry-project"))).toBe("Public API docs");
    expect(txt(q(body, ":scope > p.entry-meta > span.entry-took"))).toBe("19 min");
    const chip = q(body, ":scope > p.entry-meta > span.source");
    expect(attr(chip, "data-source")).toBe("device");
    expect(txt(q(chip, ".source-ms"))).toBe("97 ms");
  });

  it("archived task entries carry their own accent and project", () => {
    const { host } = mount(vm({ view: "diary", workspace: "w1" }));
    const li = qa(host, "li.entry").find((x) => txt(q(x, ".entry-title")) === "Run all suites");
    expect(li).toBeDefined();
    expect(attr(li as Element, "data-accent")).toBe("slate");
    expect(txt(q(li as Element, ".entry-project"))).toBe("Monorepo");
  });

  it("time is taken from 'at' (HH:MM), not derived from at_ms", () => {
    const step = mkDone("s", "Today 07:05", ms(13, 23, 59), "Today");
    const { host } = mount(withTasks([mkTask("a", { steps: [step] })], { view: "diary" }));
    expect(txt(q(host, "time.entry-time"))).toBe("07:05");
  });

  it("ties on at_ms keep input order; sorting is by at_ms, not by input or label", () => {
    const t = ms(13, 10, 0);
    const steps = [
      mkDone("tie-1", "Today 10:00", t, "Today"), mkDone("older", "Today 08:00", ms(13, 8, 0), "Today"),
      mkDone("tie-2", "Today 10:00", t, "Today"), mkDone("newest", "Today 11:00", ms(13, 11, 0), "Today"),
      mkDone("tie-3", "Today 10:00", t, "Today"),
    ];
    const { host } = mount(withTasks([mkTask("a", { steps })], { view: "diary" }));
    expect(txts(host, "li.entry .entry-title")).toEqual(["newest", "tie-1", "tie-2", "tie-3", "older"]);
  });

  it("ties across tasks keep input order of tasks", () => {
    const t = ms(13, 10, 0);
    const a = mkTask("a", { steps: [mkDone("from-a", "Today 10:00", t, "Today")] });
    const b = mkTask("b", { steps: [mkDone("from-b", "Today 10:00", t, "Today")] });
    const { host } = mount(withTasks([b, a], { view: "diary" }));
    expect(txts(host, "li.entry .entry-title")).toEqual(["from-b", "from-a"]);
  });

  it("entries from different tasks interleave by time", () => {
    const a = mkTask("a", { steps: [mkDone("a1", "Today 09:00", ms(13, 9, 0), "Today"), mkDone("a2", "Today 11:00", ms(13, 11, 0), "Today")] });
    const b = mkTask("b", { archived: true, steps: [mkDone("b1", "Today 10:00", ms(13, 10, 0), "Today")] });
    const { host } = mount(withTasks([a, b], { view: "diary" }));
    expect(txts(host, "li.entry .entry-title")).toEqual(["a2", "b1", "a1"]);
  });

  it("not-done steps and done steps without detail are excluded", () => {
    const noDetail = mkDone("no-detail", "Today 10:00", ms(13, 10, 0), "Today");
    delete (noDetail as { detail?: unknown }).detail;
    const steps = [mkStep("act", "active"), mkStep("blk", "blocked"), mkStep("pen", "pending"), noDetail, mkDone("real", "Today 09:00", ms(13, 9, 0), "Today")];
    const { host } = mount(withTasks([mkTask("a", { steps })], { view: "diary" }));
    expect(txts(host, "li.entry .entry-title")).toEqual(["real"]);
  });

  it("other workspaces' steps never appear", () => {
    const a = mkTask("a", { steps: [mkDone("mine", "Today 09:00", ms(13, 9, 0), "Today")] });
    const b = mkTask("b", { workspace: "w2", steps: [mkDone("theirs", "Today 10:00", ms(13, 10, 0), "Today")] });
    const { host } = mount(withTasks([a, b], { view: "diary" }));
    expect(txts(host, "li.entry .entry-title")).toEqual(["mine"]);
  });

  it("no done steps: empty section.diary (no day headings)", () => {
    const { host } = mount(withTasks([mkTask("a", { steps: [mkStep("x", "active")] })], { view: "diary" }));
    expect(qa(host, "section.diary").length).toBe(1);
    expect(qa(host, "h2.diary-heading").length).toBe(0);
  });

  it("day headings come from 'day' and each day appears once", () => {
    const { host } = mount(vm({ view: "diary", workspace: "w1" }));
    const days = txts(host, "h2.diary-heading");
    expect(new Set(days).size).toBe(days.length);
    expect(days).toEqual(["Today", "Yesterday", "Wed 11 Nov"]);
  });

  it("structure: .diary-day > h2.diary-heading + ol.timeline", () => {
    const { host } = mount(vm({ view: "diary" }));
    const d = q(host, ".diary-day");
    expect(Array.from(d.children).map((c) => c.tagName.toLowerCase())).toEqual(["h2", "ol"]);
    expect(attr(q(host, "section.diary"), "aria-label")).toBeTruthy();
  });
});
