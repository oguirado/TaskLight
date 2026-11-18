import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentLink, AgentLinkDeps } from "../../../src/app/agent_link";
import { EXT_ID, PagePort, roomEvent } from "../u37c/harness";

const captured = vi.hoisted(() => ({ link: undefined as AgentLink | undefined }));

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
vi.mock("../../../src/app/agent_link", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/app/agent_link")>();
  return { ...real, createAgentLink: (deps: AgentLinkDeps) => {
    captured.link = real.createAgentLink(deps);
    return captured.link;
  } };
});

const DEMO = "demo";
const OTHER = "other";
const FLOOR = "ONLY_ON_DEVICE";
const READ_ALERT = "Can't read this workspace: Room data could not be read.";
const SYNC_ALERT = "Can't read this workspace: Room synchronization could not complete.";
const EMPTY_COPY = /no agents|empty workspace|connect your harness and assign work/i;
const ZERO_TOTALS = /\b0\s+working\s*·\s*0\s+waiting\s*·\s*0\s+finished\b/i;

let ports: PagePort[];
let observers: MutationObserver[];
let network: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_001_000);
  captured.link = undefined;
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
  captured.link?.stop();
  observers.forEach(observer => observer.disconnect());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  expect(network).not.toHaveBeenCalled();
});

function hello(port: PagePort, rooms = [DEMO, OTHER]): void {
  port.emit({ t: "room_hello", v: 1, rooms: rooms.map(room => ({ room, floor: FLOOR })), agent: "harness" });
}

function snapshot(port: PagePort): void {
  const message = port.ofType("hello").at(-1);
  expect(message, "production link must send its port handshake").toBeDefined();
  port.emit({ t: "snapshot", v: 1, nonce: message?.["nonce"], items: [] });
  vi.advanceTimersByTime(1);
}

function handshake(port: PagePort, rooms = [DEMO, OTHER]): void {
  snapshot(port);
  hello(port, rooms);
}

async function boot(rooms = [DEMO, OTHER]): Promise<PagePort> {
  await import("../../../hosting/src/main");
  const port = ports.at(-1);
  expect(port, "hosting must connect the production room link").toBeDefined();
  handshake(port!, rooms);
  return port!;
}

function reconnect(old: PagePort, rooms = [DEMO, OTHER]): PagePort {
  old.drop();
  vi.advanceTimersByTime(100);
  const port = ports.at(-1);
  expect(port).toBeDefined();
  expect(port).not.toBe(old);
  handshake(port!, rooms);
  return port!;
}

interface Replay { rid: string; since: number }
function replay(port: PagePort, room: string): Replay {
  const frame = port.ofType("room_sync").findLast(message =>
    Object.hasOwn(message["since"] as Record<string, unknown>, room));
  expect(frame, `expected a room_sync request for ${room}`).toBeDefined();
  const since = (frame!["since"] as Record<string, number>)[room];
  const rid = frame!["rid"];
  expect(typeof since).toBe("number");
  expect(typeof rid).toBe("string");
  return { rid: rid as string, since: since! };
}

function terminal(port: PagePort, room: string, upto: number, rid = replay(port, room).rid, more = false): void {
  port.emit({ t: "room_synced", v: 1, room, rid, upto, more });
}

function register(port: PagePort, room: string, lamport: number, agent: string, rid?: string): void {
  port.emit({ t: "room_event", v: 1, room, floor: FLOOR, ...(rid === undefined ? {} : { rid }),
    event: roomEvent(lamport, room, { agent, act: "op", text: "",
      op: { kind: "agent.lifecycle", state: "deployed", run_id: `run-${agent}`, op_id: `register-${agent}` },
    }) });
}

function fault(port: PagePort, room: string, fields: Record<string, unknown> = {}): void {
  port.emit({ t: "room_sync_error", v: 1, room, code: "room_read_failed", ...fields });
}

function board(room: string): HTMLElement {
  const workspace = document.querySelector<HTMLButtonElement>(`button[data-wsid="${room}"]`);
  expect(workspace, `${room} should be selectable`).not.toBeNull();
  if (document.querySelector(".app")?.getAttribute("data-workspace") !== room) workspace!.click();
  const app = document.querySelector<HTMLElement>(`.app[data-workspace="${room}"]`);
  expect(app).not.toBeNull();
  if (app!.querySelector('section[aria-label="Agents"]') === null) {
    const tab = app!.querySelector<HTMLButtonElement>('button[data-nav="swarm"]');
    expect(tab).not.toBeNull();
    tab!.click();
  }
  const result = document.querySelector<HTMLElement>('section[aria-label="Agents"]');
  expect(result).not.toBeNull();
  return result!;
}

function alerts(view: HTMLElement): string[] {
  return Array.from(view.querySelectorAll('[role="alert"]'), node => node.textContent?.trim() ?? "");
}

function visibleText(root: HTMLElement): string {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const text: string[] = [];
  while (walker.nextNode()) {
    let ancestor = walker.currentNode.parentElement;
    while (ancestor !== null) {
      const style = getComputedStyle(ancestor);
      if (ancestor.hidden || style.display === "none" || style.visibility === "hidden") break;
      if (ancestor === root) {
        text.push(walker.currentNode.textContent ?? "");
        break;
      }
      ancestor = ancestor.parentElement;
    }
  }
  return text.join(" ");
}

function expectFaulted(view: HTMLElement, alert = READ_ALERT): void {
  expect(alerts(view)).toEqual([alert]);
  expect(view.textContent).not.toMatch(EMPTY_COPY);
  expect(view.textContent).not.toMatch(ZERO_TOTALS);
}

function expectHealthyEmpty(view: HTMLElement): void {
  expect(alerts(view)).toEqual([]);
  expect(view.textContent).toContain("No agents in this room");
}

function completeWithAgent(port: PagePort, room: string, agent: string): void {
  register(port, room, 1, agent, replay(port, room).rid);
  terminal(port, room, 1);
  const view = board(room);
  expect(alerts(view)).toEqual([]);
  expect(view.textContent, "the healthy fixture must render its own registered agent").toContain(agent);
}

describe("C5b production link, hosting, Wall state and Agents board", () => {
  it("M3/M5 shows a correlated cold fault without borrowing another room's inventory", async () => {
    const port = await boot();
    completeWithAgent(port, OTHER, "other-worker");
    board(DEMO);
    fault(port, DEMO, { rid: replay(port, DEMO).rid });
    const faulted = board(DEMO);
    expectFaulted(faulted);
    expect(faulted.textContent).toContain("Inventory unavailable");
    expect(faulted.textContent).not.toContain("other-worker");
    const healthy = board(OTHER);
    expect(alerts(healthy)).toEqual([]);
    expect(healthy.textContent).toContain("other-worker");
  });

  it("M5/M6 retains the last good room snapshot with a visible stale label and fixed sync text", async () => {
    const port = await boot();
    completeWithAgent(port, DEMO, "saved-worker");
    const before = board(DEMO).querySelector(".swarm-summary")?.textContent;
    expect(before).toMatch(/\b1\s+waiting\b/);
    fault(port, DEMO, { code: "room_sync_failed" });
    const hostile = "<b>private_marker</b>";
    fault(port, DEMO, { code: "room_sync_failed", message: hostile, path: hostile, event: { text: hostile } });
    register(port, DEMO, 2, "unverified-worker");
    const view = board(DEMO);
    expectFaulted(view, SYNC_ALERT);
    expect(view.textContent).toContain("saved-worker");
    expect(view.querySelector(".swarm-summary")?.textContent).toBe(before);
    expect(view.textContent).not.toContain("unverified-worker");
    expect(view.innerHTML).not.toContain("private_marker");
    expect(visibleText(view)).toMatch(/\bstale\b|\boutdated\b|\blast (?:known good|good|verified)\b/i);
  });

  it("M5 hides empty copy and zero totals when the previous healthy snapshot was empty", async () => {
    const port = await boot([DEMO]);
    terminal(port, DEMO, 0);
    expectHealthyEmpty(board(DEMO));
    fault(port, DEMO);
    expectFaulted(board(DEMO));
  });

  it("M3 ignores foreign rooms, invalid frames, and a rid outstanding only for another room", async () => {
    const port = await boot();
    const rid = replay(port, DEMO).rid;
    terminal(port, DEMO, 0, rid);
    expectHealthyEmpty(board(DEMO));
    for (const fields of [{ rid }, { rid: "obsolete" }, { rid: 9 }, { room: 9 },
      { v: 2 }, { t: "room_sync_errored" }, { room: "foreign" }]) fault(port, DEMO, fields);
    expectHealthyEmpty(board(DEMO));
    terminal(port, OTHER, 0);
    expectHealthyEmpty(board(OTHER));
  });

  it("M3 ignores a room removed from current hello membership and frames from a previous port", async () => {
    const first = await boot();
    terminal(first, DEMO, 0);
    terminal(first, OTHER, 0);
    expectHealthyEmpty(board(DEMO));
    hello(first, [OTHER]);
    fault(first, DEMO);
    const second = reconnect(first, [DEMO, OTHER]);
    expect(alerts(board(DEMO))).not.toContain(READ_ALERT);
    fault(first, DEMO, { rid: replay(second, DEMO).rid });
    fault(first, DEMO);
    expect(alerts(board(DEMO))).not.toContain(READ_ALERT);
    terminal(second, DEMO, 0);
    terminal(second, OTHER, 0);
    expectHealthyEmpty(board(DEMO));
  });

  it("M4 rejects an otherwise matching completion for a replay started before the fault", async () => {
    const port = await boot([DEMO]);
    completeWithAgent(port, DEMO, "saved-worker");
    const completed = replay(port, DEMO);
    snapshot(port);
    const old = replay(port, DEMO);
    expect(old.rid).not.toBe(completed.rid);
    fault(port, DEMO);
    register(port, DEMO, 2, "unverified-worker", old.rid);
    terminal(port, DEMO, 2, old.rid);
    expectFaulted(board(DEMO));
  });

  it("M4 stays faulted across hello, reconnect, wrong or partial completion and clears on a later qualifying replay", async () => {
    const first = await boot();
    completeWithAgent(first, DEMO, "saved-worker");
    terminal(first, OTHER, 0);
    fault(first, DEMO);
    register(first, DEMO, 2, "recovered-worker");
    hello(first);
    expectFaulted(board(DEMO));

    const second = reconnect(first);
    const firstPage = replay(second, DEMO);
    expect(firstPage.since, "recovery starts at or before the last good cursor").toBeLessThanOrEqual(1);
    expect(firstPage.since).toBeGreaterThanOrEqual(0);
    expectFaulted(board(DEMO));
    terminal(second, OTHER, 0);
    terminal(second, DEMO, 2, "obsolete");
    terminal(first, DEMO, 2, firstPage.rid);
    expectFaulted(board(DEMO));

    if (firstPage.since === 0) register(second, DEMO, 1, "saved-worker", firstPage.rid);
    register(second, DEMO, 2, "recovered-worker", firstPage.rid);
    terminal(second, DEMO, 2, firstPage.rid, true);
    expectFaulted(board(DEMO));

    const finalPage = replay(second, DEMO);
    expect(finalPage.rid).not.toBe(firstPage.rid);
    terminal(second, DEMO, 2, finalPage.rid);
    const view = board(DEMO);
    expect(alerts(view)).toEqual([]);
    expect(view.textContent).toContain("saved-worker");
    expect(view.textContent).toContain("recovered-worker");
  });

  it("M1/M5 gives a healthy replayed empty room its normal empty state", async () => {
    const port = await boot([DEMO]);
    terminal(port, DEMO, 0);
    expectHealthyEmpty(board(DEMO));
  });
});
