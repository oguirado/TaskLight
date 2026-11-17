// The protocol boundary is Python stdio; exercise it from the Vitest entry point.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const cases = [
  // A-U132c: the Python discovery oracle also checks lifecycle and both U119 work tools.
  // A-C3c: it pins the exact module tuple and discovers orchestrator_snapshot once.
  // A-C6: the same exact Python pin includes waiter and discovers wait_agents once.
  "a8_registration_schema_and_fresh_mcp_discovery",
  "a8_success_is_raw_in_handler_and_untrusted_in_mcp",
  "a8_errors_are_structured_and_server_survives",
  "a8_pages_and_retries_are_stateless_across_fresh_processes",
  "a8_hostile_text_stays_literal_inside_untrusted_envelope",
] as const;

describe("U89 room_events MCP protocol smoke", () => {
  it.each(cases)("%s", name => {
    const run = spawnSync("python3", ["-B", "-m", "unittest",
      `bridge.tests.room.u89.test_events.ProtocolOracle.test_${name}`], {
      cwd: process.cwd(), encoding: "utf8", timeout: 10000, maxBuffer: 128 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(run.error, "bounded stdlib unittest subprocess launches").toBeUndefined();
    expect(run.signal, run.stdout + run.stderr).toBeNull();
    expect(run.stderr).not.toMatch(/ImportError|ModuleNotFoundError|SyntaxError/);
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });
});
