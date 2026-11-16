# U89 protocol smoke map

The complete M1–M8 / A1–A8 map, executable inbox negative control, determinism
rules and integration blockers are documented in `bridge/tests/room/u89/ORACLE.md`.

`protocol.test.ts` invokes the corresponding `ProtocolOracle.test_*` stdlib tests
in fresh bounded Python processes. Each smoke test exercises real MCP stdio after
its public-handler preflight gate; no browser, network or protocol mock is used.

| Acceptance case | Vitest name or Python ownership |
| --- | --- |
| A1 | `a8_pages_and_retries_are_stateless_across_fresh_processes`; full event checks in `CursorOracle.test_a1_*` |
| A2 | Inclusive limits and defaults: `CursorOracle.test_a2_*` |
| A3 | Filter semantics, malformed operations, inbox and cursor-trap mutants: `CursorOracle.test_a3_*`, `OracleControls.test_a3_inbox_negative_control_is_rejected_by_a1_and_a3`, `test_a3_cursor_trap_negative_control_is_rejected` |
| A4 | Resync and missing storage: `CursorOracle.test_a4_*`, `OracleControls.test_a4_waiting_ahead_negative_control_is_rejected` |
| A5 | Journal validity and captured reads: `CursorOracle.test_a5_*` and `test_m5_response_uses_one_captured_read` |
| A6 | Fake time and process synchronization: `CursorOracle.test_a6_*` |
| A7 | `a8_errors_are_structured_and_server_survives`, `a8_hostile_text_stays_literal_inside_untrusted_envelope`; exhaustive validation in `CursorOracle.test_a7_*` |
| A8 | `a8_registration_schema_and_fresh_mcp_discovery`, `a8_success_is_raw_in_handler_and_untrusted_in_mcp`, `a8_errors_are_structured_and_server_survives`, `a8_pages_and_retries_are_stateless_across_fresh_processes`, `a8_hostile_text_stays_literal_inside_untrusted_envelope` |

CLI parity is conditional on U87 and is out of scope here. The frozen extension
seam must remain unchanged. Stub failures are expected until implementation;
legacy tests that freeze the total tool list remain an integration blocker.

Amendment B-U89 applies: validation checks room before agent before other fields;
error payloads allow optional string `detail`; event projection adds only non-null
object `op`; malformed operations follow the existing parser's validity rules.
Store-assigned Lamports are strictly increasing, and waiting uses fake monotonic
time with bounded sleeps without prescribing private implementation names.
