import { describe, expect, it } from "vitest";
import { clone, deterministic, event, fixture, python, view } from "./support";

type LastResult = { verdict: string; summary: string | null; receipt: string | null;
  evidence?: { path: string; sha256: string }[] };
type Row = { agent: string; state: string; run_id: string | null; last_result?: LastResult | null };
const row = (events = clone(fixture.seed)): Row => {
  const value = view(events).agents.find(item => item.agent === "worker");
  expect(value).toBeDefined();
  return value as unknown as Row;
};
function resultIn(events: typeof fixture.seed): Record<string, unknown> {
  return (events.at(-1)!.op as unknown as { result: Record<string, unknown> }).result;
}
deterministic();

describe("C7 M1/M6 result propagation to the browser inventory", () => {
  for (const count of [1, 8, 9, 32]) it(`m1_evidence_first_eight_of_${count}`, () => {
    const events = clone(fixture.seed);
    const evidence = Array.from({ length: count }, (_, n) => ({ path: `artifacts/check-${n}.json`, sha256: n.toString(16).padStart(64, "0") }));
    Object.assign(resultIn(events), { evidence, summary: "s".repeat(201) });
    const before = clone(events), actual = row(events);
    expect(actual.last_result).toEqual({ verdict: "ADMIT", summary: "s".repeat(200),
      receipt: "artifacts/result.json", evidence: evidence.slice(0, 8) });
    expect(actual.state).toBe("finished");
    expect(actual.run_id).toBe("r1");
    expect(events).toEqual(before);
  });
  it("m1_absent_evidence_is_omitted", () => {
    const events = clone(fixture.seed);
    delete resultIn(events)["evidence"];
    expect(row(events).last_result).toEqual({ verdict: "ADMIT", summary: "Result summary", receipt: "artifacts/result.json" });
  });
  it("m1_verdict_only_result_keeps_optional_fields_null", () => {
    const events = clone(fixture.seed), op = events.at(-1)!.op as unknown as { result: unknown };
    op.result = { verdict: "HOLD" };
    expect(row(events).last_result).toEqual({ verdict: "HOLD", summary: null, receipt: null });
  });
  it("m1_failed_result_keeps_evidence", () => {
    const events = clone(fixture.seed);
    Object.assign(events.at(-1)!.op, { state: "failed", result: { verdict: "FAIL", evidence: fixture.evidence.slice(0, 1) } });
    expect(row(events)).toMatchObject({ state: "failed", last_result: { verdict: "FAIL", evidence: fixture.evidence.slice(0, 1) } });
  });
  it("m1_empty_evidence_remains_empty", () => {
    const events = clone(fixture.seed); resultIn(events)["evidence"] = [];
    expect(row(events).last_result?.evidence).toEqual([]);
  });
  it("m1_existing_result_hash_case_and_unicode_path_keep_their_bytes", () => {
    const events = clone(fixture.seed), evidence = [{ path: "artifacts/évidence.json", sha256: "A".repeat(64) }];
    resultIn(events)["evidence"] = evidence;
    expect(row(events).last_result?.evidence).toEqual(evidence);
  });
  it("m1_redeployment_resets_old_result_evidence", () => {
    const events = clone(fixture.seed);
    events.push(event(6, { kind: "agent.lifecycle", op_id: "c7-redeploy", state: "deployed", run_id: "r2" }, "worker"));
    expect(row(events)).toMatchObject({ run_id: "r2", last_result: null });
  });
  it("m1_legacy_terminal_has_null_result", () => {
    const events = clone(fixture.seed);
    delete (events.at(-1)!.op as unknown as Record<string, unknown>)["result"];
    expect(row(events).last_result).toBeNull();
  });
  it("m1_inventory_result_parity_uses_real_python_and_browser_implementations", () => {
    const events = clone(fixture.seed);
    const backend = python("inventory", events) as { agents: Row[] };
    const browser = row(events), worker = backend.agents.find(item => item.agent === "worker")!;
    // Both sides must include evidence; two missing fields must not pass parity.
    for (const candidate of [worker, browser]) expect(candidate.last_result?.evidence).toEqual(fixture.evidence);
    expect(browser.last_result).toEqual(worker.last_result);
  });
});
