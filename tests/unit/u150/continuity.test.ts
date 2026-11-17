import { describe, expect, it, vi } from "vitest";
import { startAgentWall } from "../../../src/app/agent_wall";
import type { SwarmRegistration } from "../../../src/app/swarm_vm";
import { clock, flush, roomFixture } from "../u118/fixtures";
import {
  accessibleName, activate, agentMetadata, button, cleanup, commitBeat, detail,
  deterministic, fallbackVM, freeze, mount, one, panel, planFixture, planVM, press,
  prunedControls, silentVM, status, visible, watchStatus,
} from "./helpers";

deterministic();

describe("U150 A1 fallback cards survive opaque-article pruning", () => {
  it("A1 fallback task has a named non-article root and preserves task identity", () => {
    const { host } = mount(fallbackVM());
    const card = one(host, '.task[data-task-id="legacy-task"]');
    expect(card.tagName, "Fallback task still creates an opaque article").not.toBe("ARTICLE");
    expect(card.getAttribute("role")).not.toBe("article");
    expect(accessibleName(card)).toContain("Inspect fallback evidence");
    expect(card.getAttribute("data-task-id")).toBe("legacy-task");
  });

  it("A1 fallback disclosure remains reachable after opaque-article pruning", () => {
    const { host } = mount(fallbackVM());
    const card = one(host, '.task[data-task-id="legacy-task"]');
    const disclosure = one(card, 'button[data-micro-id="T01.M01"]');
    expect(prunedControls(card), "Pruning hides the fallback disclosure").toContain(accessibleName(disclosure));
    activate(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(visible(panel(disclosure))).toBe(true);
  });
});

describe("U150 A2 workspace control continuity", () => {
  it.each([false, true])("A2 focused workspace survives refresh with reorder=%s and duplicate display names", reorder => {
    const vm = fallbackVM(), onWorkspace = vi.fn(), h = mount(vm, { onWorkspace });
    one(h.host, 'button[data-wsid="work"]').focus();
    const next = { ...vm, now: "Refreshed time", workspaces: reorder ? [...vm.workspaces].reverse() : vm.workspaces,
      tasks: [...vm.tasks, { ...vm.tasks[0]!, id: "another-task", workspace: "work" }] };
    h.update(next);
    const restored = one(h.host, 'button[data-wsid="work"]');
    expect(document.activeElement, "Workspace focus was lost during refresh").toBe(restored);
    activate(restored);
    expect(onWorkspace).toHaveBeenCalledExactlyOnceWith("work");
  });

  it("A2 a removed workspace never transfers focus to a different workspace", () => {
    const vm = fallbackVM(), h = mount(vm);
    one(h.host, 'button[data-wsid="work"]').focus();
    h.update({ ...vm, workspaces: vm.workspaces.filter(ws => ws.id !== "work") });
    expect((document.activeElement as HTMLElement).getAttribute("data-wsid")).not.toBe("demo");
  });

  it("A2 a refresh leaves focus outside the Wall untouched", () => {
    const vm = fallbackVM(), h = mount(vm), outside = document.createElement("button");
    outside.textContent = "Outside Wall"; document.body.append(outside); outside.focus();
    h.update({ ...vm, now: "Refreshed time" });
    expect(document.activeElement).toBe(outside);
  });

  it("A2 preserved microtask focus and expansion survive refresh", () => {
    const vm = fallbackVM(), h = mount(vm);
    activate(one(h.host, 'button[data-micro-id="T01.M01"]'));
    h.update({ ...vm, now: "Refreshed time" });
    const restored = one(h.host, 'button[data-micro-id="T01.M01"]');
    expect(document.activeElement).toBe(restored);
    expect(restored.getAttribute("aria-expanded")).toBe("true");
    expect(visible(panel(restored))).toBe(true);
  });
});

describe("U150 A3 Swarm agent metadata continuity", () => {
  it.each([false, true])("A3 expanded metadata and its focused control survive beat refresh with reorder=%s", reorder => {
    const p = planFixture(), h = mount(planVM(p));
    activate(agentMetadata(h.host, "worker-b"));
    const before = agentMetadata(h.host, "worker-b");
    expect(before.getAttribute("aria-expanded")).toBe("true");
    const next = planVM(commitBeat(p, 1));
    if (reorder && next.swarm) next.swarm = { ...next.swarm, agents: [...next.swarm.agents].reverse() };
    h.update(next);
    const restored = agentMetadata(h.host, "worker-b");
    expect.soft(document.activeElement, "Metadata focus was lost").toBe(restored);
    expect.soft(restored.getAttribute("aria-expanded"), "Metadata collapsed during refresh").toBe("true");
    expect.soft(visible(panel(restored))).toBe(true);
    expect(agentMetadata(h.host, "worker-a").getAttribute("aria-expanded")).toBe("false");
    expect(agentMetadata(h.host, "worker-c").getAttribute("aria-expanded")).toBe("false");
  });

  it("A3 expanded metadata persists when focus belongs to another Wall control", () => {
    const p = planFixture(), h = mount(planVM(p));
    activate(agentMetadata(h.host, "worker-b"));
    button(h.host, "Models").focus();
    h.update(planVM(commitBeat(p, 1)));
    expect.soft(agentMetadata(h.host, "worker-b").getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(button(h.host, "Models"));
  });
});

describe("U150 A4 Swarm task detail continuity", () => {
  it.each(["metadata", "task-detail"] as const)("A4 %s survives an unrelated agent lifecycle refresh", focus => {
    const vm = planVM(planFixture()), h = mount(vm);
    if (focus === "metadata") activate(agentMetadata(h.host, "worker-b"));
    else activate(button(h.host, "View task T05"));
    h.update({ ...vm, swarm: { ...vm.swarm!, agents: vm.swarm!.agents.map(agent =>
      agent.agent === "worker-a" ? { ...agent, lifecycle: "failed" as const } : agent) } });
    const restored = focus === "metadata" ? agentMetadata(h.host, "worker-b") : detail(h.host);
    expect.soft(restored, "An unrelated lifecycle refresh removed the open detail").toBeDefined();
    expect.soft(document.activeElement === restored, "Lifecycle refresh lost the focused detail control").toBe(true);
    if (focus === "metadata") expect(restored!.getAttribute("aria-expanded")).toBe("true");
    else expect(button(h.host, "View task T05").getAttribute("aria-expanded")).toBe("true");
  });

  it.each(["region", "close", "trigger"] as const)("A4 T05 detail and %s focus survive worker-a/T01 activity_beat", focus => {
    const p = planFixture(), onOpenTask = vi.fn(), h = mount(planVM(p), { onOpenTask });
    activate(button(h.host, "View task T05"));
    const opened = detail(h.host);
    expect(opened, "Fixture precondition: T05 detail opens").toBeDefined();
    if (focus === "close") button(opened!, "Close task details").focus();
    if (focus === "trigger") button(h.host, "View task T05").focus();
    expect(focus === "region" ? document.activeElement === opened :
      accessibleName(document.activeElement as HTMLElement) === (focus === "close" ? "Close task details" : "View task T05")).toBe(true);
    h.update(planVM(commitBeat(p, 1)));
    const restored = detail(h.host);
    expect(restored, "T05 detail disappeared after an unrelated activity_beat").toBeDefined();
    expect(restored!.textContent).toContain("T05 recorded outcome");
    expect(restored!.textContent).toContain("evidence/T05.txt");
    const target = focus === "region" ? restored : focus === "close"
      ? button(restored!, "Close task details") : button(h.host, "View task T05");
    expect(document.activeElement).toBe(target);
    expect(button(h.host, "View task T05").getAttribute("aria-expanded")).toBe("true");
    expect(button(h.host, "View task T07").getAttribute("aria-expanded")).toBe("false");
    press(document.activeElement!, "Escape");
    expect(detail(h.host)).toBeUndefined();
    expect(document.activeElement).toBe(button(h.host, "View task T05"));
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it("A4 refreshed Close task details still closes and returns focus to T05", () => {
    const p = planFixture(), h = mount(planVM(p));
    activate(button(h.host, "View task T05"));
    h.update(planVM(commitBeat(p, 1)));
    const restored = detail(h.host);
    expect(restored, "An open detail must survive before its Close control can be used").toBeDefined();
    activate(button(restored!, "Close task details"));
    expect(detail(h.host)).toBeUndefined();
    expect(document.activeElement).toBe(button(h.host, "View task T05"));
  });

  it("A4 application refresh preserves T05 detail after committing a worker-a/T01 beat", async () => {
    const f = roomFixture(); f.rooms.clear(); f.rooms.set("demo", freeze(planFixture())); f.history.splice(0);
    const wallHost = document.createElement("div"), chatHost = document.createElement("div");
    document.body.append(wallHost, chatHost);
    const post = vi.fn(async () => ({ ok: true as const, id: "e-000000000000ffff", lamport: 65535 }));
    const wall = startAgentWall({ wallHost, chatHost, store: f.store, clock, userAgent: "operator",
      initialView: "swarm", link: { post },
      reviewer: { review: vi.fn(async () => undefined) } });
    cleanup.push(() => wall.destroy());
    await flush();
    activate(button(wallHost, "View task T05"));
    expect(detail(wallHost)).toBeDefined();
    const live = status(wallHost), previous = live.textContent, mutations = watchStatus(live);
    f.rooms.set("demo", freeze(commitBeat(f.rooms.get("demo")!, 1)));
    wall.refresh(); await flush();
    const restored = detail(wallHost);
    expect(restored, "R42 reproduction: T05 detail disappeared after worker-a/T01 beat").toBeDefined();
    expect(document.activeElement).toBe(restored);
    expect(document.activeElement).not.toBe(button(wallHost, "View task T07"));
    expect(status(wallHost)).toBe(live); expect(live.textContent).toBe(previous);
    expect(mutations.takeRecords()).toHaveLength(0);
    expect(wall.selection()).toBeNull(); expect(post).not.toHaveBeenCalled();
    expect(chatHost.getAttribute("data-open")).not.toBe("true");
  });
});

describe("U150 A5 agent-only lifecycle announcements", () => {
  for (const view of ["wall", "swarm"] as const) {
    it.each(["deployed", "failed", "finished"] as const)(`A5 ${view}: silent agent %s changes the persistent status without task activity`, lifecycle => {
      const base = fallbackVM([]), previous: Record<string, SwarmRegistration> = lifecycle === "deployed" ? {} : {
        "quiet-agent": { lifecycle: "deployed", run_id: "quiet-run", swarm: "alpha", harness: "Fixture harness" },
      };
      const h = mount(silentVM(previous, view, base));
      const live = status(h.host), before = live.textContent;
      const outside = document.createElement("button"); outside.textContent = "External control";
      document.body.append(outside); outside.focus();
      const next = silentVM({ "quiet-agent": { lifecycle, run_id: "quiet-run", swarm: "alpha", harness: "Fixture harness" } }, view, base);
      expect(next.tasks).toBe(base.tasks); expect(next.tasks).toHaveLength(0);
      expect(next.swarm?.agents[0]?.last_beat_ts).toBeNull();
      h.update(next);
      expect(document.activeElement, "Lifecycle announcements must not steal focus").toBe(outside);
      expect(status(h.host), "The status region must remain mounted").toBe(live);
      expect(live.textContent, "Agent-only lifecycle change left status text unchanged").not.toBe(before);
      expect(live.textContent).toContain("quiet-agent");
      expect(live.textContent?.toLowerCase()).toContain(lifecycle);
      const mutations = watchStatus(live), announced = live.textContent;
      h.update({ ...next });
      expect(live.textContent).toBe(announced);
      expect(mutations.takeRecords(), "Identical lifecycle replay must remain silent").toHaveLength(0);
    });
  }

  it("A5 one refresh reports both silent agents whose lifecycles changed", () => {
    const h = mount(silentVM({ "quiet-a": { lifecycle: "deployed", run_id: "a" },
      "quiet-b": { lifecycle: "deployed", run_id: "b" } }));
    h.update(silentVM({ "quiet-a": { lifecycle: "failed", run_id: "a" },
      "quiet-b": { lifecycle: "finished", run_id: "b" } }));
    const message = status(h.host).textContent?.toLowerCase();
    for (const word of ["quiet-a", "failed", "quiet-b", "finished"]) expect(message).toContain(word);
  });

  it("A5 preserved task and microtask transitions still announce in the same status node", () => {
    const vm = fallbackVM(), h = mount(vm), live = status(h.host);
    h.update({ ...vm, tasks: vm.tasks.map(t => ({ ...t, activity: { state: "blocked" },
      steps: t.steps.map(s => ({ ...s, activity: { state: "blocked" } })) })) });
    expect(status(h.host)).toBe(live);
    expect(live.textContent).toContain("Task legacy-task: Blocked");
    expect(live.textContent).toContain("Microtask T01.M01: Blocked");
  });
});

describe("U150 A6 hostile beat-only refreshes", () => {
  it.each(["workspace", "metadata", "task-detail"] as const)("A6 fifty unchanged-semantic beats preserve %s focus and expansion without announcements", focus => {
    let p = planFixture();
    const h = mount(focus === "workspace" ? { ...planVM(p, "wall"), workspaces: fallbackVM([]).workspaces } : planVM(p));
    if (focus === "workspace") one(h.host, 'button[data-wsid="work"]').focus();
    if (focus === "metadata") activate(agentMetadata(h.host, "worker-b"));
    if (focus === "task-detail") activate(button(h.host, "View task T05"));
    const live = status(h.host), initial = live.textContent, observer = watchStatus(live);
    const focusLoss: number[] = [], expansionLoss: number[] = [], announcements: number[] = [], replacedStatus: number[] = [];
    for (let sequence = 1; sequence <= 50; sequence++) {
      p = commitBeat(p, sequence);
      const next = planVM(p, focus === "workspace" ? "wall" : "swarm");
      if (focus === "workspace") next.workspaces = fallbackVM([]).workspaces;
      h.update(next);
      const target = focus === "workspace" ? one(h.host, 'button[data-wsid="work"]')
        : focus === "metadata" ? agentMetadata(h.host, "worker-b") : detail(h.host);
      if (!target || document.activeElement !== target) focusLoss.push(sequence);
      if (focus === "metadata" && (target?.getAttribute("aria-expanded") !== "true" || !visible(panel(target!)))) expansionLoss.push(sequence);
      if (focus === "task-detail" && (!target || button(h.host, "View task T05").getAttribute("aria-expanded") !== "true")) expansionLoss.push(sequence);
      if (status(h.host) !== live) replacedStatus.push(sequence);
      if (live.textContent !== initial || observer.takeRecords().length > 0) announcements.push(sequence);
    }
    expect.soft(replacedStatus, "Persistent status was replaced").toEqual([]);
    expect.soft(announcements, "Unchanged semantic beats made status writes").toEqual([]);
    expect.soft(expansionLoss, "Refreshes collapsed an open disclosure/detail").toEqual([]);
    expect(focusLoss, "Refreshes lost or redirected focus").toEqual([]);
  });

  it("A6 fifty beat-only refreshes remain silent and never steal external focus", () => {
    let p = planFixture(); const h = mount(planVM(p));
    const outside = document.createElement("button"); outside.textContent = "External control";
    document.body.append(outside); outside.focus();
    const live = status(h.host), before = live.textContent, observer = watchStatus(live);
    for (let i = 1; i <= 50; i++) {
      p = commitBeat(p, i); h.update(planVM(p));
      expect(document.activeElement).toBe(outside); expect(status(h.host)).toBe(live);
      expect(live.textContent).toBe(before); expect(observer.takeRecords()).toHaveLength(0);
    }
  });
});

describe("U150 A7 negative control: delegated card-to-chat routing stays removed", () => {
  it.each(["fallback", "plan"] as const)("A7 %s card body click cannot call the legacy task opener", mode => {
    const onOpenTask = vi.fn(), vm = mode === "fallback" ? fallbackVM() : planVM(planFixture(), "wall");
    const h = mount(vm, { onOpenTask });
    const card = [...h.host.querySelectorAll<HTMLElement>(".task[data-task-id]")].find(visible)!;
    expect(card, "Fixture precondition: a task card exists").toBeDefined();
    card.click(); one(card, ".task-head").click();
    expect(onOpenTask, "Restoring the delegated card-to-chat handler must turn this assertion red").not.toHaveBeenCalled();
  });

  it("A7 Messages (legacy) still opens the selected fallback task explicitly", () => {
    const onOpenTask = vi.fn(), vm = fallbackVM(), h = mount(vm, { onOpenTask });
    const messages = button(h.host, "Messages (legacy)");
    expect(messages.getAttribute("aria-expanded")).toBe("false");
    activate(messages); activate(button(h.host, "Open task messages"));
    expect(onOpenTask).toHaveBeenCalledTimes(1);
    expect(onOpenTask.mock.calls[0]?.[0]).toBe("legacy-task");
  });

  it.each(["Enter", " "] as const)("A7 fallback disclosure %j activation remains read-only", key => {
    const onOpenTask = vi.fn(), h = mount(fallbackVM(), { onOpenTask });
    activate(one(h.host, 'button[data-micro-id="T01.M01"]'), key);
    expect(onOpenTask).not.toHaveBeenCalled();
    expect(one(h.host, 'button[data-micro-id="T01.M01"]').getAttribute("aria-expanded")).toBe("true");
  });
});

describe("U150 A8 ownership stop rule", () => {
  it("A8 destroyed Wall ignores updates and cannot steal focus or announce", () => {
    const h = mount(planVM(planFixture())), live = status(h.host), observer = watchStatus(live);
    h.handle.destroy();
    const outside = document.createElement("button"); document.body.append(outside); outside.focus();
    h.update(silentVM({ "quiet-agent": { lifecycle: "failed", run_id: "r1" } }));
    vi.advanceTimersByTime(100_000);
    expect(h.host.children).toHaveLength(0); expect(document.activeElement).toBe(outside);
    expect(observer.takeRecords()).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });
});
