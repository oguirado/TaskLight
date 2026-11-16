import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
type Probe = { ok: boolean; tests: number; failures: number; errors: number; reason: string };

function check(name: string): void {
  // U87's production surface is Python. Run the same authoritative behavioral
  // checks rather than introducing a second implementation of the dispatcher.
  const child = spawnSync("python3", ["-B", "-m", "bridge.tests.room.u87.probe", "case", name], {
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
