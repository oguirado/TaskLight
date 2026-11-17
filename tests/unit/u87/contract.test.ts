import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
type Probe = { ok: boolean; tests: number; failures: number; errors: number; reason: string };

// A-U109c: (a) the all-tools close fixture must complete its work, M6/M7.
// Adapt only this legacy subprocess fixture in memory; retain exact payload,
// journal bytes, envelope and dispatch assertions without changing Python files.
// A-U87r: SPEC_U121 M3 requires canonical batch.request_sha256 metadata.
const lifecycleParity = String.raw`
import hashlib, json, sys
from bridge.tests.room.u87 import probe, test_contract as checks

legacy_parity = checks.ParityOracle.parity

def parity(self, name):
    if name != "plan_close":
        return legacy_parity(self, name)
    outcomes, journals, spies = [], [], []
    for adapter in ("cli", "mcp"):
        home = self.tmp / adapter
        with checks.deterministic(home):
            args = checks.fixture(home, name)
            completed = checks.call(adapter, "microtask_set", dict(
                room="demo", agent="worker", id="T01.M01", state="done"))
            self.assertEqual(completed[0], 0, completed)
            with checks.dispatch_spy(name, args) as seen:
                result = checks.call(adapter, name, args)
            spies.append(seen)
            outcomes.append(result)
            journals.append(checks.journal(home))
    self.assertEqual(outcomes[0], outcomes[1], "complete decoded payload differs")
    self.assertEqual(outcomes[0][0], 0, outcomes)
    self.assertEqual(journals[0], journals[1], "complete journal bytes differ")
    expected = json.loads((checks.ROOT / "bridge/tests/room/u87/expected.json").read_text())[name]
    path = "rooms/demo/events.jsonl"
    lines = expected["journals"][path].splitlines()
    close = json.loads(lines.pop())
    # This frozen seed batch has no local keys or generated operation fields.
    events = [json.loads(line) for line in lines]
    request = dict(strict=False, ops=[event["op"] for event in events])
    digest = hashlib.sha256(json.dumps(request, sort_keys=True, separators=(",", ":"),
                                       ensure_ascii=False, allow_nan=False).encode("utf-8")).hexdigest()
    for event in events:
        event["batch"]["request_sha256"] = digest
    lines = [json.dumps(event, sort_keys=True, separators=(",", ":")) for event in events]
    complete = dict(close, op=dict(kind="micro.set", micro_id="T01.M01", state="done"))
    close = dict(close, id="e-0000000000000004", lamport=4)
    lines.extend(json.dumps(e, sort_keys=True, separators=(",", ":")) for e in (complete, close))
    expected["journals"][path] = "\n".join(lines) + "\n"
    expected["payload"]["untrusted"]["rev"] = 4
    self.assertEqual(outcomes[0][1], expected["payload"], "successful payload changed")
    self.assertEqual({p: b.decode() for p, b in journals[0].items()}, expected["journals"],
                     "committed journal changed beyond the completion step")
    checks.assert_shared(*spies)
    self.assertEqual(set(outcomes[0][1]), {"untrusted"})
    return spies[0] & spies[1]

checks.ParityOracle.parity = parity
print(json.dumps(probe.run_case(sys.argv[1])))
`;

// A-U87r: SPEC_U121 M1 requires monotonic deadlines; load lock timing before fake clocks.
const legacyClock = String.raw`
from bridge.room import store
from bridge.tests.room.u87 import probe
import json, sys
print(json.dumps(probe.run_case(sys.argv[1])))
`;

function check(name: string): void {
  // U87's production surface is Python. Run the same authoritative behavioral
  // checks rather than introducing a second implementation of the dispatcher.
  const args = name === "ParityOracle.test_a2_same_dispatcher_for_every_tool"
    ? ["-B", "-c", lifecycleParity, name]
    : name === "RegressionOracle.test_a9_legacy_commands_exact_outputs_and_exits"
      ? ["-B", "-c", legacyClock, name]
      : ["-B", "-m", "bridge.tests.room.u87.probe", "case", name];
  const child = spawnSync("python3", args, {
    cwd: root,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    encoding: "utf8",
    timeout: 120_000, // A-U87d: python child under host load (was 20 s)
    maxBuffer: 512 * 1024,
  });
  if (child.error) throw child.error;
  expect(child.status, child.stderr).toBe(0);
  const report = JSON.parse(child.stdout) as Probe;
  expect(report.tests).toBeGreaterThan(0);
  if (!report.ok) throw new Error(report.reason);
  expect(report.failures + report.errors).toBe(0);
}

describe("U87 public CLI/MCP contract", () => {
  it.each([
    ["A1 discovery, complete schemas, no writes", "DiscoveryOracle.test_a1_tools_complete_object_and_no_writes"],
    ["A1 CLI-only extension startup", "DiscoveryOracle.test_a1_cli_only_startup"],
    ["A1 real module discovery and call", "DiscoveryOracle.test_a1_real_module_discovery_and_call"],
    ["A2 all tools: complete payloads, journals and common dispatch spy", "ParityOracle.test_a2_same_dispatcher_for_every_tool"],
    ["A3 no_plan detail", "ErrorOracle.test_a3_empty_room_no_plan"],
    ["A3 stale_rev detail and no append", "ErrorOracle.test_a3_stale_microtask_detail_and_no_append"],
    ["A4 syntax versus handler bad_args", "ErrorOracle.test_a4_handler_bad_args_exits_three"],
    ["A5 schema paths and required sets", "BoundaryOracle.test_a5_all_schema_paths"],
    ["A6 hostile nested task", "ErrorOracle.test_a6_hostile_task_no_append"],
    ["A6 traversal", "ErrorOracle.test_a6_path_traversal_no_outside_directory"],
    ["A7 S0 extension startup in both orders", "DiscoveryOracle.test_a7_mcp_first_synthetic_extension"],
    ["A8 dispatcher bypass mutation", "MutationOracle.test_a8_remove_dispatch_from_each_adapter"],
    ["A8 extension omission mutation", "MutationOracle.test_a8_omit_extension_dispatch"],
    ["A8 nested items mutation", "MutationOracle.test_a8_remove_nested_items"],
    ["A8 stripped detail mutation", "MutationOracle.test_a8_strip_detail"],
    ["A9 sanitized unexpected exception", "DiscoveryOracle.test_a9_unexpected_exception_sanitized"],
    ["A-U87-1 prompt list", "PromptOracle.test_amendment_executor_loop_appended_and_existing_entries_exact"],
    ["A-U87-1 executor steering", "PromptOracle.test_amendment_executor_loop_steering"],
    ["A-U87-1 argument validation", "PromptOracle.test_amendment_executor_loop_rejects_invalid_slugs"],
  ])("%s", (_label, testName) => check(testName), 150_000); // A-U87d

  it.each([
    ["A4 RPC envelopes", "RegressionOracle.test_a4_mcp_invalid_envelopes_preserve_rpc_errors"],
    ["A9 legacy CLI", "RegressionOracle.test_a9_legacy_commands_exact_outputs_and_exits"],
    ["A9 app import", "RegressionOracle.test_a9_import_app_silent_and_no_mcp_dependency"],
    ["M1 independent app I/O checker control", "RegressionOracle.test_oracle_application_stdout_control_is_not_vacuous"],
    ["A8 independent dispatch checker control", "RegressionOracle.test_oracle_dispatch_control_is_not_vacuous"],
    ["A8 independent detail checker control", "RegressionOracle.test_oracle_detail_control_is_not_vacuous"],
    ["A8 independent nested items checker control", "RegressionOracle.test_oracle_nested_items_control_is_not_vacuous"],
  ])("%s", (_label, testName) => check(testName), 150_000); // A-U87d
});
