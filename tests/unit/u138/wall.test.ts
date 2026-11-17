import { beforeEach, describe, expect, it, vi } from "vitest";
import { startAgentWall } from "../../../src/app/agent_wall";
import type { AgentWall } from "../../../src/app/agent_wall";
import { mountWall } from "../../../src/views";
import type { WallMountHandlers, WallMountVM } from "../../../src/views";
import type { SwarmViewModel } from "../../../src/app/swarm_vm";
import {
  DESTINATIONS, HOSTILE, NOW, accessibleName, activate, beat, chipHeader, cleanup, clock, control,
  deterministic, disclosure, agentCard, event, flush, freeze, frozenPlan, key, micro, models, mountVM,
  noExecutableLabels, noNewControls, projection, registration, registrationOnly, roomFixture,
  selected, strip, swarmRoot, swarmVM, task, taskCard, text, viewModel, visible, visibleText, wallVM,
} from "./helpers";

// Observe the public seam while executing the real renderer and its update/destroy paths.
const observed = vi.hoisted(() => ({
  handlers: undefined as WallMountHandlers | undefined,
  vm: undefined as WallMountVM | undefined,
  derive: vi.fn(), openTask: vi.fn(),
}));
vi.mock("../../../src/views", async original => {
  const real = await original<typeof import("../../../src/views")>();
  return { ...real, mountWall(host: HTMLElement, vm: WallMountVM, handlers?: WallMountHandlers) {
    observed.handlers = handlers; observed.vm = vm;
    const wrapped: WallMountHandlers = { ...handlers, onOpenTask: (...args) => {
      observed.openTask(...args); handlers?.onOpenTask?.(...args);
    } };
    const handle = real.mountWall(host, vm, wrapped);
    return { update(next: WallMountVM) { observed.vm = next; handle.update(next); }, destroy() { handle.destroy(); } };
  } };
});
vi.mock("../../../src/app/swarm_vm", async original => {
  const real = await original<typeof import("../../../src/app/swarm_vm")>();
  return { ...real, deriveSwarmViewModel(...args: Parameters<typeof real.deriveSwarmViewModel>) {
    observed.derive(...args); return real.deriveSwarmViewModel(...args);
  } };
});

deterministic();
beforeEach(() => { observed.handlers = undefined; observed.vm = undefined; observed.derive.mockClear(); observed.openTask.mockClear(); });

function start(options: { initialView?: unknown; connected?: boolean; onOpenModels?: (trigger: HTMLElement) => void } = {}) {
  const f = roomFixture(); f.rooms.set("demo", frozenPlan());
  f.rooms.set("work", freeze(projection([task("T01", { assignee: "other-room-agent", title: "Other room task",
    microtasks: [micro("T01.M01", { live: beat({ agent: "other-room-agent" }) })] })], {
      "other-room-agent": registration({ harness: "Other room harness" }),
    })));
  f.history.splice(0, f.history.length, event(1));
  const wallHost = document.createElement("div"), chatHost = document.createElement("div");
  document.body.append(wallHost, chatHost);
  const post = vi.fn(async () => ({ ok: true as const, id: "e-000000000000ffff", lamport: 65535 }));
  const review = vi.fn(async () => undefined);
  const testClock = { ...clock, setTimeout: vi.fn(clock.setTimeout), clearTimeout: vi.fn(clock.clearTimeout) };
  const deps = { ...options, wallHost, chatHost, store: f.store, clock: testClock, userAgent: "wall-user",
    link: { post, state: () => ({ kind: options.connected === false ? "disconnected" : "linked" }) }, reviewer: { review } };
  const wall = Reflect.apply(startAgentWall, undefined, [deps]) as AgentWall;
  cleanup.push(() => wall.destroy());
  return { ...f, wall, wallHost, chatHost, post, review, testClock };
}

function navigate(value: unknown): void {
  expect(observed.handlers?.onView).toBeTypeOf("function");
  Reflect.apply(observed.handlers!.onView!, undefined, [value]);
}
function expectLanding(root: HTMLElement): void { expect(selected(root)).toBe("wall"); }

describe("U138 A1 / M1 navigation", () => {
  it("A1 fresh startup selects Wall with five ordered primary tabs and secondary Swarm", () => {
    const h = start(); expectLanding(h.wallHost);
    const tabs = [...h.wallHost.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')];
    expect(tabs.map(accessibleName)).toEqual(DESTINATIONS.slice(0, 5));
    const secondary = control(h.wallHost, "Swarm"); expect(secondary.closest('[role="tablist"]')).toBeNull();
    expect(tabs[4]!.compareDocumentPosition(secondary) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });
  it.each(DESTINATIONS)("A1 explicit initialView %s is accepted by both validators", name => {
    const h = start({ initialView: name.toLowerCase() }); expect(selected(h.wallHost)).toBe(name.toLowerCase());
  });
  it.each([undefined, null, "", "invalid", "__proto__", "constructor", "toString", HOSTILE, 7, {}])(
    "A1 invalid or absent initialView %j falls back to Wall", initialView => { expectLanding(start({ initialView }).wallHost); });
  it.each(DESTINATIONS)("A1 %s click, shortcut and advertised shortcut agree", name => {
    const h = start({ initialView: "wall" }), index = DESTINATIONS.indexOf(name);
    let target = control(h.wallHost, name); expect(target.getAttribute("aria-keyshortcuts")).toBe(String(index + 1));
    target.click(); expect(selected(h.wallHost)).toBe(name.toLowerCase());
    navigate(name === "Wall" ? "diary" : "wall");
    key(document.body, String(index + 1)); expect(selected(h.wallHost)).toBe(name.toLowerCase());
    expect(h.post).not.toHaveBeenCalled(); expect(h.wall.selection()).toBeNull();
  });
  it("A1 primary End/Home/arrows select Memory/Wall and restore focused tabs", () => {
    const h = start({ initialView: "wall" });
    for (const [value, expected] of [["End", "Memory"], ["ArrowRight", "Wall"], ["ArrowLeft", "Memory"], ["Home", "Wall"]]) {
      const current = h.wallHost.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!;
      current.focus(); key(current, value!);
      expect(selected(h.wallHost)).toBe(expected!.toLowerCase()); expect(accessibleName(document.activeElement as HTMLElement)).toBe(expected);
    }
    key(document.body, "6"); expect(selected(h.wallHost)).toBe("swarm");
  });
  it.each(["input", "textarea", "select", "contenteditable", "nested-contenteditable"])(
    "A1 shortcuts are suppressed in %s", kind => {
      const h = start({ initialView: "wall" });
      const parent = document.createElement(kind.includes("contenteditable") ? "div" : kind);
      if (kind.includes("contenteditable")) parent.setAttribute("contenteditable", "true");
      const target = kind === "nested-contenteditable" ? parent.appendChild(document.createElement("span")) : parent;
      h.wallHost.append(parent); parent.focus();
      for (const digit of ["1", "2", "3", "4", "5", "6"]) key(target, digit);
      expectLanding(h.wallHost); expect(h.post).not.toHaveBeenCalled();
    });
  it.each(["ctrlKey", "altKey", "metaKey", "shiftKey"] as const)("A1 %s suppresses all destination shortcuts", modifier => {
    const h = start({ initialView: "wall" });
    for (const digit of ["1", "2", "3", "4", "5", "6"]) key(document.body, digit, { [modifier]: true });
    expectLanding(h.wallHost);
  });
  it("M1 legacy direct mount keeps navigation controlled until update", () => {
    const vm = wallVM(), root = document.createElement("div"), onView = vi.fn(); document.body.append(root);
    const handle = mountWall(root, vm, { onView }); cleanup.push(() => handle.destroy());
    key(document.body, "2"); expect(onView).toHaveBeenCalledExactlyOnceWith("agenda"); expectLanding(root);
    handle.update({ ...vm, view: "agenda" }); expect(selected(root)).toBe("agenda");
  });
  it.each([undefined, "bogus", "__proto__", HOSTILE])("M1 direct-mount invalid view %j also falls back to Wall", view => {
    const p = frozenPlan(), vm = wallVM(p, swarmVM(p)), root = document.createElement("div"); document.body.append(root);
    const handle = Reflect.apply(mountWall, undefined, [root, { ...vm, view }]) as ReturnType<typeof mountWall>;
    cleanup.push(() => handle.destroy()); expectLanding(root);
  });
  it.each(["bogus", "__proto__", "constructor", "toString", HOSTILE, "", null, {}, 7])(
    "A1 invalid runtime navigation %j is a mutation-free no-op", value => {
      const h = start({ initialView: "wall" }), before = h.wallHost.innerHTML, first = h.wallHost.firstChild;
      const observer = new MutationObserver(() => undefined); observer.observe(h.wallHost, { subtree: true, childList: true, attributes: true, characterData: true });
      try {
        navigate(value); expect(observer.takeRecords()).toEqual([]); expect(h.wallHost.innerHTML).toBe(before);
        expect(h.wallHost.firstChild).toBe(first); expectLanding(h.wallHost); expect(h.wall.selection()).toBeNull(); expect(h.post).not.toHaveBeenCalled();
      } finally { observer.disconnect(); }
    });
});

describe("U138 A2 / M2-M4 Wall agents and dependency identity", () => {
  it("A2 Wall receives the admitted selected-room model through the local seam", () => {
    const h = start({ initialView: "wall" });
    expect(observed.derive).toHaveBeenCalledTimes(1);
    expect(observed.derive).toHaveBeenCalledWith(expect.objectContaining({ room: "demo", projection: h.rooms.get("demo"), connected: true, nowMs: NOW }));
    expect(observed.vm?.swarm?.agents.map(a => a.agent)).toContain("registered-only");
    expect(observed.vm?.swarm?.agents.map(a => a.agent)).not.toContain("other-room-agent");
    expect(h.store.ingest).not.toHaveBeenCalled(); expect(h.store.ingestChecked).not.toHaveBeenCalled(); expect(h.store.ingestJsonl).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled(); expect(h.review).not.toHaveBeenCalled();
  });
  it("M2 extending the existing Swarm seam to Wall adds no store reads", () => {
    const reference = start({ initialView: "swarm" });
    const reads = ["plans", "plan", "events"] as const;
    const budgets = reads.map(name => vi.mocked(reference.store[name]).mock.calls.length);
    reference.wall.destroy(); observed.derive.mockClear();
    const h = start({ initialView: "wall" }); expect(observed.derive).toHaveBeenCalledTimes(1);
    reads.forEach((name, i) => expect(vi.mocked(h.store[name]).mock.calls.length, `Existing ${name} read budget`).toBeLessThanOrEqual(budgets[i]!));
    expect(h.store.ingest).not.toHaveBeenCalled(); expect(h.post).not.toHaveBeenCalled();
  });
  it("A2 T01 and multi-task executor-a have correct chips beside unchanged task rings", () => {
    const h = start({ initialView: "wall" });
    chipHeader(h.wallHost, "T01", "executor-b", "Harness B", "Waiting");
    chipHeader(h.wallHost, "T02", "executor-a", "Harness A", "Working");
    chipHeader(h.wallHost, "T03", "executor-a", "Harness A", "Working");
    expect(taskCard(h.wallHost, "T01").querySelector(".status-icon")?.getAttribute("data-activity")).toBe("waiting");
    expect(taskCard(h.wallHost, "T02").querySelector(".status-icon")?.getAttribute("data-activity")).toBe("working");
    expect(taskCard(h.wallHost, "T03").querySelector(".status-icon")?.getAttribute("data-activity")).toBe("waiting");
  });
  it.each([["T04", "failed-agent", "Failed harness", "Failed"], ["T05", "finished-agent", "Finished harness", "Finished"]])(
    "A2 terminal lifecycle on %s overrides a fresh beat", (id, owner, harness, label) => {
      const h = start({ initialView: "wall" }); chipHeader(h.wallHost, id!, owner!, harness!, label!);
      const header = taskCard(h.wallHost, id!).querySelector(".task-head")!.cloneNode(true) as HTMLElement;
      // A-R41: task activity is labelled separately; lifecycle precedence is checked on the chip.
      header.querySelectorAll(".task-activity,.status-icon").forEach(node => node.remove());
      expect(visibleText(header)).not.toContain("Working"); expect(text(header)).not.toMatch(/process (?:terminated|exited)|killed/i);
    });
  it("A2 unregistered ownership is explicit and null ownership does not fabricate an agent", () => {
    const h = start({ initialView: "wall" }); chipHeader(h.wallHost, "T06", "unregistered", "", "Not registered by a harness");
    expect(text(taskCard(h.wallHost, "T07"))).not.toContain("Not registered by a harness");
    expect(text(taskCard(h.wallHost, "T06"))).not.toMatch(/Deployed|Fixture harness/);
  });
  it.each([{ lifecycle: "alive" as const }, { run_id: "run-only" }, { swarm: "swarm-only" }, { harness: "harness-only" }])(
    "M3 any supplied registration field preserves U112 registration semantics: %j", fields => {
      const p = projection([task()]), admitted = swarmVM(p);
      const vm = { ...admitted, agents: admitted.agents.map(a => ({ ...a, ...fields })) };
      const root = mountVM(wallVM(p, vm));
      chipHeader(root, "T01", "executor-a", "harness" in fields ? fields.harness : "", "Working");
      expect(text(taskCard(root, "T01"))).not.toMatch(/not registered by a harness/i);
      if (!("harness" in fields)) expect(text(taskCard(root, "T01"))).not.toContain("Fixture harness");
    });
  it("M3 empty registration fields retain the explicit unregistered label", () => {
    const p = projection([task()]), admitted = swarmVM(p);
    const vm = { ...admitted, agents: admitted.agents.map(a => ({ ...a, run_id: "", swarm: "", harness: "" })) };
    const root = mountVM(wallVM(p, vm)); chipHeader(root, "T01", "executor-a", "", "Not registered by a harness");
  });
  it("M2 connected:false reaches the Wall derivation and cannot assert Working", () => {
    const h = start({ initialView: "wall", connected: false });
    expect(observed.derive).toHaveBeenCalledWith(expect.objectContaining({ connected: false, room: "demo" }));
    chipHeader(h.wallHost, "T02", "executor-a", "Harness A", "Liveness unknown");
  });
  it("A2 blockers match downstream task identity, including unowned, null and missing upstreams", () => {
    const h = start({ initialView: "wall" });
    expect(text(taskCard(h.wallHost, "T01"))).toContain("Waiting on T02 · executor-a");
    expect(text(taskCard(h.wallHost, "T01"))).not.toContain("T404");
    expect(text(taskCard(h.wallHost, "T02"))).not.toContain("Waiting on T90");
    expect(text(taskCard(h.wallHost, "T03"))).toContain("Waiting on T90 · executor-c");
    const unowned = text(taskCard(h.wallHost, "T07"));
    expect(unowned).toContain("Waiting on T02 · executor-a"); expect(unowned).toContain("Waiting on T08 · unassigned");
    const other = text(taskCard(h.wallHost, "T09"));
    expect(other).toContain("Waiting on T08 · unassigned"); expect(other).toContain("T404"); expect(other).toContain("Missing task");
    expect(other).toContain("Literal approval <pending> & unchanged"); expect(other).not.toContain("Waiting on T02");
  });
  it("A2 readiness comes from existing card data, not every admitted waiting_on entry", () => {
    const p = frozenPlan(), vm = wallVM(p, swarmVM(p));
    vm.tasks = vm.tasks.map(t => t.taskId === "T03" ? { ...t, waitsFor: [] } : t);
    const root = mountVM(vm); expect(text(taskCard(root, "T03"))).not.toContain("Waiting on T90");
    expect(text(taskCard(root, "T01"))).toContain("Waiting on T02 · executor-a");
  });
  it.each(["future", "disconnected", "missing"])("A2 %s liveness evidence never becomes Working or a fabricated beat", mode => {
    const p = projection([task("T01", { microtasks: [micro("T01.M01", mode === "missing" ? {} : { live: beat({ beat_ts: mode === "future" ? NOW + 1 : NOW - 1_000 }) })] })], { "executor-a": registration({ harness: "Harness A" }) });
    const root = mountVM(wallVM(p, swarmVM(p, mode !== "disconnected")));
    chipHeader(root, "T01", "executor-a", "Harness A", "Liveness unknown");
    if (mode !== "disconnected") expect(visibleText(strip(root))).toContain("No beat observed");
  });
  it("M2 legacy direct mount without swarm keeps its signature and fabricates no model", () => {
    const vm = wallVM(), host = document.createElement("div"); document.body.append(host);
    const handle = mountWall(host, vm); cleanup.push(() => handle.destroy());
    expect(taskCard(host, "T01")).toBeDefined(); expect(text(host)).not.toContain("Show all in Swarm");
    expect(vm.swarm).toBeUndefined();
  });
});

describe("U138 A3 / M2 M5 strip, rooms and expiry", () => {
  it("A3 strip precedes Plan, caps globally at five, and opens every agent in Swarm", () => {
    const h = start({ initialView: "wall" }), section = strip(h.wallHost), vm = observed.vm!.swarm!;
    const shown = vm.agents.filter(a => visibleText(section).includes(a.agent));
    expect(vm.agents.length).toBeGreaterThan(5); expect(shown.length).toBeGreaterThan(0); expect(shown.length).toBeLessThanOrEqual(5);
    const plan = h.wallHost.querySelector('[aria-label="Plan"]')!;
    expect(section.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    const action = control(section, "Show all in Swarm"); expect(action.tabIndex).toBeGreaterThanOrEqual(0); activate(action);
    expect(selected(h.wallHost)).toBe("swarm"); const root = swarmRoot(h.wallHost);
    for (const a of vm.agents) expect(visibleText(root)).toContain(a.agent);
    expect(h.post).not.toHaveBeenCalled(); expect(h.wall.selection()).toBeNull();
  });
  it("A3 strip includes registration-only agents and honest absent work/beat evidence", () => {
    const p = projection([], { registered: registration({ harness: "Only harness" }) });
    const root = mountVM(wallVM(p, swarmVM(p))), section = strip(root);
    for (const value of ["registered", "Only harness", "Idle", "No beat observed"]) expect(visibleText(section)).toContain(value);
    expect(visibleText(section)).not.toMatch(/0\s*\/\s*0|0s ago/);
  });
  it.each([[999, "0s"], [1_999, "1s"], [61_999, "61s"]] as const)("M5 strip floors observed %i ms to %s", (age, label) => {
    const a = registrationOnly("age-agent", { current_task_id: "T71", active_micro_id: "T71.M02", last_beat_age_ms: age, last_beat_ts: NOW - age });
    const section = strip(mountVM(wallVM(projection(), viewModel([a]))));
    for (const value of [label, "T71", "T71.M02"]) expect(visibleText(section)).toContain(value);
  });
  it("M5 strip preserves U136 group and urgency order and distinct literal Ungrouped", () => {
    const missing = registrationOnly("missing-group"); const { swarm: _unused, ...ungrouped } = missing;
    const vm = viewModel([
      ungrouped, registrationOnly("literal-group", { swarm: "Ungrouped" }),
      registrationOnly("z-working", { swarm: "alpha", activity: "working" }),
      registrationOnly("a-failed", { swarm: "alpha", lifecycle: "failed" }),
    ]);
    const section = strip(mountVM(wallVM(projection(), vm)));
    const labels = [...section.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6,[role=heading],[aria-label]")].map(el => `${accessibleName(el)} ${visibleText(el)}`);
    expect(labels.filter(label => /^Ungrouped\b/.test(label)).length).toBeGreaterThanOrEqual(2);
    const content = visibleText(section);
    expect(content.indexOf("literal-group")).toBeLessThan(content.indexOf("a-failed"));
    expect(content.indexOf("a-failed")).toBeLessThan(content.indexOf("z-working"));
    expect(content.indexOf("z-working")).toBeLessThan(content.indexOf("missing-group"));
  });
  it("M5 empty membership gives harness guidance and keeps Show all in Swarm available", () => {
    const root = mountVM(wallVM(projection(), viewModel([]))), section = strip(root);
    expect(visibleText(section)).toMatch(/harness/i); expect(visibleText(section)).toMatch(/connect|assign/i);
    expect(control(section, "Show all in Swarm").tabIndex).toBeGreaterThanOrEqual(0);
    expect(visibleText(section)).not.toContain("Working");
  });
  it.each(["wall", "swarm"])("A3 expiry updates %s at the admitted deadline without ingestion or writes", async initialView => {
    const h = start({ initialView }), before = structuredClone(h.rooms.get("demo"));
    expect(observed.vm?.swarm?.refresh_at_ms).toBe(NOW + 89_001);
    expect(h.testClock.setTimeout).toHaveBeenCalledWith(expect.any(Function), 89_001);
    vi.advanceTimersByTime(89_000); await flush();
    expect(observed.vm?.swarm?.agents.find(a => a.agent === "executor-a")?.activity).toBe("working");
    vi.advanceTimersByTime(1); await flush();
    expect(observed.vm?.swarm?.agents.find(a => a.agent === "executor-a")?.activity).toBe("unknown");
    if (initialView === "wall") {
      chipHeader(h.wallHost, "T02", "executor-a", "Harness A", "Liveness unknown");
      expect(visibleText(strip(h.wallHost))).toContain("Liveness unknown");
    } else expect(visibleText(swarmRoot(h.wallHost))).toContain("Liveness unknown");
    expect(h.rooms.get("demo")).toEqual(before); expect(h.store.ingest).not.toHaveBeenCalled(); expect(h.post).not.toHaveBeenCalled();
  });
  it("A3 workspace updates replace both chips and strip without leaking repeated task IDs", () => {
    const h = start({ initialView: "wall" });
    for (const room of ["work", "demo", "work"]) {
      observed.handlers!.onWorkspace!(room); h.wall.refresh();
      const owner = room === "work" ? "other-room-agent" : "executor-b";
      expect(text(taskCard(h.wallHost, "T01"))).toContain(owner);
      expect(visibleText(strip(h.wallHost))).not.toContain(room === "work" ? "executor-a" : "other-room-agent");
      expect(h.wallHost.querySelectorAll('[aria-label="Swarm"]')).toHaveLength(0);
    }
    expect(h.post).not.toHaveBeenCalled();
  });
  it("A3 replacement cancels the obsolete expiry and destruction clears all scheduled work", async () => {
    const h = start({ initialView: "wall" });
    const scheduled = h.testClock.setTimeout.mock.results.find((_, i) => h.testClock.setTimeout.mock.calls[i]?.[1] === 89_001);
    expect(scheduled, "Wall must schedule its admitted expiry before cancellation can pass").toBeDefined();
    h.rooms.set("demo", projection([], { replacement: registration() })); h.wall.refresh();
    expect(h.testClock.clearTimeout).toHaveBeenCalledWith(scheduled!.value);
    h.wall.destroy(); const before = h.wallHost.innerHTML;
    expect(vi.getTimerCount()).toBe(0); vi.advanceTimersByTime(180_000); h.wall.refresh(); await flush();
    expect(h.wallHost.innerHTML).toBe(before); expect(h.post).not.toHaveBeenCalled();
  });
  it("A3 store refresh replaces removed membership rather than retaining stale registration", () => {
    const h = start({ initialView: "wall" }); expect(strip(h.wallHost)).toBeDefined();
    h.rooms.set("demo", projection([task("T81", { assignee: "new-owner", microtasks: [] })], { "new-owner": registration({ harness: "New harness" }) }));
    h.wall.refresh(); chipHeader(h.wallHost, "T81", "new-owner", "New harness", "Idle");
    expect(visibleText(strip(h.wallHost))).not.toContain("executor-a");
    // A-U150: Removed tasks must be absent regardless of their card container.
    expect(h.wallHost.querySelectorAll('.task[data-task-id="T01"]')).toHaveLength(0);
  });
  it("M2 loaded-history recipients do not become a second registration source", () => {
    const h = start({ initialView: "wall" }); expect(observed.vm?.swarm).toBeDefined();
    h.history.push(event(5, { to: "history-only-recipient" })); h.wall.refresh();
    expect(observed.vm!.swarm!.agents.map(a => a.agent)).not.toContain("history-only-recipient");
    expect(visibleText(strip(h.wallHost))).not.toContain("history-only-recipient"); expect(h.post).not.toHaveBeenCalled();
  });
});

describe("U138 A4 A5 / M7 hostile values and negative controls", () => {
  it.each([HOSTILE, "__proto__", "constructor", "toString"])("A4 Wall owner/harness/swarm/room/IDs remain passive: %s", value => {
    const id = `T01["${value}"]`, p = projection([task(id, { assignee: value, title: value, blocked_reason: value,
      microtasks: [micro(`${id}.M01`, { text: value, outcome: value })] })], Object.fromEntries([[value, registration({ harness: value, swarm: value })]]));
    const vm = wallVM(p, { ...swarmVM(p), room: value });
    vm.workspace = value; vm.workspaces = [{ id: value, name: value, lens: "dev", accent: "sky" }];
    vm.tasks = vm.tasks.map(t => ({ ...t, workspace: value }));
    const before = Object.getOwnPropertyDescriptors(Object.prototype), root = mountVM(freeze(vm));
    expect(text(taskCard(root, id))).toContain(value); expect(visibleText(strip(root))).toContain(value);
    noExecutableLabels(root); expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(before);
  });
  it("A4 hostile room replacement cannot contaminate another selected room", () => {
    const h = start({ initialView: "wall" });
    h.rooms.set(HOSTILE, projection([task("T01", { assignee: HOSTILE, title: HOSTILE })], { [HOSTILE]: registration({ harness: HOSTILE }) }));
    observed.handlers!.onWorkspace!(HOSTILE); expect(visibleText(strip(h.wallHost))).toContain(HOSTILE); noExecutableLabels(h.wallHost);
    observed.handlers!.onWorkspace!("demo"); expect(visibleText(strip(h.wallHost))).not.toContain(HOSTILE);
    expect(text(taskCard(h.wallHost, "T01"))).toContain("executor-b"); expect(h.post).not.toHaveBeenCalled();
  });
  it("A5 the landing oracle rejects a Swarm-default negative witness", () => {
    const h = start({ initialView: "swarm" }); expect(() => expectLanding(h.wallHost)).toThrow();
  });
  it("A5 the chip/strip oracle rejects missing Wall derivation without fabricating evidence", () => {
    const p = frozenPlan(), admitted = mountVM(wallVM(p, swarmVM(p)));
    expect(strip(admitted)).toBeDefined(); chipHeader(admitted, "T01", "executor-b", "Harness B", "Waiting");
    const root = mountVM(wallVM());
    expect(() => strip(root)).toThrow(); expect(() => chipHeader(root, "T01", "executor-b", "Harness B", "Waiting")).toThrow();
  });
  it("A5 the terminal oracle rejects a working-only model that drops Failed lifecycle", () => {
    const p = frozenPlan(), vm = swarmVM(p);
    const altered: SwarmViewModel = { ...vm, agents: vm.agents.map(a => {
      if (a.agent !== "failed-agent") return a;
      const { lifecycle: _lifecycle, ...rest } = a; return { ...rest, activity: "working" as const };
    }) };
    const root = mountVM(wallVM(p, altered));
    chipHeader(root, "T04", "failed-agent", "Failed harness", "Working");
    expect(() => chipHeader(root, "T04", "failed-agent", "Failed harness", "Failed")).toThrow();
  });
  it("M7 Models and collapsed legacy guidance remain available without activating chat", () => {
    const open = vi.fn(), h = start({ initialView: "wall", onOpenModels: open });
    const trigger = models(h.wallHost); trigger.click(); expect(open).toHaveBeenCalledExactlyOnceWith(trigger);
    const entry = control(h.wallHost, "Messages (legacy)"); expect(entry.getAttribute("aria-expanded")).toBe("false");
    entry.click(); expect(visibleText(h.wallHost)).toContain("Use your harness to message agents");
    expect(h.chatHost.getAttribute("data-open")).not.toBe("true"); expect(h.post).not.toHaveBeenCalled();
  });
  // A-R41: removed implicit card-to-chat routing; legacy Messages remains available.
  it("M7 Wall task clicks stay read-only and legacy Messages opens the chosen task", () => {
    const h = start({ initialView: "wall" }); taskCard(h.wallHost, "T01").click();
    expect(h.wall.selection()).toBeNull();
    expect(h.chatHost.getAttribute("data-open")).not.toBe("true");
    control(h.wallHost, "Messages (legacy)").click(); control(h.wallHost, "Open task messages").click();
    expect(h.wall.selection()).toEqual({ room: "demo", taskId: "T01", assignee: "executor-b" });
    expect(h.chatHost.getAttribute("data-open")).toBe("true"); expect(h.post).not.toHaveBeenCalled();
  });
  it("M7 Swarm disclosure/detail never activates agent_wall message/task handlers", () => {
    const h = start({ initialView: "swarm" }), root = swarmRoot(h.wallHost);
    activate(disclosure(agentCard(root, "executor-b")));
    expect(h.wall.selection()).toBeNull(); expect(observed.openTask).not.toHaveBeenCalled();
    expect(h.chatHost.getAttribute("data-open")).not.toBe("true");
    const button = control(root, "View task T01"); activate(button);
    expect(visibleText(root)).toContain("T01 local outcome");
    expect(observed.openTask).not.toHaveBeenCalled(); expect(h.wall.selection()).toBeNull();
    expect(h.chatHost.getAttribute("data-open")).not.toBe("true"); expect(h.post).not.toHaveBeenCalled(); noNewControls(root);
  });
});
