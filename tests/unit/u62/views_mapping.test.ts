import { describe, expect, it, vi } from "vitest";
import { buildPlanAgenda, buildPlanDiary, renderPlanAgenda, renderPlanDiary, renderPlanArchive } from "../../../src/views/plan";
import { all, entries, hostile, mount, q, safeDOM, setup, source, task, text, wall } from "./helpers";

setup();
describe("O4 actionable agenda", () => {
  it("O4 maps Now, Next and two Blocked items in order with agent and reasons", () => {
    const tasks = [task({ steps: [{ label: "Working", state: "active" }] }),
      task({ id: "T02", taskId: "T02", steps: [{ label: "Ready next", state: "pending" }] }),
      task({ id: "T03", taskId: "T03", waitsFor: ["T01"], steps: [{ label: "Waiting next", state: "pending" }] }),
      task({ id: "T04", taskId: "T04", status: "blocked", blockedReason: "Needs approval", steps: [] })];
    const groups = buildPlanAgenda(tasks);
    expect(groups.map(g => g.group)).toEqual(["Now", "Next", "Blocked"]);
    expect(groups.map(g => g.items.length)).toEqual([1, 1, 2]);
    expect(groups[0]!.items[0]!.what).toContain("Working");
    expect(groups[1]!.items[0]!.what).toContain("Ready next");
    const root = renderPlanAgenda(document, groups);
    for (const s of ["Now", "Next", "Blocked", "Working", "Ready next", "builder", "Waits for T01", "Needs approval"]) expect(text(root)).toContain(s);
    expect(root.querySelector('[class*="agenda-"]')).not.toBeNull();
  });
  it("O4 dependency-ready blocked tasks remain excluded from Next (W0-R)", () => {
    const groups = buildPlanAgenda([task({ status: "blocked", waitsFor: [], blockedReason: "Needs review",
      steps: [{ label: "Pending but blocked", state: "pending" }] })]);
    expect(groups.find(g => g.group === "Next")?.items ?? []).toHaveLength(0);
    const root = renderPlanAgenda(document, groups); expect(text(root)).toContain("Needs review");
  });
  it("O4 archived pending tasks are excluded from Next", () => {
    const groups = buildPlanAgenda([task({ archived: true, steps: [{ label: "Archived pending", state: "pending" }] })]);
    expect(groups.find(g => g.group === "Next")?.items ?? []).toHaveLength(0);
  });
  it("O4 blocked microtasks enter Blocked even on an otherwise running task", () => {
    const groups = buildPlanAgenda([task({ steps: [{ label: "Micro blocked", state: "blocked" }] })]);
    expect(groups.find(g => g.group === "Blocked")?.items.map(i => i.what)).toContain("Micro blocked");
    expect(groups.find(g => g.group === "Next")?.items ?? []).toHaveLength(0);
  });
  it("O4 empty agenda has no fabricated items", () => {
    const groups = buildPlanAgenda([]);
    expect(groups.flatMap(g => g.items)).toHaveLength(0);
    expect(() => renderPlanAgenda(document, groups)).not.toThrow();
  });
  it("O4 mountWall honors pre-supplied plan agenda", () => {
    const groups = [{ group: "Now", items: [{ when: "Now", task: "T01", what: "Supplied task", agent: "builder" }] }];
    const reference = renderPlanAgenda(document, groups);
    const { host } = mount(wall({ view: "agenda", agenda: groups }));
    expect(text(reference)).toContain("Supplied task"); expect(text(host)).toContain("Supplied task");
  });
});
describe("O5 diary and archive", () => {
  it("O5 diary groups same-day microtasks and memory updates without dropping entries", () => {
    const groups = buildPlanDiary(entries);
    expect(groups).toHaveLength(2);
    expect(groups.find(g => g.day === "2026-11-15")?.entries).toHaveLength(2);
    expect(groups.find(g => g.day === "2026-11-14")?.entries).toHaveLength(1);
    const root = renderPlanDiary(document, groups);
    expect(all(root, ".entry")).toHaveLength(3);
    for (const s of ["2026-11-15", "2026-11-14", "Verify release", "Verified", "2 min", "reports/check.txt", "Decisions", "builder", "09:10", "Risks", "reviewer", "08:00"]) expect(text(root)).toContain(s);
  });
  it("O5 empty diary has explicit English copy", () => {
    expect(text(renderPlanDiary(document, buildPlanDiary([])))).toContain("No diary entries yet.");
  });
  it("O5 mountWall diary routes supplied memory and microtask entries", () => {
    const reference = renderPlanDiary(document, buildPlanDiary(entries));
    const { host } = mount(wall({ view: "diary" }));
    expect(all(host, ".entry")).toHaveLength(all(reference, ".entry").length);
    for (const s of ["Decisions", "Verified", "reports/check.txt"]) expect(text(host)).toContain(s);
  });
  it.each([true, false])("O5 archive includes count/duration/outcome/source and restore (taskCount=%s)", withCount => {
    const onRestore = vi.fn(); const item = {
      id: "p1", planId: "p1", workspace: "w1", project: "Release", accent: "sky" as const,
      title: "Closed release", archived: "2026-11-15", took: "2 days", steps: 3, outcome: "Shipped", source,
      ...(withCount ? { taskCount: 7 } : {}),
    };
    const root = renderPlanArchive(document, [item], { onRestore }); const card = q(root, ".archived");
    for (const s of ["Closed release", "2026-11-15", "2 days", "Shipped"]) expect(text(card)).toContain(s);
    expect(text(card)).toMatch(new RegExp(`\\b${withCount ? 7 : 3}\\b`));
    expect(card.querySelector(".source")).not.toBeNull();
    const restore = all(card, "button").find(n => /restore/i.test(text(n))); expect(restore).toBeDefined();
    restore!.click(); expect(onRestore).toHaveBeenCalledExactlyOnceWith("p1");
  });
  it("O5 mountWall archive routes plan count, outcome and restore", () => {
    const item = { id: "p1", planId: "p1", workspace: "w1", project: "Release", accent: "sky" as const,
      title: "Closed release", archived: "2026-11-15", took: "2 days", steps: 3, taskCount: 7, outcome: "Shipped", source };
    const reference = renderPlanArchive(document, [item]);
    const onRestore = vi.fn(); const { host } = mount(wall({ view: "archive", archive: [item] }), { onRestore });
    expect(all(host, ".archived")).toHaveLength(all(reference, ".archived").length);
    const card = q(host, ".archived");
    for (const value of ["Closed release", "2 days", "Shipped"]) expect(text(card)).toContain(value);
    expect(text(card)).toMatch(/\b7\b/);
    const restore = all(card, "button").find(n => /restore/i.test(text(n))); expect(restore).toBeDefined();
    restore!.click(); expect(onRestore).toHaveBeenCalledExactlyOnceWith("p1");
  });
  it("O5 archive renders without optional restore callback", () => {
    expect(() => renderPlanArchive(document, [])).not.toThrow();
  });
});
describe("O8 safe mapping payloads", () => {
  it("O8 agenda reasons and agent-authored labels remain inert text", () => {
    const groups = [{ group: "Blocked", items: [{ when: hostile, task: "T01", what: hostile, reason: hostile, agent: hostile }] }];
    const root = renderPlanAgenda(document, groups);
    expect(text(root)).toContain(hostile); safeDOM(root);
  });
  it("O8 diary and archive untrusted text stays literal", () => {
    const diary = renderPlanDiary(document, buildPlanDiary([{ kind: "microtask", day: hostile, at: hostile,
      title: hostile, outcome: hostile, evidence: [hostile] }, { kind: "memory", day: hostile, at: hostile, title: hostile, author: hostile }]));
    const archive = renderPlanArchive(document, [{ id: "p1", workspace: "w1", project: hostile, accent: "sky",
      title: hostile, archived: hostile, took: hostile, steps: 1, outcome: hostile, source }]);
    expect(text(diary)).toContain(hostile); expect(text(archive)).toContain(hostile); safeDOM(diary); safeDOM(archive);
  });
  it.each([null, undefined, {}, [null, {}]])("O8 malformed collection %j is contained by mapping renderers", value => {
    type A = Parameters<typeof renderPlanAgenda>[1];
    type D = Parameters<typeof renderPlanDiary>[1];
    type R = Parameters<typeof renderPlanArchive>[1];
    expect(() => renderPlanAgenda(document, value as unknown as A)).not.toThrow();
    expect(() => renderPlanDiary(document, value as unknown as D)).not.toThrow();
    expect(() => renderPlanArchive(document, value as unknown as R)).not.toThrow();
  });
});
