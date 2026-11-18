import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentLink } from "../../../src/app/agent_link";
import type { AgentLink, AgentLinkDeps } from "../../../src/app/agent_link";
import { PORT_LIMITS } from "../../../src/app/wall_port";
import { EXT_ID, FakeAppClock, PagePort, pageRuntime, roomEvent } from "../u37c/harness";

const ROOM = "demo";
const PEER = "peer";
const FLOOR = "ONLY_ON_DEVICE";
const LAST_GOOD = 1;
const PREFIX = 2;
const STALE = /\bstale\b|\boutdated\b|\blast (?:known good|good|verified)\b/i;
const TIMEOUT_STEPS = 64;

interface Replay {
  rid: string;
  since: number;
}

function roomReplays(port: PagePort, room = ROOM): Replay[] {
  return port.ofType("room_sync").flatMap(frame => {
    const since = (frame["since"] as Record<string, number>)[room];
    return since === undefined ? [] : [{ rid: frame["rid"] as string, since }];
  });
}

function latestReplay(port: PagePort, room = ROOM): Replay {
  const replay = roomReplays(port, room).at(-1);
  expect(replay, "expected an outgoing room_sync for " + room).toBeDefined();
  return replay!;
}

function snapshot(port: PagePort): void {
  const hello = port.ofType("hello").at(-1);
  expect(hello?.["nonce"]).toEqual(expect.any(String));
  port.emit({ t: "snapshot", v: 1, nonce: hello!["nonce"], items: [] });
}

function hello(port: PagePort, rooms: string[]): void {
  port.emit({ t: "room_hello", v: 1, agent: "harness", rooms: rooms.map(room => ({ room, floor: FLOOR })) });
}

function terminal(port: PagePort, replay: Replay, fields: Record<string, unknown> = {}): void {
  port.emit({ t: "room_synced", v: 1, room: ROOM, rid: replay.rid, upto: PREFIX, more: false, ...fields });
}

function replayEvent(port: PagePort, replay: Replay, lamport: number): void {
  const agent = lamport === LAST_GOOD ? "saved-worker" : "prefix-worker";
  port.emit({
    t: "room_event", v: 1, room: ROOM, floor: FLOOR, rid: replay.rid,
    event: roomEvent(lamport, ROOM, {
      agent, act: "op", text: "",
      op: { kind: "agent.lifecycle", state: "deployed", run_id: "run-" + agent, op_id: "register-" + agent },
    }),
  });
}

class ReplayClock extends FakeAppClock {
  until(done: () => boolean): void {
    for (let step = 0; step < TIMEOUT_STEPS && !done(); step++) {
      const next = Math.min(...[...this.timers.values()].map(timer => timer.at));
      if (!Number.isFinite(next)) return;
      this.advance(next - this.now());
    }
  }
}

const links: AgentLink[] = [];
afterEach(() => {
  for (const link of links.splice(0)) link.stop();
});

function startLink(rooms = [ROOM]) {
  const clock = new ReplayClock();
  const runtime = pageRuntime();
  const cursors: Record<string, number> = {};
  const onFault = vi.fn();
  const onRecovered = vi.fn();
  const onSynced = vi.fn();
  const onEvent = vi.fn<AgentLinkDeps["onRoomEvent"]>(({ room, event }) => {
    const { lamport } = event as { lamport: number };
    cursors[room] = Math.max(cursors[room] ?? 0, lamport);
  });
  const link = createAgentLink({
    extId: EXT_ID, connect: runtime.connect, clock, nonce: () => "test-nonce",
    since: () => ({ ...cursors }), onRoomHello: () => undefined,
    onRoomEvent: onEvent, onRoomSynced: onSynced, onRoomSyncError: onFault,
    onRoomSyncRecovered: onRecovered,
  });
  links.push(link);
  link.start();
  const port = runtime.last();
  snapshot(port);
  clock.advance(1);
  hello(port, rooms);
  return { clock, runtime, link, port, onFault, onRecovered, onSynced, onEvent };
}

function interrupt(rooms = [ROOM]) {
  const rig = startLink(rooms);
  const { port, clock, onEvent, onFault } = rig;
  const initial = latestReplay(port);
  replayEvent(port, initial, LAST_GOOD);
  terminal(port, initial, { upto: LAST_GOOD });
  if (rooms.includes(PEER)) terminal(port, latestReplay(port, PEER), { room: PEER, upto: 0 });

  snapshot(port);
  clock.until(() => latestReplay(port).rid !== initial.rid);
  const lost = latestReplay(port);
  expect(lost.rid, "fixture must start a new replay").not.toBe(initial.rid);
  expect(lost.since).toBe(LAST_GOOD);
  replayEvent(port, lost, PREFIX);
  expect(onEvent).toHaveBeenLastCalledWith(expect.objectContaining({
    room: ROOM, rid: lost.rid, event: expect.objectContaining({ lamport: PREFIX }),
  }));
  expect(onFault, "a delivered prefix is healthy until the deadline").not.toHaveBeenCalled();
  return { ...rig, lost };
}

function expire(rig: ReturnType<typeof interrupt>): void {
  rig.clock.until(() => rig.onFault.mock.calls.length > 0);
  expect(rig.onFault, "a delivered prefix without a terminal must expire as a room fault")
    .toHaveBeenCalledWith(expect.objectContaining({ room: ROOM }));
  expect(rig.onRecovered).not.toHaveBeenCalled();
}

function recoverFrom(port: PagePort, clock: ReplayClock, expired: Replay): Replay {
  // A snapshot requests sync on the existing port without resetting hello membership.
  if (latestReplay(port).rid === expired.rid) {
    snapshot(port);
    clock.until(() => latestReplay(port).rid !== expired.rid);
  }
  const retry = latestReplay(port);
  expect(retry.rid, "the expired request must release its room for a fresh request").not.toBe(expired.rid);
  expect(retry.since).toBeGreaterThanOrEqual(0);
  expect(retry.since, "recovery must cover the unverified prefix").toBeLessThanOrEqual(LAST_GOOD);
  return retry;
}

function replayMissing(port: PagePort, retry: Replay): void {
  if (retry.since < LAST_GOOD) replayEvent(port, retry, LAST_GOOD);
  replayEvent(port, retry, PREFIX);
}

describe("R52S room replay deadline", () => {
  it("releases the expired replay and retries from the last verified coverage", () => {
    const rig = interrupt();
    expire(rig);
    const retry = recoverFrom(rig.port, rig.clock, rig.lost);
    replayMissing(rig.port, retry);
    terminal(rig.port, retry);
    expect(rig.onRecovered.mock.calls).toEqual([[ROOM]]);
  });

  it("keeps the fault when another room completes a valid replay", () => {
    const rig = interrupt([ROOM, PEER]);
    const previousPeer = latestReplay(rig.port, PEER);
    expire(rig);
    const retry = recoverFrom(rig.port, rig.clock, rig.lost);

    rig.port.emit({ t: "room_event", v: 1, room: PEER, floor: FLOOR, event: roomEvent(1, PEER) });
    snapshot(rig.port);
    rig.clock.until(() => latestReplay(rig.port, PEER).rid !== previousPeer.rid);
    const peer = latestReplay(rig.port, PEER);
    expect(peer.rid).not.toBe(previousPeer.rid);
    terminal(rig.port, peer, { room: PEER, upto: 1 });
    expect(rig.onSynced).toHaveBeenLastCalledWith(expect.objectContaining({ room: PEER, rid: peer.rid }));
    expect(rig.onRecovered).not.toHaveBeenCalled();

    replayMissing(rig.port, retry);
    terminal(rig.port, retry);
    expect(rig.onRecovered.mock.calls).toEqual([[ROOM]]);
  });

  it.each([
    ["the expired request completes late", null],
    ["a foreign room is supplied", { room: "foreign" }],
    ["a terminal with nonboolean more arrives", { more: "false" }],
  ] as const)("keeps the fault when %s", (_name, fields) => {
    const rig = interrupt();
    expire(rig);
    const retry = recoverFrom(rig.port, rig.clock, rig.lost);
    replayMissing(rig.port, retry);
    if (fields === null) terminal(rig.port, rig.lost);
    else terminal(rig.port, retry, fields);
    expect(rig.onRecovered).not.toHaveBeenCalled();
    terminal(rig.port, retry);
    expect(rig.onRecovered.mock.calls).toEqual([[ROOM]]);
  });

  it("ignores a matching terminal from the previous port", () => {
    const rig = interrupt();
    expire(rig);
    rig.port.drop();
    rig.clock.advance(PORT_LIMITS.RECONNECT_RETRY_MS);
    const current = rig.runtime.last();
    expect(current).not.toBe(rig.port);
    snapshot(current);
    rig.clock.advance(1);
    hello(current, [ROOM]);
    const retry = latestReplay(current);
    replayMissing(current, retry);

    terminal(rig.port, retry);
    expect(rig.onRecovered).not.toHaveBeenCalled();
    terminal(current, retry);
    expect(rig.onRecovered.mock.calls).toEqual([[ROOM]]);
  });

  it("keeps the fault through a continuation until its final page arrives", () => {
    const rig = interrupt();
    expire(rig);
    const retry = recoverFrom(rig.port, rig.clock, rig.lost);
    replayMissing(rig.port, retry);
    terminal(rig.port, retry, { more: true });
    expect(rig.onRecovered).not.toHaveBeenCalled();
    const continuation = latestReplay(rig.port);
    expect(continuation.rid).not.toBe(retry.rid);
    expect(continuation.since).toBe(PREFIX);

    terminal(rig.port, retry);
    expect(rig.onRecovered).not.toHaveBeenCalled();
    terminal(rig.port, continuation);
    expect(rig.onRecovered.mock.calls).toEqual([[ROOM]]);
  });

  it("cancels an in-flight deadline on disconnect and preserves reconnect", () => {
    const rig = interrupt();
    const before = roomReplays(rig.port);
    rig.port.drop();

    const idle = startLink();
    terminal(idle.port, latestReplay(idle.port), { upto: 0 });
    idle.port.drop();
    expect(rig.clock.pending(), "an interrupted replay must leave no timers beyond normal reconnect")
      .toBe(idle.clock.pending());

    rig.clock.advance(PORT_LIMITS.RECONNECT_RETRY_MS);
    const current = rig.runtime.last();
    expect(current).not.toBe(rig.port);
    snapshot(current);
    rig.clock.until(() => false);
    expect(roomReplays(rig.port)).toEqual(before);
    expect(rig.onFault).not.toHaveBeenCalled();
    expect(rig.onRecovered).not.toHaveBeenCalled();
  });

  it("cancels an in-flight deadline on stop", () => {
    const rig = interrupt();
    const before = roomReplays(rig.port);
    rig.link.stop();
    expect(rig.clock.pending(), "stopping the link must cancel its timers").toBe(0);
    terminal(rig.port, rig.lost);
    rig.clock.until(() => false);
    expect(roomReplays(rig.port)).toEqual(before);
    expect(rig.onFault).not.toHaveBeenCalled();
    expect(rig.onRecovered).not.toHaveBeenCalled();
  });

  it("accepts an on-time terminal without a later fault or retry", () => {
    const rig = interrupt();
    terminal(rig.port, rig.lost);
    expect(rig.onSynced).toHaveBeenLastCalledWith(expect.objectContaining({
      room: ROOM, rid: rig.lost.rid, upto: PREFIX, more: false,
    }));
    const before = roomReplays(rig.port);
    rig.clock.until(() => false);
    expect(roomReplays(rig.port)).toEqual(before);
    expect(rig.onFault).not.toHaveBeenCalled();
    expect(rig.onRecovered).not.toHaveBeenCalled();
  });
});

const hosting = vi.hoisted(() => ({ link: undefined as AgentLink | undefined }));
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
vi.mock("../../../src/app/agent_link", async importOriginal => {
  const real = await importOriginal<typeof import("../../../src/app/agent_link")>();
  return { ...real, createAgentLink: (deps: AgentLinkDeps) => {
    const link = real.createAgentLink(deps);
    hosting.link = link;
    return link;
  } };
});

function board(): HTMLElement {
  const agents = document.querySelector<HTMLElement>('section[aria-label="Agents"]');
  expect(agents, "the production Agents board should render").not.toBeNull();
  return agents!;
}

function visibleBoardText(): string {
  const root = board();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const visible: string[] = [];
  while (walker.nextNode()) {
    for (let element = walker.currentNode.parentElement; element !== null; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (element.hidden || style.display === "none" || style.visibility === "hidden") break;
      if (element === root) {
        visible.push(walker.currentNode.textContent ?? "");
        break;
      }
    }
  }
  return visible.join(" ");
}

function advanceBrowserClockUntil(done: () => boolean): void {
  for (let step = 0; step < TIMEOUT_STEPS && !done(); step++) {
    vi.advanceTimersToNextTimer();
  }
}

it("shows stale inventory and retains the verified bubble until replay completes", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_001_000);
  const port = new PagePort();
  const fetch = vi.fn(() => { throw new Error("The oracle uses a fake port"); });
  const observers: MutationObserver[] = [];
  const NativeObserver = globalThis.MutationObserver;
  vi.stubGlobal("MutationObserver", class extends NativeObserver {
    constructor(callback: MutationCallback) {
      super(callback);
      observers.push(this);
    }
  });
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("chrome", { runtime: { connect: () => port } });
  document.body.replaceChildren(Object.assign(document.createElement("div"), { id: "wall" }));

  try {
    await import("../../../hosting/src/main");
    snapshot(port);
    vi.advanceTimersByTime(1);
    hello(port, [ROOM]);
    const initial = latestReplay(port);
    replayEvent(port, initial, LAST_GOOD);
    terminal(port, initial, { upto: LAST_GOOD });

    const nav = document.querySelector<HTMLButtonElement>('button[data-nav="swarm"]');
    expect(nav).not.toBeNull();
    nav!.click();
    expect(board().textContent).toContain("saved-worker");
    expect(board().textContent).not.toMatch(STALE);

    snapshot(port);
    vi.advanceTimersByTime(1);
    const lost = latestReplay(port);
    expect(lost.rid).not.toBe(initial.rid);
    replayEvent(port, lost, PREFIX);
    expect(board().textContent).not.toMatch(STALE);

    advanceBrowserClockUntil(() => STALE.test(board().textContent ?? ""));
    expect(visibleBoardText(), "a missing replay terminal must render a visible stale label").toMatch(STALE);
    expect(visibleBoardText()).toContain("saved-worker");

    if (latestReplay(port).rid === lost.rid) {
      snapshot(port);
      advanceBrowserClockUntil(() => latestReplay(port).rid !== lost.rid);
    }
    const retry = latestReplay(port);
    expect(retry.rid).not.toBe(lost.rid);
    replayMissing(port, retry);
    expect(visibleBoardText()).toMatch(STALE);
    terminal(port, retry);
    expect(visibleBoardText()).not.toMatch(STALE);
    expect(visibleBoardText()).toContain("saved-worker");
    expect(visibleBoardText()).toContain("prefix-worker");
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    hosting.link?.stop();
    for (const observer of observers) observer.disconnect();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  }
});
