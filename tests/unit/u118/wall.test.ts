import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAgentWall, type AgentWall } from "../../../src/app/agent_wall";
import { deriveSwarmViewModel } from "../../../src/app/swarm_vm";
import { renderSwarmView } from "../../../src/views/swarm";
import { mountWall } from "../../../src/views";
import type { WallHandlers, WallVM } from "../../../src/views/types";
import { NOW, HOSTILE, accessibleName, clock, control, event, flush, models, noExecutableLabels, projection, roomFixture, swarm, task, text, visibleText } from "./fixtures";

const observed = vi.hoisted(() => ({ handlers: undefined as WallHandlers | undefined, taskOpen: vi.fn() }));
vi.mock("../../../src/views", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/views")>();
  return { ...real, mountWall: (...args: Parameters<typeof real.mountWall>) => {
    observed.handlers = args[2];
    const handlers = { ...args[2], onOpenTask: (...params: Parameters<NonNullable<WallHandlers["onOpenTask"]>>) => {
      observed.taskOpen(...params); args[2]?.onOpenTask?.(...params);
    } };
    return real.mountWall(args[0], args[1], handlers);
  } };
});
let wall: AgentWall | undefined;
let disposeView: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); observed.handlers = undefined; observed.taskOpen.mockClear(); });
afterEach(() => { wall?.destroy(); wall = undefined; disposeView?.(); disposeView = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function start(options: { initialView?: unknown; onOpenModels?: (trigger: HTMLElement) => void } = {}) {
  const f = roomFixture();
  const wallHost = document.createElement("div"), chatHost = document.createElement("div");
  document.body.append(wallHost, chatHost);
  const post = vi.fn(async () => ({ ok: true as const, id: "e-000000000000ffff", lamport: 65535 }));
  const deps = { ...options, wallHost, chatHost, store: f.store, clock, userAgent: "wall-user", link: { post }, reviewer: { review: vi.fn(async () => undefined) } };
  // Deliberately exercise untyped runtime input without pretending ViewId already includes Swarm.
  wall = Reflect.apply(startAgentWall, undefined, [deps]) as AgentWall;
  return { ...f, wall, wallHost, chatHost, post };
}
function navigate(value: unknown): void {
  expect(observed.handlers?.onView).toBeTypeOf("function");
  Reflect.apply(observed.handlers!.onView!, undefined, [value]);
}
function selected(root: ParentNode): string | null | undefined {
  // A-U152: navigation exposes its current destination through aria-current.
  const node = root.querySelector<HTMLElement>('button[data-nav][aria-current="page"]');
  // A-V1: destination identity remains swarm when its label becomes Agents.
  return node?.getAttribute("data-nav") ?? null;
}
// A-R40: full registration/blocker/history fields live behind labelled disclosures, U138 M6.
// A-Q1: U150 preserves Swarm metadata expansion across refresh; retain initial collapsed checks.
function expandedSwarm(root: ParentNode, alreadyExpanded = false): HTMLElement {
  const view = swarm(root);
  for (const toggle of view.querySelectorAll<HTMLButtonElement>(".swarm-metadata-toggle")) {
    expect(toggle.getAttribute("aria-expanded")).toBe(alreadyExpanded ? "true" : "false");
    if (!alreadyExpanded) toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(panel?.hidden).toBe(false);
  }
  return view;
}
const baseVM = (): WallVM => ({ now: "", model: { state: "ready", label: "Device ready" }, network: "online", workspaces: [], workspace: "", view: "wall", archiveScope: "workspace", tasks: [], agenda: [], archive: [] });

describe("U118 A1 / M1-M3 landing and lifecycle", () => {
  it("M1 exercises existing U112 contracts before functional assertions; no missing-import failure", () => {
    expect(deriveSwarmViewModel).toBeTypeOf("function"); expect(renderSwarmView).toBeTypeOf("function");
  });
  // A-R40: Wall is first/default and consumes selected-room agents, U138 M1/M2 and Oracle amendments supersede U118 M2/Amendment B §1.
  it("A1 defaults to Agents as the first view and renders selected-room agents", () => {
    const h = start();
    const first = h.wallHost.querySelector<HTMLElement>('nav button, [role="navigation"] button');
    // A-V1: Agents replaces Wall as the default.
    expect(first ? accessibleName(first) : null).toBe("Agents");
    expect(selected(h.wallHost)).toBe("swarm");
    const strip = h.wallHost.querySelector<HTMLElement>(".swarm-view");
    expect(strip).not.toBeNull();
    expect(text(strip!)).toContain("executor-a");
    expect(text(strip!)).not.toContain("work-executor");
  });
  // A-R40: accept Agenda and Archive as explicit destinations, U138 M1 / Oracle amendments.
  it.each(["wall", "agenda", "diary", "archive", "memory", "swarm"])("A1 preserves explicit initialView %s", initialView => {
    const h = start({ initialView }); expect(selected(h.wallHost)).toBe(initialView);
  });
  // A-R40: invalid initial values fall back to Wall; Agenda/Archive are valid, U138 M1 / Oracle amendments.
  it.each(["__proto__", "<img src=x onerror=alert(1)>", "", null, 7])(
    "A1 Amendment B invalid initialView %j falls back to Agents", initialView => {
      // A-V1: invalid initial views use the new default without changing its stable id.
      const h = start({ initialView }); expect(selected(h.wallHost)).toBe("swarm"); expect(h.wallHost.querySelector(".swarm-view")).not.toBeNull();
    });
  it("A1 navigates Swarm Wall Memory Swarm and replaces previous-room cards", () => {
    const h = start();
    for (const [name, id] of [["Swarm", "swarm"], ["Wall", "wall"], ["Memory", "memory"], ["Swarm", "swarm"]]) {
      control(h.wallHost, name!).click(); expect(selected(h.wallHost)).toBe(id);
    }
    observed.handlers!.onWorkspace!("work");
    expect(text(swarm(h.wallHost))).toContain("work-executor");
    expect(text(swarm(h.wallHost))).not.toContain("executor-a");
    observed.handlers!.onWorkspace!("demo"); expect(text(swarm(h.wallHost))).not.toContain("work-executor");
  });
  it.each(["agenda", "archive"])("A1 runtime navigation accepts restored %s", value => {
    // A-R40: restored destinations navigate without selecting a task or writing, U138 M1/M7.
    const h = start({ initialView: "wall" });
    navigate(value);
    expect(selected(h.wallHost)).toBe(value);
    expect(h.wall.selection()).toBeNull(); expect(h.post).not.toHaveBeenCalled();
  });
  // A-R40: Agenda/Archive navigation is valid; retain mutation-free rejection of invalid values, U138 M1.
  it.each(["bogus", "__proto__", "", null, {}, 7])(
    "A1 Amendment B invalid runtime navigation %j performs zero DOM or selection mutation", value => {
      const h = start({ initialView: "wall" }); const before = h.wallHost.innerHTML, first = h.wallHost.firstChild;
      const observer = new MutationObserver(() => undefined); observer.observe(h.wallHost, { subtree: true, attributes: true, childList: true, characterData: true });
      try {
        navigate(value);
        expect(observer.takeRecords()).toHaveLength(0); expect(h.wallHost.innerHTML).toBe(before);
        expect(h.wallHost.firstChild).toBe(first); expect(h.wall.selection()).toBeNull(); expect(h.post).not.toHaveBeenCalled();
      } finally { observer.disconnect(); }
    });
  it("A1 refresh consumes changed projection and same-room unanswered questions", () => {
    // A-R40: select secondary Swarm explicitly and preserve this oracle, U138 M1/M6 / Oracle amendments.
    const h = start({ initialView: "swarm" });
    h.rooms.set("demo", projection([task("T09", { title: "Changed task", microtasks: [] })]));
    h.history.push(event(3)); h.wall.refresh();
    const content = visibleText(expandedSwarm(h.wallHost)); expect(content).toContain("T09"); expect(content).toContain("Changed task");
    expect(content).not.toContain("T01"); expect(content).toMatch(/Unanswered questions in loaded history:?\s*2/);
    expect(h.store.events).toHaveBeenCalledWith("demo"); expect(h.post).not.toHaveBeenCalled();
  });
  it("A1 clock-driven refresh expires working evidence without a store mutation", async () => {
    // A-R40: select secondary Swarm explicitly and preserve this oracle, U138 M1/M6 / Oracle amendments.
    const h = start({ initialView: "swarm" }); const original = structuredClone(h.rooms.get("demo"));
    expect(text(swarm(h.wallHost)).match(/Working/g)).toHaveLength(2);
    expect(text(swarm(h.wallHost)).match(/Liveness unknown/g)).toHaveLength(1);
    vi.advanceTimersByTime(90_001); await flush();
    expect(text(swarm(h.wallHost))).not.toMatch(/Working/);
    expect(text(swarm(h.wallHost)).match(/Liveness unknown/g)).toHaveLength(3);
    expect(h.rooms.get("demo")).toEqual(original); expect(h.post).not.toHaveBeenCalled();
  });
  it("A1 U112 current task active microtask progress and read-only question count reach the mount", () => {
    // A-R40: select secondary Swarm explicitly and preserve this oracle, U138 M1/M6 / Oracle amendments.
    const h = start({ initialView: "swarm" }); const content = visibleText(expandedSwarm(h.wallHost));
    expect(content).toContain("Current task"); expect(content).toContain("T01");
    expect(content).toContain("Active microtask"); expect(content).toContain("T01.M02"); expect(content).toContain("1/2 microtasks done");
    expect(content).toContain("T04 → T03 → executor-c");
    expect(content).toMatch(/Unanswered questions in loaded history:?\s*1/);
  });
  it("A1 replacement and repeated refresh never retain another room's cards", async () => {
    // A-R40: select secondary Swarm explicitly and preserve this oracle, U138 M1/M6 / Oracle amendments.
    const h = start({ initialView: "swarm" });
    for (const room of ["demo", "work", "demo", "work", "demo"]) {
      const old = swarm(h.wallHost); observed.handlers!.onWorkspace!(room); h.wall.refresh();
      vi.advanceTimersByTime(30_000); await flush(); const live = swarm(h.wallHost);
      // A-V1: the renamed Agents destination retains one swarm view instance.
      expect(h.wallHost.querySelectorAll(".swarm-view")).toHaveLength(1);
      // A-U146: named non-article Swarm cards retain their class hook.
      expect(live.querySelectorAll(".swarm-card")).toHaveLength(room === "demo" ? 3 : 1);
      expect(text(live)).not.toContain(room === "demo" ? "work-executor" : "executor-a");
      if (old !== live) expect(old.isConnected).toBe(false);
    }
    h.wall.destroy(); expect(vi.getTimerCount()).toBe(0); expect(h.post).not.toHaveBeenCalled();
  });
  it("A1 refresh recomputes read-only loaded questions after an answer", () => {
    // A-R40: select secondary Swarm explicitly and preserve this oracle, U138 M1/M6 / Oracle amendments.
    const h = start({ initialView: "swarm" });
    expect(visibleText(expandedSwarm(h.wallHost))).toMatch(/Unanswered questions in loaded history:?\s*1/);
    h.history.push(event(3, { agent: "executor-a", act: "answer", re: event(1).id })); h.wall.refresh();
    const content = visibleText(expandedSwarm(h.wallHost, true)); expect(content).not.toMatch(/Unanswered questions in loaded history:?\s*1/);
    expect(h.store.events).toHaveBeenCalledWith("demo"); expect(h.post).not.toHaveBeenCalled();
  });
  it("A1 destroy clears scheduled work and refresh cannot remount a destroyed wall", async () => {
    const h = start(); await flush(); h.wall.destroy(); const before = h.wallHost.innerHTML;
    expect(vi.getTimerCount()).toBe(0); vi.advanceTimersByTime(180_000); h.wall.refresh(); await flush();
    expect(h.wallHost.innerHTML).toBe(before); expect(h.post).not.toHaveBeenCalled();
  });
});

describe("U118 A2 / M4 Models contract and callback forwarding", () => {
  // A-U152: private-room policy and provider availability override stale active labels.
  it.each(["ready", "unavailable"] as const)("consolidates truthful %s provider, reviewer and private policy copy", state => {
    const host = document.createElement("div"); document.body.append(host);
    const label = "Gemini Nano ready · on-device model active · cloud active · Rules active";
    const handle = mountWall(host, { ...baseVM(), model: { state, label }, availability: "Private room · cloud disabled" });
    disposeView = () => handle.destroy();
    const record = host.querySelector<HTMLElement>(".model-health")!;
    expect(record).not.toBeNull();
    expect(text(record)).toContain("Private room · cloud disabled");
    expect(text(record)).toContain("Rules active");
    expect(text(record)).not.toContain("cloud active");
    if (state === "unavailable") {
      expect(text(record)).not.toMatch(/Gemini Nano ready|on-device model active/);
      expect(text(record)).toContain("Gemini Nano unavailable");
    }
    expect(record.querySelector("button,a,input,select,textarea")).toBeNull();
    expect(record.tabIndex).toBeLessThan(0);
    expect(models(host).disabled).toBe(false);
    expect(host.querySelectorAll('button[aria-controls="model-sheet"]')).toHaveLength(1);
  });
  it("A2 standalone wall has exactly one named enabled Models opener", () => {
    const host = document.createElement("div"); document.body.append(host);
    const handle = mountWall(host, baseVM(), { onOpenModels: vi.fn() }); disposeView = () => handle.destroy();
    expect(models(host).getAttribute("aria-expanded")).toBe("false");
  });
  it("A2 A6 AgentWall forwards onOpenModels with the actual trigger", () => {
    const callback = vi.fn(); start({ onOpenModels: callback }); const trigger = document.createElement("button");
    observed.handlers?.onOpenModels?.(trigger); expect(callback).toHaveBeenCalledExactlyOnceWith(trigger);
  });
  it.each(["sync", "async"])("A2 contains a %s Models callback failure", async mode => {
    const callback = vi.fn(() => { if (mode === "sync") throw new Error("unavailable"); return Promise.reject(new Error("unavailable")); });
    const h = start({ onOpenModels: callback });
    const errors: unknown[] = []; const onError = (ev: ErrorEvent) => { errors.push(ev.error); ev.preventDefault(); };
    window.addEventListener("error", onError);
    try { const trigger = models(h.wallHost); expect(() => trigger.click()).not.toThrow(); await flush(); expect(callback).toHaveBeenCalledTimes(1); expect(errors).toEqual([]); }
    finally { window.removeEventListener("error", onError); }
  });
});

describe("U118 A4 A5 / M6-M7 passive text and legacy regression", () => {
  it("A4 hostile agent task and microtask labels are literal text", () => {
    // A-R40: select secondary Swarm explicitly and preserve this oracle, U138 M1/M6 / Oracle amendments.
    const h = start({ initialView: "swarm" }); const t = task("T01", { assignee: HOSTILE, title: HOSTILE });
    t.microtasks[0]!.text = HOSTILE; h.rooms.set("demo", projection([t])); h.wall.refresh();
    expect(text(swarm(h.wallHost))).toContain(HOSTILE); noExecutableLabels(h.wallHost); expect(h.post).not.toHaveBeenCalled();
  });
  it("A4 existing workspace display names render hostile markup literally", () => {
    const host = document.createElement("div"); document.body.append(host);
    const vm = { ...baseVM(), workspace: "demo", workspaces: [{ id: "demo", name: HOSTILE, lens: "dev" as const, accent: "sky" as const }] };
    const handle = mountWall(host, vm); disposeView = () => handle.destroy();
    expect(text(host)).toContain(HOSTILE); noExecutableLabels(host);
  });
  it("A4 Amendment B hostile workspace names remain passive text", () => {
    // A-R40: select secondary Swarm explicitly and preserve this oracle, U138 M1/M6 / Oracle amendments.
    const h = start({ initialView: "swarm" }); h.rooms.set(HOSTILE, projection([task("T81", { assignee: "hostile-room-worker" })]));
    h.wall.refresh(); observed.handlers!.onWorkspace!(HOSTILE);
    expect(text(swarm(h.wallHost))).toContain(HOSTILE); noExecutableLabels(h.wallHost); expect(h.post).not.toHaveBeenCalled();
  });
  it("A5 no lifecycle input means Not registered by a harness and no invented deployment", () => {
    // A-R40: select secondary Swarm explicitly and preserve this oracle, U138 M1/M6 / Oracle amendments.
    const h = start({ initialView: "swarm" }); const content = visibleText(expandedSwarm(h.wallHost));
    expect(content).toContain("Not registered by a harness"); expect(content).not.toMatch(/\bDeployed\b|Harness:/);
  });
  it("A5 Swarm has no composer message input or terminal controls", () => {
    // A-R40: select secondary Swarm explicitly and preserve this oracle, U138 M1/M6 / Oracle amendments.
    const h = start({ initialView: "swarm" }); const root = swarm(h.wallHost);
    expect(root.querySelector('textarea,input,[contenteditable="true"],form')).toBeNull();
    expect(text(root)).not.toMatch(/\b(?:Send message|Terminal|Liaison)\b/); expect(h.wall.selection()).toBeNull();
  });
  it("A5 Amendment B Swarm card selection never activates the Wall chat callback", () => {
    // A-R40: select secondary Swarm explicitly and preserve this oracle, U138 M1/M6 / Oracle amendments.
    // A-U146: locate the Swarm card independently of its container element.
    const h = start({ initialView: "swarm" }); const root = swarm(h.wallHost); const card = root.querySelector<HTMLElement>(".swarm-card");
    expect(card, "Real U112 card must be present").not.toBeNull(); card!.click();
    expect(observed.taskOpen).not.toHaveBeenCalled(); expect(h.wall.selection()).toBeNull();
    expect(h.chatHost.getAttribute("data-open")).not.toBe("true"); expect(h.post).not.toHaveBeenCalled();
  });
  it("A5 Messages legacy is initially collapsed and gives harness guidance when opened", () => {
    const h = start(); const entry = control(h.wallHost, "Messages (legacy)");
    expect(entry.getAttribute("aria-expanded") ?? String(entry.closest("details")?.hasAttribute("open") ?? true)).toBe("false");
    expect(entry.closest('[role="tablist"]'), "Legacy access is secondary to primary view navigation").toBeNull();
    entry.click();
    expect(entry.closest("details")?.open ?? (entry.getAttribute("aria-expanded") === "true")).toBe(true);
    expect(visibleText(h.wallHost)).toContain("Use your harness to message agents");
  });
  it("A5 legacy Messages opens the selected task chat and can send", async () => {
    const h = start({ initialView: "wall" });
    // A-U146: task cards retain their class and identity hooks across container changes.
    const card = [...h.wallHost.querySelectorAll<HTMLElement>(".task[data-task-id]")].find(node => text(node).includes("Task T01"));
    // A-R41: task chat is reached only through expanded legacy Messages.
    expect(card).toBeDefined(); openLegacyMessages(h.wallHost, "plan:demo:T01");
    expect(h.wall.selection()).toEqual({ room: "demo", taskId: "T01", assignee: "executor-a" });
    expect(h.chatHost.getAttribute("data-open")).toBe("true"); h.wall.chat()!.setDraft("Keep the existing delivery path");
    h.chatHost.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await flush();
    expect(h.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ room: "demo", to: "executor-a", text: "Keep the existing delivery path" }));
  });
  it("M7 retains U108 workspace help and theme switching", () => {
    const h = start({ initialView: "wall" }); control(h.wallHost, "New workspace").click();
    expect(text(h.wallHost)).toContain("Connect your MCP client or agent harness");
    const toggle = h.wallHost.querySelector<HTMLButtonElement>('button[aria-label^="Toggle theme"]')!;
    const before = document.documentElement.dataset.theme; toggle.click(); expect(document.documentElement.dataset.theme).not.toBe(before);
  });
});

// A-R41: task conversations open only inside the expanded Messages (legacy) entry.
function openLegacyMessages(host: HTMLElement, taskId?: string): void {
  const toggle = host.querySelector<HTMLButtonElement>(".messages-toggle")!;
  if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
  const button = taskId === undefined ? host.querySelector<HTMLButtonElement>(".messages-open")
    : [...host.querySelectorAll<HTMLButtonElement>(".messages-task")]
      .find(node => node.getAttribute("data-task-vm-id") === taskId);
  expect(button).toBeDefined(); button!.click();
}
