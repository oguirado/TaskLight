// A-Q1: U148/U150 named non-article task roots retain their classes and identity hooks.
import { afterEach, describe, expect, it } from "vitest";
import type { WallVM } from "../../../src/views/types";
import { FIXTURE, mkTask, vm, withTasks } from "./fixture";
import { ALL_VIEWS, attr, cleanup, mount, nth, q, qa, txt } from "./helpers";

afterEach(cleanup);

const bad = (x: unknown): WallVM => x as WallVM;
const mountAny = (x: unknown) => mount(bad(x));

describe("B15 unknown workspace", () => {
  it("wall: empty board and the first workspace highlighted", () => {
    const { host } = mount(vm({ workspace: "nope" }));
    expect(qa(host, ".task[data-task-id]").length).toBe(0);
    q(host, "section.board");
    const cur = qa(host, "button.workspace[aria-current]");
    expect(cur.length).toBe(1);
    expect(txt(q(nth(cur, 0), ".ws-name"))).toBe("Backend & API");
    expect(attr(nth(cur, 0), "aria-current")).toBe("true");
    expect(q<HTMLElement>(host, "section.focus").hidden).toBe(true);
  });

  it.each(["agenda", "diary", "archive"] as const)("view %s does not throw and shows nothing for the unknown workspace", (view) => {
    const { host } = mount(vm({ workspace: "nope", view }));
    expect(qa(host, "li.agenda-item, li.entry, li.archived").length).toBe(0);
  });

  it("archive with scope all still lists everything for an unknown workspace", () => {
    const { host } = mount(vm({ workspace: "nope", view: "archive", archiveScope: "all" }));
    expect(qa(host, "li.archived").length).toBe(4);
  });

  it("update() to an unknown workspace and back recovers", () => {
    const { host, handle } = mount();
    handle.update(vm({ workspace: "gone" }));
    expect(qa(host, ".task[data-task-id]").length).toBe(0);
    handle.update(vm());
    expect(qa(host, ".task[data-task-id]").length).toBe(2);
  });

  it("no workspaces at all", () => {
    for (const view of ALL_VIEWS) {
      expect(() => mount(vm({ workspaces: [], view }))).not.toThrow();
    }
  });
});

describe("B15 data-* from raw values", () => {
  const accentTask = (accent: string) => mkTask("a", { accent: accent as never, status: "blocked", attention: "now" });
  it.each(["violet", "a", "abcdefghijklmnop"])("valid-looking unknown accent %j is rendered raw", (accent) => {
    const { host } = mount(withTasks([accentTask(accent)]));
    expect(attr(q(host, ".task[data-task-id]"), "data-accent")).toBe(accent);
  });

  it.each(["", "Rose", "ROSE", "has space", "x_y", "a-b", "<abc", "<img src=x>", "abcdefghijklmnopq", "r0se", "\"onmouseover=\"x", "rose\n"])("invalid accent %j: data-accent omitted", (accent) => {
    const { host } = mount(withTasks([accentTask(accent)], { view: "wall" }));
    expect(q(host, ".task[data-task-id]").hasAttribute("data-accent")).toBe(false);
  });

  it("invalid accent omitted everywhere it is used (workspace, agenda, diary, archive)", () => {
    const evil = "Bad Accent!";
    const base = vm();
    const v: WallVM = {
      ...base,
      workspaces: base.workspaces.map((w) => ({ ...w, accent: evil as never })),
      tasks: base.tasks.map((t) => ({ ...t, accent: evil as never })),
      archive: base.archive.map((a) => ({ ...a, accent: evil as never })),
    };
    for (const view of ALL_VIEWS) {
      const { host } = mount({ ...v, view, archiveScope: "all" });
      expect(qa(host, "[data-accent]").length, view).toBe(0);
    }
  });

  it("unknown status values: data-status carries the raw value when it matches ^[a-z]{1,16}$", () => {
    const { host } = mount(withTasks([mkTask("a", { status: "paused" as never, attention: "now" })]));
    expect(attr(q(host, ".task[data-task-id]"), "data-status")).toBe("paused");
    expect(attr(q(host, ".task[data-task-id] span.status"), "data-status")).toBe("paused");
    expect(attr(q(host, "li.focus-item"), "data-status")).toBe("paused");
    expect(txt(q(host, ".task[data-task-id] span.status-label"))).not.toMatch(/undefined|null/);
  });

  it.each(["Paused", "in progress", "x1", "<b>", "abcdefghijklmnopq", ""])("invalid status %j: data-status omitted on article, pill and focus item", (status) => {
    const { host } = mount(withTasks([mkTask("a", { status: status as never, attention: "now" })]));
    expect(q(host, ".task[data-task-id]").hasAttribute("data-status")).toBe(false);
    expect(q(host, ".task[data-task-id] span.status").hasAttribute("data-status")).toBe(false);
    expect(q(host, "li.focus-item").hasAttribute("data-status")).toBe(false);
  });

  it("unknown status in the agenda pill", () => {
    const v = withTasks([mkTask("t1", { status: "paused" as never })], { view: "agenda", workspace: "w1" });
    const { host } = mount(v);
    expect(attr(q(host, "li.agenda-item span.status"), "data-status")).toBe("paused");
    cleanup();
    const { host: h2 } = mount(withTasks([mkTask("t1", { status: "NOPE" as never })], { view: "agenda", workspace: "w1" }));
    expect(q(h2, "li.agenda-item span.status").hasAttribute("data-status")).toBe(false);
  });

  const SAFE = /^[a-z]{1,16}$/;
  const safeOrAbsent = (e: Element, n: string) => { const v = e.getAttribute(n); if (v !== null) expect(v).toMatch(SAFE); };

  it("unknown attention: no throw; data-attention is never an unsafe value", () => {
    const { host } = mount(withTasks([mkTask("a", { attention: "urgent" as never }), mkTask("b", { attention: "Very Urgent!" as never })]));
    for (const a of qa(host, ".task[data-task-id]")) safeOrAbsent(a, "data-attention");
    expect(qa(host, ".task[data-task-id]").length).toBe(2);
  });

  it("unknown lens on a workspace: data-lens is never an unsafe value", () => {
    const base = vm();
    const mk = (lens: string) => ({ ...base, workspaces: [{ id: "w1", name: "W", lens: lens as never, accent: "rose" as const }] });
    for (const l of ["lab", "Lab!", "<x>"]) {
      const { host } = mount(mk(l));
      safeOrAbsent(q(host, "button.workspace"), "data-lens");
      safeOrAbsent(q(host, ".app"), "data-lens");
      cleanup();
    }
  });

  it("unknown source kind: data-source is never an unsafe value; chip still renders", () => {
    const { host } = mount(withTasks([mkTask("a", { source: { kind: "Mars<3" as never, ms: 5 } })]));
    safeOrAbsent(q(host, "p.provenance span.source"), "data-source");
    // A-U51: unknown kinds render as "Rules" with no latency (SPEC_U51 §4, U38 V3 source truth)
    expect(txt(q(host, "p.provenance span.source"))).toContain("Rules");
    expect(host.querySelector("p.provenance .source-ms")).toBeNull();
  });

  it("unknown step state: no throw, data-state never unsafe, no 'undefined' text", () => {
    const { host } = mount(withTasks([mkTask("a", { steps: [{ label: "odd", state: "skipped" as never }, { label: "odd2", state: "S K I P" as never }] })]));
    expect(qa(host, "li.step").length).toBe(2);
    for (const li of qa(host, "li.step")) safeOrAbsent(li, "data-state");
    expect(host.textContent).not.toMatch(/undefined/);
  });
});

describe("B15 never throws", () => {
  it.each([
    ["empty object", {}],
    ["null", null],
    ["undefined", undefined],
    ["a string", "wall"],
    ["number", 42],
    ["empty arrays only", { ...FIXTURE, workspaces: [], tasks: [], agenda: [], archive: [] }],
    ["missing collections", { now: "x", model: { state: "ready", label: "l" }, network: "online", workspace: "w1", view: "wall", archiveScope: "workspace" }],
    ["null task", { ...FIXTURE, tasks: [null] }],
    ["empty task", { ...FIXTURE, tasks: [{}] }],
    ["task without steps", { ...FIXTURE, tasks: [{ ...FIXTURE.tasks[0], steps: undefined }] }],
    ["task with null steps entries", { ...FIXTURE, tasks: [{ ...FIXTURE.tasks[0], steps: [null, {}] }] }],
    ["step detail without evidence", { ...FIXTURE, tasks: [{ ...FIXTURE.tasks[0], steps: [{ label: "x", state: "done", detail: { outcome: "o" } }] }] }],
    ["null source", { ...FIXTURE, tasks: [{ ...FIXTURE.tasks[0], source: null }] }],
    ["unknown view", { ...FIXTURE, view: "settings" }],
    ["unknown scope", { ...FIXTURE, view: "archive", archiveScope: "everything" }],
    ["null model", { ...FIXTURE, model: null }],
    ["unknown network", { ...FIXTURE, network: "flaky" }],
    ["agenda null group", { ...FIXTURE, view: "agenda", agenda: [null, { group: "g" }] }],
    ["archive null item", { ...FIXTURE, view: "archive", archive: [null, {}] }],
  ] as [string, unknown][])("mount with %s", (_n, input) => {
    expect(() => mountAny(input)).not.toThrow();
  });

  it.each(["wall", "agenda", "diary", "archive"] as const)("update with garbage after a good mount (view %s)", (view) => {
    const { handle } = mount(vm({ view }));
    expect(() => handle.update(bad({}))).not.toThrow();
    expect(() => handle.update(bad(null))).not.toThrow();
    expect(() => handle.update(vm({ view }))).not.toThrow();
  });

  it("agenda items pointing at unknown tasks are skipped, not fatal", () => {
    const agenda = [{ group: "Ghosts", items: [{ when: "now", task: "ghost", what: "boo" }, { when: "now", task: "t1", what: "real" }] }];
    const { host } = mount(vm({ view: "agenda", agenda }));
    expect(qa(host, ".agenda-what").map(txt)).toEqual(["real"]);
  });

  it("archived items of an unknown workspace render in scope all (no .archived-ws crash)", () => {
    const archive = [{ ...FIXTURE.archive[0]!, workspace: "ghost" }];
    const { host } = mount(vm({ view: "archive", archiveScope: "all", archive }));
    expect(qa(host, "li.archived").length).toBe(1);
  });

  it("diary: done step whose 'at' does not look like 'Day HH:MM' and missing at_ms/day do not throw", () => {
    const steps = [
      { label: "odd-at", state: "done" as const, at: "whenever", detail: { outcome: "o", evidence: [], source: { kind: "device" as const, ms: 1 } } },
      { label: "no-at", state: "done" as const, detail: { outcome: "o", evidence: [], source: { kind: "device" as const, ms: 1 } } },
    ];
    expect(() => mount(withTasks([mkTask("a", { steps })], { view: "diary" }))).not.toThrow();
  });

  it("duplicate task ids and workspace ids do not throw", () => {
    const tasks = [mkTask("dup"), mkTask("dup")];
    expect(() => mount(withTasks(tasks, { workspaces: [...FIXTURE.workspaces, ...FIXTURE.workspaces] }))).not.toThrow();
  });

  it("non-finite and negative numbers (ms, steps) do not throw and are not echoed as 'undefined'", () => {
    const tasks = [mkTask("a", { source: { kind: "device", ms: Number.NaN } })];
    const archive = [{ ...FIXTURE.archive[0]!, steps: -3 }];
    const { host } = mount(withTasks(tasks, { archive, view: "wall" }));
    expect(host.textContent).not.toMatch(/undefined/);
  });
});
