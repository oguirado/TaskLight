import { describe, expect, it, vi } from "vitest";
import { buildPlanAgenda, renderPlanBand } from "../../../src/views/plan";
import type { AgendaItemVM, ActivityStateVM } from "../../../src/views/types";
import { activate, announcements, canonical, card, map, micro, mount, plan, projection, q, setup,
  step, task, text, wall, workingWall } from "./fixtures";
import { hasAnimation } from "./css_probe";

setup();
const foreign = () => task({ id: "plan:room-b:T01", workspace: "room-b", title: "Foreign task",
  activity: { state: "idle" }, steps: [step({ activity: { state: "idle" } })] });
const local = () => task({ activity: { state: "idle" }, steps: [step({ activity: { state: "idle" } })] });
const entry = (taskId: string, what: string): AgendaItemVM =>
  ({ task: taskId, taskId, microId: "T01.M02", when: "Next", what });

describe("U91 repair: workspace and supplied Agenda admission", () => {
  it("keeps the integrated wall scoping when phases and local ids collide", () => {
    const { host } = mount(wall({ tasks: [local(), foreign()] }));
    expect(host.querySelectorAll("article.task")).toHaveLength(1);
    expect(text(q(host, ".phase-groups"))).not.toContain("Foreign task");
  });
  it.each(["Now", "Next", "Blocked"])("reconciles every supplied %s identity, rejecting unknown, foreign and ambiguous ids", group => {
    const { host } = mount(wall({ view: "agenda", tasks: [local(), foreign()], agenda: [{ group, items: [
      entry("T01", "AMBIGUOUS secret"), entry("plan:room-b:T01", "FOREIGN secret"),
      entry("missing", "UNKNOWN secret"), entry("plan:room-a:T01", "LOCAL allowed"),
      { ...entry("plan:room-a:T01", "BAD micro"), microId: "missing" },
      { ...entry("plan:room-a:T01", "CONFLICTING workspace"), workspace: "room-b" },
    ] }] }));
    const contents = text(q(host, ".agenda"));
    expect(contents).toContain("LOCAL allowed");
    expect(contents).not.toMatch(/secret|BAD micro|CONFLICTING/);
  });
  it("preserves workspace qualification in mapped and generated Agenda items", () => {
    const a = canonical({ state: "pending", microtasks: [micro({ state: "pending", text: "LOCAL mapped" })] });
    const b = canonical({ state: "pending", microtasks: [micro({ state: "pending", text: "FOREIGN mapped" })] });
    const vm = map([a], 189999, {}, [projection([b], "room-b")]);
    const { host } = mount({ ...vm, view: "agenda" });
    expect(text(q(host, ".agenda"))).toContain("LOCAL mapped");
    expect(text(q(host, ".agenda"))).not.toContain("FOREIGN mapped");
    const generated = buildPlanAgenda([local(), foreign()]).find(g => g.group === "Next")!.items;
    const { host: again } = mount(wall({ view: "agenda", tasks: [local(), foreign()], agenda: [{ group: "Next", items: generated }] }));
    expect(q(again, ".agenda").querySelectorAll(".agenda-item")).toHaveLength(1);
  });
  it.each(["Next", "next", "nExT"])("gates task-only %s against pending child activity", group => {
    const t = task({ activity: { state: "idle" }, steps: [step({ activity: { state: "unknown" } })] });
    const { host } = mount(wall({ view: "agenda", tasks: [t], agenda: [{ group, items: [
      { task: "T01", when: group, what: "UNKNOWN task-only" },
      entry("T01", "UNKNOWN microtask"),
    ] }] }));
    expect(text(q(host, ".agenda"))).not.toContain("UNKNOWN");
  });
  it("normalises lower-case Next before excluding completed work", () => {
    const { host } = mount(wall({ view: "agenda", tasks: [task({ status: "done", activity: { state: "done" },
      steps: [step({ state: "done", activity: { state: "done" } })] })],
      agenda: [{ group: "next", items: [entry("T01", "COMPLETED stale entry")] }] }));
    expect(text(q(host, ".agenda"))).not.toContain("COMPLETED");
  });
});

describe("U91 repair: child deadlines and truthful animation", () => {
  it("keeps the parent and dot working until the last fresh child expires", () => {
    const vm = map([canonical({ microtasks: [micro({ id: "T01.M01" }),
      micro({ live: { agent: "owner", run_id: "r2", beat_ts: 110000, beat_lamport: 8 } })] })]);
    const { host, handle } = mount(vm);
    const progress = q(host, '[role="progressbar"]').getAttribute("aria-valuenow");
    vi.advanceTimersByTime(2);
    expect(q(host, '[data-micro-id="T01.M01"]').closest("li.step")?.getAttribute("data-activity")).toBe("unknown");
    expect(card(host).dataset.activity).toBe("working");
    expect(q(host, ".agent-dot").dataset.active).toBe("true");
    vi.advanceTimersByTime(10000);
    expect(card(host).dataset.activity).toBe("unknown");
    expect(q(host, ".agent-dot").dataset.active).toBe("false");
    expect(q(host, '[role="progressbar"]').getAttribute("aria-valuenow")).toBe(progress);
    handle.destroy(); expect(vi.getTimerCount()).toBe(0);
  });
  it("animates the working task's own icon and disables all its motion when reduced", () => {
    const { host } = mount(workingWall());
    const icon = q(card(host), ".task-head > .status-icon");
    expect(hasAnimation(icon)).toBe(true);
    for (const pseudo of ["", "before", "after"] as const) expect(hasAnimation(icon, pseudo, true)).toBe(false);
  });
  it("never rotates a running workspace badge after its liveness expires", () => {
    const { host } = mount(workingWall());
    expect(q(host, ".ws-running").dataset.activity).toBe("working");
    expect(hasAnimation(q(host, ".ws-running"), "before")).toBe(true);
    vi.advanceTimersByTime(2);
    expect(hasAnimation(q(host, ".ws-running"), "before")).toBe(false);
    expect(card(host).dataset.status).toBe("running");
  });
  it("suppresses workspace rotation for the published stale outcome", () => {
    const { host } = mount({ ...workingWall(), syncStale: true });
    expect(hasAnimation(q(host, ".ws-running"), "before")).toBe(false);
  });
});

describe("U91 repair: semantic announcements", () => {
  it.each([["idle", "working"], ["working", "done"], ["blocked", "done"]] as const)(
    "announces task and microtask %s to %s once, with unchanged beats silent", async (before, after) => {
      const vm = (state: ActivityStateVM) => wall({ tasks: [task({ activity: { state },
        steps: [step({ activity: { state } })] })] });
      const { host, handle } = mount(vm(before)); const observed = announcements(host);
      handle.update(vm(after)); await Promise.resolve();
      expect(observed.messages).toHaveLength(1);
      expect(observed.messages[0]).toContain("T01.M02");
      expect(observed.messages[0]?.match(new RegExp(after === "working" ? "Working" : "Done", "g"))).toHaveLength(2);
      handle.update(vm(after)); await Promise.resolve();
      expect(observed.messages).toHaveLength(1); observed.stop();
    });
  it("announces a microtask change even when the parent remains working", async () => {
    const vm = workingWall(); const { host, handle } = mount(vm); const observed = announcements(host);
    handle.update({ ...vm, tasks: [task({ activity: { state: "working" },
      steps: [step({ activity: { state: "done" }, state: "done" })] })] });
    await Promise.resolve(); expect(observed.messages).toHaveLength(1);
    expect(observed.messages[0]).toMatch(/T01\.M02.*Done/); observed.stop();
  });
});

describe("U91 repair: selection callback rejection containment", () => {
  it.each(["mounted", "standalone"])("handles a rejected promise from %s phase selection once", async mode => {
    const rejected = Promise.reject(new Error("phase failure"));
    void rejected.catch(() => undefined); // The fail-first test itself must not leak a rejection.
    const then = vi.spyOn(rejected, "then"); let calls = 0;
    const onSelectPhase = () => { calls++; return rejected; };
    const host = mode === "mounted" ? mount(wall(), { onSelectPhase }).host
      : renderPlanBand(document, plan(), { onSelectPhase });
    activate(q(host, '[data-phase-id="build"]'));
    expect(calls).toBe(1);
    expect(then.mock.calls.some(([, onRejected]) => typeof onRejected === "function")).toBe(true);
    await Promise.resolve();
  });
});
