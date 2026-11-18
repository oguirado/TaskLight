// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createAgentStore } from "../../../src/app/agent_store";
import type { AgentStore, MemoryVersionVM, PlanProjectionResult } from "../../../src/app/agent_store";
import type { RoomEvent } from "../../../src/agents/types";
import { foldPlan } from "../../../src/plan";
import type { PlanningTemplate } from "../../../src/plan";

const fixture = JSON.parse(readFileSync("tests/bench/oracle.json", "utf8")) as {
  events: RoomEvent[];
  template: PlanningTemplate;
};
const room = "synthetic-bench";
const now = 1_700_000_020_000;
const eventId = (n: number): string => `e-${n.toString(16).padStart(16, "0")}`;

function heartbeat(i: number): RoomEvent {
  return { id: eventId(20_000 + i), room, agent: "alice", act: "heartbeat",
    text: "burst", ts: now + i, lamport: 20_000 + i };
}

function memory(i: number, text: string, base_rev: number): RoomEvent {
  return { ...heartbeat(i), act: "op", text: "", op: { kind: "memory.set", section: "goal", text, base_rev } };
}

const first = memory(0, "Burst first", 6);
const last = memory(480, "Burst final", 20_000);
const stale = memory(511, "Stale update", 6);
const burst = Array.from({ length: 512 }, (_, i) => i === 0 ? first :
  i === 480 ? last : i === 511 ? stale : heartbeat(i));
const seed = fixture.events;
const history = {
  goal: [
    { rev: 20_480, by: "alice", ts: now + 480, text: "Burst final" },
    { rev: 20_000, by: "alice", ts: now, text: "Burst first" },
    { rev: 6, by: "alice", ts: 1_700_000_000_006, text: "Ship TaskLight" },
  ],
  decisions: [
    { rev: 7, by: "alice", ts: 1_700_000_000_007, text: "Keep evidence and uncertainty visible" },
  ],
};

function ingest(store: AgentStore, events: readonly RoomEvent[]): void {
  for (const event of events) expect(store.ingestChecked(event), event.id).toBe("accepted");
}

function seeded(resolve: () => PlanningTemplate | undefined = () => fixture.template): AgentStore {
  const store = createAgentStore({
    maxPerRoom: 16,
    templates: (id, hash) =>
      id === fixture.template.id && hash === fixture.template.hash ? resolve() : undefined,
  });
  ingest(store, seed);
  expect(store.plan(room)?.projection.memory["goal"]?.rev).toBe(6);
  return store;
}

function expectFullReplay(store: AgentStore, template = fixture.template): PlanProjectionResult {
  const all = [...seed, ...burst];
  const folded = foldPlan(all, (id, hash) =>
    id === template.id && hash === template.hash ? template : undefined);
  const result = store.plan(room);
  expect(result?.room).toBe(room);
  expect(result?.source).toBe("v2");
  expect(result?.projection).toEqual(folded.projection);
  expect(result?.projection.agent_lifecycle ?? {}).toEqual(folded.projection.agent_lifecycle ?? {});
  expect(result?.invalidOps).toBe(folded.stats.invalid);
  expect(result?.rejectedOps).toBe(folded.stats.rejected);
  expect(result?.errors).toEqual(folded.stats.errors);
  expect(result?.memoryHistory).toEqual(history);
  expect(result?.template).toEqual(template);
  return result!;
}

it("P1 first ordered burst read matches cold full replay", () => {
  const store = seeded();
  ingest(store, burst);

  const result = expectFullReplay(store);
  expect(result.projection.memory["goal"]).toMatchObject({ rev: 20_480, text: "Burst final" });
  expect(result.invalidOps).toBe(0);
  expect(result.rejectedOps).toBe(4);
  expect(result.errors?.at(-1)).toEqual({ id: stale.id, lamport: stale.lamport, code: "stale_rev" });
});

it("P2 late and reversed arrivals repair the first projection", () => {
  const store = seeded();
  ingest(store, burst.slice(1).reverse());
  const before = store.plan(room);
  expect(before?.projection.memory["goal"]).toMatchObject({ rev: 20_511, text: "Stale update" });
  expect(before?.errors).toContainEqual({ id: last.id, lamport: last.lamport, code: "stale_rev" });

  ingest(store, [first]);
  expectFullReplay(store);
});

it("P3 duplicate payloads and malformed envelopes cannot change replay", () => {
  const store = seeded();
  ingest(store, burst);
  expect(store.ingestChecked(first)).toBe("duplicate");
  expect(store.ingestChecked({ ...last, op: { ...last.op, text: "Conflicting payload" } })).toBe("duplicate");
  const hostile = { ...memory(900, "Must remain absent", last.lamport), room: "__proto__" };
  expect(store.ingestChecked(hostile)).toBe("invalid");
  expect(store.plan(hostile.room)).toBeUndefined();
  expect(store.since()).toEqual({ [room]: stale.lamport });
  expectFullReplay(store);
});

it("P4 replacing a template at the same identity refreshes projection and diagnostics", () => {
  let template = fixture.template;
  const store = seeded(() => template);
  ingest(store, burst);
  expectFullReplay(store);
  template = { ...template, name: "Replacement", memory_sections: [
    ...template.memory_sections, { id: "goal", label: "Goal", hint: "Short", required: false, max_chars: 14 },
  ] };

  const replaced = expectFullReplay(store, template);
  expect(replaced.projection.memory["goal"]).toEqual({
    id: "goal", text: "Burst final", rev: 20_480, by: "alice", ts: now + 480,
  });
  expect(replaced.template?.name).toBe("Replacement");

  template = { ...template, memory_sections: template.memory_sections.map(section =>
    section.id === "goal" ? { ...section, max_chars: 8 } : section) };
  const restricted = expectFullReplay(store, template);
  expect(restricted.projection.memory["goal"]).toBeUndefined();
  expect(restricted.rejectedOps).toBeGreaterThan(replaced.rejectedOps!);
});

it("P5 editing a returned projection does not change later reads", () => {
  const store = seeded();
  ingest(store, burst);
  const result = expectFullReplay(store);
  const mutate = (edit: () => void): void => {
    try { edit(); } catch (error) { expect(error).toBeInstanceOf(TypeError); }
  };
  mutate(() => { result.projection.memory["goal"]!.text = "Changed copy"; });
  mutate(() => { (result.memoryHistory?.["goal"] as MemoryVersionVM[]).splice(0); });
  mutate(() => { (result.errors as { code: string }[]).splice(0); });
  mutate(() => { result.template!.granularity.micro_max = 1; });

  expectFullReplay(store);
});

const fixtureHash = "10e0c1e5132282c471fa3277cab74b149f70c8cad25b05215eb09db2cda7c5ed";
const streamHash = "23dd4fdabda6e73cc48a4703db11105fd599e880f204b663a887cadf7f77cbcb";
interface Sample {
  node: string;
  python: string;
  scratch_device: number;
  fixture_sha256: string;
  stream_sha256: string;
  correct: boolean;
  fresh: boolean;
  ingest_ms: number;
  projection_ms: number;
  peak_rss_bytes: number;
  load: number[];
  available_kib: number;
}
interface Side {
  source_sha256: string;
  samples: Sample[];
}
interface Evidence {
  control: Side;
  candidate?: Side;
}

function validate(side: Side): void {
  expect(side.samples).toHaveLength(5);
  const first = side.samples[0]!;
  expect(first.node).toMatch(/^v\d+\./);
  expect(first.python).toMatch(/^\d+\./);
  expect(Number.isSafeInteger(first.scratch_device)).toBe(true);
  for (const sample of side.samples) {
    expect([sample.node, sample.python, sample.scratch_device])
      .toEqual([first.node, first.python, first.scratch_device]);
    expect([sample.fixture_sha256, sample.stream_sha256, sample.correct, sample.fresh])
      .toEqual([fixtureHash, streamHash, true, true]);
    expect(sample.load).toHaveLength(3);
    expect(sample.load.every(value => Number.isFinite(value) && value >= 0)).toBe(true);
    for (const value of [sample.ingest_ms, sample.projection_ms, sample.peak_rss_bytes, sample.available_kib]) {
      expect(value).toBeGreaterThan(0);
      expect(Number.isFinite(value)).toBe(true);
    }
  }
}

function median(samples: Sample[], key: "ingest_ms" | "projection_ms" | "peak_rss_bytes"): number {
  return samples.map(sample => sample[key]).sort((a, b) => a - b)[2]!;
}

it("P6 the first projection meets the burst performance gate", () => {
  const pinned = JSON.parse(readFileSync("tests/unit/r52p/baseline.json", "utf8")) as Evidence;
  const report = process.env["R52P_BURST_EVIDENCE"];
  const evidence = report === undefined ? pinned : JSON.parse(readFileSync(report, "utf8")) as Evidence;
  const { control, candidate } = evidence;
  const measured = candidate ?? control;
  const source = createHash("sha256").update(readFileSync("src/app/agent_store.ts")).digest("hex");
  expect(control.source_sha256).toBe(pinned.control.source_sha256);
  expect(source, "measure this exact source with the paired burst runner").toBe(measured.source_sha256);
  validate(control);
  if (candidate !== undefined) {
    validate(candidate);
    const controlRun = control.samples[0]!;
    const candidateRun = candidate.samples[0]!;
    expect([candidateRun.node, candidateRun.python, candidateRun.scratch_device])
      .toEqual([controlRun.node, controlRun.python, controlRun.scratch_device]);
  }

  expect(median(measured.samples, "projection_ms"), "first public projection median (ms)").toBeLessThanOrEqual(40);
  expect(median(measured.samples, "ingest_ms"), "ingestion median (ms)").toBeLessThanOrEqual(4);
  expect(median(measured.samples, "peak_rss_bytes"), "Node median peak RSS (bytes)").toBeLessThanOrEqual(157 * 1024 * 1024);
  expect(candidate, "admission requires a contemporaneous matched control").toBeDefined();
  expect(median(measured.samples, "projection_ms")).toBeLessThanOrEqual(0.8 * median(control.samples, "projection_ms"));
});
