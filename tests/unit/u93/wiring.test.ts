import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAgentWall, type AgentWall } from "../../../src/app/agent_wall";
import type { AgentLinkDeps } from "../../../src/app/agent_link";
import type { WallHandlers } from "../../../src/views/types";
import type { AgentChatHandlers } from "../../../src/agentsui/types";
import { mountLiaisonPanel } from "../../../src/agentsui/liaison_panel";
import { FakeAppClock } from "../u37c/harness";
import { fixture, element } from "../u86/helpers";
import type { LiaisonDeps, LiaisonGenerateRequest } from "../../../src/app/liaison";
import { boot, control, deferred, fakeDeps, flush, input, keepPanel, text, answer } from "./helpers";

const observed = vi.hoisted(() => ({
  wallHandlers: undefined as WallHandlers | undefined,
  chatHandlers: undefined as AgentChatHandlers | undefined,
  hostStore: undefined as ReturnType<typeof fixture>["store"] | undefined,
  linkDeps: undefined as AgentLinkDeps | undefined,
  liaisonDeps: [] as LiaisonDeps[],
  post: vi.fn(async () => ({ ok: true as const, id: "e-000000000000ffff", lamport: 65535 })),
}));
vi.mock("../../../src/views", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/views")>();
  return { ...real, mountWall: (...args: Parameters<typeof real.mountWall>) => {
    observed.wallHandlers = args[2]; return real.mountWall(...args);
  } };
});
vi.mock("../../../src/agentsui", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/agentsui")>();
  return { ...real, mountAgentChat: (...args: Parameters<typeof real.mountAgentChat>) => {
    observed.chatHandlers = args[2]; return real.mountAgentChat(...args);
  } };
});
vi.mock("../../../src/app/liaison", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/app/liaison")>();
  return { ...real, createLiaisonController: (deps: LiaisonDeps) => {
    observed.liaisonDeps.push(deps); return real.createLiaisonController(deps);
  } };
});
vi.mock("../../../src/app/index", () => ({ readHostEnv: () => ({
  extensionOrigins: [`chrome-extension://${"a".repeat(32)}`], firebaseConfig: {},
}) }));
vi.mock("../../../src/app/firebase-config.public", () => ({ isPlaceholderConfig: () => true }));
vi.mock("../../../src/app/connector", () => ({ createConnector: () => ({ onMessage: () => undefined }) }));
vi.mock("../../../src/ui/model_selector", () => ({ createModelSheet: () => ({ render() {}, open() {} }) }));
vi.mock("../../../src/app/plan_wiring", () => ({ createPlanWiring: () => ({
  notifyChange() {}, taskVerdicts: () => new Map(), planBriefs: () => new Map(), dispose() {},
}) }));
vi.mock("../../../src/app/agent_store", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/app/agent_store")>();
  return { ...real, createAgentStore: (...args: Parameters<typeof real.createAgentStore>) =>
    observed.hostStore ?? real.createAgentStore(...args) };
});
vi.mock("../../../src/app/agent_link", () => ({ createAgentLink: (deps: AgentLinkDeps) => {
  observed.linkDeps = deps;
  return { post: observed.post, start() {}, stop() {} };
} }));

const walls: AgentWall[] = [];
const observers: MutationObserver[] = [];
beforeEach(() => {
  observed.wallHandlers = undefined; observed.chatHandlers = undefined;
  observed.hostStore = undefined; observed.linkDeps = undefined; observed.post.mockClear();
  observed.liaisonDeps = [];
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  walls.splice(0).forEach(w => w.destroy());
  observers.splice(0).forEach(o => o.disconnect());
  vi.clearAllTimers();
});
function planFixture() {
  const f = fixture(); f.open(); f.task(); f.task("worker-b", "Second task"); return f;
}
function start(f = planFixture()) {
  const wallHost = document.createElement("div"); const chatHost = document.createElement("div");
  document.body.append(wallHost, chatHost);
  const wall = startAgentWall({ wallHost, chatHost, store: f.store, clock: new FakeAppClock(),
    userAgent: "wall-user", link: { post: observed.post }, reviewer: { review: async () => undefined } });
  walls.push(wall); return { ...f, wall, wallHost, chatHost };
}
function open(id = "plan:demo:T01") { observed.wallHandlers!.onOpenTask!(id); }
function selectedContext(wall: AgentWall) {
  const selected = wall.selection();
  if (selected === null) throw new Error("No plan task selected");
  return input({ room: selected.room, task_id: selected.taskId,
    human: { id: "human-1", text: wall.chat()!.getDraft() } });
}
async function hosted(withFloor = true) {
  vi.resetModules();
  const f = planFixture(); observed.hostStore = f.store;
  document.body.replaceChildren(Object.assign(document.createElement("div"), { id: "wall" }));
  const NativeObserver = globalThis.MutationObserver;
  vi.stubGlobal("MutationObserver", class extends NativeObserver {
    constructor(callback: MutationCallback) { super(callback); observers.push(this); }
  });
  await import("../../../hosting/src/main");
  if (withFloor) observed.linkDeps!.onRoomHello!({ t: "room_hello", v: 1, agent: "wall-user",
    rooms: [{ room: "demo", floor: "PREFER_ON_DEVICE" }] });
  open();
  return f;
}

describe("U93 M1 wall bindings", () => {
  it("exposes only an open plan selection, not legacy drawers or a closed drawer", () => {
    const f = planFixture(); f.legacy("legacy-worker"); const h = start(f);
    expect(h.wall.selection()).toBeNull();
    open(); expect(h.wall.selection()).toEqual({ room: "demo", taskId: "T01", assignee: "worker-a" });
    observed.chatHandlers!.onClose!(); expect(h.wall.selection()).toBeNull();
    open("agent:demo:legacy-worker"); expect(h.wall.selection()).toBeNull();
    open("plan:demo:T02"); expect(h.wall.selection()).toEqual({ room: "demo", taskId: "T02", assignee: "worker-b" });
  });
  it("binds a clicked plan card to the active workspace when task IDs repeat", () => {
    const f = planFixture(); f.open("work"); f.task("worker-w", "Work task", "work");
    const h = start(f); observed.wallHandlers!.onWorkspace!("work");
    // A-R41: task selection for liaison now starts inside legacy Messages.
    openLegacyMessages(h.wallHost, "plan:work:T01");
    expect(h.wall.selection()).toEqual({ room: "work", taskId: "T01", assignee: "worker-w" });
    expect(observed.post).not.toHaveBeenCalled();
  });
  it("round-trips the live S1 draft, keeps task drafts separate and returns null after destroy", () => {
    const h = start(); open(); const handle = h.wall.chat()!;
    handle.setDraft("Task one draft"); expect(handle.getDraft()).toBe("Task one draft");
    open("plan:demo:T02"); expect(h.wall.chat()!.getDraft()).toBe("");
    h.wall.chat()!.setDraft("Task two draft"); open(); expect(h.wall.chat()!.getDraft()).toBe("Task one draft");
    h.wall.destroy(); expect(h.wall.chat()).toBeNull(); expect(h.wall.selection()).toBeNull();
    handle.setDraft("Late draft"); expect(handle.getDraft()).toBe(""); expect(observed.post).not.toHaveBeenCalled();
  });
  it("notifies after binding the selected composer, contains errors and unsubscribes", () => {
    const h = start(); const seen: unknown[] = [];
    h.wall.onSelection(() => { throw new Error("Listener failure"); });
    const off = h.wall.onSelection(() => seen.push([h.wall.selection(), h.wall.chat()?.getDraft()]));
    open(); expect(seen).toEqual([[{ room: "demo", taskId: "T01", assignee: "worker-a" }, ""]]);
    h.wall.refresh(); expect(seen).toHaveLength(1);
    open("plan:demo:T02"); expect(seen).toHaveLength(2);
    observed.chatHandlers!.onClose!(); expect(seen.at(-1)).toEqual([null, ""]);
    off(); open(); expect(seen).toHaveLength(3);
  });
  it("reports refreshed assignees and invalidation without exposing an old task", () => {
    const h = start(); open(); const listener = vi.fn(); h.wall.onSelection(listener);
    h.op("demo", { kind: "task.release", task_id: "T01" }, "worker-a");
    h.op("demo", { kind: "task.claim", task_id: "T01" }, "replacement");
    h.wall.refresh(); expect(h.wall.selection()?.assignee).toBe("replacement"); expect(listener).toHaveBeenCalledOnce();
    // A-U109c: (a) each current owner cancels before the close/invalidation probe, M6 / Amendment C.2.
    for (const task of h.store.plan("demo")!.projection.tasks) {
      h.op("demo", { kind: "task.set", task_id: task.id, base_rev: task.rev, state: "cancelled" }, task.assignee!);
    }
    h.op("demo", { kind: "plan.close", base_rev: h.store.plan("demo")!.projection.plan!.rev });
    h.wall.refresh(); expect(h.wall.selection()).toBeNull(); expect(listener).toHaveBeenCalledTimes(2);
  });
  it("Use draft alone changes the selected S1 composer and never posts", async () => {
    const h = start(); open(); const d = fakeDeps(); const controller = boot(d);
    const root = document.createElement("div"); document.body.append(root);
    const getContext = () => selectedContext(h.wall);
    const panel = keepPanel(mountLiaisonPanel(root, { controller, getContext,
      getChatHandle: context => h.wall.selection()?.room === context.room && h.wall.selection()?.taskId === context.task_id
        ? h.wall.chat() ?? undefined : undefined,
      onSend: ({ text }) => observed.chatHandlers!.onSend!(text), onPlan() {}, onMemory() {}, trigger: h.wallHost,
    }));
    const setDraft = vi.spyOn(h.wall.chat()!, "setDraft");
    for (const label of [/^Draft$/, /^Summary$/, /^Clarify$/]) { control(root, label).click(); await flush(); }
    expect(setDraft).not.toHaveBeenCalled(); expect(observed.post).not.toHaveBeenCalled();
    control(root, /^Use draft$/).click(); expect(setDraft).toHaveBeenCalledExactlyOnceWith("A careful draft");
    open("plan:demo:T02"); expect(h.wall.chat()!.getDraft()).toBe("");
    panel.destroy(); expect(observed.post).not.toHaveBeenCalled();
  });
});

describe("U93 M1 hosted mount", () => {
  it("mounts in the drawer, updates task context, and uses existing delivery only on explicit Send", async () => {
    await hosted();
    const panel = element(document, ".chat-drawer .liaison-panel");
    const composer = element<HTMLTextAreaElement>(document, ".chat-drawer textarea");
    composer.value = "Original task one"; composer.dispatchEvent(new Event("input", { bubbles: true }));
    control(panel, /^Draft$/).click(); await flush();
    expect(text(panel)).toContain("Original task one"); expect(text(panel)).toContain("Rules");
    control(panel, /^Use draft$/).click(); expect(composer.value).toBe("Original task one");
    expect(observed.post).not.toHaveBeenCalled();
    open("plan:demo:T02");
    control(panel, /^Use draft$/).click(); expect(composer.value).toBe("");
    const second = element(document, ".chat-drawer .liaison-panel");
    expect(text(second)).not.toContain("Original task one");
    expect(control(second, /^Use draft$/).disabled).toBe(true);
    composer.value = "Original task two"; composer.dispatchEvent(new Event("input", { bubbles: true }));
    control(second, /^Draft$/).click(); await flush();
    expect(JSON.parse(localStorage.getItem("tasklight.liaison.v1:demo:T02")!)).toMatchObject({ human: { text: "Original task two" } });
    expect(observed.post).not.toHaveBeenCalled();
    control(second, /^Send$/).click(); await flush();
    expect(observed.post).toHaveBeenCalledExactlyOnceWith({ room: "demo", to: "worker-b", text: "Original task two" });
    window.dispatchEvent(new Event("pagehide"));
    control(second, /^Draft$/).click(); expect(observed.post).toHaveBeenCalledTimes(1);
  });
  it.each(["task switch", "host floor change", "page teardown"] as const)(
    "%s aborts the bound request; late output cannot change another task or send", async action => {
      const f = await hosted();
      f.event("demo", "worker-a", "answer", "Executor history");
      const panel = element(document, ".chat-drawer .liaison-panel");
      const composer = element<HTMLTextAreaElement>(document, ".chat-drawer textarea");
      composer.value = "Preserve this human draft";
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      const pending = deferred<ReturnType<typeof answer>>();
      let request: LiaisonGenerateRequest | undefined;
      const generate = vi.spyOn(observed.liaisonDeps.at(-1)!.registry, "generate")
        .mockImplementationOnce(req => { request = req; return pending.promise; });
      control(panel, /^Draft$/).click(); await flush();
      expect(request).toMatchObject({ task: "liaison", room: "demo", tier: "standard" });
      expect(request!.prompt).toContain("Export verified");
      expect(request!.prompt).toContain("Executor history");
      expect(generate).toHaveBeenCalledOnce();
      if (action === "task switch") open("plan:demo:T02");
      else if (action === "host floor change") observed.linkDeps!.onRoomHello!({
        t: "room_hello", v: 1, agent: "wall-user", rooms: [{ room: "demo", floor: "ONLY_ON_DEVICE" }],
      });
      else window.dispatchEvent(new Event("pagehide"));
      expect(request!.signal.aborted).toBe(true);
      pending.resolve(answer({ text: JSON.stringify({ kind: "draft", text: "Late answer", refs: [] }) }));
      await flush();
      expect(text(document.body)).not.toContain("Late answer");
      control(panel, /^Use draft$/).click();
      expect(observed.post).not.toHaveBeenCalled();
      if (action === "task switch") expect(composer.value).toBe("");
      if (action === "host floor change") {
        expect(composer.value).toBe("Preserve this human draft");
        const currentPanel = element(document, ".chat-drawer .liaison-panel");
        control(currentPanel, /^Draft$/).click(); await flush();
        expect(generate.mock.calls.at(-1)?.[0].tier).toBe("private");
      }
    },
  );
  it("missing floor blocks generation while the original direct Send remains available", async () => {
    await hosted(false);
    const panel = element(document, ".chat-drawer .liaison-panel");
    const composer = element<HTMLTextAreaElement>(document, ".chat-drawer textarea"); composer.value = "Direct message";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    control(panel, /^Draft$/).click(); await flush();
    expect(text(panel)).toMatch(/privacy floor.*blocked/i);
    expect(observed.post).not.toHaveBeenCalled();
    element<HTMLButtonElement>(document, ".chat-drawer .chat-send").click(); await flush();
    expect(observed.post).toHaveBeenCalledExactlyOnceWith({ room: "demo", to: "worker-a", text: "Direct message" });
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
