import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentStore } from "../../../src/app/agent_store";
import type { TemplateResolver } from "../../../src/app/agent_store";
import type { PlanningTemplate } from "../../../src/plan";
import { fixture, opEvent, template } from "../u85/helpers";
import { CLOCK } from "./histories";
import { observeWork } from "./instrumentation";
import { UncachedReference } from "./uncached-reference";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(CLOCK); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("A3 normalized resolver freshness", () => {
  it("A3 missing, matching, throwing and mismatched outcomes preserve complete replay diagnostics", () => {
    let mode: "missing" | "matching" | "threw" | "mismatch" = "missing";
    const source = structuredClone(template);
    const resolve: TemplateResolver = () => {
      if (mode === "threw") throw new Error("resolver failure");
      if (mode === "missing") return undefined;
      return mode === "mismatch" ? { ...source, hash: "f".repeat(64) } : source;
    };
    const resolver = vi.fn(resolve);
    const store = createAgentStore({ templates: resolver });
    const reference = new UncachedReference(resolve);
    for (const item of fixture()) { expect(store.ingest(item)).toBe(true); reference.retain(item); }
    for (const next of ["missing", "matching", "threw", "mismatch", "matching", "missing"] as const) {
      mode = next;
      const calls = resolver.mock.calls.length;
      const result = store.plan("demo");
      expect(resolver).toHaveBeenCalledTimes(calls + 1);
      expect(resolver).toHaveBeenLastCalledWith("neutral", template.hash);
      expect(result).toEqual(reference.plan("demo"));
      expect(result?.projection.tasks[0]?.assignee).toBe("alice");
      expect(result?.projection.rollup.progress_pct).toBe(50);
      expect(result?.invalidOps).toBe(0);
      expect(result?.rejectedOps).toBe(0);
      expect(result?.errors).toEqual([]);
      if (next === "matching") expect(result?.template?.name).toBe("Neutral");
      else expect(result).not.toHaveProperty("template");
      expect(store.states()).toEqual(reference.states());
    }
  });

  it("A3 resolver object replacement and in-place content changes are visible with unchanged declared hash", () => {
    let source = structuredClone(template);
    const resolver = vi.fn(() => source);
    const store = createAgentStore({ templates: resolver });
    const reference = new UncachedReference(() => source);
    for (const item of fixture()) { expect(store.ingest(item)).toBe(true); reference.retain(item); }
    const original = store.plan("demo");
    expect(original?.template?.name).toBe("Neutral");
    const hash = source.hash;
    source.name = "In-place name";
    expect(source.hash).toBe(hash);
    expect(store.plan("demo")?.template?.name, "in-place template.name freshness").toBe("In-place name");
    expect(store.plan("demo")).toEqual(reference.plan("demo"));
    source.granularity.rule = "Changed nested content";
    expect(store.plan("demo")?.template?.granularity.rule).toBe("Changed nested content");
    expect(store.plan("demo")).toEqual(reference.plan("demo"));
    source = { ...structuredClone(source), name: "Replacement name" };
    expect(store.plan("demo")?.template?.name).toBe("Replacement name");
    expect(store.plan("demo")).toEqual(reference.plan("demo"));
  });

  it("A3 template content changes refold constraints and rejection receipts without new events", () => {
    const source = structuredClone(template);
    const resolver = vi.fn(() => source);
    const store = createAgentStore({ templates: resolver });
    const reference = new UncachedReference(() => source);
    for (const item of fixture()) { expect(store.ingest(item)).toBe(true); reference.retain(item); }
    expect(store.plan("demo")?.projection.memory["goal"]?.text).toBe("Ship TaskLight");
    const cursor = store.since();
    source.memory_sections = [{ id: "goal", label: "Goal", required: true, max_chars: 1, hint: "Short" }];
    const constrained = store.plan("demo");
    expect(constrained).toEqual(reference.plan("demo"));
    expect(constrained?.projection.memory["goal"]).toBeUndefined();
    expect(constrained?.errors).toEqual([{ id: fixture()[5]!.id, lamport: 6, code: "bad_op" }]);
    expect(constrained?.rejectedOps).toBe(1);
    source.memory_sections[0]!.max_chars = 100;
    const unconstrained = store.plan("demo");
    expect(unconstrained).toEqual(reference.plan("demo"));
    expect(unconstrained?.projection.memory["goal"]?.text).toBe("Ship TaskLight");
    expect(unconstrained?.errors).toEqual([]);
    expect(store.since()).toEqual(cursor);
    expect(source.hash).toBe(template.hash);
  });

  it.each(["matching", "missing", "threw", "mismatch"] as const)("A3 stable %s outcome still calls resolver and reuses both projections", outcome => {
    const source = structuredClone(template);
    const resolver = vi.fn((): PlanningTemplate | undefined => {
      if (outcome === "threw") throw new Error("resolver failure");
      if (outcome === "missing") return undefined;
      return outcome === "mismatch" ? { ...source, hash: "f".repeat(64) } : source;
    });
    const store = createAgentStore({ templates: resolver });
    for (const item of fixture()) expect(store.ingest(item)).toBe(true);
    const work = observeWork();
    const expectedPlan = structuredClone(store.plan("demo"));
    const expectedStates = structuredClone(store.states());
    const before = work.snapshot();
    const calls = resolver.mock.calls.length;
    const repeated = Array.from({ length: 3 }, () => ({ plan: store.plan("demo"), states: store.states() }));
    const after = work.snapshot();
    expect(resolver).toHaveBeenCalledTimes(calls + 3);
    expect(repeated).toEqual(Array.from({ length: 3 }, () => ({ plan: expectedPlan, states: expectedStates })));
    expect(after, "stable events and normalized resolver outcome must reuse computed projections").toEqual(before);
  });

  it("A3 equal template snapshots with different object identity reuse projection work", () => {
    const resolver = vi.fn(() => structuredClone(template));
    const store = createAgentStore({ templates: resolver });
    for (const item of fixture()) expect(store.ingest(item)).toBe(true);
    const work = observeWork();
    const first = store.plan("demo"); store.states();
    const before = work.snapshot();
    const calls = resolver.mock.calls.length;
    const second = store.plan("demo"); store.states();
    const after = work.snapshot();
    expect(resolver).toHaveBeenCalledTimes(calls + 1);
    expect(second).toEqual(first);
    expect(after, "canonical content equality permits cache hits across replacement objects").toEqual(before);
  });

  // A-U113: SPEC_U161 makes sorted admission, rather than the latest opening, select context.
  it("M4 resolver retains the admitted sorted generation across equal-Lamport and rejected opens", () => {
    const latestTemplate = { ...structuredClone(template), id: "latest", name: "Latest" };
    const resolver = vi.fn((id: string) => id === "latest" ? latestTemplate : template);
    const store = createAgentStore({ templates: resolver });
    const reference = new UncachedReference(resolver);
    const earlier = opEvent(100, { ...fixture()[0]!.op!, template_id: "neutral" });
    const later = { ...opEvent(101, { ...fixture()[0]!.op!, template_id: "latest", title: "Latest plan" }), lamport: 100 };
    for (const item of [later, earlier]) { expect(store.ingest(item)).toBe(true); reference.retain(item); }
    const result = store.plan("demo");
    expect(resolver).toHaveBeenLastCalledWith("latest", template.hash);
    expect(result).toEqual(reference.plan("demo"));
    // A-U113: SPEC_U161 keeps the earlier admitted template after the rejected opening.
    expect(result?.template?.name).toBe("Neutral");
    // A-U113: SPEC_U161 keeps the earlier admitted plan after the rejected opening.
    expect(result?.projection.plan?.title).toBe(earlier.op!["title"]);
    // A-U113: SPEC_U161 rejects the later opening without retroactive unknown_template.
    expect(result?.errors).toEqual([{ id: later.id, lamport: 100, code: "plan_exists" }]);
    const rejectedOpen = opEvent(102, { ...later.op!, title: "Rejected open" });
    expect(store.ingest(rejectedOpen)).toBe(true); reference.retain(rejectedOpen);
    expect(store.plan("demo")).toEqual(reference.plan("demo"));
    expect(store.plan("demo")?.errors?.at(-1)?.code).toBe("plan_exists");
    expect(resolver).toHaveBeenLastCalledWith("latest", template.hash);
  });

  it("M5 template snapshots are room-local and store-local even with equal declared hashes", () => {
    const alpha = { ...structuredClone(template), id: "alpha", name: "Alpha" };
    const beta = { ...structuredClone(template), id: "beta", name: "Beta" };
    const resolver = vi.fn((id: string) => id === "alpha" ? alpha : beta);
    const store = createAgentStore({ templates: resolver });
    const reference = new UncachedReference(resolver);
    const otherSource = { ...structuredClone(alpha), name: "Other instance" };
    const other = createAgentStore({ templates: () => otherSource });
    const a = { ...opEvent(100, { ...fixture()[0]!.op!, template_id: "alpha" }), room: "alpha" };
    const b = { ...opEvent(101, { ...fixture()[0]!.op!, template_id: "beta" }), room: "beta" };
    for (const item of [b, a]) { expect(store.ingest(item)).toBe(true); reference.retain(item); }
    expect(other.ingest(a)).toBe(true);
    expect(store.plan("alpha")?.template?.name).toBe("Alpha");
    expect(store.plan("beta")?.template?.name).toBe("Beta");
    expect(other.plan("alpha")?.template?.name).toBe("Other instance");
    beta.name = "Beta changed";
    expect(store.plan("beta")?.template?.name).toBe("Beta changed");
    expect(store.plan("alpha")?.template?.name).toBe("Alpha");
    expect(other.plan("alpha")?.template?.name).toBe("Other instance");
    expect(store.plans()).toEqual(reference.plans());
  });
});
