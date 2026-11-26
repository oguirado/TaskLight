import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAgentWall, type AgentWall, type AgentWallDeps } from "../../../src/app/agent_wall";
import { clock, dataFixture, observation } from "../u125/fixtures";

const walls: AgentWall[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const wall of walls.splice(0)) wall.destroy();
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.replaceChildren();
});

function start(
  status = observation(),
  data = dataFixture(),
  options: Pick<AgentWallDeps, "initialView"> = {},
  hasUnverifiedReplay?: AgentWallDeps["link"]["hasUnverifiedReplay"],
) {
  const wallHost = document.createElement("div");
  const chatHost = document.createElement("div");
  document.body.append(wallHost, chatHost);
  const wall = startAgentWall({
    wallHost,
    chatHost,
    userAgent: "wall-user",
    store: data.store,
    clock,
    link: {
      post: vi.fn(async () => ({ ok: true as const, id: "e-0000000000000001", lamport: 1 })),
      ...(hasUnverifiedReplay === undefined ? {} : { hasUnverifiedReplay }),
    },
    reviewer: { review: vi.fn(async () => undefined) },
    workspaceStatus: () => status,
    ...options,
  });
  walls.push(wall);
  return { wall, wallHost };
}

describe("R52B Agents fallback controls", () => {
  it("keeps the Agents view usable when replay status is unavailable", () => {
    const readReplayStatus = vi.fn(() => {
      throw new Error("Replay status unavailable");
    });
    const { wall, wallHost } = start(observation(), dataFixture(), {}, readReplayStatus);
    expect(readReplayStatus).toHaveBeenCalledWith("demo");
    expect(() => wall.refresh()).not.toThrow();
    expect(wallHost.querySelector('section[aria-label="Agents"]')).not.toBeNull();
  });

  it("discards an unverified Wall snapshot while Agents waits for synchronization", () => {
    const status = { ...observation(), synced: [] };
    const data = dataFixture();
    data.emit({
      kind: "agent.lifecycle", state: "deployed", run_id: "preview-run", op_id: "preview-registration",
    }, "demo", "preview-worker");
    const { wallHost } = start(status, data, { initialView: "wall" });
    expect(wallHost.textContent).toContain("preview-worker");
    const agentsView = wallHost.querySelector<HTMLButtonElement>('button[data-nav="swarm"]');
    expect(agentsView).not.toBeNull();
    agentsView!.click();
    const board = wallHost.querySelector('section[aria-label="Agents"]');
    expect(board).not.toBeNull();
    expect(board!.textContent).not.toContain("preview-worker");
  });
});
