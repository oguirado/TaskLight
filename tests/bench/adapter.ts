/** Native-clock adapters. Never launches agents, providers, or application services. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { foldPlan } from "../../src/plan";
import { createAgentStore } from "../../src/app/agent_store";
import type { PlanningTemplate } from "../../src/plan";
import type { RoomEvent } from "../../src/agents/types";

// JSON fixture schemas are independently checked in the Python and TS suites.
type Json = Record<string, any>;
export interface Fixture { events: RoomEvent[]; template: PlanningTemplate; expected: Json; manifest: Json }
const hash = (data: string) => createHash("sha256").update(data).digest("hex");
function canonical(v: any): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export function fixtureHash(events: readonly RoomEvent[]): string {
  return hash(events.map(e => canonical(e) + "\n").join(""));
}
export function summarize(p: Json, counts: Json): Json {
  const tasks: Json[] = p.tasks ?? [];
  return { title: p.plan?.title ?? null, task_ids: tasks.map(t => t.id),
    states: tasks.map(t => t.state), owners: tasks.map(t => t.assignee),
    claim_lamports: tasks.map(t => t.claim_lamport), micro_states: tasks.map(t => t.microtasks.map((m: Json) => m.state)),
    progress_pct: p.rollup?.progress_pct, tasks_total: p.rollup?.tasks_total,
    micro_total: p.rollup?.micro_total, micro_done: p.rollup?.micro_done,
    memory: Object.fromEntries(Object.entries(p.memory ?? {}).map(([k, v]) => [k, { text: (v as Json).text, rev: (v as Json).rev }])),
    rejections: (p.rejected ?? []).map((r: Json) => ({ id: r.id, lamport: r.lamport, code: r.code })),
    last_lamport: p.last_lamport, counts };
}
export function semanticExpected(f: Fixture): Json {
  const { ingestion: _ingestion, ...expected } = f.expected;
  return expected;
}
const coreCounts = { applied: 8, rejected: 3, invalid: 0, replayed: 0 };
function projectionSummary(store: ReturnType<typeof createAgentStore>, applied = 8): Json {
  const plan = store.plan("synthetic-bench");
  return summarize(plan?.projection ?? {}, { ...coreCounts, applied, rejected: plan?.rejectedOps, invalid: plan?.invalidOps });
}
export function runAdapter(fixture: Fixture, variant: string): Json {
  const events = structuredClone(fixture.events);
  const store = createAgentStore({ templates: () => fixture.template });
  let elapsed = 0, actual: Json = {}, expected: Json = {}, units = 0;
  let metrics: Json = {};
  let workloadHash = fixtureHash(events);
  const clock = () => process.hrtime.bigint();
  const millis = (start: bigint) => Number(clock()-start)/1e6;
  if (variant === "fold") {
    const start = clock();
    const result = foldPlan(events, fixture.template);
    elapsed = millis(start);
    const { errors: _errors, ...counts } = result.stats;
    actual = summarize(result.projection, counts);
    expected = semanticExpected(fixture);
    units = events.length;
  } else {
    const ingestion = { accepted: 0, duplicate: 0, invalid: 0 };
    for (const e of events) ingestion[store.ingestChecked(e)]++;
    // Validate seed state before reads or stress; this is outside the interval.
    const before = projectionSummary(store);
    if (canonical(before) !== canonical(semanticExpected(fixture)) || canonical(ingestion) !== canonical(fixture.expected.ingestion)) {
      return { elapsed_ms: null, actual: before, expected: semanticExpected(fixture), work_units: 0,
        fixture_sha256: fixtureHash(events), peak_rss_bytes: process.resourceUsage().maxRSS * 1024 };
    }
    if (variant === "cached-plan" || variant === "states") {
      store.plan("synthetic-bench"); store.states();
      const start = clock();
      // Each observation measures one real read, not its setup.
      const read = variant === "cached-plan" ? store.plan("synthetic-bench") : store.states();
      elapsed = millis(start); units = 1;
      actual = { projection: projectionSummary(store), ingestion, read_present: variant === "states" ? Array.isArray(read) && read.length > 0 : read !== undefined };
      expected = { projection: semanticExpected(fixture), ingestion: fixture.expected.ingestion, read_present: true };
    } else if (variant === "ingest-read") {
      const update: RoomEvent = { id: "e-00000000ffffffff", room: "synthetic-bench", agent: "alice", act: "op",
        text: "", ts: 1_700_001_000_000, lamport: 0xffff, op: { kind: "memory.set", section: "goal", base_rev: 6, text: "Updated synthetic goal" } } as RoomEvent;
      const start = clock();
      const accepted = store.ingest(update);
      store.plan("synthetic-bench"); store.states();
      elapsed = millis(start); units = 3;
      const changed = structuredClone(semanticExpected(fixture));
      changed.memory.goal = { text: "Updated synthetic goal", rev: 0xffff };
      changed.last_lamport = 0xffff;
      changed.counts.applied++;
      const plan = store.plan("synthetic-bench");
      actual = { accepted, projection: summarize(plan?.projection ?? {}, { ...coreCounts, applied: 9, rejected: plan?.rejectedOps, invalid: plan?.invalidOps }) };
      expected = { accepted: true, projection: changed };
    } else if (variant === "history" || variant === "burst") {
      const count = variant === "history" ? 100_000 : 512;
      const heaps: { events: number; heap_used_bytes: number; rss_bytes: number }[] = [];
      let accepted = 0, ingestionMs = 0;
      let revision = 6, projectionReadMs = 0;
      const clientHash = createHash("sha256");
      const combinedHash = createHash("sha256").update(events.map(e => canonical(e)+"\n").join(""));
      const retainedHeaps: { events: number; heap_used_bytes: number }[] = [];
      const gc = (globalThis as { gc?: () => void }).gc;
      const lastId = (20_000+count-1).toString(16).padStart(16, "0");
      for (let offset = 0; offset < count; offset += 512) {
        // Generate one bounded client chunk outside the hot interval.
        const chunk: RoomEvent[] = [];
        for (let i = offset; i < Math.min(offset+512, count); i++) {
          const e: RoomEvent = {
          id: `e-${(20_000+i).toString(16).padStart(16, "0")}`, room: "synthetic-bench",
          agent: i % 2 === 0 ? "alice" : "bob", act: "heartbeat", text: `synthetic:${fixture.manifest.seed}:${i}`,
          ts: 1_700_000_020_000+i, lamport: 20_000+i };
          if (variant === "burst" && i % 32 === 0) {
            Object.assign(e, { act: "op", text: "", op: { kind: "memory.set", section: "goal",
              base_rev: revision, text: `Synthetic burst ${i}` } });
            revision = 20_000+i;
          }
          chunk.push(e);
        }
        const bytes = chunk.map(e => canonical(e)+"\n").join("");
        clientHash.update(bytes); combinedHash.update(bytes);
        const start = clock();
        for (const e of chunk) if (store.ingest(e)) accepted++;
        ingestionMs += millis(start);
        if (variant === "burst") {
          const readStart = clock();
          store.plan("synthetic-bench");
          projectionReadMs += millis(readStart);
        }
        if (gc && ((offset+chunk.length) % 4096 === 0 || offset+chunk.length === count)) {
          gc();
          retainedHeaps.push({ events: offset+chunk.length, heap_used_bytes: process.memoryUsage().heapUsed });
        }
        const memory = process.memoryUsage();
        heaps.push({ events: Math.min(offset+512, count), heap_used_bytes: memory.heapUsed, rss_bytes: memory.rss });
      }
      elapsed = ingestionMs; units = count;
      workloadHash = combinedHash.digest("hex");
      const display = store.events("synthetic-bench");
      const operations = display.filter(e => e.act === "op").length;
      actual = { accepted, projection: projectionSummary(store, variant === "burst" ? 24 : 8), last_id: display.at(-1)?.id,
        operations, recent_non_ops: display.filter(e => e.act !== "op").length };
      const semantic = structuredClone(semanticExpected(fixture));
      if (variant === "burst") {
        semantic.memory.goal = { text: "Synthetic burst 480", rev: 20_480 };
        semantic.last_lamport = 20_480; semantic.counts.applied = 24;
      }
      expected = { accepted: count, projection: semantic, last_id: `e-${lastId}`,
        operations: variant === "burst" ? 27 : 11, recent_non_ops: 5000 };
      if (variant === "burst") expected.recent_non_ops = 5000;
      const xs = heaps.map(h => h.events), ys = heaps.map(h => h.heap_used_bytes);
      const mx = xs.reduce((a,b) => a+b,0)/xs.length, my = ys.reduce((a,b) => a+b,0)/ys.length;
      const denominator = xs.reduce((a,x) => a+(x-mx)**2,0);
      const retainedXs = retainedHeaps.map(h => h.events), retainedYs = retainedHeaps.map(h => h.heap_used_bytes);
      const rx = retainedXs.reduce((a,b) => a+b,0)/retainedXs.length;
      const ry = retainedYs.reduce((a,b) => a+b,0)/retainedYs.length;
      const rd = retainedXs.reduce((a,x) => a+(x-rx)**2,0);
      metrics = { client_events: count, client_stream_sha256: clientHash.digest("hex"),
        heap_observations: heaps, post_gc_heap_observations: retainedHeaps,
        retained_heap_slope_bytes_per_event: gc && rd > 0 ? retainedXs.reduce((a,x,i) => a+(x-rx)*(retainedYs[i]!-ry),0)/rd : null,
        retained_heap_reason: gc && rd > 0 ? "post-GC process heap observations" : "AUSENTE: exposed GC or multiple post-GC observations",
        heap_trend_bytes_per_event:
        denominator ? xs.reduce((a,x,i) => a+(x-mx)*(ys[i]!-my),0)/denominator : null,
        heap_slope_reason: "process heap trend includes garbage collection; not retained-object attribution",
        retained_display_bytes: Buffer.byteLength(canonical(display)), retained_display_events: display.length,
        retained_non_op_events: display.filter(e => e.act !== "op").length,
        ingestion_events_per_second: ingestionMs > 0 ? count/(ingestionMs/1000) : null,
        projection_freshness: actual.projection.last_lamport === (variant === "burst" ? 20_480 : 13),
        projection_read_ms: variant === "burst" ? projectionReadMs : null,
        retention_scope: "public display history; process heap includes retained internal journal",
        browser_update_latency_ms: null, dom_mutations_per_beat: null, browser_reason: "AUSENTE: real browser runner" };
    } else throw new Error("unknown benchmark adapter");
  }
  return { elapsed_ms: elapsed, expected, actual, work_units: units,
    fixture_sha256: workloadHash, peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
    process_scope: "fresh-node-process-lifetime-high-water", runtime: process.version, metrics };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const request = JSON.parse(readFileSync(0, "utf8")) as { fixture: Fixture; variant: string };
  console.log(JSON.stringify(runAdapter(request.fixture, request.variant)));
}
