import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanProjectionResult } from "../../../src/app/agent_store";
import type { AgentState } from "../../../src/agents/types";
import { createAgentStore } from "../../../src/app/agent_store";
import { fixture, template } from "../u85/helpers";
import { CLOCK } from "./histories";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(CLOCK); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function assertionReceipt(caseId: string, mutation: string, assertion: () => void): void {
  let failure: unknown;
  try { assertion(); } catch (error) { failure = error; }
  // A setup/import/runtime exception cannot pass as a detected semantic mutation.
  expect(failure, "the deliberately broken cache must trigger a test assertion").toBeInstanceOf(Error);
  const error = failure as Error;
  expect(error.name).toBe("AssertionError");
  console.info("U113_NEGATIVE_CONTROL", JSON.stringify({ case: caseId, mutation,
    status: "DETECTED", error: error.name, assertion: error.message.split("\n")[0] }));
}

describe("A2 and A3 negative controls", () => {
  it("A2 rejects a cache invalidated only by maximum Lamport and records the assertion receipt", () => {
    const store = createAgentStore({ templates: () => structuredClone(template) });
    const events = fixture();
    const claim = events.find(item => item.op?.kind === "task.claim")!;
    for (const item of events.filter(item => item.id !== claim.id)) expect(store.ingest(item)).toBe(true);
    let watermark: number | undefined;
    let cachedPlan: PlanProjectionResult | undefined;
    let cachedStates: AgentState[] = [];
    const brokenRead = () => {
      const current = store.since()["demo"];
      if (watermark !== current) {
        watermark = current;
        cachedPlan = structuredClone(store.plan("demo"));
        cachedStates = structuredClone(store.states());
      }
      return { plan: structuredClone(cachedPlan), states: structuredClone(cachedStates) };
    };
    expect(brokenRead().plan?.projection.tasks[0]?.assignee).toBeNull();
    const before = store.since();
    expect(store.ingestChecked(claim)).toBe("accepted");
    expect(store.since()).toEqual(before);
    const actual = store.plan("demo");
    expect(actual?.projection.tasks[0]?.assignee).toBe("alice");
    assertionReceipt("A2", "invalidate-only-on-maximum-lamport", () => {
      expect(brokenRead().plan?.projection.tasks.find(task => task.id === "T01")?.assignee,
        "late accepted claim must assign T01 to alice").toBe("alice");
    });
  });

  it("A3 rejects a template cache comparing identity/id/hash without content and records the assertion receipt", () => {
    const source = structuredClone(template);
    const store = createAgentStore({ templates: () => source });
    for (const item of fixture()) expect(store.ingest(item)).toBe(true);
    let previous: typeof source | undefined;
    let cached: PlanProjectionResult | undefined;
    const brokenRead = () => {
      if (source !== previous) {
        previous = source;
        cached = structuredClone(store.plan("demo"));
      }
      return structuredClone(cached);
    };
    expect(brokenRead()?.template?.name).toBe("Neutral");
    const hash = source.hash;
    source.name = "In-place name";
    expect(source.hash).toBe(hash);
    expect(store.plan("demo")?.template?.name).toBe("In-place name");
    assertionReceipt("A3", "template-content-comparison-disabled", () => {
      expect(brokenRead()?.template?.name, "in-place template.name freshness").toBe("In-place name");
    });
  });
});
