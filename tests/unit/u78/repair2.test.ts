import { describe, expect, it, vi } from "vitest";
import { startAgentWall } from "../../../src/app/agent_wall";
import { createAgentStore } from "../../../src/app/agent_store";
import { FakeAppClock } from "../u37c/harness";
import { legacyEvents } from "../u61/helpers";
import { setup } from "./helpers";

const handles = vi.hoisted(() => ({ wallDestroy: vi.fn(), chatDestroy: vi.fn() }));
vi.mock("../../../src/views", () => ({
  mountWall: () => ({ update: vi.fn(), destroy: handles.wallDestroy }),
}));
vi.mock("../../../src/agentsui", () => ({
  mountAgentChat: () => ({ update: vi.fn(), destroy: handles.chatDestroy }),
}));

setup();
function harness() {
  handles.wallDestroy.mockReset(); handles.chatDestroy.mockReset();
  const store = createAgentStore(); legacyEvents().forEach(e => store.ingest(e));
  const wallHost = document.createElement("div"), chatHost = document.createElement("div");
  document.body.append(wallHost, chatHost);
  const clock = new FakeAppClock();
  const deps = { wallHost, chatHost, store, clock, userAgent: "human",
    modelStatus: () => undefined,
    link: { post: vi.fn(async () => ({ ok: true as const, id: "e-0000000000000010", lamport: 16 })) },
    reviewer: { review: async () => undefined } };
  return { clock, chatHost, deps };
}

describe("U78 repair 2 throwing clock ports", () => {
  it("rolls back the registered interval when model timeout registration throws", () => {
    const h = harness(); const failure = new Error("timeout registration failed");
    const cancel = vi.spyOn(h.clock, "clearInterval");
    vi.spyOn(h.clock, "setTimeout").mockImplementation(() => { throw failure; });
    expect(() => startAgentWall(h.deps)).toThrow(failure);
    expect(h.clock.pending()).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("tears down both handles and the timeout despite interval cancellation throwing", () => {
    const h = harness(); const wall = startAgentWall(h.deps);
    expect(h.clock.pending()).toBe(2);
    const clearTimeout = vi.spyOn(h.clock, "clearTimeout");
    const failure = new Error("interval cancellation failed");
    const clearInterval = vi.spyOn(h.clock, "clearInterval").mockImplementation(() => { throw failure; });
    // A teardown error may be surfaced only after all resources have been attempted.
    try { wall.destroy(); } catch (error) { expect(error).toBe(failure); }
    expect(handles.wallDestroy).toHaveBeenCalledTimes(1);
    expect(handles.chatDestroy).toHaveBeenCalledTimes(1);
    expect(clearTimeout).toHaveBeenCalledTimes(1);
    expect(h.clock.pending()).toBe(1); // The throwing port refused to cancel its interval.
    expect(h.chatHost.classList.contains("chat-drawer")).toBe(false);
    for (const attr of ["data-open", "role", "aria-label"]) expect(h.chatHost.hasAttribute(attr)).toBe(false);
    expect(() => wall.destroy()).not.toThrow();
    expect(clearInterval).toHaveBeenCalledTimes(1);
    expect(clearTimeout).toHaveBeenCalledTimes(1);
    expect(handles.wallDestroy).toHaveBeenCalledTimes(1);
    expect(handles.chatDestroy).toHaveBeenCalledTimes(1);
  });
});
