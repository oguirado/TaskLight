import { describe, expect, it, vi } from "vitest";
import { startAgentWall, type WorkspaceStatus } from "../../../src/app/agent_wall";
import type { RoomEvent } from "../../../src/agents/types";
import { clock, dataFixture, observation } from "../u125/fixtures";
import { deterministic, visibleText } from "../v1/helpers";

type View = "wall" | "swarm";

const WORKER = "first-worker";
const NEW_WORKER = "second-worker";
const READ_ERROR = "Can't read this workspace: Room data could not be read.";
const SYNC_ERROR = "Can't read this workspace: Syncing workspace";

function register(data: ReturnType<typeof dataFixture>, agent: string, state: "deployed" | "failed" = "deployed") {
  data.emit({ kind: "agent.lifecycle", state, run_id: "run-" + agent, op_id: state + "-" + agent }, "demo", agent);
}

function mount(view: View, data: ReturnType<typeof dataFixture>, status?: WorkspaceStatus) {
  const host = document.createElement("div");
  const chatHost = document.createElement("div");
  document.body.append(host, chatHost);
  const wall = startAgentWall({
    wallHost: host, chatHost, store: data.store, initialView: view, clock, userAgent: "wall-user",
    reviewer: { review: vi.fn(async () => undefined) },
    link: { post: vi.fn(), hasUnverifiedReplay: () => false },
    ...(status === undefined ? {} : { workspaceStatus: () => status }),
  });
  function open(next: View) {
    if (host.querySelector(".app")?.getAttribute("data-view") !== next) {
      host.querySelector<HTMLButtonElement>(`button[data-nav="${next}"]`)!.click();
    }
  }
  function board() {
    open("swarm");
    const panel = host.querySelector<HTMLElement>('.app[data-view="swarm"] section[aria-label="Agents"]');
    expect(panel).not.toBeNull();
    return visibleText(panel!);
  }
  return { open, board, refresh: wall.refresh, destroy: wall.destroy };
}

function expectUnavailable(board: string, reason: string) {
  expect(board).toContain(reason);
  expect(board).toContain("Inventory unavailable");
  expect(board).not.toContain("0 working · 0 waiting · 0 finished");
  expect(board).not.toContain(WORKER);
}

describe.each(["swarm", "wall"] as const)("Agents preview with %s opened first", firstView => {
  deterministic();

  it.each([false, true])("suppresses uncertified zero totals (verified before sync: %s)", verified => {
    const data = dataFixture();
    const status = observation();
    if (!verified) status.synced = [];
    const wall = mount(firstView, data, status);
    try {
      if (verified) expect(wall.board()).toContain("0 working · 0 waiting · 0 finished");
      status.synced = [];
      wall.refresh();
      expectUnavailable(wall.board(), SYNC_ERROR);
      wall.open("wall");
      expectUnavailable(wall.board(), SYNC_ERROR);
    } finally { wall.destroy(); }
  });

  it("keeps the verified inventory stale during resync", () => {
    const data = dataFixture();
    const status = observation();
    register(data, WORKER);
    const wall = mount(firstView, data, status);
    try {
      status.synced = [];
      register(data, NEW_WORKER);
      wall.refresh();
      const assertStale = (board: string) => {
        expect(board).toContain(SYNC_ERROR);
        expect(board).toContain("Last verified inventory (stale)");
        expect(board).toContain(WORKER);
        expect(board).not.toContain(NEW_WORKER);
      };
      assertStale(wall.board());
      wall.open("wall");
      assertStale(wall.board());
    } finally { wall.destroy(); }
  });

  it("reads current live inventory before replay completes", () => {
    const data = dataFixture();
    register(data, WORKER);
    const wall = mount(firstView, data, { ...observation(), synced: [] });
    try {
      const before = wall.board();
      expect(before).toContain(WORKER);
      expect(before).toContain(SYNC_ERROR);
      expect(before).not.toContain(NEW_WORKER);
      wall.open("wall");
      expect(wall.board()).toBe(before);
      wall.open("wall");
      register(data, WORKER, "failed");
      register(data, NEW_WORKER);
      wall.refresh();
      const after = wall.board();
      expect(after).toContain(NEW_WORKER);
      expect(after).toContain("1 failed");
      expect(after).toContain(SYNC_ERROR);
      expect(after).not.toContain("Last verified inventory");
    } finally { wall.destroy(); }
  });

  it.each([true, false])("reports a missing projection even before sync (status provided: %s)", observed => {
    const data = dataFixture();
    const status = observed ? observation() : undefined;
    register(data, WORKER);
    data.store.plan.mockReturnValue(undefined);
    const wall = mount(firstView, data, status);
    try {
      expectUnavailable(wall.board(), READ_ERROR);
      if (status !== undefined) status.synced = [];
      wall.refresh();
      wall.open("wall");
      const board = wall.board();
      expectUnavailable(board, READ_ERROR);
      expect(board).not.toContain(SYNC_ERROR);
    } finally { wall.destroy(); }
  });

  it("reports malformed event entries on mount and refresh", () => {
    const data = dataFixture();
    data.store.plan.mockReturnValue(undefined);
    data.store.events.mockReturnValue([null as unknown as RoomEvent]);
    const wall = mount(firstView, data, observation());
    try {
      expectUnavailable(wall.board(), READ_ERROR);
      wall.refresh();
      expectUnavailable(wall.board(), READ_ERROR);
    } finally { wall.destroy(); }
  });
});
