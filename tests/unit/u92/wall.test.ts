import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAgentWall, type AgentWall } from "../../../src/app/agent_wall";
import { createAgentLink, LINK_LIMITS, type PostRequest, type PostResult } from "../../../src/app/agent_link";
import { mountAgentChat } from "../../../src/agentsui";
import type { AgentChatHandle, AgentChatVM } from "../../../src/agentsui/types";
import type { RoomEvent } from "../../../src/agents/types";
import type { WallHandlers } from "../../../src/views/types";
import { EXT_ID, FakeAppClock, pageRuntime } from "../u37c/harness";
import { baseVM, deferred, draft, element, fixture, hasDraftSeam, HOSTILE, HOSTILE_CODE, keyboardActivate,
  NOW, RAW, RECEIPT, REQUEST, settle, submit, typeDraft, watchAnnouncements } from "./helpers";
import type { ChatVM, Handlers, Message } from "./helpers";

const observed = vi.hoisted(() => ({
  wallHandlers: undefined as WallHandlers | undefined,
  vm: undefined as ChatVM | undefined,
  handlers: undefined as Handlers | undefined,
  handle: undefined as AgentChatHandle | undefined,
}));
// Recording only: every mount/update goes through the production component.
vi.mock("../../../src/views", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/views")>();
  return { ...real, mountWall: (...args: Parameters<typeof real.mountWall>) => {
    observed.wallHandlers = args[2];
    return real.mountWall(...args);
  } };
});
vi.mock("../../../src/agentsui", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/agentsui")>();
  return { ...real, mountAgentChat: (...args: Parameters<typeof real.mountAgentChat>) => {
    observed.vm = args[1] as ChatVM; observed.handlers = args[2] as Handlers | undefined;
    const handle = real.mountAgentChat(...args);
    const update = handle.update.bind(handle);
    handle.update = (vm: AgentChatVM) => { observed.vm = vm as ChatVM; update(vm); };
    observed.handle = handle;
    return handle;
  } };
});

const probe = mountAgentChat(document.createElement("div"), baseVM());
const S1_AVAILABLE = hasDraftSeam(probe);
probe.destroy();
let wall: AgentWall | undefined;
const cleanups: Array<() => void> = [];
beforeEach(() => {
  observed.vm = undefined; observed.handlers = undefined; observed.handle = undefined; observed.wallHandlers = undefined;
});
afterEach(async () => {
  wall?.destroy(); wall = undefined;
  for (const cleanup of cleanups.splice(0)) cleanup();
  await settle(); vi.restoreAllMocks(); document.body.replaceChildren();
});

async function start(plan = false) {
  const f = fixture();
  if (plan) {
    f.openPlan(); f.task(); f.task("executor-b"); f.task(null);
    f.openPlan("work"); f.task("executor-a", "work");
  }
  // Supported legacy selections isolate U92 from the absent U86 resolver.
  f.legacy("executor-a"); f.legacy("executor-b"); f.legacy("executor-a", "work");
  const journal: RoomEvent[] = [];
  const events = f.store.events.bind(f.store);
  vi.spyOn(f.store, "events").mockImplementation(room => [...events(room), ...journal.filter(e => e.room === room)]);
  const wallHost = document.createElement("div"); const chatHost = document.createElement("div");
  document.body.append(wallHost, chatHost);
  const clock = new FakeAppClock(); clock.t = NOW;
  const pending: Array<ReturnType<typeof deferred<unknown>>> = [];
  const post = vi.fn((_request: PostRequest): Promise<PostResult> => {
    const result = deferred<unknown>(); pending.push(result); return result.promise as Promise<PostResult>;
  });
  wall = startAgentWall({ wallHost, chatHost, store: f.store, clock, userAgent: "wall-user", link: { post },
    reviewer: { review: async () => undefined } });
  await settle();
  const open = (id = plan ? "plan:demo:T01" : "agent:demo:executor-a") => {
    expect(observed.wallHandlers?.onOpenTask).toBeTypeOf("function");
    observed.wallHandlers!.onOpenTask!(id);
  };
  open();
  const resolve = async (value: unknown, index = 0) => {
    expect(pending[index], "a deferred post must exist").toBeDefined(); pending[index]!.resolve(value); await settle();
  };
  const echo = (id = "e-receipt", text = "Explain this", room = "demo") => {
    journal.push({ id, lamport: id === "e-receipt" ? 42 : 43, ts: NOW, room, agent: "wall-user",
      act: "question", to: "executor-a", text });
    wall!.refresh();
  };
  return { ...f, wallHost, chatHost, clock, post, pending, resolve, echo, open };
}
type Rig = Awaited<ReturnType<typeof start>>;
function outgoing(): Message[] { return observed.vm?.messages.filter(m => m.delivery !== undefined) ?? []; }
function local(state: NonNullable<Message["delivery"]>["state"]): Message {
  const all = outgoing(); expect(all, `expected one local message in ${state}`).toHaveLength(1);
  expect(all[0]!.delivery!.state).toBe(state);
  expect(all[0]!.delivery!.client_id).toEqual(expect.any(String)); expect(all[0]!.delivery!.client_id).not.toBe("");
  return all[0]!;
}
function assertUnknown(h: Rig, code: string): void {
  expect(local("unknown").delivery).toMatchObject({ state: "unknown", code });
  const status = element(h.chatHost, ".chat-delivery"); expect(status.textContent).toContain("Delivery unknown");
  expect(status.textContent).not.toMatch(/\bDelivered\b|\bFailed\b/);
  expect(h.chatHost.querySelector("button.chat-retry")).toBeNull(); expect(draft(h.chatHost)).toBe(RAW);
  expect(h.post).toHaveBeenCalledTimes(1);
}
function retryCallback(): (id: string) => void {
  expect(observed.handlers?.onRetry, "M2 controller onRetry callback").toBeTypeOf("function");
  return observed.handlers!.onRetry!;
}
async function send(h: Rig, text = RAW) { typeDraft(h.chatHost, text); submit(h.chatHost); await settle(); }

describe("U92 controller receipts on a supported task selection", () => {
  it("A1 captures the unchanged wire request and creates Sending with an opaque local id before post", async () => {
    const h = await start(); let atPost: Message[] = [];
    const original = h.post.getMockImplementation()!;
    h.post.mockImplementation(req => { atPost = structuredClone(outgoing()); return original(req); });
    await send(h);
    expect(h.post).toHaveBeenCalledExactlyOnceWith(REQUEST);
    expect(atPost).toHaveLength(1); expect(atPost[0]!.delivery).toMatchObject({ state: "sending", client_id: expect.any(String) });
    const id = local("sending").delivery!.client_id;
    expect(element(h.chatHost, "[data-client-id]").dataset.clientId).toBe(id);
    expect(element(h.chatHost, ".chat-delivery").textContent).toContain("Sending");
    expect(draft(h.chatHost)).toBe(RAW);
  });

  it.each(["form", "ctrlKey", "metaKey"] as const)("A1 blocks a trimmed-equal pending re-submit through %s", async via => {
    const h = await start(); await send(h);
    typeDraft(h.chatHost, "Explain this "); submit(h.chatHost, via); submit(h.chatHost, via);
    expect(h.post).toHaveBeenCalledTimes(1); local("sending");
    expect(element<HTMLButtonElement>(h.chatHost, ".chat-send").disabled).toBe(true);
  });

  it("M6 direct repeated Send callbacks cannot bypass the pending-message guard", async () => {
    const h = await start(); await send(h);
    observed.handlers?.onSend?.("Explain this"); observed.handlers?.onSend?.("Explain this");
    expect(h.post).toHaveBeenCalledTimes(1); local("sending");
  });

  it("M6 genuinely edited pending text creates a distinct submission instead of globally locking Send", async () => {
    const h = await start(); await send(h); typeDraft(h.chatHost, "Explain the next step");
    expect(element<HTMLButtonElement>(h.chatHost, ".chat-send").disabled).toBe(false);
    submit(h.chatHost, "ctrlKey"); await settle();
    expect(h.post).toHaveBeenNthCalledWith(2, { ...REQUEST, text: "Explain the next step" });
    const ids = outgoing().map(m => m.delivery!.client_id);
    expect(ids).toHaveLength(2); expect(new Set(ids).size).toBe(2);
    await h.resolve(RECEIPT); expect(draft(h.chatHost)).toBe("Explain the next step");
    await h.resolve({ ...RECEIPT, id: "e-second", lamport: 43 }, 1); expect(draft(h.chatHost)).toBe("");
  });

  it("A2 successful acknowledgement retains both receipt values, keeps its client id and clears only the unchanged draft", async () => {
    const h = await start(); await send(h); const id = local("sending").delivery!.client_id;
    await h.resolve(RECEIPT);
    expect(local("delivered").delivery).toEqual({ client_id: id, state: "delivered", event_id: "e-receipt", lamport: 42 });
    expect(element(h.chatHost, ".chat-delivery").textContent).toContain("Delivered");
    expect(element(h.chatHost, ".chat-delivery").textContent).toContain("e-receipt");
    expect(element(h.chatHost, ".chat-delivery").textContent).toMatch(/\b42\b/); expect(draft(h.chatHost)).toBe("");
  });

  it.each(["new draft", "Explain this "])("A2 success preserves a newer raw composer edit: %j", async edit => {
    const h = await start(); await send(h); typeDraft(h.chatHost, edit); await h.resolve(RECEIPT);
    expect(draft(h.chatHost)).toBe(edit); local("delivered");
  });

  it.each(["bad_request", "timeout"])("M5 %s preserves newer composer edits as well as the captured message text", async code => {
    const h = await start(); await send(h); typeDraft(h.chatHost, "new draft"); await h.resolve({ ok: false, code });
    expect(draft(h.chatHost)).toBe("new draft");
    expect(local(code === "timeout" ? "unknown" : "failed").text).toBe("Explain this");
  });

  it.each([1, 42])("M4 positive integer Lamport %s is accepted and displayed", async lamport => {
    const h = await start(); await send(h); await h.resolve({ ...RECEIPT, lamport });
    expect(local("delivered").delivery).toMatchObject({ event_id: "e-receipt", lamport });
    expect(element(h.chatHost, ".chat-delivery").textContent).toContain(String(lamport));
  });

  it("M4/M7 a nonempty hostile receipt id is accepted as data and rendered literally", async () => {
    const h = await start(); await send(h); await h.resolve({ ...RECEIPT, id: HOSTILE_CODE });
    expect(local("delivered").delivery).toMatchObject({ event_id: HOSTILE_CODE });
    expect(element(h.chatHost, ".chat-delivery").textContent).toContain(HOSTILE_CODE);
    expect(h.chatHost.querySelector("svg, script, [onload]")).toBeNull();
  });

  it.each(["journal-before-receipt", "receipt-before-journal"] as const)("A2 %s reconciles by event id without losing the receipt or merging equal text", async order => {
    const h = await start(); await send(h);
    if (order === "journal-before-receipt") { h.echo(); await settle(); await h.resolve(RECEIPT); }
    else { await h.resolve(RECEIPT); h.echo(); await settle(); }
    expect(local("delivered").delivery).toMatchObject({ event_id: "e-receipt", lamport: 42 });
    expect(h.chatHost.querySelectorAll(".chat-msg")).toHaveLength(1);
    h.echo("e-different"); await settle();
    expect(h.chatHost.querySelectorAll(".chat-msg")).toHaveLength(2);
    wall!.refresh(); await settle(); expect(h.chatHost.querySelectorAll(".chat-msg")).toHaveLength(2);
    expect(outgoing()).toHaveLength(1); expect(element(h.chatHost, ".chat-delivery").textContent).toContain("e-receipt");
  });

  it("A3 a confirmed rejection retains the draft and renders literal failure with Retry", async () => {
    const h = await start(); await send(h); await h.resolve({ ok: false, code: "bad_request" });
    expect(local("failed").delivery).toMatchObject({ code: "bad_request" }); expect(draft(h.chatHost)).toBe(RAW);
    expect(element(h.chatHost, ".chat-delivery").textContent).toContain("Failed");
    expect(element(h.chatHost, ".chat-delivery").textContent).toContain("bad_request");
    expect(element<HTMLButtonElement>(h.chatHost, "button.chat-retry").disabled).toBe(false);
  });

  it("A3 keyboard Retry resends the captured request, keeps one bubble/id and preserves edited text", async () => {
    const h = await start(); await send(h); await h.resolve({ ok: false, code: "bad_request" });
    const id = local("failed").delivery!.client_id; typeDraft(h.chatHost, "new draft");
    keyboardActivate(element<HTMLButtonElement>(h.chatHost, "button.chat-retry")); await settle();
    expect(h.post).toHaveBeenCalledTimes(2); expect(h.post).toHaveBeenNthCalledWith(2, REQUEST);
    expect(local("sending").delivery!.client_id).toBe(id); expect(h.chatHost.querySelectorAll(".chat-msg")).toHaveLength(1);
    await h.resolve(RECEIPT, 1); expect(local("delivered").delivery!.client_id).toBe(id);
    expect(h.chatHost.querySelectorAll(".chat-msg")).toHaveLength(1); expect(draft(h.chatHost)).toBe("new draft");
    expect(h.chatHost.querySelector("button.chat-retry:not(:disabled)")).toBeNull();
  });

  it("M6 synchronous double Retry and unknown client ids cannot issue extra posts", async () => {
    const h = await start(); await send(h); await h.resolve({ ok: false, code: "bad_request" });
    const id = local("failed").delivery!.client_id; const retry = retryCallback();
    retry("not-a-client-id"); expect(h.post).toHaveBeenCalledTimes(1);
    retry(id); retry(id); expect(h.post).toHaveBeenCalledTimes(2); expect(local("sending").delivery!.client_id).toBe(id);
    for (const button of h.chatHost.querySelectorAll<HTMLButtonElement>("button.chat-retry")) expect(button.disabled).toBe(true);
  });

  it("M6 direct Retry for a task that is no longer selected is a no-op", async () => {
    const h = await start(); await send(h); await h.resolve({ ok: false, code: "bad_request" });
    const id = local("failed").delivery!.client_id; const retry = retryCallback();
    h.open("agent:demo:executor-b"); retry(id); expect(h.post).toHaveBeenCalledTimes(1);
    h.open(); expect(local("failed").delivery!.client_id).toBe(id);
  });

  it("A4 times out at LINK_LIMITS.POST_TIMEOUT_MS with unknown delivery, no Retry and no automatic resend", async () => {
    const h = await start(); const runtime = pageRuntime();
    const link = createAgentLink({ extId: EXT_ID, connect: runtime.connect, clock: h.clock, nonce: () => "u92-nonce",
      since: () => ({}), onRoomEvent: () => undefined, onRoomHello: () => undefined });
    cleanups.push(() => link.stop()); link.start();
    runtime.last().emit({ t: "snapshot", v: 1, nonce: "u92-nonce", items: [] }); h.clock.advance(1);
    h.post.mockImplementation(req => link.post(req)); await send(h);
    expect(runtime.last().ofType("room_post")).toHaveLength(1);
    h.clock.advance(LINK_LIMITS.POST_TIMEOUT_MS - 1); await settle(); local("sending");
    h.clock.advance(1); await settle(); assertUnknown(h, "timeout");
    h.clock.advance(LINK_LIMITS.POST_TIMEOUT_MS * 2); await settle(); assertUnknown(h, "timeout");
    expect(runtime.last().ofType("room_post")).toHaveLength(1);
  });

  it("A4 negative control: deliberately mapping timeout to failed is rejected by the same acceptance assertion", async () => {
    const h = await start(); await send(h); await h.resolve({ ok: false, code: "timeout" });
    // Establish the real oracle first: the broken baseline cannot make this control green.
    assertUnknown(h, "timeout");
    const correct = observed.vm!;
    const mutant: ChatVM = { ...correct, messages: correct.messages.map(m => m.delivery?.state === "unknown" ?
      { ...m, delivery: { client_id: m.delivery.client_id, state: "failed" as const, code: "timeout" } } : m) };
    observed.vm = mutant; observed.handle!.update(mutant);
    expect(() => assertUnknown(h, "timeout")).toThrow();
  });

  it.each(["timeout", "stopped", "error"])("A4 %s is unknown, never Failed or Delivered, and never auto-retried", async code => {
    const h = await start(); await send(h); await h.resolve({ ok: false, code });
    assertUnknown(h, code); h.clock.advance(LINK_LIMITS.POST_TIMEOUT_MS * 2); await settle(); assertUnknown(h, code);
    retryCallback()(outgoing()[0]!.delivery!.client_id); expect(h.post).toHaveBeenCalledTimes(1);
  });

  const malformed: Array<[string, unknown]> = [
    ["missing receipt", { ok: true }], ["empty id", { ok: true, id: "", lamport: 1 }],
    ["non-string id", { ok: true, id: 7, lamport: 1 }], ["zero Lamport", { ok: true, id: "e1", lamport: 0 }],
    ["negative Lamport", { ok: true, id: "e1", lamport: -1 }], ["fractional Lamport", { ok: true, id: "e1", lamport: 1.5 }],
    ["string Lamport", { ok: true, id: "e1", lamport: "42" }], ["NaN Lamport", { ok: true, id: "e1", lamport: NaN }],
    ["infinite Lamport", { ok: true, id: "e1", lamport: Infinity }], ["missing code", { ok: false }],
    ["empty code", { ok: false, code: "" }], ["non-string code", { ok: false, code: 7 }],
    ["non-boolean ok", { ok: "true", id: "e1", lamport: 1 }], ["null", null], ["undefined", undefined],
  ];
  it.each(malformed)("A4 malformed result (%s) becomes unknown with unexpected_result", async (_name, result) => {
    const h = await start(); await send(h); await h.resolve(result); assertUnknown(h, "unexpected_result");
  });

  it.each(["throw", "reject"] as const)("A4 a post that %ss becomes unknown with unexpected_result", async failure => {
    const h = await start(); h.post.mockImplementation(() => {
      if (failure === "throw") throw new Error("broken link");
      return Promise.reject(new Error("broken link"));
    });
    await send(h); assertUnknown(h, "unexpected_result");
  });

  it.each([RECEIPT, { ok: false, code: "bad_request" }, { ok: false, code: "timeout" }])(
    "A5 late settlement %j leaves another task's draft/status alone and restores the originating record", async result => {
      const h = await start(); await send(h); h.open("agent:demo:executor-b"); typeDraft(h.chatHost, "new draft");
      const before = structuredClone(observed.vm); await h.resolve(result);
      expect(draft(h.chatHost)).toBe("new draft"); expect(observed.vm).toEqual(before);
      h.open();
      local(result.ok ? "delivered" : result.code === "timeout" ? "unknown" : "failed");
      expect(draft(h.chatHost)).toBe(result.ok ? "" : RAW);
    });

  it("A5 switching rooms while sending isolates drafts and outgoing records", async () => {
    const h = await start(); await send(h); h.open("agent:work:executor-a"); typeDraft(h.chatHost, "work draft");
    await h.resolve(RECEIPT); expect(draft(h.chatHost)).toBe("work draft"); expect(outgoing()).toHaveLength(0);
    h.open(); local("delivered"); expect(element(h.chatHost, ".chat-delivery").textContent).toContain("e-receipt");
  });

  it.each(["sending", "failed", "unknown", "delivered"] as const)("A5 close/reopen restores %s and its draft without resending", async state => {
    const h = await start(); await send(h);
    if (state !== "sending") await h.resolve(state === "delivered" ? RECEIPT : { ok: false, code: state === "failed" ? "bad_request" : "timeout" });
    const id = local(state).delivery!.client_id;
    element<HTMLButtonElement>(h.chatHost, ".agent-chat-close").click(); expect(h.chatHost.dataset.open).toBe("false");
    h.open(); expect(h.chatHost.dataset.open).toBe("true"); expect(local(state).delivery!.client_id).toBe(id);
    expect(draft(h.chatHost)).toBe(state === "delivered" ? "" : RAW); expect(h.post).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "rejection", "throw"] as const)("A5 destroyed wall ignores late %s without DOM mutations or exceptions", async outcome => {
    const h = await start(); await send(h); wall!.destroy();
    const updates: MutationRecord[] = []; const observer = new MutationObserver(records => updates.push(...records));
    observer.observe(h.chatHost, { subtree: true, childList: true, attributes: true, characterData: true });
    try {
      if (outcome === "throw") h.pending[0]!.reject(new Error("late rejection"));
      else h.pending[0]!.resolve(outcome === "success" ? RECEIPT : { ok: false, code: "bad_request" });
      await settle(); expect(updates).toEqual([]); expect(h.chatHost.childNodes).toHaveLength(0);
    } finally { observer.disconnect(); }
  });

  it("A6 hostile draft and returned error remain literal end to end", async () => {
    const h = await start(); await send(h, HOSTILE); await h.resolve({ ok: false, code: HOSTILE_CODE });
    expect(h.post).toHaveBeenCalledExactlyOnceWith({ ...REQUEST, text: HOSTILE });
    expect(element(h.chatHost, ".chat-text").textContent).toBe(HOSTILE);
    expect(element(h.chatHost, ".chat-delivery").textContent).toContain(HOSTILE_CODE);
    expect(h.chatHost.querySelector("img, svg, script, [onerror], [onload]")).toBeNull(); expect(draft(h.chatHost)).toBe(HOSTILE);
  });

  it("M7 restoring records on task switch and drawer reopen emits no delivery announcements", async () => {
    const h = await start(); await send(h); await h.resolve(RECEIPT); local("delivered");
    h.open("agent:demo:executor-b"); await settle(); const live = watchAnnouncements(h.chatHost);
    try {
      h.open(); await settle(); expect(live.take()).toEqual([]); local("delivered");
      element<HTMLButtonElement>(h.chatHost, ".agent-chat-close").click(); await settle(); live.take();
      h.open(); await settle(); expect(live.take()).toEqual([]);
    } finally { live.disconnect(); }
  });
});

describe.skipIf(!S1_AVAILABLE)("U86-dependent plan integration (out of scope while prerequisite is absent)", () => {
  it("A1 exact plan:demo:T01 selection sends only to its assignee and retains its draft", async () => {
    const h = await start(true); await send(h); expect(h.post).toHaveBeenCalledExactlyOnceWith(REQUEST);
    local("sending"); expect(draft(h.chatHost)).toBe(RAW);
  });

  it("A5 unassigned task stays Executor unassigned and cannot fall back to a neighboring agent", async () => {
    const h = await start(true); h.open("plan:demo:T03");
    expect(h.chatHost.textContent).toContain("Executor unassigned");
    typeDraft(h.chatHost, RAW); submit(h.chatHost, "ctrlKey"); observed.handlers?.onSend?.("Explain this");
    expect(h.post).not.toHaveBeenCalled();
  });

  it.each(["reassigned", "unassigned"] as const)("A3 %s task disables Retry, explains the mismatch and guards direct callback invocation", async change => {
    const h = await start(true); await send(h); await h.resolve({ ok: false, code: "bad_request" });
    const id = local("failed").delivery!.client_id; const retry = retryCallback();
    const before = element(h.chatHost, ".chat-delivery").textContent;
    if (change === "reassigned") { h.op("demo", { kind: "task.release", task_id: "T01" }, "executor-a"); h.op("demo", { kind: "task.claim", task_id: "T01" }, "executor-b"); } // A-U92a: takeover needs a stale claim
    else h.op("demo", { kind: "task.release", task_id: "T01" }, "executor-a");
    // The controller guard must work before a refresh or a disabled DOM button.
    retry(id); expect(h.post).toHaveBeenCalledTimes(1); wall!.refresh(); await settle();
    const button = h.chatHost.querySelector<HTMLButtonElement>("button.chat-retry");
    if (button) expect(button.disabled).toBe(true);
    const status = element(h.chatHost, ".chat-delivery"); expect(status.textContent).toContain("Failed");
    expect(status.textContent, "mismatch must add a visible explanation").not.toBe(before);
    expect(status.textContent!.replace(/Failed|bad_request|Retry/g, "").replace(/[^a-z]/gi, ""), "visible mismatch reason").not.toBe("");
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it("A5 task-scoped records remain separate for tasks sharing the same assignee", async () => {
    const h = await start(true); h.task("executor-a"); await send(h);
    h.open("plan:demo:T04"); typeDraft(h.chatHost, "new draft"); await h.resolve(RECEIPT);
    expect(draft(h.chatHost)).toBe("new draft"); expect(outgoing()).toHaveLength(0);
    h.open(); local("delivered");
  });

  it("A5 plan selection and captured recipient survive room changes before settlement", async () => {
    const h = await start(true); await send(h); h.open("plan:work:T01"); typeDraft(h.chatHost, "new draft");
    await h.resolve(RECEIPT); expect(draft(h.chatHost)).toBe("new draft"); expect(outgoing()).toHaveLength(0);
    expect(h.post).toHaveBeenCalledExactlyOnceWith(REQUEST); h.open(); local("delivered");
  });

  it("A2/A7 replacing via setDraft protects even a raw-equal draft from acknowledgement clearing", async () => {
    const h = await start(true); await send(h);
    expect(observed.handle && hasDraftSeam(observed.handle)).toBe(true);
    if (!observed.handle || !hasDraftSeam(observed.handle)) return;
    observed.handle.setDraft(RAW); await h.resolve(RECEIPT);
    expect(observed.handle.getDraft()).toBe(RAW); expect(h.post).toHaveBeenCalledTimes(1); local("delivered");
  });
});
