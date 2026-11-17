// Frozen before candidate tests were authored. Baseline: src/app/agent_store.ts,
// compareEvents and createAgentStore states/plan/plans; no candidate store calls.
// Admission is asserted separately by tests; retain receives known accepted events.
import { foldRoomWithStats } from "../../../src/agents";
import { foldPlan } from "../../../src/plan";
import type { AgentState, RoomEvent } from "../../../src/agents/types";
import type { PlanProjectionResult, TemplateResolver } from "../../../src/app/agent_store";

// Capture the real reducers before test-local spies instrument candidate calls.
const replayStates = foldRoomWithStats;
const replayPlan = foldPlan;
const compare = (a: RoomEvent, b: RoomEvent): number =>
  a.lamport !== b.lamport ? a.lamport - b.lamport : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export class UncachedReference {
  private readonly rooms = new Map<string, RoomEvent[]>();
  private readonly ids = new Set<string>();
  constructor(private readonly resolver?: TemplateResolver) {}

  retain(event: RoomEvent): void {
    if (this.ids.has(event.id)) return;
    this.ids.add(event.id);
    let events = this.rooms.get(event.room);
    if (events === undefined) {
      events = [];
      this.rooms.set(event.room, events);
    }
    events.push(structuredClone(event));
  }

  since(): Record<string, number> {
    return Object.fromEntries([...this.rooms].map(([room, events]) =>
      [room, Math.max(...events.map(event => event.lamport))]));
  }

  states(): AgentState[] {
    return structuredClone(replayStates([...this.rooms.values()].flat()).states);
  }

  plan(room: string): PlanProjectionResult | undefined {
    const events = this.rooms.get(room);
    if (events === undefined || events.length === 0) return undefined;
    const sorted = [...events].sort(compare);
    if (!sorted.some(event => event.act === "op")) return undefined;
    // A-U113: SPEC_U161 replaces latest-opening replay with admitted-generation templates.
    const templates = new Map<string, ReturnType<TemplateResolver>>();
    for (const event of sorted) {
      const op = event.op as Record<string, unknown> | undefined;
      if (event.act !== "op" || op?.["kind"] !== "plan.open") continue;
      const id = op["template_id"], hash = op["template_hash"];
      if (typeof id !== "string" || typeof hash !== "string") continue;
      const key = JSON.stringify([id, hash]);
      if (templates.has(key)) continue;
      let candidate: ReturnType<TemplateResolver>;
      try {
        const resolved = this.resolver?.(id, hash);
        if (resolved !== null && typeof resolved === "object" && !Array.isArray(resolved)
            && resolved.hash === hash) candidate = resolved;
      } catch { /* Preserve the existing unavailable-template behavior. */ }
      templates.set(key, candidate);
    }
    const result = this.resolver === undefined ? replayPlan(sorted)
      : replayPlan(sorted, (id, hash) => templates.get(JSON.stringify([id, hash])));
    const plan = result.projection.plan;
    const template = plan !== null
      ? templates.get(JSON.stringify([plan.template_id, plan.template_hash]))
      : undefined;
    return structuredClone({
      room, source: "v2", projection: result.projection, invalidOps: result.stats.invalid,
      rejectedOps: result.stats.rejected, errors: result.stats.errors,
      ...(template === undefined ? {} : { template }),
    });
  }

  plans(): PlanProjectionResult[] {
    const result: PlanProjectionResult[] = [];
    for (const room of [...this.rooms.keys()].sort()) {
      const plan = this.plan(room);
      if (plan !== undefined) result.push(plan);
    }
    return result;
  }
}
