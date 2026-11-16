import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAgentWall, type AgentWall } from "../../../src/app/agent_wall";
import { createAgentStore, type AgentStore } from "../../../src/app/agent_store";
import type { AgentChatHandlers, AgentChatVM } from "../../../src/agentsui/types";
import type { DriftVerdict } from "../../../src/agents/types";
import type { WallHandlers } from "../../../src/views/types";
import { FakeAppClock, settle } from "../u37c/harness";
import { element, fixture, NOW, submit, typeDraft, visibleText } from "./helpers";

const observed = vi.hoisted(() => ({
  wallHandlers: undefined as WallHandlers | undefined,
  chatHandlers: undefined as AgentChatHandlers | undefined,
  chatVm: undefined as AgentChatVM | undefined,
}));

// Observe controller seams while preserving the real mounted DOM and handlers.
vi.mock("../../../src/views", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/views")>();
  return { ...real, mountWall: (...args: Parameters<typeof real.mountWall>) => {
    observed.wallHandlers = args[2];
    return real.mountWall(...args);
  } };
});
vi.mock("../../../src/agentsui", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/agentsui")>();
  return { ...real, mountAgentChat: (...args: Parameters<typeof real.mountAgentChat>) => {
    observed.chatVm = args[1];
    observed.chatHandlers = args[2];
    const handle = real.mountAgentChat(...args);
    const update = handle.update.bind(handle);
    vi.spyOn(handle, "update").mockImplementation((vm: AgentChatVM) => {
      observed.chatVm = vm;
      update(vm);
    });
    return handle;
  } };
});

let wall: AgentWall | undefined;
beforeEach(() => {
  observed.wallHandlers = undefined;
  observed.chatHandlers = undefined;
  observed.chatVm = undefined;
});
afterEach(async () => {
  wall?.destroy();
  wall = undefined;
  await settle(10);
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const DRIFT: DriftVerdict = { verdict: "drift", source: "rules", reason: "Legacy plan changed" };
type Request = { room: string; to: string; text: string };
const receipt = { ok: true as const, id: "e-000000000000ffff", lamport: 65535 };
async function start(store: AgentStore, pending?: Promise<typeof receipt>) {
  const wallHost = document.createElement("div");
  const chatHost = document.createElement("div");
  document.body.append(wallHost, chatHost);
  const clock = new FakeAppClock();
  clock.t = NOW;
  const post = vi.fn((_request: Request) => pending ?? Promise.resolve(receipt));
  wall = startAgentWall({ wallHost, chatHost, store, clock, userAgent: "wall-user", link: { post },
    reviewer: { review: async () => DRIFT } });
  await settle(10);
  return { chatHost, post };
}
function open(id: string): void {
  expect(observed.wallHandlers?.onOpenTask).toBeTypeOf("function");
  observed.wallHandlers!.onOpenTask!(id);
}
function assertCleared(chatHost: HTMLElement): void {
  expect(chatHost.getAttribute("data-open")).toBe("false");
  expect(observed.chatVm).toMatchObject({ room: "", agent: "", title: "", messages: [], sending: false });
  expect(observed.chatVm?.task).toBeUndefined();
  expect(observed.chatVm?.drift).toBeUndefined();
  expect(observed.chatVm?.suggestNotice).toBeUndefined();
  expect(element<HTMLTextAreaElement>(chatHost, "textarea").value).toBe("");
  expect(element<HTMLButtonElement>(chatHost, ".chat-suggest").disabled).toBe(true);
  typeDraft(chatHost, "stale recipient");
  expect(element<HTMLButtonElement>(chatHost, ".chat-send").disabled).toBe(true);
  submit(chatHost);
}

describe("U86 repair: selection transitions", () => {
  // A-U86b: after U85 (M1) the store keeps complete history and states() never evicts an agent,
  // so this eviction precondition can no longer occur. The guard stays in agent_wall.ts.
  it.skip.each(["form", "onSend", "onEscalate", "onSuggest", "onAcceptDrift", "refresh"] as const)(
    "invalidates an evicted legacy selection before %s without selecting its replacement", async entry => {
      const f = fixture();
      const store = createAgentStore({ maxPerRoom: 1 });
      const legacy = (agent: string) => {
        const ev = f.event("demo", agent, "plan", `${agent} plan`, {
          plan: { title: `${agent} plan`, steps: [{ text: "Inspect export" }] },
        });
        expect(store.ingest(ev)).toBe(true);
      };
      legacy("worker-a");
      const h = await start(store);
      expect(h.chatHost.getAttribute("data-open")).toBe("false");
      expect(observed.chatVm?.agent).toBe("worker-a");
      open("agent:demo:worker-a");
      expect(h.chatHost.getAttribute("data-open")).toBe("true");
      typeDraft(h.chatHost, "draft for worker-a");
      observed.chatHandlers!.onSuggest!();
      const callbacks = observed.chatHandlers!;
      legacy("worker-b");
      expect(store.states().map(s => s.agent)).toEqual(["worker-b"]);
      // No refresh between real retention eviction and the recipient action.
      if (entry === "form") submit(h.chatHost);
      else if (entry === "onSend") callbacks.onSend!("draft for worker-a");
      else if (entry === "refresh") wall!.refresh();
      else callbacks[entry]!();
      await settle(10);
      expect(h.post, "eviction must never reroute the previous draft or escalation").not.toHaveBeenCalled();
      assertCleared(h.chatHost);
      callbacks.onSend!("retained callback");
      callbacks.onEscalate!();
      callbacks.onSuggest!();
      callbacks.onAcceptDrift!();
      wall!.refresh();
      await settle(10);
      expect(h.chatHost.getAttribute("data-open")).toBe("false");
      expect(h.post).not.toHaveBeenCalled();
      // A new explicit selection can recover after rejection.
      open("agent:demo:worker-b");
      typeDraft(h.chatHost, "new recipient");
      submit(h.chatHost);
      await settle(10);
      expect(h.post).toHaveBeenCalledExactlyOnceWith({ room: "demo", to: "worker-b", text: "new recipient" });
    },
  );

  it("restores usable drift acceptance after visiting an unassigned task", async () => {
    const f = fixture();
    f.open(); f.task(null); f.legacy("worker-a");
    const h = await start(f.store);
    open("agent:demo:worker-a");
    const accept = element<HTMLButtonElement>(h.chatHost, ".chat-accept-drift");
    expect(accept.disabled).toBe(false);
    open("plan:demo:T01");
    expect(visibleText(h.chatHost)).toContain("Executor unassigned");
    expect(accept.disabled).toBe(true);
    open("agent:demo:worker-a");
    expect(observed.chatVm?.drift).toMatchObject(DRIFT);
    const restored = element<HTMLButtonElement>(h.chatHost, ".chat-accept-drift");
    expect(restored.disabled).toBe(false);
    restored.click();
    expect(observed.chatVm?.drift).toBeUndefined();
    expect(h.chatHost.querySelector(".chat-accept-drift")).toBeNull();
    wall!.refresh(); await settle(10);
    expect(observed.chatVm?.drift).toBeUndefined();
    expect(h.post).not.toHaveBeenCalled();
  });

  it("keeps an unassigned task idle while another task's post is pending", async () => {
    const f = fixture();
    f.open(); f.task(); f.task(null, "Unassigned export");
    let complete!: (value: typeof receipt) => void;
    const pending = new Promise<typeof receipt>(resolve => { complete = resolve; });
    const h = await start(f.store, pending);
    try {
      open("plan:demo:T01");
      typeDraft(h.chatHost, "status?"); submit(h.chatHost);
      expect(h.post).toHaveBeenCalledExactlyOnceWith({ room: "demo", to: "worker-a", text: "status?" });
      expect(observed.chatVm?.sending).toBe(true);
      open("plan:demo:T02");
      expect(observed.chatVm).toMatchObject({
        room: "demo", agent: "", title: "Unassigned export", messages: [], silent: false, sending: false,
        task: { id: "T02", assignee: null },
      });
      expect(visibleText(h.chatHost)).toContain("Executor unassigned");
      wall!.refresh(); await settle(10);
      expect(observed.chatVm?.sending).toBe(false);
      typeDraft(h.chatHost, "must remain unsent");
      expect(element<HTMLButtonElement>(h.chatHost, ".chat-send").disabled).toBe(true);
      submit(h.chatHost); observed.chatHandlers!.onSend!("synthetic submission");
      expect(h.post).toHaveBeenCalledTimes(1);
      open("plan:demo:T01");
      expect(observed.chatVm?.sending).toBe(true);
      open("plan:demo:T02");
    } finally {
      complete(receipt);
      await settle(10);
    }
    expect(observed.chatVm?.sending).toBe(false);
    expect(h.post).toHaveBeenCalledTimes(1);
  });
});
