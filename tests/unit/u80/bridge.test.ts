// Run the unittest oracle from the required Vitest entry point as well.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const cases = [
  "A1_private_floor_denies_remote", "A1_standard_floor_admits_remote", "A1_declared_private_wins",
  "A2_missing_room_uses_strictest", "A2_only_standard_admits", "A2_floor_order_independent",
  "A3_unknown_room_denies", "A3_unknown_room_local_opt_in_denies", "A3_unknown_room_without_config_denies",
  "A4_local_private_opt_in_admits", "A4_local_without_opt_in_denies",
  "M3_declared_shared_denies_remote", "M3_shared_cannot_weaken_private_floor", "M3_shared_local_standard_floor_admits",
  "M5_empty_config_preserves_standard", "M5_empty_config_preserves_private_denial",
  "M5_missing_room_local_requires_opt_in", "M5_missing_room_local_opt_in_admits",
  "M1_malformed_room_is_structural", "M1_explicit_null_room_is_structural", "M1_unknown_keys_still_rejected", "M7_denial_log_uses_policy",
];
describe("U80 Python room admission (unittest)", () => {
  it.each(cases)("%s", name => {
    const result = spawnSync("python3", ["-B", "-m", "unittest",
      `bridge.tests.wall.u80.test_room_policy.RoomPolicy.test_${name}`], {
      cwd: process.cwd(), encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(result.error, "unittest must launch successfully").toBeUndefined();
    expect(result.stderr).not.toMatch(/ImportError|ModuleNotFoundError|SyntaxError|TypeError/);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
