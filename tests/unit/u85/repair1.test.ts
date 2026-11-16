import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStore, AgentStoreOptions } from "../../../src/app/agent_store";
import type { AgentLink, AgentLinkDeps } from "../../../src/app/agent_link";
import type { AgentWall } from "../../../src/app/agent_wall";
import { EXT_ID, FLOOR, HELLO, PagePort, event, eventFrame, fixture, gapFrame,
  synced, template } from "./helpers";

const captured = vi.hoisted(() => ({
  store: undefined as AgentStore | undefined,
  link: undefined as AgentLink | undefined,
  wall: undefined as AgentWall | undefined,
  refresh: vi.fn(),
}));
vi.mock("../../../src/app/index", () => ({ readHostEnv: () => ({
  extensionOrigins: [`chrome-extension://${EXT_ID}`], firebaseConfig: {},
}) }));
vi.mock("../../../src/app/firebase-config.public", () => ({ isPlaceholderConfig: () => true }));
vi.mock("../../../src/app/connector", () => ({ createConnector: () => ({ onMessage: () => undefined }) }));
vi.mock("../../../src/app/plan_wiring", () => ({ createPlanWiring: () => ({
  notifyChange: () => undefined, taskVerdicts: () => new Map(), planBriefs: () => new Map(),
}) }));
vi.mock("../../../src/ui/model_selector", () => ({ createModelSheet: () => ({
  render: () => undefined, open: () => undefined,
}) }));
vi.mock("../../../src/app/starter_templates", () => ({
  resolveStarterTemplate: () => template, getTemplateMemorySections: () => undefined,
}));
vi.mock("../../../src/app/agent_store", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/app/agent_store")>();
  return { ...real, createAgentStore: (opts?: AgentStoreOptions) => {
    captured.store = real.createAgentStore(opts); return captured.store;
  } };
});
vi.mock("../../../src/app/agent_link", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/app/agent_link")>();
  return { ...real, createAgentLink: (deps: AgentLinkDeps) => {
    captured.link = real.createAgentLink(deps); return captured.link;
  } };
});
vi.mock("../../../src/app/agent_wall", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/app/agent_wall")>();
  return { ...real, startAgentWall: (deps: Parameters<typeof real.startAgentWall>[0]) => {
    captured.wall = real.startAgentWall(deps);
    captured.refresh.mockImplementation(captured.wall.refresh);
    return { ...captured.wall, refresh: captured.refresh };
  } };
});

let ports: PagePort[];
let observers: MutationObserver[];
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(1_700_000_001_000);
  document.body.replaceChildren(Object.assign(document.createElement("div"), { id: "wall" }));
  ports = []; observers = [];
  captured.store = undefined; captured.link = undefined; captured.wall = undefined;
  captured.refresh.mockReset();
  const NativeObserver = globalThis.MutationObserver;
  class Observer extends NativeObserver {
    constructor(callback: MutationCallback) { super(callback); observers.push(this); }
  }
  vi.stubGlobal("MutationObserver", Observer);
  vi.stubGlobal("chrome", { runtime: { connect: () => {
    const port = new PagePort(); ports.push(port); return port;
  } } });
});
afterEach(() => {
  captured.link?.stop(); captured.wall?.destroy(); observers.forEach(o => o.disconnect());
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  document.body.replaceChildren();
});

function handshake(port: PagePort): void {
  const hello = port.ofType("hello").at(-1)!;
  port.emit({ t: "snapshot", v: 1, nonce: hello["nonce"], items: [] });
  vi.advanceTimersByTime(1);
}
async function boot(): Promise<PagePort> {
  await import("../../../hosting/src/main");
  const port = ports.at(-1)!;
  expect(port).toBeDefined(); handshake(port); port.emit(HELLO);
  return port;
}
function reconnect(port: PagePort, hello = true): PagePort {
  port.drop(); vi.advanceTimersByTime(100);
  const next = ports.at(-1)!;
  expect(next).not.toBe(port); handshake(next);
  if (hello) next.emit(HELLO);
  return next;
}
const rid = (port: PagePort): string => String(port.ofType("room_sync").at(-1)!["rid"]);
const since = (port: PagePort): Record<string, number> =>
  port.ofType("room_sync").at(-1)!["since"] as Record<string, number>;
const notice = (): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[role="status"]')]
    .find(node => node.textContent?.includes("Progress may be outdated"));
function replay(port: PagePort, through = 8): void {
  fixture().filter(ev => ev.lamport <= through)
    .forEach(ev => port.emit(eventFrame(ev, rid(port))));
}
function unknownFault(port: PagePort): void {
  port.emit({ t: "room_event", v: 1, room: "demo", floor: FLOOR, event: { room: "demo" } });
  expect(notice()?.textContent).toContain("demo");
}

describe("U85 repair: recovery boundaries and connection membership", () => {
  it("unknown-position faults clear after a clean full-history replay", async () => {
    const port = await boot(); replay(port, 7); unknownFault(port);
    const next = reconnect(port);
    expect(since(next)["demo"]).toBe(0);
    replay(next); expect(notice()).toBeDefined();
    next.emit(synced(rid(next), 8));
    expect(notice()).toBeUndefined();
    expect(captured.store?.plan("demo")?.projection.tasks[0]?.state).toBe("done");
  });

  it.each([false, true])("unknown-position faults override known intervals (unknown first: %s)", async unknownFirst => {
    const port = await boot(); replay(port, 7);
    if (unknownFirst) unknownFault(port);
    port.emit(gapFrame());
    if (!unknownFirst) unknownFault(port);
    const next = reconnect(port);
    expect(since(next)["demo"]).toBe(0);
    // Pagination and duplicate deliveries must retain the full-history origin.
    replay(next, 7); next.emit(synced(rid(next), 7, true));
    next.emit(eventFrame(fixture().at(-1)!, rid(next)));
    next.emit(eventFrame(fixture().at(-1)!, rid(next)));
    expect(notice()).toBeDefined();
    next.emit(synced(rid(next), 8));
    expect(notice()).toBeUndefined();
  });

  it.each([7, 8])("terminal upto %s cannot clear faults beyond its coverage", async upto => {
    const port = await boot(); replay(port, 7);
    port.emit(gapFrame());
    port.emit(gapFrame({ from_lamport: 10, to_lamport: 12 }));
    let next = reconnect(port);
    expect(since(next)["demo"]).toBe(7);
    if (upto >= 8) next.emit(eventFrame(fixture().at(-1)!, rid(next)));
    next.emit(synced(rid(next), upto));
    expect(notice()?.textContent).toContain("demo");
    next = reconnect(next);
    expect(since(next)["demo"]).toBe(7);
    replay(next);
    for (let n = 9; n <= 12; n++) next.emit(eventFrame(event(n), rid(next)));
    next.emit(synced(rid(next), 12));
    expect(notice()).toBeUndefined();
  });

  it.each([
    undefined,
    { ...HELLO, v: 2 },
    { ...HELLO, rooms: [{ room: "demo" }] },
  ])("replacement ports reject room frames until their own valid hello (%j)", async invalidHello => {
    const port = await boot(); replay(port, 7);
    const next = reconnect(port, false);
    if (invalidHello !== undefined) next.emit(invalidHello);
    const before = captured.store!.events("demo");
    port.emit(eventFrame(event(9))); port.emit(gapFrame());
    next.emit(eventFrame(event(9))); next.emit(gapFrame());
    next.emit(synced(rid(next), 9));
    expect(captured.store!.events("demo")).toEqual(before);
    expect(notice()).toBeUndefined();
    next.emit(HELLO);
    next.emit(eventFrame(event(9)));
    expect(captured.store!.events("demo").some(ev => ev.lamport === 9)).toBe(true);
    next.emit(gapFrame()); expect(notice()).toBeDefined();
  });

  it("dormant room faults permit clean-room refresh and remain recoverable when reannounced", async () => {
    const port = await boot(); replay(port, 7); port.emit(gapFrame());
    const complete = structuredClone(captured.store!.plan("demo")!.projection);
    port.emit({ ...HELLO, rooms: [{ room: "other", floor: FLOOR }] });
    expect(notice()).toBeUndefined();
    const refreshes = captured.refresh.mock.calls.length;
    fixture().forEach(ev => port.emit(eventFrame({ ...ev, id: event(ev.lamport + 100).id, room: "other" }, rid(port))));
    port.emit({ ...synced(rid(port), 8), room: "other" });
    expect(captured.store!.plan("other")?.projection.tasks[0]?.state).toBe("done");
    expect(captured.refresh.mock.calls.length).toBeGreaterThan(refreshes);
    expect(captured.store!.plan("demo")?.projection).toEqual(complete);
    port.emit(HELLO);
    expect(notice()?.textContent).toContain("demo");
    expect(since(port)["demo"]).toBe(7);
    port.emit(eventFrame(fixture().at(-1)!, rid(port)));
    port.emit(synced(rid(port), 8));
    expect(notice()).toBeUndefined();
  });
});
