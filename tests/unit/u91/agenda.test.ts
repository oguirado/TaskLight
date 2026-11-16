import { describe, expect, it } from "vitest";
import { buildPlanAgenda } from "../../../src/views/plan";
import type { AgendaGroupVM, AgendaItemVM } from "../../../src/views/types";
import { canonical, map, micro, mount, setup, step, task, text, wall } from "./fixtures";
import type { Task } from "./fixtures";

setup();
function next(tasks: readonly Task[]): readonly AgendaItemVM[] {
  return buildPlanAgenda(tasks).find(g => g.group.toLowerCase() === "next")?.items ?? [];
}
function supplied(items: readonly AgendaItemVM[]): readonly AgendaGroupVM[] { return [{ group: "Next", items }]; }
function item(taskId: string, microId: string, what: string): AgendaItemVM {
  return { when: "Next", task: taskId, taskId, microId, what };
}
function renderedNext(host: ParentNode): string {
  const group = [...host.querySelectorAll<HTMLElement>(".agenda-group")].find(n => /^next$/i.test(n.querySelector("h2")?.textContent?.trim() ?? ""));
  return group ? text(group) : "";
}
function pair() {
  return task({ status: "running", activity: { state: "idle" }, steps: [
    step({ microId: "T01.M01", label: "Completed headers", state: "done", activity: { state: "done" } }),
    step({ microId: "T01.M02", label: "Pending parser", state: "pending", activity: { state: "idle" } }),
  ] });
}
describe("A6 Next eligibility", () => {
  it("A6 generated Next includes only the pending eligible microtask", () => {
    const result = next([pair()]); expect(result.map(i => i.microId)).toEqual(["T01.M02"]);
  });
  it("A6 supplied Next reconciles done and pending entries against current identities", () => {
    const agenda = supplied([item("T01", "T01.M01", "STALE completed entry"), item("T01", "T01.M02", "Pending parser")]);
    const vm = wall({ tasks: [pair()], view: "agenda", agenda }); const before = structuredClone(vm);
    const { host } = mount(vm); const contents = renderedNext(host);
    expect(contents).toContain("Pending parser"); expect(contents).not.toContain("STALE completed entry"); expect(vm).toEqual(before);
  });
  it("A6 supplied Next loses eligibility immediately when its referenced microtask completes", () => {
    const agenda = supplied([item("T01", "T01.M02", "Supplied pending parser")]);
    const vm = wall({ tasks: [pair()], view: "agenda", agenda }); const { host, handle } = mount(vm);
    expect(renderedNext(host)).toContain("Supplied pending parser");
    handle.update({ ...vm, tasks: [task({ status: "done", activity: { state: "done" },
      steps: [step({ state: "done", activity: { state: "done" } })] })] });
    expect(renderedNext(host)).not.toContain("Supplied pending parser");
  });
  it.each(["done", "cancelled", "archived", "unknown"] as const)("A6 generated Next excludes %s work even with a pending child", kind => {
    const t = task({ activity: { state: kind === "archived" ? "idle" : kind },
      status: kind === "done" ? "done" : kind === "cancelled" ? "failed" : "idle", archived: kind === "archived" });
    expect(next([t])).toHaveLength(0);
  });
  it.each(["done", "cancelled", "archived", "unknown"] as const)("A6 supplied Next cannot bypass %s eligibility", kind => {
    const t = task({ activity: { state: kind === "archived" ? "idle" : kind },
      status: kind === "done" ? "done" : kind === "cancelled" ? "failed" : "idle", archived: kind === "archived" });
    const { host } = mount(wall({ view: "agenda", tasks: [t], agenda: supplied([item("T01", "T01.M02", "INELIGIBLE sentinel")]) }));
    expect(renderedNext(host)).not.toContain("INELIGIBLE sentinel");
  });
  it("A6 an unknown microtask activity cannot enter Next merely because it is pending", () => {
    expect(next([task({ activity: { state: "idle" }, steps: [step({ activity: { state: "unknown" } })] })])).toHaveLength(0);
  });
  it.each(["pending", "done", "cancelled", "missing"] as const)("A6 canonical %s prerequisite uses U88 readiness semantics", state => {
    const dependent = canonical({ id: "T02", state: "pending", deps: ["T01"], ready: state === "done" || state === "cancelled",
      microtasks: [micro({ id: "T02.M01", state: "pending", text: "Dependent parser" })] });
    const prerequisite = canonical({ state: state === "missing" ? "pending" : state,
      explicit_state: state === "cancelled" ? "cancelled" : null,
      microtasks: [micro({ id: "T01.M01", state: state === "done" ? "done" : "pending" })] });
    const vm = map(state === "missing" ? [dependent] : [prerequisite, dependent]);
    const mapped = vm.tasks.find(t => t.taskId === "T02"); expect(mapped).toBeDefined();
    const eligible = state === "done" || state === "cancelled";
    expect(mapped?.waitsFor ?? []).toEqual(eligible ? [] : ["T01"]);
    expect(next(vm.tasks).some(i => i.microId === "T02.M01")).toBe(eligible);
    const { host } = mount({ ...vm, view: "agenda", agenda: supplied([item("T02", "T02.M01", "DEPENDENT sentinel")]) });
    expect(renderedNext(host).includes("DEPENDENT sentinel")).toBe(eligible);
  });
  it("A6 a blocked task remains excluded even when dependencies are satisfied", () => {
    const t = task({ status: "blocked", blockedReason: "Review required", waitsFor: [], activity: { state: "blocked" } });
    expect(next([t])).toHaveLength(0);
    const { host } = mount(wall({ tasks: [t], view: "agenda", agenda: supplied([item("T01", "T01.M02", "BLOCKED sentinel")]) }));
    expect(renderedNext(host)).not.toContain("BLOCKED sentinel");
  });
  it("A6 unknown task and microtask identities in supplied groups never leak", () => {
    const agenda = supplied([item("T99", "T99.M01", "UNKNOWN task"), item("T01", "T01.M99", "UNKNOWN micro"),
      item("T01", "T01.M02", "Pending parser")]);
    const { host } = mount(wall({ tasks: [pair()], view: "agenda", agenda }));
    expect(renderedNext(host)).toContain("Pending parser"); expect(renderedNext(host)).not.toMatch(/UNKNOWN/);
  });
  it("A6 a microtask from another task cannot be attached to a local task identity", () => {
    const second = task({ id: "plan:room-a:T02", taskId: "T02", steps: [step({ microId: "T02.M01" })] });
    const { host } = mount(wall({ tasks: [pair(), second], view: "agenda", agenda: supplied([item("T01", "T02.M01", "MISMATCH sentinel")]) }));
    expect(renderedNext(host)).not.toContain("MISMATCH sentinel");
  });
  it("A6 another workspace cannot enter generated or supplied displayed-room Next", () => {
    const foreign = task({ id: "plan:room-b:T03", taskId: "T03", workspace: "room-b",
      steps: [step({ microId: "T03.M01", label: "FOREIGN generated" })] });
    for (const agenda of [[], supplied([item("T03", "T03.M01", "FOREIGN supplied"), item("T01", "T01.M02", "Pending parser")])]) {
      const { host } = mount(wall({ tasks: [pair(), foreign], view: "agenda", agenda }));
      expect(renderedNext(host)).toContain("Pending parser"); expect(renderedNext(host)).not.toContain("FOREIGN");
    }
  });
  it("A6 supplied items resolve canonical VM ids without bypassing microtask eligibility", () => {
    const agenda = supplied([item("plan:room-a:T01", "T01.M02", "CANONICAL pending"), item("plan:room-a:T01", "T01.M01", "CANONICAL done")]);
    const { host } = mount(wall({ tasks: [pair()], view: "agenda", agenda }));
    expect(renderedNext(host)).toContain("CANONICAL pending"); expect(renderedNext(host)).not.toContain("CANONICAL done");
  });
  it("A6 Now and Blocked preserve available work and dependency explanations", () => {
    const groups = buildPlanAgenda([task({ steps: [step({ state: "active", label: "Current parser" })] }),
      task({ id: "plan:room-a:T02", taskId: "T02", status: "blocked", blockedReason: "CSV source missing", steps: [] }),
      task({ id: "plan:room-a:T03", taskId: "T03", status: "waiting", waitsFor: ["T00"], steps: [] })]);
    expect(groups.find(g => g.group === "Now")?.items.some(i => /Current parser/.test(i.what))).toBe(true);
    const blocked = groups.find(g => g.group === "Blocked");
    expect(blocked?.items.some(i => /CSV source missing/.test(i.reason ?? i.what))).toBe(true);
    expect(blocked?.items.some(i => /T00/.test(i.reason ?? i.what))).toBe(true);
  });
});
