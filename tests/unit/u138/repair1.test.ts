import { describe, expect, it, vi } from "vitest";
import { startAgentWall } from "../../../src/app/agent_wall";
import {
  chipHeader, cleanup, clock, deterministic, event, flush, frozenPlan,
  roomFixture, selected, strip, taskCard, visibleText,
} from "./helpers";

deterministic();

function fixture() {
  const f = roomFixture();
  f.rooms.set("demo", frozenPlan());
  f.history.splice(0, f.history.length, event(1));
  const wallHost = document.createElement("div"), chatHost = document.createElement("div");
  document.body.append(wallHost, chatHost);
  const addDocument = vi.spyOn(document, "addEventListener");
  const removeDocument = vi.spyOn(document, "removeEventListener");
  const addHost = vi.spyOn(wallHost, "addEventListener");
  const removeHost = vi.spyOn(wallHost, "removeEventListener");
  const events = vi.spyOn(f.store, "events");
  const states = vi.spyOn(f.store, "states");
  const testClock = { ...clock, setTimeout: vi.fn(clock.setTimeout) };
  const post = vi.fn(async () => ({ ok: true as const, id: "e-000000000000ffff", lamport: 65535 }));
  const start = () => {
    const wall = startAgentWall({ wallHost, chatHost, store: f.store, clock: testClock,
      userAgent: "wall-user", link: { post, state: () => ({ kind: "linked", nonce: "fixture" }) },
      reviewer: { review: async () => undefined } });
    cleanup.push(() => wall.destroy());
    return wall;
  };
  const expectDisposed = () => {
    const keyListeners = addDocument.mock.calls.filter(([type]) => type === "keydown");
    expect(keyListeners.length).toBeGreaterThan(0);
    for (const [type, listener] of keyListeners)
      expect(removeDocument.mock.calls.some(call => call[0] === type && call[1] === listener)).toBe(true);
    const clickListeners = addHost.mock.calls.filter(([type]) => type === "click");
    expect(clickListeners.length).toBeGreaterThan(0);
    for (const [type, listener] of clickListeners)
      expect(removeHost.mock.calls.some(call => call[0] === type && call[1] === listener)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(post).not.toHaveBeenCalled();
    expect(f.store.ingest).not.toHaveBeenCalled();
  };
  return { ...f, wallHost, events, states, testClock, start, expectDisposed };
}

function expectWallWithoutAgents(root: HTMLElement): void {
  expect(selected(root)).toBe("wall");
  expect(taskCard(root, "T02").querySelector(".status-icon")).not.toBeNull();
  expect(visibleText(root)).not.toContain("Show all in Swarm");
  expect(visibleText(taskCard(root, "T02"))).not.toContain("Harness A");
}

describe("U138 repair: injected read-port failures", () => {
  it("renders Wall without optional agent data when events throws at startup and disposes listeners", async () => {
    const h = fixture();
    h.events.mockImplementation(() => { throw new Error("Events unavailable"); });
    expect(() => h.start()).not.toThrow();
    await flush();
    expect(h.events).toHaveBeenCalledWith("demo");
    expectWallWithoutAgents(h.wallHost);
    // The registered disposer must still be reachable after degraded startup.
    cleanup.pop()!();
    h.expectDisposed();
  });

  it("drops stale agent data on an events failure during refresh and recovers without leaking listeners", async () => {
    const h = fixture(), wall = h.start();
    await flush();
    chipHeader(h.wallHost, "T02", "executor-a", "Harness A", "Working");
    expect(strip(h.wallHost)).toBeDefined();
    h.events.mockImplementation(() => { throw new Error("Events unavailable"); });
    expect(() => wall.refresh()).not.toThrow();
    await flush();
    expectWallWithoutAgents(h.wallHost);
    h.events.mockImplementation(room => h.history.filter(e => e.room === room));
    expect(() => wall.refresh()).not.toThrow();
    await flush();
    chipHeader(h.wallHost, "T02", "executor-a", "Harness A", "Working");
    expect(strip(h.wallHost)).toBeDefined();
    wall.destroy();
    h.expectDisposed();
  });

  it("contains a throwing states port inside the expiry callback and permits later refresh and disposal", async () => {
    const h = fixture(), wall = h.start();
    await flush();
    chipHeader(h.wallHost, "T02", "executor-a", "Harness A", "Working");
    const scheduled = h.testClock.setTimeout.mock.calls.find(([, delay]) => delay === 89_001);
    expect(scheduled).toBeDefined();
    vi.advanceTimersByTime(89_000);
    await flush();
    h.states.mockImplementation(() => { throw new Error("States unavailable"); });
    // The next tick is the real expiry, before the next periodic refresh.
    expect(() => vi.advanceTimersByTime(1)).not.toThrow();
    h.states.mockReturnValue([]);
    expect(() => wall.refresh()).not.toThrow();
    await flush();
    chipHeader(h.wallHost, "T02", "executor-a", "Harness A", "Liveness unknown");
    wall.destroy();
    h.expectDisposed();
  });
});
