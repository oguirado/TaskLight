import { beforeAll, describe, expect, it } from "vitest";
import { createAgentStore } from "../../src/app/agent_store";
import { foldPlan } from "../../src/plan";
import { fixture as generate, clientFixture } from "./fixtures";
import { fixtureHash, runAdapter, semanticExpected, summarize } from "./adapter";
import type { Fixture } from "./adapter";

let fixture: Fixture;
beforeAll(() => { fixture = generate(); });

describe("deterministic synthetic fixtures and independent full-fold truth", () => {
  it("pins 10000 events, byte hash, counts and expected progress/ownership", () => {
    expect(fixture.manifest.event_count).toBe(10_000);
    expect(fixtureHash(fixture.events)).toBe(fixture.manifest.fixture_sha256);
    expect(fixture.expected.ingestion).toEqual({ accepted: 9901, duplicate: 99, invalid: 0 });
    expect(fixture.manifest.journal_bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(fixtureHash(generate().events)).toBe(fixtureHash(fixture.events));
    expect(fixtureHash(generate(10_000, 116).events)).not.toBe(fixtureHash(fixture.events));
    const mutated = structuredClone(fixture.events);
    mutated[0]!.text = "changed synthetic payload";
    expect(fixtureHash(mutated)).not.toBe(fixtureHash(fixture.events));
  });
  it("executes the real TypeScript fold against frozen expectations", () => {
    const result = runAdapter(fixture, "fold");
    expect(result.actual).toEqual(semanticExpected(fixture));
    expect(result.actual.progress_pct).toBe(50);
    expect(result.actual.owners).toEqual(["alice", null]);
    expect(result.actual.counts).toEqual({ applied: 8, rejected: 3, replayed: 0, invalid: 0 });
    expect(result.work_units).toBe(10_000);
    expect(result.peak_rss_bytes).toBeGreaterThan(0);
    expect(result.fixture_sha256).toBe(fixture.manifest.fixture_sha256);
  });
  it("detects agreeing fast no-ops and omitted accepted operations", () => {
    const noop = () => foldPlan([], fixture.template);
    expect(noop()).toEqual(noop());
    expect(summarize(noop().projection, noop().stats)).not.toEqual(semanticExpected(fixture));
    const omitted = foldPlan(fixture.events.filter(e => e.lamport !== 2), fixture.template);
    expect(summarize(omitted.projection, omitted.stats)).not.toEqual(semanticExpected(fixture));
  });
});

describe("real wall adapters and takeover-sensitive retention", () => {
  it.each(["cached-plan", "states", "ingest-read", "burst"])("validates %s before any timing can pass", variant => {
    const input = variant === "burst" ? clientFixture("burst") : fixture;
    const r = runAdapter(input, variant);
    expect(r.actual).toEqual(r.expected);
    expect(r.work_units).toBeGreaterThan(0);
    expect(r.fixture_sha256).toBe(input.manifest.fixture_sha256);
    if (variant === "ingest-read") expect(r.actual.projection.memory.goal.text).toBe("Updated synthetic goal");
    if (variant === "burst") {
      expect(r.metrics.browser_update_latency_ms).toBeNull();
      expect(r.metrics.dom_mutations_per_beat).toBeNull();
    }
  });
  it("keeps every operation plus recent display events; preserves pruned owner activity", () => {
    const store = createAgentStore({ maxPerRoom: 2, templates: () => fixture.template });
    fixture.events.forEach(e => store.ingest(e));
    const display = store.events("synthetic-bench");
    expect(display.filter(e => e.act === "op")).toHaveLength(11);
    expect(display.filter(e => e.act !== "op")).toHaveLength(2);
    expect(display.some(e => e.lamport === 9)).toBe(false);
    const result = store.plan("synthetic-bench")!;
    expect(result.projection.tasks[0]?.assignee).toBe("alice");
    expect(result.projection.rejected.map(r => r.code)).toEqual(["claimed_by_other", "stale_rev", "claimed_by_other"]);
    // A shared-list pruning mutant loses takeover-sensitive activity.
    expect(foldPlan(display, fixture.template).projection).not.toEqual(result.projection);
  });
  it("preserves late earlier events and deduplication, without trusting display order", () => {
    const store = createAgentStore({ templates: () => fixture.template });
    for (const e of [...fixture.events].reverse()) store.ingest(e);
    const before = store.plan("synthetic-bench");
    for (const e of fixture.events) expect(store.ingestChecked(e)).toBe("duplicate");
    expect(store.plan("synthetic-bench")).toEqual(before);
    expect(before?.projection.rollup.progress_pct).toBe(50);
  });
  it("rejects hostile room/markup envelopes and never executes strings", () => {
    const store = createAgentStore({ templates: () => fixture.template });
    for (const room of ["../escape", "<svg onload=alert(1)>", "bad/room"]) {
      expect(store.ingestChecked({ ...fixture.events[0], room })).toBe("invalid");
    }
    const addressed = fixture.events.find(e => e.lamport === 10)!;
    expect(store.ingestChecked(addressed)).toBe("accepted");
    expect(store.events("synthetic-bench")[0]?.text).toBe("<img src=x onerror=alert(1)>");
  });
  it("runs a bounded 100000-event client stream and records actual retention/heap telemetry", () => {
    const input = clientFixture("history");
    const result = runAdapter(input, "history");
    expect(result.fixture_sha256).toBe(input.manifest.fixture_sha256);
    expect(result.actual).toEqual(result.expected);
    expect(result.work_units).toBe(100_000);
    expect(result.metrics.client_events).toBe(100_000);
    expect(result.metrics.heap_observations).toHaveLength(Math.ceil(100_000/512));
    expect(result.metrics.retained_non_op_events).toBe(5000);
    expect(result.metrics.retained_display_bytes).toBeGreaterThan(0);
    expect(Number.isFinite(result.metrics.heap_trend_bytes_per_event)).toBe(true);
    expect(result.metrics.browser_reason).toContain("AUSENTE");
  });
});
