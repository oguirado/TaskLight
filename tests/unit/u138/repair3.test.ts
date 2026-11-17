import { beforeEach, describe, expect, it, vi } from "vitest";
import { startAgentWall } from "../../../src/app/agent_wall";
import type { AgentWall, AgentWallDeps } from "../../../src/app/agent_wall";
import type { AgentState } from "../../../src/agents/types";
import type { AgentChatHandlers } from "../../../src/agentsui/types";
import type { WallMountHandlers } from "../../../src/views";
import { NOW, cleanup, clock, deterministic, event, flush, frozenPlan, roomFixture, selected } from "./helpers";

const probe = vi.hoisted(() => ({
  failures: new Set<string>(), invalid: new Map<string, unknown>(), calls: new Map<string, number>(),
  wallHandlers: undefined as WallMountHandlers | undefined,
  chatHandlers: undefined as AgentChatHandlers | undefined,
  disposers: [] as Array<() => void>,
  run<T>(name: string, action: () => T): T {
    this.calls.set(name, (this.calls.get(name) ?? 0) + 1);
    if (this.failures.has(name)) throw new Error(`Unavailable port: ${name}`);
    if (this.invalid.has(name)) return this.invalid.get(name) as T;
    return action();
  },
}));

vi.mock("../../../src/views", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/views")>();
  return { ...actual, mountWall: (...args: Parameters<typeof actual.mountWall>) => {
    probe.wallHandlers = args[2];
    return probe.run("mountWall", () => {
      const handle = actual.mountWall(...args);
      probe.disposers.push(() => handle.destroy());
      return {
        update: (...values: Parameters<typeof handle.update>) => probe.run("wall.update", () => handle.update(...values)),
        destroy: () => probe.run("wall.destroy", () => handle.destroy()),
      };
    });
  } };
});
vi.mock("../../../src/agentsui", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/agentsui")>();
  return { ...actual, mountAgentChat: (...args: Parameters<typeof actual.mountAgentChat>) => {
    probe.chatHandlers = args[2];
    return probe.run("mountAgentChat", () => {
      const handle = actual.mountAgentChat(...args);
      probe.disposers.push(() => handle.destroy());
      return {
        update: (...values: Parameters<typeof handle.update>) => probe.run("chat.update", () => handle.update(...values)),
        destroy: () => probe.run("chat.destroy", () => handle.destroy()),
        getDraft: () => probe.run("chat.getDraft", () => handle.getDraft()),
        setDraft: (text: string) => probe.run("chat.setDraft", () => handle.setDraft(text)),
      };
    });
  } };
});
vi.mock("../../../src/ui/theme_store", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/ui/theme_store")>();
  return {
    readTheme: () => probe.run("readTheme", actual.readTheme),
    writeTheme: (...args: Parameters<typeof actual.writeTheme>) => probe.run("writeTheme", () => actual.writeTheme(...args)),
  };
});

deterministic();
beforeEach(() => {
  probe.failures.clear(); probe.invalid.clear(); probe.calls.clear();
  probe.wallHandlers = undefined; probe.chatHandlers = undefined; probe.disposers = [];
});

// This inventory covers every dependency called by the controller, including adapter handles
// and the selection subscriber supplied through the returned public handle.
const PORTS = [
  "store.states", "store.events", "store.plan", "store.plans", "link.post", "link.state",
  "clock.now", "clock.setTimeout", "clock.clearTimeout", "clock.setInterval", "clock.clearInterval",
  "reviewer.review", "orchestrator", "modelAvailability", "modelStatus", "planVerdicts", "planBriefs",
  "templateMemorySections", "onOpenModels", "readTheme", "writeTheme", "mountWall", "wall.update", "wall.destroy",
  "mountAgentChat", "chat.update", "chat.destroy", "chat.getDraft", "chat.setDraft", "selection listener",
] as const;

function fixture() {
  const f = roomFixture();
  f.rooms.clear(); f.rooms.set("demo", frozenPlan());
  f.history.splice(0, f.history.length, event(1));
  const legacy: AgentState = { room: "demo", agent: "executor-a", stepStates: [], outcomes: [], took: [],
    lastSeen: NOW, openQuestions: [], closed: false };
  const states = vi.spyOn(f.store, "states").mockImplementation(() => probe.run("store.states", () => [legacy]));
  for (const name of ["events", "plan", "plans"] as const) {
    const original = vi.isMockFunction(f.store[name]) ? f.store[name].getMockImplementation()! : f.store[name];
    vi.spyOn(f.store, name).mockImplementation(((...args: never[]) =>
      probe.run(`store.${name}`, () => (original as (...values: never[]) => unknown)(...args))) as never);
  }
  const testClock = {
    now: () => probe.run("clock.now", clock.now),
    setTimeout: (fn: () => void, ms: number) => probe.run("clock.setTimeout", () => clock.setTimeout(fn, ms)),
    clearTimeout: (id: number) => probe.run("clock.clearTimeout", () => clock.clearTimeout(id)),
    setInterval: (fn: () => void, ms: number) => probe.run("clock.setInterval", () => clock.setInterval(fn, ms)),
    clearInterval: (id: number) => probe.run("clock.clearInterval", () => clock.clearInterval(id)),
  };
  const wallHost = document.createElement("div"), chatHost = document.createElement("div");
  document.body.append(wallHost, chatHost);
  let wall: AgentWall | undefined;
  cleanup.push(() => {
    probe.failures.clear(); probe.invalid.clear();
    wall?.destroy();
    for (const dispose of probe.disposers.splice(0)) dispose();
    vi.clearAllTimers();
  });
  const start = (extra: Partial<AgentWallDeps> = {}) => {
    // A-V1: preserve the Wall-specific read-port assertions under an explicit view.
    wall = startAgentWall({ initialView: "wall", wallHost, chatHost, store: f.store, clock: testClock, userAgent: "wall-user",
      link: {
        post: () => probe.run("link.post", async () => ({ ok: true as const, id: "e-000000000000ffff", lamport: 1 })),
        state: () => probe.run("link.state", () => ({ kind: "linked" as const, nonce: "fixture" })),
      },
      reviewer: { review: () => probe.run("reviewer.review", async () => undefined) },
      orchestrator: () => probe.run("orchestrator", () => "orchestrator"),
      modelStatus: () => probe.run("modelStatus", () => undefined),
      modelAvailability: () => probe.run("modelAvailability", () => "Available"),
      planVerdicts: () => probe.run("planVerdicts", () => new Map()),
      planBriefs: () => probe.run("planBriefs", () => new Map()),
      templateMemorySections: () => probe.run("templateMemorySections", () => []),
      onOpenModels: () => probe.run("onOpenModels", () => undefined), ...extra,
    });
    return wall;
  };
  return { ...f, wallHost, chatHost, states, testClock, start };
}

describe("U138 repair 3: named blocking reproductions", () => {
  it("contains throwing swarm cancellation, retires stale callbacks and recovers", async () => {
    const h = fixture(), schedule = vi.spyOn(h.testClock, "setTimeout"), wall = h.start();
    await flush();
    const stale = schedule.mock.calls.find(([, delay]) => delay === 89_001)?.[0];
    expect(stale).toBeTypeOf("function");
    probe.failures.add("clock.clearTimeout");
    expect(() => wall.refresh()).not.toThrow();
    await flush();
    const paints = probe.calls.get("wall.update");
    expect(() => stale!()).not.toThrow();
    expect(probe.calls.get("wall.update")).toBe(paints);
    probe.failures.clear();
    expect(() => wall.refresh()).not.toThrow();
    await flush();
    expect(selected(h.wallHost)).toBe("wall");
    expect(() => wall.destroy()).not.toThrow();
  });

  it.each([undefined, {}])("normalizes a non-thenable reviewer result (%j)", async result => {
    const h = fixture(); probe.invalid.set("reviewer.review", result);
    let wall!: AgentWall;
    expect(() => { wall = h.start(); }).not.toThrow();
    await flush();
    expect(() => wall.refresh()).not.toThrow();
    await flush();
    expect(selected(h.wallHost)).toBe("wall");
    expect(() => wall.destroy()).not.toThrow();
  });

  it.each([null, {}])("treats malformed plans as no plans (%j)", async plans => {
    const h = fixture(); probe.invalid.set("store.plans", plans);
    const wall = h.start(); await flush();
    expect(() => wall.refresh()).not.toThrow(); await flush();
    expect(selected(h.wallHost)).toBe("wall");
    expect(h.wallHost.querySelector('article[data-task-id="T02"]')).toBeNull();
    expect(() => wall.destroy()).not.toThrow();
  });

  it("contains memory metadata exceptions inside the view-model callback and recovers", async () => {
    const h = fixture(); probe.failures.add("templateMemorySections");
    const wall = h.start(); await flush();
    expect(probe.calls.get("templateMemorySections")).toBeGreaterThan(0);
    expect(() => wall.refresh()).not.toThrow(); await flush();
    expect(selected(h.wallHost)).toBe("wall");
    probe.failures.clear(); wall.refresh(); await flush();
    expect(() => wall.destroy()).not.toThrow();
  });

  it.each(["clock.setInterval", "clock.setTimeout"])("degrades %s startup without losing the Wall", async name => {
    const h = fixture(); probe.failures.add(name);
    let wall!: AgentWall;
    expect(() => { wall = h.start(); }).not.toThrow(); await flush();
    expect(selected(h.wallHost)).toBe("wall");
    expect(() => wall.refresh()).not.toThrow(); await flush();
    expect(() => vi.advanceTimersByTime(100_000)).not.toThrow(); await flush();
    expect(() => wall.destroy()).not.toThrow();
  });
});

describe("U138 repair 3: complete injected-port inventory", () => {
  it.each(PORTS)("contains throwing %s through start, refresh, timers, handlers and destroy", async name => {
    const h = fixture(); probe.failures.add(name);
    let wall!: AgentWall;
    expect(() => { wall = h.start(); }).not.toThrow(); await flush();
    wall.onSelection(() => probe.run("selection listener", () => undefined));
    expect(() => {
      probe.wallHandlers?.onOpenModels?.(document.createElement("button"));
      probe.wallHandlers?.onThemeToggle?.();
      probe.wallHandlers?.onOpenTask?.("plan:demo:T02");
      wall.chat()?.setDraft("Plan draft");
      probe.chatHandlers?.onSend?.("Plan question");
      probe.chatHandlers?.onEscalate?.();
      probe.wallHandlers?.onOpenTask?.("agent:demo:executor-a");
      wall.chat()?.setDraft("Legacy draft");
      wall.chat()?.getDraft();
      probe.chatHandlers?.onSend?.("Legacy question");
      probe.chatHandlers?.onEscalate?.();
      probe.chatHandlers?.onAcceptDrift?.();
      probe.chatHandlers?.onSuggest?.();
      wall.refresh(); wall.refreshModels?.();
    }).not.toThrow(); await flush();
    expect(() => vi.advanceTimersByTime(100_000)).not.toThrow(); await flush();
    expect(() => wall.destroy()).not.toThrow();
    expect(probe.calls.get(name), "Every failure must actually reach its injected port").toBeGreaterThan(0);
    expect(() => wall.destroy()).not.toThrow();
    expect(h.store.ingest).not.toHaveBeenCalled();
  });

  const invalid = [
    ["planVerdicts", {}], ["planBriefs", {}], ["templateMemorySections", {}],
    ["modelStatus", {}], ["modelAvailability", {}], ["link.state", null],
    ["mountWall", null], ["mountWall", {}], ["mountAgentChat", null], ["mountAgentChat", {}],
    ["clock.setTimeout", NaN], ["clock.setInterval", Infinity], ["chat.getDraft", {}],
  ] as const;
  it.each(invalid)("contains invalid %s result (%j)", async (name, result) => {
    const h = fixture(); probe.invalid.set(name, result);
    let wall!: AgentWall;
    expect(() => { wall = h.start(); }).not.toThrow(); await flush();
    expect(() => { wall.refresh(); wall.chat()?.getDraft(); }).not.toThrow(); await flush();
    expect(() => vi.advanceTimersByTime(100_000)).not.toThrow(); await flush();
    expect(() => wall.destroy()).not.toThrow();
  });

  it.each(PORTS.filter(name => !["reviewer.review", "link.post"].includes(name)))(
    "observes an invalid rejected result from synchronous %s", async name => {
      const h = fixture(), run = probe.run;
      let rejected = 0;
      vi.spyOn(probe, "run").mockImplementation(function<T>(port: string, action: () => T): T {
        if (port === name) rejected += 1;
        return run.call(probe, port, port === name
          ? () => Promise.reject(new Error("Unexpected async result")) as T : action) as T;
      });
      let wall!: AgentWall;
      expect(() => { wall = h.start(); }).not.toThrow(); await flush();
      wall.onSelection(() => probe.run("selection listener", () => undefined));
      expect(() => {
        probe.wallHandlers?.onOpenModels?.(document.createElement("button"));
        probe.wallHandlers?.onThemeToggle?.();
        probe.wallHandlers?.onOpenTask?.("plan:demo:T02");
        wall.chat()?.getDraft(); wall.chat()?.setDraft("Draft");
        probe.chatHandlers?.onSend?.("Question");
        probe.chatHandlers?.onEscalate?.();
        wall.refresh(); wall.refreshModels?.();
      }).not.toThrow(); await flush();
      expect(() => vi.advanceTimersByTime(100_000)).not.toThrow(); await flush();
      expect(() => wall.destroy()).not.toThrow(); await flush();
      expect(rejected, "The rejected result must actually be returned").toBeGreaterThan(0);
    },
  );

  it("contains rejected asynchronous review and post results", async () => {
    const h = fixture(), wall = h.start({
      reviewer: { review: () => Promise.reject(new Error("Review unavailable")) },
      link: { post: () => Promise.reject(new Error("Post unavailable")) },
    });
    await flush();
    expect(() => {
      probe.wallHandlers?.onOpenTask?.("plan:demo:T02");
      probe.chatHandlers?.onSend?.("Question");
      probe.chatHandlers?.onEscalate?.();
      wall.refresh();
    }).not.toThrow(); await flush();
    expect(() => wall.destroy()).not.toThrow();
  });
});
