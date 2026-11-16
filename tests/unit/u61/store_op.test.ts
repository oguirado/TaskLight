import { describe, expect, it } from "vitest";
import { foldRoomWithStats } from "../../../src/agents";
import { createAgentStore } from "../../../src/app/agent_store";
import { event, id, opEvent, openOp, planStore, vector } from "./helpers";

const validOps: Record<string, unknown>[] = [
  openOp(), { kind: "plan.close", base_rev: 1, outcome: "Complete" },
  { kind: "plan.phase", base_rev: 1, phase: "finish" },
  { kind: "task.add", title: "Task", type: "action", phase: "start", assignee: null, microtasks: [{ text: "Check" }] },
  { kind: "task.set", task_id: "T01", base_rev: 2, state: "blocked", reason: "Review", estimate: null },
  { kind: "task.claim", task_id: "T01" }, { kind: "task.release", task_id: "T01" },
  { kind: "micro.add", task_id: "T01", base_rev: 2, text: "Check" },
  { kind: "micro.set", micro_id: "T01.M01", state: "done", evidence: [{ path: "proof.txt", sha256: "a".repeat(64) }] },
  { kind: "memory.set", section: "notes", base_rev: 0, text: "Decision" },
];

describe("O1 operation ingestion (structural acceptance, not stateful application)", () => {
  it.each(validOps.map(op => [op["kind"], op] as const))("O1 accepts %s without an op_id", (_kind, op) => {
    const s = createAgentStore(); const e = opEvent(1, op);
    expect(s.ingest(e)).toBe(true);
    expect(s.events("oracle")).toEqual([e]);
    expect(s.since()).toEqual({ oracle: 1 });
  });
  it.each(["a".repeat(8), "Z_-0".repeat(16)])("O1 accepts op_id boundary %s", op_id => {
    const s = createAgentStore(); expect(s.ingest(opEvent(1, { ...openOp(), op_id }))).toBe(true);
  });
  it("O1 permits ordinary operation text containing markup and Unicode", () => {
    const s = createAgentStore(); const title = "<script>literal</script> 🧭";
    expect(s.ingest(opEvent(1, { ...openOp(), title }))).toBe(true);
    expect((s.events("oracle")[0] as unknown as { op: { title: string } }).op.title).toBe(title);
  });
  it("O1 enforces the configured room buffer while preserving the high-water mark", () => {
    const s = createAgentStore({ maxPerRoom: 2 });
    for (const n of [3, 1, 2]) expect(s.ingest(opEvent(n, { ...openOp(), op_id: `unique_${n}` }))).toBe(true);
    // A-U85c: pin every accepted operation; bound only non-op display events, M1.
    expect(s.events("oracle").map(e => e.lamport)).toEqual([1, 2, 3]);
    expect(s.since()).toEqual({ oracle: 3 });
    for (const n of [6, 4, 5]) expect(s.ingest(event(n))).toBe(true);
    expect(s.events("oracle").map(e => e.lamport)).toEqual([1, 2, 3, 5, 6]);
    expect(s.events("oracle").filter(e => e.act !== "op")).toHaveLength(2);
    expect(s.since()).toEqual({ oracle: 6 });
  });
});

describe("O2/O3 JSONL and replay records", () => {
  it("O2 mixed complete lines survive a torn final op", () => {
    const lines = [event(1), event(2, { act: "plan", plan: { title: "Legacy", steps: [{ text: "Check" }] } }),
      event(3, { act: "step", step: { index: 0, state: "done" } }), event(4, { act: "question", text: "Why?" }), opEvent(5, openOp())];
    const s = createAgentStore();
    expect(s.ingestJsonl(lines.map(e => JSON.stringify(e)).join("\n") + '\n{"act":"op","op":')).toEqual({ accepted: 5, duplicate: 0, malformed: 0, torn: true });
    expect(s.events("oracle")).toHaveLength(5); expect(s.since()).toEqual({ oracle: 5 });
  });
  it("O2 a valid final line needs no newline; malformed complete JSON counts as malformed", () => {
    const s = createAgentStore();
    expect(s.ingestJsonl('not-json\n' + JSON.stringify(opEvent(1, openOp())))).toEqual({ accepted: 1, duplicate: 0, malformed: 1, torn: false });
  });
  it("O3 rejects duplicate event IDs through both entry points", () => {
    const s = createAgentStore(); const e = opEvent(1, openOp());
    expect(s.ingest(e)).toBe(true); expect(s.ingest(e)).toBe(false);
    expect(s.ingestJsonl(JSON.stringify(e) + "\n")).toEqual({ accepted: 0, duplicate: 1, malformed: 0, torn: false });
    expect(s.events("oracle")).toHaveLength(1);
  });
  it("O3 retains distinct IDs sharing op_id, including conflicting payloads and different agents", () => {
    const s = createAgentStore();
    const ops = [opEvent(1, { ...openOp(), op_id: "retry_001" }),
      opEvent(2, { ...openOp(), title: "Different payload", op_id: "retry_001" }),
      opEvent(3, { ...openOp(), op_id: "retry_001" }, { agent: "bob" })];
    expect(s.ingestJsonl(ops.map(e => JSON.stringify(e)).join("\n"))).toEqual({ accepted: 3, duplicate: 0, malformed: 0, torn: false });
    expect(s.events("oracle")).toEqual(ops); expect(s.since()).toEqual({ oracle: 3 });
    expect(s.events("oracle").every(e => !Object.hasOwn(e, "replayed"))).toBe(true);
  });
  it("O2 preserved legacy torn-line handling remains green", () => {
    expect(createAgentStore().ingestJsonl(JSON.stringify(event(1)) + '\n{"id":')).toEqual({ accepted: 1, duplicate: 0, malformed: 0, torn: true });
  });
});

const invalid: [string, () => unknown][] = [
  ["missing op", () => event(1, { act: "op" })],
  ["null op", () => event(1, { act: "op", op: null })],
  ["array op", () => event(1, { act: "op", op: [] })],
  ["unknown kind", () => opEvent(1, { kind: "task.delete" })],
  ["short op_id", () => opEvent(1, { ...openOp(), op_id: "bad" })],
  ["long op_id", () => opEvent(1, { ...openOp(), op_id: "a".repeat(65) })],
  ["null op_id", () => opEvent(1, { ...openOp(), op_id: null })],
  ["bad op_id alphabet", () => opEvent(1, { ...openOp(), op_id: "bad.id!!" })],
  ["negative base_rev", () => opEvent(1, { kind: "plan.close", base_rev: -1 })],
  ["fractional base_rev", () => opEvent(1, { kind: "plan.close", base_rev: 1.5 })],
  ["unsafe base_rev", () => opEvent(1, { kind: "plan.close", base_rev: Number.MAX_SAFE_INTEGER + 1 })],
  ["oversized UTF-8 op", () => opEvent(1, { ...openOp(), title: "é".repeat(8192) })],
  ["op plus plan", () => opEvent(1, openOp(), { plan: { title: "Bad", steps: [{ text: "Bad" }] } })],
  ["op plus step", () => opEvent(1, openOp(), { step: { index: 0, state: "done" } })],
  ["legacy plan plus op", () => event(1, { act: "plan", plan: { title: "Bad", steps: [{ text: "Bad" }] }, op: openOp() })],
  ["legacy step plus op", () => event(1, { act: "step", step: { index: 0, state: "done" }, op: openOp() })],
  ["legacy question plus op", () => event(1, { act: "question", op: openOp() })],
  ["non-array evidence", () => event(1, { evidence: {} })],
];
for (const key of ["lamport", "ts"] as const) {
  for (const [label, value] of [["NaN", NaN], ["Infinity", Infinity], ["negative Infinity", -Infinity], ["fractional", 1.5], ["boolean", true]] as const) {
    invalid.push([`${key} ${label}`, () => event(1, { [key]: value })]);
  }
}
for (const [label, value] of [["negative", -1], ["zero", 0], ["unsafe", Number.MAX_SAFE_INTEGER + 1]] as const) invalid.push([`lamport ${label}`, () => event(1, { lamport: value })]);
for (const ts of [8.64e15 + 1, -8.64e15 - 1]) invalid.push([`timestamp outside Date range ${ts}`, () => event(1, { ts })]);
for (const key of ["__proto__", "constructor", "prototype"]) {
  invalid.push([`dangerous own envelope key ${key}`, () => JSON.parse(JSON.stringify(event(1)).slice(0, -1) + `,"${key}":{}}`)]);
  invalid.push([`dangerous nested operation key ${key}`, () => opEvent(1, JSON.parse(JSON.stringify(openOp()).slice(0, -1) + `,"${key}":{}}`) as Record<string, unknown>)]);
}

describe("O4 hostile envelopes are rejected without throwing", () => {
  it.each(invalid)("O4 %s", (_label, make) => {
    const e = make(); const s = createAgentStore();
    expect(() => s.ingest(e)).not.toThrow(); expect(s.ingest(e)).toBe(false);
    expect(s.ingestJsonl(JSON.stringify(e) + "\n")).toEqual({ accepted: 0, duplicate: 0, malformed: 1, torn: false });
    expect(s.events("oracle")).toEqual([]); expect(s.since()).toEqual({});
  });
  it.each([null, false, 1, [], "bad"])("O4 non-event %j is contained", value => {
    const s = createAgentStore(); expect(() => s.ingest(value)).not.toThrow(); expect(s.ingest(value)).toBe(false);
  });
  it.each(["cycle", "bigint", "function", "symbol", "non-finite"])("O4 non-JSON operation %s is contained", kind => {
    const op = openOp();
    op["brief"] = kind === "cycle" ? op : { goal: kind === "bigint" ? 1n : kind === "function" ? () => 1 : kind === "symbol" ? Symbol("x") : NaN };
    const s = createAgentStore(); expect(() => s.ingest(opEvent(1, op))).not.toThrow(); expect(s.ingest(opEvent(1, op))).toBe(false);
  });
  it("O4 an invalid event never poisons deduplication of a corrected event", () => {
    const s = createAgentStore(); expect(s.ingest(event(1, { lamport: -1 }))).toBe(false);
    expect(s.ingest(opEvent(1, openOp()))).toBe(true);
  });
});

describe("O5 defensive ownership", () => {
  it("O5 clones nested operation input and returned events before later folding", () => {
    const s = createAgentStore(); const op = openOp(); const e = opEvent(1, op);
    expect(s.ingest(e)).toBe(true);
    op["title"] = "Caller mutation"; (op["brief"] as Record<string, string>)["goal"] = "Changed";
    const first = s.events("oracle")[0] as unknown as { op: Record<string, unknown> };
    expect(first.op).toEqual(openOp());
    const ps = planStore(s); const before = structuredClone(ps.plan("oracle"));
    first.op["title"] = "Returned mutation"; (first.op["brief"] as Record<string, string>)["goal"] = "Changed again";
    expect((s.events("oracle")[0] as unknown as { op: unknown }).op).toEqual(openOp());
    expect(ps.plan("oracle")).toEqual(before);
  });
  it("O5 clones operation evidence independently of top-level legacy evidence", () => {
    const s = createAgentStore(); const proof = { path: "op-proof.txt", sha256: "a".repeat(64) };
    const e = opEvent(1, { kind: "micro.set", micro_id: "T01.M01", state: "done", evidence: [proof] }, { evidence: [{ path: "legacy-proof.txt", sha256: "b".repeat(64) }] });
    expect(s.ingest(e)).toBe(true); proof.path = "Changed";
    const stored = s.events("oracle")[0] as unknown as { op: { evidence: { path: string }[] }; evidence: { path: string }[] };
    expect(stored.op.evidence[0]!.path).toBe("op-proof.txt"); expect(stored.evidence[0]!.path).toBe("legacy-proof.txt");
    stored.op.evidence[0]!.path = "Returned mutation";
    expect((s.events("oracle")[0] as unknown as typeof stored).op.evidence[0]!.path).toBe("op-proof.txt");
  });
  it("O5 preserves deterministic lamport then ordinal ID ordering", () => {
    const s = createAgentStore(); const events = [opEvent(2, openOp(), { id: id(3) }), opEvent(1, openOp()), opEvent(2, openOp(), { id: id(2) })];
    events.forEach(e => expect(s.ingest(e)).toBe(true));
    expect(s.events("oracle").map(e => e.id)).toEqual([id(1), id(2), id(3)]);
  });
  it("O5 preserved legacy states match the existing folder", () => {
    const s = createAgentStore();
    const legacy = vector("plan_open").events.map(e => ({ ...e, act: "open", op: undefined }));
    legacy.forEach(e => s.ingest(e)); expect(s.states()).toEqual(foldRoomWithStats(legacy).states);
  });
});
