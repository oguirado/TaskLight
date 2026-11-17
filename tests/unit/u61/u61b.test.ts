import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentStore, toWallVM } from "../../../src/app/agent_store";
import { startAgentWall } from "../../../src/app/agent_wall";
import { deriveSwarmViewModel } from "../../../src/app/swarm_vm";
import type { AgentWall, AgentWallDeps } from "../../../src/app/agent_wall";
import type { DriftVerdict } from "../../../src/agents/types";
import type { WallVM } from "../../../src/views/types";
import { FakeAppClock } from "../u37c/harness";
import { NOW, options, projection, result } from "./helpers";

const mounted = vi.hoisted(() => ({ vms: [] as WallVM[] }));
vi.mock("../../../src/views", () => ({ mountWall: (_host: HTMLElement, vm: WallVM) => {
  mounted.vms.push(vm);
  return { update: (next: WallVM) => mounted.vms.push(next), destroy: () => {} };
} }));
let wall: AgentWall | undefined;
afterEach(() => { wall?.destroy(); wall = undefined; mounted.vms.length = 0; });

const metadata = [{ id: "notes", label: "Product decisions", required: true, max_chars: 900 }];
function plans(templateId = "web-app") {
  const p = projection();
  p.plan!.template_id = templateId;
  p.memory = { notes: { id: "notes", text: "", rev: 1, by: "alice", ts: NOW } };
  return [result(p)];
}
const verdict = (source: DriftVerdict["source"]): DriftVerdict => ({ verdict: "on_track", reason: "Reviewed", source });

describe("U61b additive planning hooks", () => {
  it("uses the plan template id to resolve memory metadata", () => {
    const lookup = vi.fn(() => metadata);
    const vm = toWallVM([], new Map(), { ...options, templateMemorySections: lookup }, plans());
    expect(lookup).toHaveBeenCalledWith("web-app");
    expect(vm.memory?.sections[0]).toMatchObject({ label: "Product decisions", required: true, maxChars: 900, empty: true });
  });
  it.each(["web-app", "neutral"])("undefined lookup preserves existing metadata for %s", id => {
    const input = plans(id);
    expect(toWallVM([], new Map(), { ...options, templateMemorySections: () => undefined }, input))
      .toEqual(toWallVM([], new Map(), options, input));
  });
  it.each([
    () => { throw new Error("lookup failed"); },
    () => new Proxy(metadata, { get() { throw new Error("hostile result"); } }),
    () => [{ ...metadata[0]!, get label(): string { throw new Error("hostile entry"); } }],
  ])("contains throwing or hostile metadata and retains the baseline VM", lookup => {
    const input = plans();
    expect(toWallVM([], new Map(), { ...options, templateMemorySections: lookup }, input))
      .toEqual(toWallVM([], new Map(), options, input));
  });
  it.each([false, true])("passes maps or getters through the wall on every render (getters=%s)", getters => {
    const input = plans();
    let verdicts = new Map([["plan:oracle:T01", verdict("cloud")]]);
    let briefs = new Map([["oracle", { text: "First brief", source: "cloud" }]]);
    const clock = new FakeAppClock(); clock.t = NOW;
    const deps = {
      wallHost: document.createElement("div"), chatHost: document.createElement("div"),
      store: Object.assign(createAgentStore(), { plans: () => input }), clock, userAgent: "human",
      reviewer: { review: async () => undefined }, link: { post: vi.fn() },
      planVerdicts: getters ? () => verdicts : verdicts,
      planBriefs: getters ? () => briefs : briefs,
      templateMemorySections: () => metadata,
    };
    wall = startAgentWall(deps as AgentWallDeps);
    expect(mounted.vms.at(-1)?.tasks[0]?.nanoVerdict?.source.kind).toBe("cloud");
    expect(mounted.vms.at(-1)?.plan?.brief).toBe("First brief");
    expect(mounted.vms.at(-1)?.memory?.sections[0]?.label).toBe("Product decisions");
    if (getters) {
      verdicts = new Map([["plan:oracle:T01", verdict("rules")]]);
      briefs = new Map([["oracle", { text: "Next brief", source: "rules" }]]);
    } else {
      verdicts.set("plan:oracle:T01", verdict("rules"));
      briefs.set("oracle", { text: "Next brief", source: "rules" });
    }
    wall.refresh();
    expect(mounted.vms.at(-1)?.tasks[0]?.nanoVerdict?.source.kind).toBe("rules");
    expect(mounted.vms.at(-1)?.plan?.brief).toBe("Next brief");
  });
  it("accepts a ReadonlyMap implementation without requiring a mutable Map", () => {
    const backing = new Map([["plan:oracle:T01", verdict("remote")]]);
    const readonly = Object.freeze({
      get: backing.get.bind(backing), has: backing.has.bind(backing), size: backing.size,
      entries: backing.entries.bind(backing), keys: backing.keys.bind(backing),
      values: backing.values.bind(backing), forEach: backing.forEach.bind(backing),
      [Symbol.iterator]: backing[Symbol.iterator].bind(backing),
    });
    const vm = toWallVM([], new Map(), { ...options, planVerdicts: readonly }, plans());
    expect(vm.tasks[0]?.nanoVerdict?.source.kind).toBe("remote");
  });
  it("absent deps preserve the existing wall VM", () => {
    const input = plans(); const clock = new FakeAppClock(); clock.t = NOW;
    wall = startAgentWall({ wallHost: document.createElement("div"), chatHost: document.createElement("div"),
      store: Object.assign(createAgentStore(), { plans: () => input }), clock, userAgent: "human",
      reviewer: { review: async () => undefined }, link: { post: vi.fn() } });
    // A-R40: Wall adds the frozen swarm projection and truthful availability; preserve every legacy field, U138 M2/M7 / U118 M5.
    const actual = mounted.vms.at(-1) as WallVM & { swarm?: ReturnType<typeof deriveSwarmViewModel>; availability?: string };
    const { swarm, availability, ...legacy } = actual;
    expect(availability).toBe("Models unavailable");
    expect(swarm).toEqual(deriveSwarmViewModel({ room: actual.workspace, projection: input[0]!.projection,
      events: [], nowMs: NOW, connected: true }));
    expect(legacy).toEqual(toWallVM([], new Map(), {
      ...options, model: { state: "unavailable", label: "" }, view: "wall", archiveScope: "workspace",
    }, input));
  });
});
