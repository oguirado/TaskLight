// A-Q1: U148/U150 named non-article task roots retain their classes and identity hooks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAgentWall, type AgentWall } from "../../../src/app/agent_wall";
import type { AgentChatHandlers, AgentChatVM } from "../../../src/agentsui/types";
import type { WallHandlers, WallVM } from "../../../src/views/types";
import type { DriftVerdict } from "../../../src/agents/types";
import { FakeAppClock, settle } from "../u37c/harness";
import { element, fixture, HOSTILE, NOW, submit, typeDraft, visibleText } from "./helpers";

type TaskChatVM = AgentChatVM & { task?: { id: string; assignee: string | null } };
const observed = vi.hoisted(() => ({
  wallHandlers: undefined as WallHandlers | undefined,
  chatHandlers: undefined as AgentChatHandlers | undefined,
  wallVm: undefined as WallVM | undefined,
  chatVm: undefined as TaskChatVM | undefined,
}));

// Recording wrappers delegate every mount and update to the real DOM components.
vi.mock("../../../src/views", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/views")>();
  return { ...real, mountWall: (...args: Parameters<typeof real.mountWall>) => {
    observed.wallVm = args[1]; observed.wallHandlers = args[2];
    const handle = real.mountWall(...args);
    const update = handle.update.bind(handle);
    vi.spyOn(handle, "update").mockImplementation((vm: WallVM) => { observed.wallVm = vm; update(vm); });
    return handle;
  } };
});
vi.mock("../../../src/agentsui", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/agentsui")>();
  return { ...real, mountAgentChat: (...args: Parameters<typeof real.mountAgentChat>) => {
    observed.chatVm = args[1]; observed.chatHandlers = args[2];
    const handle = real.mountAgentChat(...args);
    const update = handle.update.bind(handle);
    vi.spyOn(handle, "update").mockImplementation((vm: AgentChatVM) => { observed.chatVm = vm; update(vm); });
    return handle;
  } };
});

let wall: AgentWall | undefined;
beforeEach(() => {
  observed.wallHandlers = undefined; observed.chatHandlers = undefined;
  observed.wallVm = undefined; observed.chatVm = undefined;
});
afterEach(async () => {
  wall?.destroy(); wall = undefined;
  await settle(10); vi.restoreAllMocks(); document.body.replaceChildren();
});

async function start(f = fixture(), verdict?: DriftVerdict) {
  const wallHost = document.createElement("div");
  const chatHost = document.createElement("div"); document.body.append(wallHost, chatHost);
  const clock = new FakeAppClock(); clock.t = NOW;
  const post = vi.fn(async (_request: { room: string; to: string; text: string }) =>
    ({ ok: true as const, id: "e-000000000000ffff", lamport: 65535 }));
  wall = startAgentWall({ wallHost, chatHost, store: f.store, clock, userAgent: "wall-user", link: { post },
    reviewer: { review: async () => verdict } });
  await settle(10);
  return { ...f, wallHost, chatHost, post, clock };
}
type Scenario = Awaited<ReturnType<typeof start>>;
function open(id: string): void {
  expect(observed.wallHandlers?.onOpenTask).toBeTypeOf("function");
  observed.wallHandlers!.onOpenTask!(id);
}
function action<K extends keyof AgentChatHandlers>(name: K): NonNullable<AgentChatHandlers[K]> {
  expect(observed.chatHandlers?.[name], `controller ${name} callback`).toBeTypeOf("function");
  return observed.chatHandlers![name] as NonNullable<AgentChatHandlers[K]>;
}
function vm(): TaskChatVM {
  expect(observed.chatVm, "selected target must produce a chat VM").toBeDefined();
  return observed.chatVm!;
}
function clickTask(h: Scenario, id = "T01"): void {
  const card = element(h.wallHost, `.task[data-task-id="${id}"]`);
  // A-R41: replace the removed card/title chat entry with the scoped legacy route.
  const vmId = card.getAttribute("data-task-vm-id") ?? card.getAttribute("data-task-id")!;
  openLegacyMessages(h.wallHost, vmId);
}
function assertTask(h: Scenario, room: string, id: string, assignee: string | null, title: string): void {
  expect(h.chatHost.getAttribute("data-open")).toBe("true");
  expect(vm()).toMatchObject({ room, agent: assignee ?? "", title, task: { id, assignee } });
  for (const text of [room, id, assignee ?? "Executor unassigned", title]) {
    expect(visibleText(h.chatHost)).toContain(text);
  }
}
function assertNoPost(h: Scenario): void {
  expect(h.post, "recipient rejection must produce no wire request").not.toHaveBeenCalled();
}
function assertRecipientActionsDisabled(h: Scenario): void {
  for (const selector of [".chat-send", ".chat-suggest", ".chat-escalate", ".chat-accept-drift"]) {
    const button = h.chatHost.querySelector<HTMLButtonElement>(selector);
    // Escalation and drift controls may be omitted when their banners are absent.
    if (button !== null) expect(button.disabled, selector).toBe(true);
  }
}
function neighbors(f: ReturnType<typeof fixture>): void {
  f.legacy("worker-b"); f.legacy("worker-c");
  f.event("demo", "worker-b", "answer", "Neighbor history");
}

const DRIFT: DriftVerdict = { verdict: "drift", source: "rules", reason: "Legacy plan changed" };

describe("A1 exact plan selection with no legacy state (M1, M2, M4)", () => {
  it.each(["real legacy Messages", "qualified callback"] as const)("A1 %s opens and sends to the task assignee", async entry => {
    const f = fixture(); f.open(); f.task();
    expect(f.store.states()).toEqual([]);
    const before = f.store.events("demo"); const h = await start(f);
    const ingest = vi.spyOn(f.store, "ingest");
    if (entry === "real legacy Messages") clickTask(h); else open("plan:demo:T01");
    assertTask(h, "demo", "T01", "worker-a", "Export CSV");
    expect(ingest).not.toHaveBeenCalled(); expect(f.store.states()).toEqual([]);
    expect(f.store.events("demo")).toEqual(before);
    typeDraft(h.chatHost, "status?"); submit(h.chatHost); await settle(10);
    expect(h.post).toHaveBeenCalledExactlyOnceWith({ room: "demo", to: "worker-a", text: "status?" });
  });

  it("A1 assigned history retains the room/executor rule without task filtering", async () => {
    const f = fixture(); f.open(); f.task();
    f.event("demo", "worker-a", "answer", "Earlier executor reply");
    f.event("demo", "wall-user", "question", "Earlier outgoing question", { to: "worker-a" });
    f.event("demo", "worker-c", "verdict", "Executor review", { to: "worker-a" });
    f.event("demo", "worker-b", "answer", "Exclude other executor");
    f.event("work", "worker-a", "answer", "Exclude other room");
    vi.spyOn(f.store, "states").mockReturnValue([]);
    const h = await start(f); open("plan:demo:T01");
    assertTask(h, "demo", "T01", "worker-a", "Export CSV");
    expect(vm().messages.map(m => m.text)).toEqual([
      "Earlier executor reply", "Earlier outgoing question", "Executor review",
    ]);
    expect([...h.chatHost.querySelectorAll(".chat-text")].map(n => n.textContent)).toEqual(vm().messages.map(m => m.text));
  });
});

describe("A2 unassigned and wrong-recipient controls (M3)", () => {
  it("A2 real unassigned Messages selection opens empty and disables every recipient action", async () => {
    const f = fixture(); f.open(); f.task(null); neighbors(f);
    const h = await start(f, DRIFT); clickTask(h);
    assertTask(h, "demo", "T01", null, "Export CSV");
    expect(vm()).toMatchObject({ messages: [], silent: false, sending: false, agent: "" });
    expect(vm().drift).toBeUndefined(); expect(vm().suggestNotice).toBeUndefined();
    expect(h.chatHost.querySelectorAll(".chat-msg")).toHaveLength(0);
    typeDraft(h.chatHost, "do not route"); assertRecipientActionsDisabled(h); assertNoPost(h);
  });

  it("A2 synthetic form submission cannot select a legacy neighbor", async () => {
    const f = fixture(); f.open(); f.task(null); neighbors(f);
    const h = await start(f); clickTask(h);
    typeDraft(h.chatHost, "synthetic submission"); submit(h.chatHost); await settle(10);
    assertNoPost(h);
  });

  it.each(["onSend", "onEscalate"] as const)("A2 captured %s cannot post for an unassigned task", async name => {
    const f = fixture(); f.open(); f.task(null); neighbors(f);
    const h = await start(f); const send = action("onSend"); const escalate = action("onEscalate");
    clickTask(h);
    if (name === "onSend") send("captured submission"); else escalate();
    await settle(10); assertNoPost(h);
  });

  it("A2 captured Suggest cannot leak a notice into another selection", async () => {
    const f = fixture(); f.open(); f.task(null); neighbors(f);
    const h = await start(f); const suggest = action("onSuggest"); clickTask(h); suggest();
    open("agent:demo:worker-b"); await settle(10);
    expect(vm().suggestNotice).toBeUndefined(); assertNoPost(h);
  });

  it("A2 captured drift acceptance cannot accept a neighbor's verdict", async () => {
    const f = fixture(); f.open(); f.task(null); neighbors(f);
    const h = await start(f, DRIFT); const accept = action("onAcceptDrift"); clickTask(h); accept();
    open("agent:demo:worker-b"); await settle(10);
    expect(vm().drift).toMatchObject({ reason: DRIFT.reason }); assertNoPost(h);
  });

  it.each(["worker-b", "worker-c"])("A2 negative control rejects a first-agent resolver choosing %s", async agent => {
    const f = fixture(); f.open(); f.task(null); neighbors(f);
    const h = await start(f);
    // Test-local broken resolution: replace the unassigned selection with a legacy target.
    // The same wire oracle used above must reject the resulting controller callback.
    const candidates = h.store.states().sort((a, b) => a.agent === agent ? -1 : b.agent === agent ? 1 : 0);
    const brokenResolver = (_id: string) => {
      const first = candidates[0]!;
      return `agent:${first.room}:${first.agent}`;
    };
    open(brokenResolver("plan:demo:T01")); action("onSend")("misrouted"); await settle(10);
    expect(h.post).toHaveBeenCalledExactlyOnceWith({ room: "demo", to: agent, text: "misrouted" });
    expect(() => assertNoPost(h)).toThrow(/recipient rejection/);
  });
});

describe("A3 room isolation and composer identity (M1, M4)", () => {
  it("A3 qualified identity selects its named room even while demo is displayed", async () => {
    const f = fixture(); f.open(); f.task(); f.open("work"); f.task("worker-w", "Work export", "work");
    const h = await start(f); expect(observed.wallVm?.workspace).toBe("demo");
    open("plan:work:T01"); assertTask(h, "work", "T01", "worker-w", "Work export");
    typeDraft(h.chatHost, "work status"); submit(h.chatHost); await settle(10);
    expect(h.post).toHaveBeenCalledExactlyOnceWith({ room: "work", to: "worker-w", text: "work status" });
  });

  it("A3 bare identity follows the latest rendered workspace only", async () => {
    const f = fixture(); f.open(); f.task(); f.open("work"); f.task("worker-w", "Work export", "work");
    const h = await start(f);
    observed.wallHandlers!.onWorkspace!("work"); expect(observed.wallVm?.workspace).toBe("work");
    clickTask(h); assertTask(h, "work", "T01", "worker-w", "Work export");
    typeDraft(h.chatHost, "work only"); submit(h.chatHost); await settle(10);
    expect(h.post).toHaveBeenCalledExactlyOnceWith({ room: "work", to: "worker-w", text: "work only" });
  });

  it("A3 missing bare identity does not search another room", async () => {
    const f = fixture(); f.open(); f.legacy("worker-b"); f.open("work"); f.task("worker-w", "Work export", "work");
    const h = await start(f); observed.wallHandlers!.onWorkspace!("demo");
    open("agent:demo:worker-b"); const send = action("onSend"); open("T01");
    send("must be rejected"); await settle(10);
    assertNoPost(h); expect(h.chatHost.getAttribute("data-open")).toBe("false");
  });

  it("A3 switching tasks with one executor clears draft and notice; same-selection refresh preserves draft", async () => {
    const f = fixture(); f.open(); f.task(); f.task("worker-a", "Export JSON"); f.legacy("worker-a");
    const h = await start(f); open("plan:demo:T01");
    assertTask(h, "demo", "T01", "worker-a", "Export CSV");
    typeDraft(h.chatHost, "old task draft"); action("onSuggest")();
    open("plan:demo:T02"); assertTask(h, "demo", "T02", "worker-a", "Export JSON");
    expect(element<HTMLTextAreaElement>(h.chatHost, "textarea").value).toBe("");
    expect(vm().suggestNotice).toBeUndefined();
    typeDraft(h.chatHost, "  retain\nthis draft  "); wall!.refresh(); await settle(10);
    expect(element<HTMLTextAreaElement>(h.chatHost, "textarea").value).toBe("  retain\nthis draft  "); assertNoPost(h);
  });

  it("A3 changing room clears the draft even when task and executor match", async () => {
    const f = fixture(); f.open(); f.task(); f.open("work"); f.task("worker-a", "Work export", "work");
    const h = await start(f); open("plan:demo:T01"); assertTask(h, "demo", "T01", "worker-a", "Export CSV");
    typeDraft(h.chatHost, "demo draft"); open("plan:work:T01");
    assertTask(h, "work", "T01", "worker-a", "Work export");
    expect(element<HTMLTextAreaElement>(h.chatHost, "textarea").value).toBe(""); assertNoPost(h);
  });
});

describe("A4 lifecycle and local rejection (M1, M3, M4)", () => {
  it.each(["form", "captured callback"] as const)("A4 reassignment before %s cancels old submission and refreshes recipient", async entry => {
    const f = fixture(); f.open(); f.task(); f.legacy("worker-a"); f.legacy("worker-b");
    const h = await start(f); open("plan:demo:T01");
    typeDraft(h.chatHost, "old assignee draft"); const send = action("onSend");
    f.op("demo", { kind: "task.release", task_id: "T01" }, "worker-a"); // A-U86a: takeover needs a stale claim; reassign by release + claim
    f.op("demo", { kind: "task.claim", task_id: "T01" }, "worker-b");
    // No refresh between the authoritative change and submission: tests the send-time check.
    if (entry === "form") submit(h.chatHost); else send("old assignee draft");
    await settle(10); assertNoPost(h);
    assertTask(h, "demo", "T01", "worker-b", "Export CSV");
    expect(element<HTMLTextAreaElement>(h.chatHost, "textarea").value).toBe("");
    typeDraft(h.chatHost, "new assignee draft"); submit(h.chatHost); await settle(10);
    expect(h.post).toHaveBeenCalledExactlyOnceWith({ room: "demo", to: "worker-b", text: "new assignee draft" });
  });

  it("A4 release before captured Send cancels instead of using a neighbor", async () => {
    const f = fixture(); f.open(); f.task(); f.legacy("worker-a");
    const h = await start(f, DRIFT); open("plan:demo:T01");
    typeDraft(h.chatHost, "old draft"); const send = action("onSend");
    f.op("demo", { kind: "task.release", task_id: "T01" }, "worker-a");
    send("old draft"); await settle(10); assertNoPost(h);
    assertTask(h, "demo", "T01", null, "Export CSV");
    expect(vm()).toMatchObject({ messages: [], silent: false, sending: false });
    expect(vm().drift).toBeUndefined(); expect(vm().suggestNotice).toBeUndefined();
    expect(element<HTMLTextAreaElement>(h.chatHost, "textarea").value).toBe("");
    assertRecipientActionsDisabled(h);
  });

  it("A4 refresh after reassignment clears draft and notices", async () => {
    const f = fixture(); f.open(); f.task(); f.legacy("worker-a"); f.legacy("worker-b");
    const h = await start(f); open("plan:demo:T01"); assertTask(h, "demo", "T01", "worker-a", "Export CSV");
    typeDraft(h.chatHost, "draft for a"); action("onSuggest")();
    f.op("demo", { kind: "task.release", task_id: "T01" }, "worker-a"); // A-U86a: takeover needs a stale claim; reassign by release + claim
    f.op("demo", { kind: "task.claim", task_id: "T01" }, "worker-b");
    wall!.refresh(); await settle(10);
    assertTask(h, "demo", "T01", "worker-b", "Export CSV");
    expect(element<HTMLTextAreaElement>(h.chatHost, "textarea").value).toBe("");
    expect(vm().suggestNotice).toBeUndefined(); assertNoPost(h);
  });

  it.each(["closed plan", "missing plan", "missing task"] as const)("A4 %s closes the drawer and rejects retained Send", async condition => {
    const f = fixture(); f.open(); f.task(); f.legacy("worker-a");
    const h = await start(f); open("plan:demo:T01"); assertTask(h, "demo", "T01", "worker-a", "Export CSV");
    const send = action("onSend"); typeDraft(h.chatHost, "orphaned draft");
    if (condition === "closed plan") {
      // A-U109c: (a) the assignee cancels open work before closing the fixture, M6 / Amendment C.2.
      f.op("demo", { kind: "task.set", task_id: "T01",
        base_rev: f.store.plan("demo")!.projection.tasks[0]!.rev, state: "cancelled" }, "worker-a");
      f.op("demo", { kind: "plan.close", base_rev: f.store.plan("demo")!.projection.plan!.rev, outcome: "Stopped" });
    } else {
      const current = f.store.plan("demo")!;
      vi.spyOn(f.store, "plan").mockReturnValue(condition === "missing plan" ? undefined :
        { ...current, projection: { ...current.projection, tasks: [] } });
    }
    wall!.refresh(); await settle(10); send("orphaned draft"); await settle(10);
    expect(h.chatHost.getAttribute("data-open")).toBe("false"); assertNoPost(h);
  });

  it.each(["closed plan", "missing plan", "missing task"] as const)("A4 %s appearing before Send cancels without an explicit refresh", async condition => {
    const f = fixture(); f.open(); f.task(); f.legacy("worker-a");
    const h = await start(f); open("plan:demo:T01"); const send = action("onSend");
    if (condition === "closed plan") {
      // A-U109c: (a) the assignee cancels open work before closing the fixture, M6 / Amendment C.2.
      f.op("demo", { kind: "task.set", task_id: "T01",
        base_rev: f.store.plan("demo")!.projection.tasks[0]!.rev, state: "cancelled" }, "worker-a");
      f.op("demo", { kind: "plan.close", base_rev: f.store.plan("demo")!.projection.plan!.rev, outcome: "Stopped" });
    } else {
      const current = f.store.plan("demo")!;
      vi.spyOn(f.store, "plan").mockReturnValue(condition === "missing plan" ? undefined :
        { ...current, projection: { ...current.projection, tasks: [] } });
    }
    send("obsolete target"); await settle(10);
    assertNoPost(h); expect(h.chatHost.getAttribute("data-open")).toBe("false");
  });

  it.each(["plan:ghost:T01", "plan:demo:T99", "plan:demo:T01:extra", "plan::T01", "plan:demo:",
    "plan:demo:T1", "agent:demo:missing", "", "unknown"])("A4/A6 invalid selection %j closes and guards callbacks", async id => {
    const f = fixture(); f.open(); f.task(); neighbors(f);
    const h = await start(f, DRIFT); open("agent:demo:worker-b");
    expect(h.chatHost.getAttribute("data-open")).toBe("true");
    const send = action("onSend"); const escalate = action("onEscalate");
    open(id); send("invalid target"); escalate(); await settle(10);
    assertNoPost(h); expect(h.chatHost.getAttribute("data-open")).toBe("false");
    assertRecipientActionsDisabled(h);
  });

  it("A4 unavailable plan lookup rejects locally without throwing or posting", async () => {
    const f = fixture(); f.open(); f.task(); neighbors(f);
    const h = await start(f); open("agent:demo:worker-b"); const send = action("onSend");
    vi.spyOn(f.store, "plan").mockImplementation(() => { throw new Error("projection unavailable"); });
    expect(() => open("plan:demo:T01")).not.toThrow(); send("unavailable"); await settle(10);
    assertNoPost(h); expect(h.chatHost.getAttribute("data-open")).toBe("false");
  });
});

describe("A6 hostile text and A7 legacy regression", () => {
  it("A6 task title, history and draft stay literal and never auto-send", async () => {
    const f = fixture(); f.open(); f.task("worker-a", HOSTILE);
    f.event("demo", "worker-a", "answer", HOSTILE);
    const h = await start(f); const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    open("plan:demo:T01"); assertTask(h, "demo", "T01", "worker-a", HOSTILE);
    typeDraft(h.chatHost, HOSTILE);
    expect(element(h.chatHost, ".agent-chat-title").textContent).toBe(HOSTILE);
    expect(element(h.chatHost, ".chat-text").textContent).toBe(HOSTILE);
    expect(element<HTMLTextAreaElement>(h.chatHost, "textarea").value).toBe(HOSTILE);
    expect(h.chatHost.querySelector("img, script, [onerror]")).toBeNull();
    expect(alert).not.toHaveBeenCalled(); assertNoPost(h);
  });

  it("A7 starts closed and remains closed through ordinary refresh", async () => {
    const f = fixture(); f.legacy("gemini-agent", "viewpoint", "Gemini conversation");
    const h = await start(f); expect(h.chatHost.getAttribute("data-open")).toBe("false");
    wall!.refresh(); await settle(10);
    expect(h.chatHost.getAttribute("data-open")).toBe("false"); assertNoPost(h);
  });

  it("A7 legacy Messages routes to gemini-agent and explicit Close survives refresh", async () => {
    const f = fixture(); f.legacy("github-agent", "viewpoint"); f.legacy("gemini-agent", "viewpoint", "Gemini conversation");
    const h = await start(f); clickTask(h, "agent:viewpoint:gemini-agent");
    expect(h.chatHost.getAttribute("data-open")).toBe("true");
    expect(vm()).toMatchObject({ room: "viewpoint", agent: "gemini-agent", title: "Gemini conversation" });
    typeDraft(h.chatHost, "  legacy status?  "); submit(h.chatHost); await settle(10);
    expect(h.post).toHaveBeenCalledExactlyOnceWith({ room: "viewpoint", to: "gemini-agent", text: "legacy status?" });
    element<HTMLButtonElement>(h.chatHost, ".agent-chat-close").click(); wall!.refresh(); await settle(10);
    expect(h.chatHost.getAttribute("data-open")).toBe("false");
  });

  it("A7 step detail still expands without opening the drawer", async () => {
    const f = fixture(); f.legacy("gemini-agent", "viewpoint");
    f.event("viewpoint", "gemini-agent", "step", "Verified", { step: { index: 0, state: "done", outcome: "Verified" } });
    const h = await start(f); const row = element<HTMLButtonElement>(h.wallHost, "button.step-row");
    row.click(); expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(visibleText(h.wallHost)).toContain("Verified");
    expect(h.chatHost.getAttribute("data-open")).toBe("false"); assertNoPost(h);
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
