import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAgentWall, WALL_REFRESH_MS } from "../../../src/app/agent_wall";
import type { AgentWall, AgentWallDeps } from "../../../src/app/agent_wall";
import { createAgentStore } from "../../../src/app/agent_store";
import type { WallVM, WallHandlers } from "../../../src/views/types";
import { FakeAppClock, settle } from "../u37c/harness";
import { legacyEvents, NOW, opEvent, openOp, projection, result } from "./helpers";
import type { ExtendedVM, ProjectionResult } from "./helpers";

const mount = vi.hoisted(() => ({ vms: [] as ExtendedVM[], handlers: undefined as WallHandlers | undefined,
  destroy: vi.fn() }));
vi.mock("../../../src/views", () => ({
  mountWall: (_host: HTMLElement, vm: WallVM, handlers: WallHandlers) => {
    mount.vms.push(vm as unknown as ExtendedVM); mount.handlers = handlers;
    return { update: (v: WallVM) => mount.vms.push(v as unknown as ExtendedVM), destroy: mount.destroy };
  },
}));

let wall: AgentWall | undefined;
beforeEach(() => { mount.vms.length = 0; mount.handlers = undefined; mount.destroy.mockClear(); });
afterEach(async () => { wall?.destroy(); wall = undefined; await settle(); document.body.replaceChildren(); vi.restoreAllMocks(); });
function setup(plans: ProjectionResult[] = [result(projection())], extra: Record<string, unknown> = {}) {
  const store = createAgentStore(); const getPlans = vi.fn(() => plans);
  const extendedStore = Object.assign(store, { plans: getPlans });
  const wallHost = document.createElement("div"); const chatHost = document.createElement("div"); document.body.append(wallHost, chatHost);
  const clock = new FakeAppClock(); clock.t = NOW;
  const post = vi.fn(async () => ({ ok: true as const, id: "e-0000000000000010", lamport: 16 }));
  const deps = { wallHost, chatHost, store: extendedStore, clock, userAgent: "human", link: { post }, reviewer: { review: async () => undefined }, ...extra };
  return { store, plans, getPlans, wallHost, chatHost, clock, post, deps };
}
function latest(): ExtendedVM { expect(mount.vms.length).toBeGreaterThan(0); return mount.vms.at(-1)!; }

describe("O11 wall integration with fake renderer and clock ports", () => {
  it("O11 reads store.plans and sends v2 and legacy content to mountWall", async () => {
    const h = setup(); legacyEvents().forEach(e => h.store.ingest(e));
    wall = startAgentWall(h.deps); await settle();
    expect(h.getPlans).toHaveBeenCalled(); expect(latest().plan?.title).toBe("Plan");
    expect(latest().tasks.map(t => t.title)).toEqual(expect.arrayContaining(["Action", "Legacy twelve"]));
    expect(h.post).not.toHaveBeenCalled();
  });
  it("O11 refresh projects newly ingested op room state", async () => {
    const h = setup([]); wall = startAgentWall(h.deps); await settle();
    expect(h.store.ingest(opEvent(1, openOp()))).toBe(true);
    h.plans.push(result(projection("plan_open"))); wall.refresh(); await settle();
    expect(latest().plan?.title).toBe("Plan");
  });
  it("O11 interval refreshes Plan projections at WALL_REFRESH_MS", async () => {
    const h = setup(); wall = startAgentWall(h.deps); await settle();
    const p = projection(); h.plans.splice(0, 1, result({ ...p, plan: { ...p.plan!, title: "Updated plan" } }));
    const before = mount.vms.length; h.clock.advance(WALL_REFRESH_MS - 1); await settle();
    expect(mount.vms).toHaveLength(before); h.clock.advance(1); await settle();
    expect(latest().plan?.title).toBe("Updated plan");
  });
  it("O11 destroy cancels the interval, destroys handles, cleans drawer attributes and prevents later work", async () => {
    const h = setup([]); wall = startAgentWall(h.deps); await settle();
    expect(h.clock.pending()).toBe(1); wall.destroy(); wall.destroy();
    expect(h.clock.pending()).toBe(0); expect(mount.destroy).toHaveBeenCalledTimes(1);
    for (const attr of ["data-open", "role", "aria-label"]) expect(h.chatHost.hasAttribute(attr)).toBe(false);
    expect(h.chatHost.classList.contains("chat-drawer")).toBe(false);
    const before = mount.vms.length; h.clock.advance(WALL_REFRESH_MS); wall.refresh(); await settle();
    expect(mount.vms).toHaveLength(before);
  });
  it.each(["onView", "onWorkspace", "onArchiveScope"] as const)("O11 %s changes local selection and re-renders", async name => {
    const h = setup([result(projection(), "first"), result(projection(), "second")]); wall = startAgentWall(h.deps); await settle();
    const handlers = mount.handlers!; expect(handlers[name]).toBeTypeOf("function"); const before = mount.vms.length;
    if (name === "onView") { handlers.onView!("agenda"); expect(latest().view).toBe("agenda"); }
    if (name === "onWorkspace") { handlers.onWorkspace!("second"); expect(latest().workspace).toBe("second"); }
    if (name === "onArchiveScope") { handlers.onArchiveScope!("all"); expect(latest().archiveScope).toBe("all"); }
    expect(mount.vms.length).toBeGreaterThan(before);
  });
  it("O11 optional initialView reaches the renderer", async () => {
    const h = setup([], { initialView: "agenda" }); wall = startAgentWall(h.deps as AgentWallDeps); await settle();
    expect(latest().view).toBe("agenda");
  });
  it("O11 legacy task selection opens chat; unknown IDs are ignored", async () => {
    const h = setup([]); legacyEvents().forEach(e => h.store.ingest(e)); wall = startAgentWall(h.deps); await settle();
    const open = mount.handlers!.onOpenTask; expect(open).toBeTypeOf("function");
    for (const id of ["unknown", "plan:missing:T99", "agent:legacy:human", "agent:missing:alice"]) expect(() => open!(id)).not.toThrow();
    expect(h.chatHost.getAttribute("data-open")).toBe("false"); open!("agent:legacy:alice");
    expect(h.chatHost.getAttribute("data-open")).toBe("true"); expect(h.chatHost.getAttribute("aria-label")).toBe("Legacy twelve");
  });
});

describe("O13 Stop rule 1 source surface", () => {
  it.each(["src/agents/types.ts", "src/app/agent_store.ts", "src/app/agent_wall.ts"])("O13 %s contains no prohibited executable identifiers", path => {
    const source = readFileSync(resolve(__dirname, "../../..", path), "utf8");
    const executable = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(executable).not.toMatch(/\b(?:innerHTML|eval|Function|fetch|XMLHttpRequest)\b/);
  });
});
