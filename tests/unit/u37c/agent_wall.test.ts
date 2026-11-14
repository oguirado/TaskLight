// U37c oracle: src/app/agent_wall.ts startAgentWall (SPEC_U37 "U37c"). Views/chat/VM builders are module-mocked
// (U35/U36 are covered by their own suites, U37b is being implemented in parallel); store/reviewer/link are fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState, DriftVerdict } from "../../../src/agents/types";
import type { AgentChatHandlers, AgentChatVM } from "../../../src/agentsui/types";
import type { WallHandlers, WallVM } from "../../../src/views/types";
import { startAgentWall, type AgentWall } from "../../../src/app/agent_wall";
import { FakeAppClock, idOf, settle } from "./harness";

const H = vi.hoisted(() => ({
  wallHandle: { update: vi.fn(), destroy: vi.fn() },
  chatHandle: { update: vi.fn(), destroy: vi.fn() },
  mountWall: vi.fn(),
  mountAgentChat: vi.fn(),
  toWallVM: vi.fn(),
  toChatVM: vi.fn(),
}));
vi.mock("../../../src/views", () => ({ mountWall: H.mountWall }));
vi.mock("../../../src/agentsui", () => ({ mountAgentChat: H.mountAgentChat }));
vi.mock("../../../src/app/agent_store", () => ({ toWallVM: H.toWallVM, toChatVM: H.toChatVM, createAgentStore: () => { throw new Error("not used"); } }));

const NOW0 = 1_700_000_000_000;
const state = (room: string, agent: string): AgentState => ({
  room, agent, contract: { title: `${agent} plan`, steps: [{ text: "s1" }], hash: `h-${agent}`, version: 1, lamport: 2 },
  stepStates: ["active"], outcomes: [undefined], took: [undefined], lastSeen: NOW0, openQuestions: [], closed: false,
});
const DRIFT: DriftVerdict = { verdict: "drift", reason: "step 1 edited", source: "rules" };
const OK: DriftVerdict = { verdict: "on_track", reason: "same", source: "rules" };

let clock: FakeAppClock; let states: AgentState[]; let wallHost: HTMLElement; let chatHost: HTMLElement; let wall: AgentWall | undefined;
let post: ReturnType<typeof vi.fn>; let review: ReturnType<typeof vi.fn>;
let wallHandlers: WallHandlers; let chatHandlers: AgentChatHandlers;

const wallVm = (): WallVM => ({ now: "", model: { state: "unavailable", label: "" }, network: "online", workspaces: [], workspace: "", view: "wall", archiveScope: "workspace", tasks: [], agenda: [], archive: [] });
beforeEach(() => {
  clock = new FakeAppClock(); clock.t = NOW0;
  states = [state("demo", "wall-user"), state("demo", "worker-1"), state("demo", "worker-2")];
  wallHost = document.createElement("div"); chatHost = document.createElement("div"); document.body.append(wallHost, chatHost);
  for (const f of [H.wallHandle.update, H.wallHandle.destroy, H.chatHandle.update, H.chatHandle.destroy, H.mountWall, H.mountAgentChat, H.toWallVM, H.toChatVM]) f.mockReset();
  H.mountWall.mockImplementation((_h: HTMLElement, _v: WallVM, h?: WallHandlers) => { wallHandlers = h ?? {}; return H.wallHandle; });
  H.mountAgentChat.mockImplementation((_h: HTMLElement, _v: AgentChatVM, h?: AgentChatHandlers) => { chatHandlers = h ?? {}; return H.chatHandle; });
  H.toWallVM.mockImplementation(() => wallVm());
  H.toChatVM.mockImplementation((s: AgentState, _e: unknown, o: { sending: boolean; drift?: DriftVerdict }): AgentChatVM => ({
    room: s.room, agent: s.agent, title: s.agent, messages: [], silent: false, sending: o.sending,
    ...(o.drift ? { drift: { verdict: o.drift.verdict, reason: o.drift.reason, added: [], removed: [], source: o.drift.source } } : {}),
  }));
  post = vi.fn(async () => ({ ok: true as const, id: idOf(1), lamport: 1 }));
  review = vi.fn(async (s: AgentState) => (s.agent === "worker-1" ? DRIFT : OK));
  wall = undefined;
});
afterEach(() => { wall?.destroy(); document.body.innerHTML = ""; });

function start(over: Record<string, unknown> = {}): AgentWall {
  const store = { ingest: vi.fn(() => true), ingestJsonl: vi.fn(), since: () => ({}), states: () => states, events: () => [] };
  wall = startAgentWall({ wallHost, chatHost, link: { post }, store, reviewer: { review }, clock, userAgent: "wall-user", ...over } as Parameters<typeof startAgentWall>[0]);
  return wall;
}
const lastChatOpts = () => H.toChatVM.mock.calls.at(-1)![2] as { userAgent: string; nowMs: number; drift?: DriftVerdict; sending: boolean };
const lastWallArgs = () => H.toWallVM.mock.calls.at(-1)! as [AgentState[], ReadonlyMap<string, DriftVerdict>, { nowMs: number }];

describe("mounting", () => {
  it("mounts U36 mountWall into wallHost and U35 mountAgentChat into chatHost", async () => {
    start(); await settle(10);
    expect(H.mountWall).toHaveBeenCalledTimes(1);
    expect(H.mountWall.mock.calls[0]![0]).toBe(wallHost);
    expect(H.mountAgentChat).toHaveBeenCalledTimes(1);
    expect(H.mountAgentChat.mock.calls[0]![0]).toBe(chatHost);
  });
  it("the wall VM is built from ALL store states + the reviewer verdicts keyed by task id agent:<room>:<agent>, nowMs = clock.now()", async () => {
    start(); await settle(10);
    const [st, verdicts, opts] = lastWallArgs();
    expect(st.map((s) => s.agent)).toEqual(["wall-user", "worker-1", "worker-2"]);
    expect(verdicts.get("agent:demo:worker-1")).toEqual(DRIFT);
    expect(verdicts.get("agent:demo:worker-2")).toEqual(OK);
    expect(opts.nowMs).toBe(NOW0);
    expect(H.wallHandle.update).toHaveBeenCalled(); // verdicts arrived asynchronously -> update
  });
  it("the chat targets the first agent that is not the user's own identity, with userAgent, nowMs, sending:false and its drift verdict", async () => {
    start(); await settle(10);
    expect((H.toChatVM.mock.calls[0]![0] as AgentState).agent).toBe("worker-1");
    expect(H.toChatVM.mock.calls.every((c) => (c[0] as AgentState).agent === "worker-1")).toBe(true);
    expect(lastChatOpts()).toMatchObject({ userAgent: "wall-user", nowMs: NOW0, sending: false, drift: DRIFT });
    expect(H.chatHandle.update).toHaveBeenCalled();
  });
  it("the reviewer is asked about the agents' states (worker-1 and worker-2 at least)", async () => {
    start(); await settle(10);
    const asked = new Set(review.mock.calls.map((c) => (c[0] as AgentState).agent));
    expect(asked.has("worker-1")).toBe(true); expect(asked.has("worker-2")).toBe(true);
  });
  it("empty store: the wall still renders; the chat mounts when the first agent state appears (via refresh)", async () => {
    states = [];
    const w = start(); await settle(10);
    expect(H.mountWall).toHaveBeenCalledTimes(1);
    expect(H.mountAgentChat).not.toHaveBeenCalled();
    states = [state("demo", "worker-1")];
    w.refresh(); await settle(10);
    expect(H.mountAgentChat).toHaveBeenCalledTimes(1);
    expect(H.mountAgentChat.mock.calls[0]![0]).toBe(chatHost);
  });
  it("a reviewer that rejects does not block rendering (no verdict -> no map entry)", async () => {
    review.mockImplementation(() => Promise.reject(new Error("model down")));
    start(); await settle(10);
    expect(H.mountWall).toHaveBeenCalledTimes(1);
    expect(lastWallArgs()[1].size).toBe(0);
    expect(lastChatOpts().drift).toBeUndefined();
  });
});

describe("chat handlers", () => {
  it("onSend posts a question to the chat's agent in its room (to = agent)", async () => {
    start(); await settle(10);
    chatHandlers.onSend?.("how is step 2 going?");
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toMatchObject({ room: "demo", to: "worker-1", text: "how is step 2 going?" });
  });
  it("`sending` is true to toChatVM while the post is in flight and false afterwards (also after a failure); never throws", async () => {
    let release: (v: unknown) => void = () => undefined;
    post.mockImplementation(() => new Promise((r) => { release = r; }));
    start(); await settle(10);
    chatHandlers.onSend?.("q1");
    await settle(4);
    expect(lastChatOpts().sending).toBe(true);
    release({ ok: false, code: "timeout" }); await settle(10);
    expect(lastChatOpts().sending).toBe(false);
  });
  it("a post that resolves ok:false or rejects leaves the wall running", async () => {
    post.mockRejectedValueOnce(new Error("link exploded"));
    start(); await settle(10);
    expect(() => { chatHandlers.onSend?.("q"); }).not.toThrow();
    await settle(10);
    post.mockResolvedValueOnce({ ok: false, code: "host_unavailable" });
    chatHandlers.onSend?.("q2"); await settle(10);
    expect(lastChatOpts().sending).toBe(false);
  });
  it("onEscalate posts a question to the orchestrator (default id `orchestrator`) in the chat's room; text non-empty and <= 4096 bytes", async () => {
    start(); await settle(10);
    chatHandlers.onEscalate?.();
    expect(post).toHaveBeenCalledTimes(1);
    const req = post.mock.calls[0]![0] as { room: string; to: string; text: string };
    expect(req).toMatchObject({ room: "demo", to: "orchestrator" });
    expect(req.text.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(req.text).length).toBeLessThanOrEqual(4096);
  });
  it("onEscalate honours a configured orchestrator (string or getter); a getter returning undefined falls back to `orchestrator`", async () => {
    start({ orchestrator: "orch-1" }); await settle(10);
    chatHandlers.onEscalate?.();
    expect(post.mock.calls[0]![0]).toMatchObject({ to: "orch-1" });
    wall!.destroy(); post.mockClear();
    start({ orchestrator: () => "orch-2" }); await settle(10);
    chatHandlers.onEscalate?.();
    expect(post.mock.calls[0]![0]).toMatchObject({ to: "orch-2" });
    wall!.destroy(); post.mockClear();
    start({ orchestrator: () => undefined }); await settle(10);
    chatHandlers.onEscalate?.();
    expect(post.mock.calls[0]![0]).toMatchObject({ to: "orchestrator" });
  });
  it("onAcceptDrift is local only: no post, the chat is re-rendered without the drift banner", async () => {
    start(); await settle(10);
    expect(lastChatOpts().drift).toEqual(DRIFT);
    const updates = H.chatHandle.update.mock.calls.length;
    chatHandlers.onAcceptDrift?.(); await settle(10);
    expect(post).not.toHaveBeenCalled();
    expect(H.chatHandle.update.mock.calls.length).toBeGreaterThan(updates);
    expect(lastChatOpts().drift).toBeUndefined();
    expect((H.chatHandle.update.mock.calls.at(-1)![0] as AgentChatVM).drift).toBeUndefined();
  });
});

describe("silence refresh every 30 s", () => {
  it("re-renders with a fresh nowMs at 30 s (not at 29.999 s), reviews the states again (memoised by the reviewer, J8), and repeats", async () => {
    start(); await settle(10);
    const calls = H.toWallVM.mock.calls.length; const reviews = review.mock.calls.length;
    clock.advance(29_999); await settle(10);
    expect(H.toWallVM.mock.calls.length).toBe(calls);
    clock.advance(1); await settle(10);
    expect(H.toWallVM.mock.calls.length).toBeGreaterThan(calls);
    expect(lastWallArgs()[2].nowMs).toBe(NOW0 + 30_000);
    expect(lastChatOpts().nowMs).toBe(NOW0 + 30_000);
    expect(review.mock.calls.length).toBeGreaterThanOrEqual(reviews + 2);
    clock.advance(30_000); await settle(10);
    expect(lastWallArgs()[2].nowMs).toBe(NOW0 + 60_000);
    expect(H.wallHandle.update).toHaveBeenCalled();
  });
  it("refresh() re-reads the store immediately", async () => {
    const w = start(); await settle(10);
    states = [...states, state("demo", "worker-3")];
    w.refresh(); await settle(10);
    expect(lastWallArgs()[0].map((s) => s.agent)).toContain("worker-3");
  });
});

describe("destroy()", () => {
  it("destroys both views once, clears every timer, is idempotent", async () => {
    const w = start(); await settle(10);
    expect(clock.pending()).toBeGreaterThan(0);
    w.destroy(); w.destroy();
    expect(H.wallHandle.destroy).toHaveBeenCalledTimes(1);
    expect(H.chatHandle.destroy).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(0);
  });
  it("after destroy nothing renders: time passing, late reviews, late post results, refresh()", async () => {
    let releaseReview: (v: DriftVerdict) => void = () => undefined;
    review.mockImplementation(() => new Promise<DriftVerdict>((r) => { releaseReview = r; }));
    let releasePost: (v: unknown) => void = () => undefined;
    post.mockImplementation(() => new Promise((r) => { releasePost = r; }));
    const w = start(); await settle(10);
    chatHandlers.onSend?.("pending"); await settle(4);
    const wallCalls = H.toWallVM.mock.calls.length; const chatCalls = H.toChatVM.mock.calls.length;
    const wu = H.wallHandle.update.mock.calls.length; const cu = H.chatHandle.update.mock.calls.length;
    w.destroy();
    clock.advance(120_000); releaseReview(DRIFT); releasePost({ ok: true, id: idOf(2), lamport: 2 }); w.refresh();
    await settle(10);
    expect(H.toWallVM.mock.calls.length).toBe(wallCalls);
    expect(H.toChatVM.mock.calls.length).toBe(chatCalls);
    expect(H.wallHandle.update.mock.calls.length).toBe(wu);
    expect(H.chatHandle.update.mock.calls.length).toBe(cu);
    expect(clock.pending()).toBe(0);
  });
  it("destroy() before the chat ever mounted (empty store) still destroys the wall and clears timers", async () => {
    states = [];
    const w = start(); await settle(10);
    w.destroy();
    expect(H.wallHandle.destroy).toHaveBeenCalledTimes(1);
    expect(H.chatHandle.destroy).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });
});
