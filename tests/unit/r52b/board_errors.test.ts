import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXT_ID, PagePort, roomEvent } from "../u37c/harness";

const local = vi.hoisted(() => ({
  failure: undefined as "events" | "plan" | undefined,
}));

vi.mock("../../../src/app/index", () => ({ readHostEnv: () => ({
  extensionOrigins: ["chrome-extension://" + EXT_ID], firebaseConfig: {},
}) }));
vi.mock("../../../src/app/firebase-config.public", () => ({ isPlaceholderConfig: () => true }));
vi.mock("../../../src/app/connector", () => ({ createConnector: () => ({ onMessage: () => undefined }) }));
vi.mock("../../../src/app/plan_wiring", () => ({ createPlanWiring: () => ({
  notifyChange: () => undefined, taskVerdicts: () => new Map(), planBriefs: () => new Map(),
}) }));
vi.mock("../../../src/ui/model_selector", () => ({ createModelSheet: () => ({
  render: () => undefined, open: () => undefined,
}) }));
vi.mock("../../../src/app/agent_store", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/app/agent_store")>();
  return { ...real, createAgentStore: (...args: Parameters<typeof real.createAgentStore>) => {
    const store = real.createAgentStore(...args);
    store.events = failRoomRead("events", store.events.bind(store));
    store.plan = failRoomRead("plan", store.plan.bind(store));
    return store;
  } };
});

const ROOM = "demo";
const PEER = "other";
const FLOOR = "ONLY_ON_DEVICE";
const READ_ALERT = "Can't read this workspace: Room data could not be read.";
const HOSTILE = '<img src="invalid" onerror="oracle_marker()">';
const EMPTY_COPY = /no agents in this room|empty workspace|connect your harness and assign work/i;
const ZERO_TOTALS = /\b0\s+working\s*·\s*0\s+waiting\s*·\s*0\s+finished\b/i;
const STALE_COPY = /\bstale\b|\boutdated\b|\blast (?:known good|good|verified)\b/i;

function failRoomRead<T>(method: "events" | "plan", read: (room: string) => T): (room: string) => T {
  return room => {
    if (room === ROOM && local.failure === method) throw new Error(HOSTILE);
    return read(room);
  };
}

let ports: PagePort[];
let observers: MutationObserver[];
let network: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_001_000);
  local.failure = undefined;
  ports = [];
  observers = [];
  document.body.replaceChildren(Object.assign(document.createElement("div"), { id: "wall" }));
  const NativeObserver = globalThis.MutationObserver;
  vi.stubGlobal("MutationObserver", class extends NativeObserver {
    constructor(callback: MutationCallback) {
      super(callback);
      observers.push(this);
    }
  });
  network = vi.fn(() => { throw new Error("Network is forbidden in this oracle"); });
  vi.stubGlobal("fetch", network);
  vi.stubGlobal("chrome", { runtime: { connect: () => {
    const port = new PagePort();
    ports.push(port);
    return port;
  } } });
});

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  observers.forEach(observer => observer.disconnect());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  expect(network).not.toHaveBeenCalled();
});

function hello(port: PagePort): void {
  port.emit({ t: "room_hello", v: 1, rooms: [ROOM, PEER].map(room => ({ room, floor: FLOOR })), agent: "harness" });
}

async function boot(): Promise<PagePort> {
  await import("../../../hosting/src/main");
  const port = ports.at(-1);
  expect(port, "hosting should connect the room link").toBeDefined();
  const handshake = port!.ofType("hello").at(-1);
  expect(handshake, "the link should request its port handshake").toBeDefined();
  port!.emit({ t: "snapshot", v: 1, nonce: handshake?.["nonce"], items: [] });
  vi.advanceTimersByTime(1);
  hello(port!);
  return port!;
}

function replayId(port: PagePort, room: string): string {
  const rid = port.ofType("room_sync").findLast(message =>
    Object.hasOwn(message["since"] as Record<string, unknown>, room))?.["rid"];
  expect(typeof rid, "expected a replay request for " + room).toBe("string");
  return rid as string;
}

function complete(port: PagePort, room: string, upto: number): void {
  port.emit({ t: "room_synced", v: 1, room, rid: replayId(port, room), upto, more: false });
}

function register(port: PagePort, room: string, lamport: number, agent: string, rid?: string): void {
  port.emit({ t: "room_event", v: 1, room, floor: FLOOR, ...(rid === undefined ? {} : { rid }),
    event: roomEvent(lamport, room, { agent, act: "op", text: "",
      op: { kind: "agent.lifecycle", state: "deployed", run_id: "run-" + agent, op_id: "register-" + agent },
    }) });
}

function openView(room: string, view: "wall" | "swarm"): HTMLElement {
  if (document.querySelector(".app")?.getAttribute("data-workspace") !== room) {
    document.querySelector<HTMLButtonElement>('button[data-wsid="' + room + '"]')?.click();
  }
  const app = document.querySelector<HTMLElement>('.app[data-workspace="' + room + '"]');
  expect(app, room + " should be selectable").not.toBeNull();
  if (app!.getAttribute("data-view") !== view) {
    app!.querySelector<HTMLButtonElement>('button[data-nav="' + view + '"]')?.click();
  }
  const panel = document.querySelector<HTMLElement>('.app[data-view="' + view + '"] section[aria-label="Agents"]');
  expect(panel, "the selected view should show its Agents section").not.toBeNull();
  return panel!;
}

const board = (room = ROOM): HTMLElement => openView(room, "swarm");

function alerts(view: HTMLElement): string[] {
  return Array.from(view.querySelectorAll('[role="alert"]'), node => node.textContent?.trim() ?? "");
}

function summary(view: HTMLElement): string | undefined {
  return view.querySelector(".swarm-summary")?.textContent?.trim();
}

function visibleText(root: HTMLElement): string {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const text: string[] = [];
  while (walker.nextNode()) {
    let element = walker.currentNode.parentElement;
    while (element !== null) {
      const style = getComputedStyle(element);
      if (element.hidden || style.display === "none" || style.visibility === "hidden") break;
      if (element === root) {
        text.push(walker.currentNode.textContent ?? "");
        break;
      }
      element = element.parentElement;
    }
  }
  return text.join(" ");
}

function expectUnavailable(view: HTMLElement): void {
  expect(summary(view)).toBe("Inventory unavailable");
  expect(view.textContent).not.toMatch(EMPTY_COPY);
  expect(view.textContent).not.toMatch(ZERO_TOTALS);
}

function completeWithAgent(port: PagePort, room: string, lamport: number, agent: string): HTMLElement {
  register(port, room, lamport, agent, replayId(port, room));
  complete(port, room, lamport);
  const view = board(room);
  expect(alerts(view)).toEqual([]);
  expect(view.textContent).toContain(agent);
  return view;
}

describe("R52B local Agents inventory failure", () => {
  it("shows cold inventory as unavailable with a safe read alert and no peer bubbles", async () => {
    const port = await boot();
    completeWithAgent(port, PEER, 1, "peer-worker");

    local.failure = "events";
    const view = board();
    expectUnavailable(view);
    expect(view.textContent).not.toContain("peer-worker");
    expect(view.innerHTML, "the local exception must stay out of the board").not.toContain("oracle_marker");
    expect(alerts(view)).toEqual([READ_ALERT]);
  });

  it("discards a readable but unverified Wall preview when the Agents read fails", async () => {
    const port = await boot();
    // A live registration can appear on Wall while this room still awaits replay.
    register(port, ROOM, 1, "preview-worker");
    expect(openView(ROOM, "wall").textContent).toContain("preview-worker");

    local.failure = "events";
    const view = board();
    expect(view.textContent, "a preview before replay completion is not verified inventory").not.toContain("preview-worker");
    expectUnavailable(view);
    expect(alerts(view)).toEqual([READ_ALERT]);
  });

  it("retains only verified same-room bubbles and totals with a visible stale label", async () => {
    const port = await boot();
    const saved = summary(completeWithAgent(port, ROOM, 1, "saved-worker"));
    expect(saved).toMatch(/\b1\s+waiting\b/);
    completeWithAgent(port, PEER, 2, "peer-worker");
    board();

    local.failure = "plan";
    register(port, ROOM, 3, "new-worker");
    const view = board();
    expect(view.textContent).toContain("saved-worker");
    expect(view.textContent).not.toContain("peer-worker");
    expect(view.textContent).not.toContain("new-worker");
    expect(summary(view)).toBe(saved);
    expect(visibleText(view), "retained inventory needs a visible stale label").toMatch(STALE_COPY);
    expect(alerts(view)).toEqual([READ_ALERT]);
  });

  it("suppresses normal empty copy and zero totals after a verified empty read", async () => {
    const port = await boot();
    complete(port, ROOM, 0);
    const healthy = board();
    expect(alerts(healthy)).toEqual([]);
    expect(healthy.textContent).toContain("No agents in this room");
    expect(summary(healthy)).toMatch(ZERO_TOTALS);

    local.failure = "events";
    register(port, PEER, 1, "peer-worker");
    const view = board();
    expect(view.textContent).not.toMatch(EMPTY_COPY);
    expect(summary(view), "a failed read cannot certify zero totals").not.toMatch(ZERO_TOTALS);
    expectUnavailable(view);
    expect(alerts(view)).toEqual([READ_ALERT]);
  });

  it("stays faulted after peer replay and restores current inventory after same-room recovery", async () => {
    const port = await boot();
    completeWithAgent(port, ROOM, 1, "saved-worker");
    local.failure = "events";

    // Request replay for both rooms while the affected room is still unreadable.
    hello(port);
    const beforePeer = alerts(board());
    expect(beforePeer).toHaveLength(1);
    completeWithAgent(port, PEER, 2, "peer-worker");
    const afterPeer = board();
    expect(alerts(afterPeer)).toEqual(beforePeer);
    expect(afterPeer.textContent).toContain("saved-worker");
    expect(afterPeer.textContent).not.toContain("peer-worker");

    local.failure = undefined;
    const recovered = completeWithAgent(port, ROOM, 3, "recovered-worker");
    expect(recovered.textContent).toContain("saved-worker");
    expect(recovered.textContent).not.toContain("peer-worker");
    expect(visibleText(recovered)).not.toMatch(STALE_COPY);
    expect(recovered.textContent).not.toContain("Inventory unavailable");
  });
});
