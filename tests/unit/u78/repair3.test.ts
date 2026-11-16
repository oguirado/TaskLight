import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAgentWall, WALL_REFRESH_MS } from "../../../src/app/agent_wall";
import type { AgentWall } from "../../../src/app/agent_wall";
import type { AgentChatHandlers, AgentChatVM } from "../../../src/agentsui/types";
import { createAgentStore } from "../../../src/app/agent_store";
import { FakeAppClock } from "../u37c/harness";
import { legacyEvents } from "../u61/helpers";
import { setup } from "./helpers";

const handles = vi.hoisted(() => ({
  wallUpdate: vi.fn(), chatUpdate: vi.fn(),
  chatHandlers: undefined as AgentChatHandlers | undefined,
}));
vi.mock("../../../src/views", () => ({
  mountWall: () => ({ update: handles.wallUpdate, destroy: vi.fn() }),
}));
vi.mock("../../../src/agentsui", () => ({
  mountAgentChat: (_host: HTMLElement, _vm: AgentChatVM, handlers: AgentChatHandlers) => {
    handles.chatHandlers = handlers;
    return { update: handles.chatUpdate, destroy: vi.fn() };
  },
}));

setup();
let wall: AgentWall | undefined;
let rejections: unknown[];
const onUnhandled = (reason: unknown): void => { rejections.push(reason); };
beforeEach(() => {
  handles.wallUpdate.mockReset(); handles.chatUpdate.mockReset();
  handles.chatHandlers = undefined;
  rejections = [];
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  wall?.destroy(); wall = undefined;
  process.off("unhandledRejection", onUnhandled);
});

function harness() {
  const store = createAgentStore(); legacyEvents().forEach(e => store.ingest(e));
  const wallHost = document.createElement("div"), chatHost = document.createElement("div");
  document.body.append(wallHost, chatHost);
  const clock = new FakeAppClock();
  const post = vi.fn(async () => ({ ok: true as const, id: "e-0000000000000010", lamport: 16 }));
  const review = vi.fn(async () => undefined);
  wall = startAgentWall({ wallHost, chatHost, store, clock, userAgent: "human",
    link: { post }, reviewer: { review } });
  return { clock, post, review };
}

describe("U78 repair 3 asynchronous render failures", () => {
  it("contains a refresh continuation failure and renders on the next interval", async () => {
    const h = harness();
    handles.wallUpdate.mockImplementationOnce(() => { throw new Error("async refresh render failed"); });
    await nextTurn();
    expect(handles.wallUpdate).toHaveBeenCalledTimes(1);
    expect(rejections).toEqual([]);
    const reviews = h.review.mock.calls.length;
    h.clock.advance(WALL_REFRESH_MS);
    await nextTurn();
    expect(h.review.mock.calls.length).toBeGreaterThan(reviews);
    expect(handles.wallUpdate).toHaveBeenCalledTimes(3);
    expect(handles.chatUpdate).toHaveBeenCalled();
    expect(rejections).toEqual([]);
  });

  it.each(["send", "escalate"] as const)("contains %s settlement failures and clears sending", async action => {
    const h = harness();
    await nextTurn(); // Let the initial review finish before arming the failure.
    handles.chatUpdate.mockClear();
    if (action === "send") handles.chatHandlers!.onSend!("Please check this task");
    else handles.chatHandlers!.onEscalate!();
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(handles.chatUpdate.mock.lastCall?.[0].sending).toBe(true);
    handles.wallUpdate.mockImplementationOnce(() => { throw new Error("settle render failed"); });
    await nextTurn();
    expect(rejections).toEqual([]);
    wall!.refresh();
    expect(handles.chatUpdate.mock.lastCall?.[0].sending).toBe(false);
    await nextTurn();
    expect(rejections).toEqual([]);
  });
});
