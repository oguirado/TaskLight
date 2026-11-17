// A-Q1: U148/U150 named non-article task roots retain their classes and identity hooks.
import { afterEach, describe, expect, it } from "vitest";
import type { SourceVM } from "../../../src/views/types";
import { mkDone, mkTask, ms, vm, withTasks } from "./fixture";
import { ALL_VIEWS, attr, cleanup, click, mount, mountSpied, nth, q, qa, txt, txts } from "./helpers";

afterEach(cleanup);

const items = (host: ParentNode) => qa(host, "section.archive ul.archive-list > li.archived");
const opts = (host: ParentNode) => qa<HTMLButtonElement>(host, "section.archive .archive-filter > button.archive-option");

describe("B10 archive", () => {
  it("scope workspace (w1): two items, count '2 finished tasks'", () => {
    const { host } = mount(vm({ view: "archive", workspace: "w1", archiveScope: "workspace" }));
    expect(txts(host, "li.archived .archived-title")).toEqual(["Rate limiting shipped to production", "Dependency cleanup finished"]);
    expect(txt(q(host, "p.archive-count"))).toBe("2 finished tasks");
  });

  it("scope all: four items, count '4 finished tasks'", () => {
    const { host } = mount(vm({ view: "archive", workspace: "w1", archiveScope: "all" }));
    expect(items(host).length).toBe(4);
    expect(txt(q(host, "p.archive-count"))).toBe("4 finished tasks");
  });

  it("singular '1 finished task' and plural zero '0 finished tasks'", () => {
    const { host } = mount(vm({ view: "archive", workspace: "w2" }));
    expect(txt(q(host, "p.archive-count"))).toBe("1 finished task");
    cleanup();
    const { host: h0 } = mount(vm({ view: "archive", archive: [] }));
    expect(txt(q(h0, "p.archive-count"))).toBe("0 finished tasks");
    expect(items(h0).length).toBe(0);
  });

  it("filter: two aria-pressed buttons 'This workspace' / 'All workspaces' reflecting the scope", () => {
    const { host } = mount(vm({ view: "archive", archiveScope: "workspace" }));
    expect(opts(host).map(txt)).toEqual(["This workspace", "All workspaces"]);
    expect(opts(host).map((b) => attr(b, "aria-pressed"))).toEqual(["true", "false"]);
    for (const b of opts(host)) expect(attr(b, "type")).toBe("button");
    cleanup();
    const { host: h2 } = mount(vm({ view: "archive", archiveScope: "all" }));
    expect(opts(h2).map((b) => attr(b, "aria-pressed"))).toEqual(["false", "true"]);
  });

  it("the bar is .archive-bar > .archive-filter + p.archive-count", () => {
    const { host } = mount(vm({ view: "archive" }));
    const bar = q(host, "section.archive > .archive-bar");
    expect(Array.from(bar.children).map((c) => c.className)).toEqual(["archive-filter", "archive-count"]);
  });

  it("clicking the other scope calls onArchiveScope with it; view is controlled (no change by itself)", () => {
    const { host, spies } = mountSpied(vm({ view: "archive", archiveScope: "workspace" }));
    click(nth(opts(host), 1));
    expect(spies.onArchiveScope.mock.calls).toEqual([["all"]]);
    expect(attr(nth(opts(host), 0), "aria-pressed")).toBe("true");
    expect(items(host).length).toBe(2);
    expect(attr(q(host, ".app"), "data-archive-scope")).toBe("workspace");
  });

  it("clicking 'This workspace' while scope is all calls onArchiveScope('workspace')", () => {
    const { host, spies } = mountSpied(vm({ view: "archive", archiveScope: "all" }));
    click(nth(opts(host), 0));
    expect(spies.onArchiveScope.mock.calls).toEqual([["workspace"]]);
  });

  it(".archived-ws appears only in scope all and carries the workspace name", () => {
    const { host } = mount(vm({ view: "archive", workspace: "w1", archiveScope: "workspace" }));
    expect(host.querySelector(".archived-ws")).toBeNull();
    cleanup();
    const { host: h2 } = mount(vm({ view: "archive", workspace: "w1", archiveScope: "all" }));
    expect(txts(h2, ".archived-head > .archived-ws")).toEqual(["Backend & API", "Backend & API", "Notes mobile app", "Master's thesis"]);
  });

  it("item markup: head (dot, project, date), title, outcome, meta (steps, chip, restore)", () => {
    const { host } = mount(vm({ view: "archive", workspace: "w2" }));
    const li = nth(items(host), 0);
    expect(attr(li, "data-accent")).toBe("iris");
    const head = q(li, ":scope > p.archived-head");
    q(head, ".project-dot");
    expect(txt(q(head, ".archived-project"))).toBe("Notes mobile app");
    expect(txt(q(head, ".archived-date"))).toContain("Mon 9 Nov");
    expect(txt(q(li, ":scope > h2.archived-title"))).toBe("Offline editor shipped in beta");
    expect(txt(q(li, ":scope > p.archived-outcome"))).toBe("Editor works fully offline; 120 beta users, crash-free rate 99.6 %.");
    const meta = q(li, ":scope > p.archived-meta");
    expect(txt(q(meta, ".archived-steps"))).toContain("6");
    expect(txt(q(meta, ".archived-steps"))).toContain("3 days");
    expect(attr(q(meta, "span.source"), "data-source")).toBe("cloud");
    expect(txt(q(meta, "button.archived-restore"))).not.toBe("");
  });

  it("restore button calls onRestore(id) with the archived item's id, once, and nothing else", () => {
    const { host, spies } = mountSpied(vm({ view: "archive", workspace: "w1" }));
    click(q(nth(items(host), 1), "button.archived-restore"));
    expect(spies.onRestore.mock.calls).toEqual([["t4"]]);
    expect(spies.onView).not.toHaveBeenCalled();
    expect(items(host).length).toBe(2); // not removed by itself
  });

  it("restore buttons are native buttons with type=button", () => {
    const { host } = mount(vm({ view: "archive", archiveScope: "all" }));
    const b = qa<HTMLButtonElement>(host, "button.archived-restore");
    expect(b.length).toBe(4);
    for (const x of b) { expect(x.tagName).toBe("BUTTON"); expect(attr(x, "type")).toBe("button"); }
  });

  it("archive items follow VM order", () => {
    const { host } = mount(vm({ view: "archive", archiveScope: "all" }));
    expect(txts(host, ".archived-project")).toEqual(["Auth service", "Monorepo", "Notes mobile app", "Thesis — chapter 2"]);
  });

  it("filtering by scope uses the item's workspace, not the task list", () => {
    const { host } = mount(vm({ view: "archive", workspace: "w3", tasks: [] }));
    expect(txts(host, ".archived-title")).toEqual(["Methodology chapter submitted to supervisor"]);
  });
});

/* ---------------------------------------------------------------------------------------- */

const LABEL = { device: "Gemini Nano · on device", cloud: "Gemini · cloud fallback" } as const;
const chipOk = (chip: Element, s: SourceVM) => {
  expect(attr(chip, "data-source")).toBe(s.kind);
  expect(chip.tagName).toBe("SPAN");
  q(chip, ":scope > .source-icon");
  expect(txt(q(chip, ":scope > .source-label"))).toBe(LABEL[s.kind]);
  expect(txt(q(chip, ":scope > .source-ms"))).toBe(`${s.ms} ms`);
};

describe("B11 source chip", () => {
  it("task provenance chip: device", () => {
    const { host } = mount();
    chipOk(q(nth(qa(host, ".task[data-task-id]"), 0), "p.provenance > span.source"), { kind: "device", ms: 142 });
  });

  it("task provenance chip: cloud", () => {
    const { host } = mount(vm({ workspace: "w2" }));
    chipOk(q(host, ".task[data-task-id] p.provenance > span.source"), { kind: "cloud", ms: 1180 });
  });

  it("step detail chip", () => {
    const { host } = mount();
    chipOk(q(host, ".task#t1 div.step-detail span.source"), { kind: "device", ms: 131 });
  });

  it("diary entry chip (cloud)", () => {
    const { host } = mount(vm({ view: "diary", workspace: "w3" }));
    const li = qa(host, "li.entry").find((x) => txt(q(x, ".entry-title")) === "Probability review");
    chipOk(q(li as Element, "span.source"), { kind: "cloud", ms: 1340 });
  });

  it("archive chip (cloud, all scope)", () => {
    const { host } = mount(vm({ view: "archive", archiveScope: "all" }));
    chipOk(q(nth(qa(host, "li.archived"), 2), "span.source"), { kind: "cloud", ms: 1210 });
  });

  it("ms is rendered verbatim as '<ms> ms' for model chips; ms 0 reads Rules (U38 V3)", () => {
    const tasks = [mkTask("a", { source: { kind: "device", ms: 0 } }), mkTask("b", { source: { kind: "cloud", ms: 123456 } })];
    const { host } = mount(withTasks(tasks));
    // U38 V3: a chip with no latency (ms 0) means no model ran -> "Rules", no "<ms> ms"; model chips keep '<ms> ms'.
    expect(txts(host, "p.provenance .source-ms")).toEqual(["123456 ms"]);
    expect(txts(host, "p.provenance .source-label")).toEqual(["Rules", LABEL.cloud]);
  });

  it.each(ALL_VIEWS)("every chip in view %s has a valid kind and label", (view) => {
    const { host } = mount(vm({ view, archiveScope: "all" }));
    for (const c of qa(host, "span.source")) {
      const k = attr(c, "data-source") as "device" | "cloud";
      expect(["device", "cloud"]).toContain(k);
      expect(txt(q(c, ".source-label"))).toBe(LABEL[k]);
    }
  });

  it("diary step source is the step's own source, not the task's", () => {
    const step = mkDone("s", "Today 10:00", ms(13, 10, 0), "Today", { detail: { outcome: "o", evidence: [], source: { kind: "cloud", ms: 777 } } });
    const { host } = mount(withTasks([mkTask("a", { source: { kind: "device", ms: 1 }, steps: [step] })], { view: "diary" }));
    chipOk(q(host, "li.entry span.source"), { kind: "cloud", ms: 777 });
  });
});
