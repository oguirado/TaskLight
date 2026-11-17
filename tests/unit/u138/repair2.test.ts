import { describe, expect, it, vi } from "vitest";
import { startAgentWall } from "../../../src/app/agent_wall";
import type { AgentWallDeps } from "../../../src/app/agent_wall";
import type { AgentState } from "../../../src/agents/types";
import type { AgentChatHandlers, AgentChatVM } from "../../../src/agentsui/types";
import {
  NOW, cleanup, clock, deterministic, flush, frozenPlan, roomFixture,
  selected, visibleText,
} from "./helpers";

// Keep real rendering while testing callbacks before UI containment can mask errors.
const probe = vi.hoisted(() => ({ handlers: null as AgentChatHandlers | null }));
vi.mock("../../../src/agentsui", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/agentsui")>();
  return { ...actual, mountAgentChat: (host: HTMLElement, vm: AgentChatVM, handlers: AgentChatHandlers) => {
    probe.handlers = handlers;
    return actual.mountAgentChat(host, vm, handlers);
  } };
});

deterministic();

function fixture(kind: "legacy" | "plan" = "legacy") {
  const f = roomFixture();
  f.rooms.clear();
  if (kind === "plan") f.rooms.set("demo", frozenPlan());
  const legacy: AgentState = {
    room: "demo", agent: "executor-a", stepStates: [], outcomes: [], took: [],
    lastSeen: NOW, openQuestions: [], closed: false,
  };
  const states = vi.spyOn(f.store, "states").mockReturnValue([legacy]);
  const events = vi.spyOn(f.store, "events");
  const testClock = { ...clock, now: vi.fn(clock.now), setTimeout: vi.fn(clock.setTimeout) };
  const post = vi.fn(async () => ({ ok: true as const, id: "e-000000000000ffff", lamport: 1 }));
  const reviewer = { review: vi.fn(async () => undefined) };
  const wallHost = document.createElement("div"), chatHost = document.createElement("div");
  document.body.append(wallHost, chatHost);
  probe.handlers = null;
  const start = (extra: Partial<AgentWallDeps> = {}) => {
    const wall = startAgentWall({ wallHost, chatHost, store: f.store, clock: testClock,
      userAgent: "wall-user", link: { post }, reviewer, ...extra });
    cleanup.push(() => wall.destroy());
    return wall;
  };
  const open = () => {
    // A-U138q: R41 opens chat through Messages (legacy), rather than Wall cards.
    const toggle = wallHost.querySelector<HTMLButtonElement>(".messages-toggle");
    expect(toggle).not.toBeNull();
    if (toggle!.getAttribute("aria-expanded") !== "true") toggle!.click();
    const taskId = kind === "plan" ? "T02" : "agent:demo:executor-a";
    const task = [...wallHost.querySelectorAll<HTMLButtonElement>(".messages-task")]
      .find(button => button.dataset.taskId === taskId);
    expect(task, `Legacy Messages task ${taskId}`).toBeDefined();
    expect(task!.disabled).toBe(false);
    task!.click();
    expect(chatHost.getAttribute("data-open")).toBe("true");
  };
  const handlers = () => {
    expect(probe.handlers).not.toBeNull();
    return probe.handlers!;
  };
  const expectDisposed = (wall: ReturnType<typeof start>) => {
    wall.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.store.ingest).not.toHaveBeenCalled();
  };
  return { ...f, wallHost, chatHost, states, events, testClock, post, reviewer, start, open, handlers, expectDisposed };
}

const throws = (): never => { throw new Error("Port unavailable"); };
const badStates: Array<[string, () => unknown]> = [
  ["throwing", throws], ["null", () => null], ["undefined", () => undefined],
  ["non-array", () => ({})], ["invalid member", () => [null]],
];
const entryPoints = ["startup", "refresh", "periodic timer", "onSend", "onRetry", "onEscalate", "onAcceptDrift"] as const;

async function prepareRetry(h: ReturnType<typeof fixture>) {
  h.post.mockResolvedValueOnce({ ok: false, code: "denied" } as never);
  h.handlers().onSend!("Retry this message");
  await flush();
  expect(h.post).toHaveBeenCalledTimes(1);
  h.post.mockClear();
}

describe("U138 repair 2: states port containment", () => {
  for (const [label, read] of badStates) {
    it.each(entryPoints)(`${label} states degrade at %s`, async point => {
      const h = fixture();
      if (point === "startup") h.states.mockImplementation(read as never);
      let wall!: ReturnType<typeof h.start>;
      expect(() => { wall = h.start(); }).not.toThrow();
      await flush();
      if (point !== "startup") {
        h.open();
        if (point === "onRetry") await prepareRetry(h);
        h.states.mockImplementation(read as never);
        const action = () => {
          if (point === "refresh") wall.refresh();
          else if (point === "periodic timer") vi.advanceTimersByTime(30_000);
          else if (point === "onSend") h.handlers().onSend!("Do not send");
          else if (point === "onRetry") h.handlers().onRetry!("c1");
          else if (point === "onEscalate") h.handlers().onEscalate!();
          else h.handlers().onAcceptDrift!();
        };
        expect(action).not.toThrow();
        await flush();
      }
      expect(h.post).not.toHaveBeenCalled();
      expect(selected(h.wallHost)).toBe("wall");
      // Restoring the port must recover without restarting the wall.
      h.states.mockReturnValue([{ room: "demo", agent: "executor-a", stepStates: [],
        outcomes: [], took: [], lastSeen: NOW, openQuestions: [], closed: false }]);
      expect(() => wall.refresh()).not.toThrow();
      await flush();
      h.expectDisposed(wall);
    });
  }
});

describe("U138 repair 2: legacy chat events", () => {
  it.each(["startup", "refresh", "onSend", "onRetry", "onEscalate", "onAcceptDrift"] as const)(
    "contains throwing events at %s, including an initially null selection", async point => {
      const h = fixture();
      if (point === "startup") h.events.mockImplementation(throws);
      let wall!: ReturnType<typeof h.start>;
      expect(() => { wall = h.start(); }).not.toThrow();
      await flush();
      if (point !== "startup") {
        h.open();
        if (point === "onRetry") await prepareRetry(h);
        h.events.mockImplementation(throws);
        expect(() => {
          if (point === "refresh") wall.refresh();
          else if (point === "onSend") h.handlers().onSend!("Still usable");
          else if (point === "onRetry") h.handlers().onRetry!("c1");
          else if (point === "onEscalate") h.handlers().onEscalate!();
          else h.handlers().onAcceptDrift!();
        }).not.toThrow();
        await flush();
      }
      expect(h.events).toHaveBeenCalledWith("demo");
      expect(wall.chat()).not.toBeNull();
      expect(h.chatHost.getAttribute("aria-label")).toContain("executor-a");
      h.expectDisposed(wall);
    },
  );
});

describe("U138 repair 2: escalation target", () => {
  const invalid: Array<[string, () => unknown]> = [
    ["throwing", throws], ["non-string", () => ({})], ["empty", () => ""],
  ];
  for (const kind of ["legacy", "plan"] as const) {
    it.each(invalid)(`${kind} escalation contains a %s orchestrator callback`, async (_label, read) => {
      const h = fixture(kind), orchestrator = vi.fn(read);
      const wall = h.start({ orchestrator: orchestrator as () => string | undefined });
      await flush(); h.open();
      expect(() => h.handlers().onEscalate!()).not.toThrow();
      await flush();
      expect(h.post).toHaveBeenCalledWith({ room: "demo", to: "orchestrator", text: expect.any(String) });
      orchestrator.mockReturnValue("lead-agent");
      h.handlers().onEscalate!();
      await flush();
      expect(h.post).toHaveBeenLastCalledWith({ room: "demo", to: "lead-agent", text: expect.any(String) });
      h.expectDisposed(wall);
    });
  }
});

describe("U138 repair 2: unavailable clocks", () => {
  const invalid: Array<[string, () => unknown]> = [
    ["NaN", () => NaN], ["Infinity", () => Infinity], ["negative Infinity", () => -Infinity],
    ["throwing", throws], ["undefined", () => undefined], ["null", () => null],
    ["outside the date range", () => Number.MAX_VALUE],
  ];
  for (const kind of ["legacy", "plan"] as const) {
    it.each(invalid)(`${kind} submit visibly refuses a %s clock and later recovers`, async (_label, read) => {
      const h = fixture(kind), wall = h.start();
      await flush(); h.open();
      wall.chat()!.setDraft("Keep my draft");
      h.testClock.setTimeout.mockClear();
      h.testClock.now.mockImplementation(read as never);
      expect(() => h.handlers().onSend!("Keep my draft")).not.toThrow();
      await flush();
      expect(h.post).not.toHaveBeenCalled();
      expect(wall.chat()!.getDraft()).toBe("Keep my draft");
      expect(visibleText(h.chatHost)).toMatch(/clock.*unavailable/i);
      expect(() => wall.refresh()).not.toThrow();
      expect(() => vi.advanceTimersByTime(90_001)).not.toThrow();
      await flush();
      expect(h.testClock.setTimeout.mock.calls.every(([, delay]) => Number.isFinite(delay) && delay >= 0)).toBe(true);
      h.testClock.now.mockImplementation(clock.now);
      wall.refresh();
      h.handlers().onSend!("Keep my draft");
      await flush();
      expect(h.post).toHaveBeenCalledTimes(1);
      expect(visibleText(h.chatHost)).not.toMatch(/clock.*unavailable/i);
      h.expectDisposed(wall);
    });
  }

  it.each(["startup", "refresh", "periodic timer"] as const)("contains a throwing clock at %s", async point => {
    const h = fixture("plan");
    if (point === "startup") h.testClock.now.mockImplementation(throws);
    let wall!: ReturnType<typeof h.start>;
    expect(() => { wall = h.start(); }).not.toThrow();
    await flush();
    h.testClock.now.mockImplementation(throws);
    expect(() => point === "periodic timer" ? vi.advanceTimersByTime(30_000) : wall.refresh()).not.toThrow();
    await flush();
    expect(selected(h.wallHost)).toBe("wall");
    expect(h.post).not.toHaveBeenCalled();
    h.expectDisposed(wall);
  });
});
