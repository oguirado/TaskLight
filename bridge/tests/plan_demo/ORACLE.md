# U65 fail-first oracle

All paths below are relative to the repository root. Only the U65 demo API is
stubbed. Every test first calls `run_demo(home: Path, room: str = "demo-webapp")
-> dict`; the initial failure must be `NotImplementedError("U65 stub")`.
This prerequisite gate deliberately prevents absent documentation from obscuring
the missing demo. After implementation, the same tests exercise their full bodies.

## Numbered acceptance mapping

| Spec acceptance case | Test names | Verification gate and negative contrast |
| --- | --- | --- |
| 1. Happy path and projection | `test_case1_happy_projection`, `test_case1_public_store_calls`, `test_case1_evidence_is_contained_and_hash_matches`, `test_summary_contract` | Fold actual room events with the real template; require valid phases, populated memory, dependency wait, completed mismatch, claims, status, atomic creation and a contained, hashed artifact for every completed microtask. Empty plans, rejected ops, missing wait and fabricated projections fail. |
| 2. Clean-directory determinism | `test_case2_separate_process_determinism` | Separate processes must produce equal summaries, normalized journal rows and canonical folded projections. Normalize generated event IDs, event timestamps and evidence home prefixes. Verify affected batch fingerprints against the original requests before recomputing them for comparison. |
| 3. Repeat idempotency | `test_case3_repeat_is_noop` | Event bytes, line count, projection and summary remain equal except `events_written`, which becomes zero. Appended status events fail. |
| 4. Containment and fail-closed inputs | `test_case4_cli_missing_empty_home`, `test_case4_cli_positive_home_sources`, `test_case4_hostile_rooms_rejected_without_writes`, `test_case4_artifact_symlink_escape_stops`, `test_case4_empty_programmatic_home_stops`, `test_case4_custom_room`, `test_case4_write_audit_rejects_outside_home` | Both CLI forms accept explicit/environment homes; unset or empty homes exit with code 2. Invalid room slugs cannot create a home. Escaping artifact symlinks cannot modify their targets. Missing-home CLI runs preserve repository bytes and the isolated user home. A child audit boundary rejects writes outside the resolved demo home. |
| 5. Documentation completeness and parity | `test_case5_planning_document_contract`, `test_case5_mcp_document_contract` | Required starters, tools, resources, prompts, fields, limits, errors, revisions and envelopes must be documented. Privacy tiers are checked in the linked planning contract. Obsolete dotted field mappings fail. |
| 6. Public text and secret hygiene | `test_case6_public_text_hygiene` | Case-insensitive encoded product denylist and operator-path checks cover docs, demo and oracle text. `bash tools/secret_scan.sh` must exit clean and report zero findings. |

`test_no_network_live_sessions_or_sleep` additionally rejects socket creation,
subprocess launches and sleeps while replaying a clean room. Subprocess timeouts
are watchdog bounds, not scenario clocks. No external service or model is used.

## Scope and interpretation

- All numbered acceptance cases are in scope. Runtime enforcement of template
  validation, reducer limits/states, store locking/idempotency/revision errors and
  MCP transport/resources/prompts belongs to U55, U56, U57 and U59. U65 checks its
  own scenario and documentation; it does not re-test those units as U65 failures.
- The supplied `.unit/SPEC.md` ends at its absence list; no final Amendment section
  is present. W0-R requirements explicitly incorporated there remain binding.
- Evidence paths are relative to the repository root and must resolve to files
  inside the room's artifacts directory with matching SHA-256 digests. A home
  outside the checkout can produce a relative path with parent components.
- The spec leaves the types of summary `tasks` and `memory_sections` unspecified.
  The oracle checks the exact key set and JSON serializability without prescribing
  those representations. Repeat summaries exclude only `events_written`.
- Acceptance mismatch uses the spec's explicit non-equality criterion, not an
  invented semantic drift classifier or exact narrative text.
- A hostile artifact symlink may be rejected or safely replaced; the oracle
  prescribes containment, not a new exception API.
- Documentation prose is not fixed. Token and structural checks are bounded
  completeness checks; they cannot prove every natural-language statement correct.

## Running with stdlib unittest

Run this command from the repository root.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/plan_demo -t .
```
