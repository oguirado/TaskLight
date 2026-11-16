# U89 fail-first oracle

Contract source: `.unit/SPEC.md`, M1–M8, A1–A8, and its final Amendment B-U89.
The import-time extension registration is functional; only `handler(args) -> dict`
raises `NotImplementedError("U89 stub")`. No import-time exception is permitted.

## Acceptance map

All Python names below are in `bridge/tests/room/u89/test_events.py`.
The `test_a7_*` input tests are generated as separately discoverable unittest methods.

| Case | Test names | Verification gate and negative contrast |
| --- | --- | --- |
| A1 | `CursorOracle.test_a1_complete_fields_and_two_pages`, `test_a1_caller_is_not_an_author_filter`, `test_a1_order_is_lamport_not_file_order`, `test_a1_repeat_request_does_not_consume_state`, `test_a1_only_requested_room_journal_is_read`, `test_m3_exact_event_projection_drops_unlisted_fields` | Exact events and response types, ascending Lamport pages, own and other authors, raw nested values; reject inbox selection, author filtering, state consumption, room leakage and extra event fields. |
| A2 | `CursorOracle.test_a2_omitted_limit_returns_small_fixture`, `test_a2_default_limit_is_100`, `test_a2_limit_500_is_inclusive`, `test_a2_limit_one_is_inclusive`, `test_a2_equal_head_is_empty_without_resync`, `test_a2_exact_page_has_no_more` | Defaults and inclusive limits on the specified fixture sizes [TARGET]; reject off-by-one pages, false continuation and equal-head resync. |
| A3 | `CursorOracle.test_a3_memory_filter_advances_over_excluded_tail`, `test_a3_empty_and_unknown_filters_match_nothing`, `test_a3_filters_use_or_within_each_array_and_and_between`, `test_a3_filtered_pagination_and_strict_cursor`, `test_a3_filter_values_are_literal_strings`, `test_a3_malformed_op_values_are_skipped_cleanly`; `OracleControls.test_a3_inbox_negative_control_is_rejected_by_a1_and_a3`, `test_a3_cursor_trap_negative_control_is_rejected` | OR within arrays, AND between arrays, absent/empty distinction, malformed operations and passive unknown strings; reject whitelist errors, excluded-tail cursor traps and inbox source substitution. |
| A4 | `CursorOracle.test_a4_ahead_cursor_resyncs_immediately_even_with_wait`, `test_a4_missing_journal_is_empty_and_never_created`, `test_a4_empty_existing_journal_is_not_resync_at_zero`, `test_a4_reads_preserve_journal_and_lock_bytes_and_metadata`; `test_m8_unset_cw_home_uses_default_context_wall`; `OracleControls.test_a4_waiting_ahead_negative_control_is_rejected` | Ahead cursors resync without sleep; absent stores stay absent; file names, bytes, modes, inodes and write times stay unchanged. Reject directory creation, silent reset, lock changes, waiting on an ahead cursor and wrong default storage. |
| A5 | `CursorOracle.test_a5_torn_tail_is_invisible_until_newline_without_rewrite`, `test_a5_malformed_and_invalid_complete_lines_do_not_set_head`, `test_a5_malformed_lines_do_not_hide_later_valid_events`; `test_m5_response_uses_one_captured_read`; `OracleControls.test_fixture_is_valid_under_existing_journal_parser`, `test_m5_store_assigns_strictly_increasing_lamports` | Torn, malformed JSON, invalid UTF-8 and invalid event objects cannot affect events/head or hide later valid lines. Append after the mandated parser returns to expose a second-read head/page race; reject mixed snapshots and journal rewriting. Store-assigned Lamports increase strictly. |
| A6 | `CursorOracle.test_a6_zero_wait_never_sleeps`, `test_a6_omitted_wait_defaults_to_zero_without_sleep`, `test_a6_available_match_with_wait_returns_without_sleep`, `test_a6_fake_monotonic_timeout_returns_latest_filtered_head`, `test_a6_empty_filter_waits_until_fake_deadline`, `test_a6_missing_journal_waits_without_creating_storage`, `test_a6_rereads_reapply_pagination_and_filters`, `test_a6_other_process_wakes_only_on_matching_append` | Fake monotonic deadlines and remaining-time sleep caps; synchronized waiter and separate writer processes. The public heartbeat writer must append while the reader is sleeping, and a second poll proves it did not satisfy the memory filter. Reject real sleeping, unrelated wakeups, stale timeout heads and held writer locks. |
| A7 | `CursorOracle.test_a7_existing_slug_boundaries_are_accepted`, `test_a7_hostile_event_and_nested_op_remain_literal`, generated `test_a7_room_*`, `test_a7_agent_*`, `test_a7_both_slugs_missing`, `test_a7_cursor_missing`, `test_a7_after_lamport_*`, `test_a7_limit_*`, `test_a7_wait_ms_*`, `test_a7_wait_30001`, `test_a7_acts_*`, `test_a7_ops_*`, `test_a7_unknown_key` | Slug checks and amended room-before-agent-before-other-arguments precedence before storage access; booleans, integral and fractional floats, strings, nulls, ranges and malformed array members are rejected. Missing room/agent plus missing cursor and simultaneous malformed fields are covered. Hostile text and filter strings stay literal. Reject coercion, traversal and execution. |
| A8 | `ProtocolOracle.test_a8_registration_schema_and_fresh_mcp_discovery`, `test_a8_success_is_raw_in_handler_and_untrusted_in_mcp`, `test_a8_errors_are_structured_and_server_survives`, `test_a8_pages_and_retries_are_stateless_across_fresh_processes`, `test_a8_hostile_text_stays_literal_inside_untrusted_envelope`, `test_m1_import_has_no_mcp_or_app_dependency`, `test_m1_application_imports_stay_within_extension_seam`; inbox control above | Fresh real stdio MCP processes, unique discovery, S3 schema, exact untrusted envelope, structured errors and surviving ping. Reject duplicate registration, application import cycles and wrapping inside the handler. CLI parity is deferred to U87, below. |

## Determinism and fail-first evidence

`support.py` builds journals independently, then checks their validity with the
existing parser. Fixtures and subprocess `CW_HOME` values live in temporary
folders inside this test package and are removed after each case. No network
or ports are used. Waiting uses fake `time.monotonic`/`time.sleep`, including
already-bound aliases. Process pipe polls, subprocess timeouts and joins are
bounded hang watchdogs, not behavioral timers or latency assertions.
No particular poll interval, private cursor helper or storage API is required.

An executable negative control substitutes a deliberately broken inbox-backed
handler in memory and runs the actual A1 and A3 test methods. Both must fail by
assertion, with no harness error; the outer control passes only then. Product
files are never mutated for these controls. Additional executable mutants return
the unchanged cursor on an empty filtered tail or sleep before returning an ahead
cursor's resync response. The existing A3 and A4 behavioral tests must reject them
by assertion, with no harness error. The latter uses fake time, not real sleeping.

Protocol cases first check the public handler contract so the red phase exposes
`NotImplementedError: U89 stub` rather than a transport's generic internal-error
mapping. Once that gate passes, they run real fresh stdio processes; the transport
and dispatcher are not mocked. `tests/unit/u89/protocol.test.ts` runs these same
protocol cases through bounded stdlib unittest subprocesses. Its test count is
an additional runner count, not an additional set of independent behaviors.

## Scope decisions and integration stop rules

- Amendment B-U89 governs validation precedence: missing, non-string or malformed
  room gives `bad_room`, then the equivalent agent checks give `bad_agent`, then
  all remaining argument errors give `bad_args`, before any storage access.
- `agent` is a caller identifier only. Returned event objects contain exactly the
  listed event fields, with `op` included only for a non-null object. Additional
  journal metadata is excluded; listed fields and nested `op` data stay unchanged.
  The existing validity parser rejects null or non-object operations, so these
  whole invalid events are skipped cleanly rather than projected or coerced.
- Store-assigned Lamports are strictly increasing; the existing public writer
  is checked against this invariant. No duplicate-Lamport page grouping or new
  tie-breaking cursor is imposed on externally corrupted journals.
- Error envelopes permit optional string `detail` alongside `ok` and `code`,
  retaining U87 compatibility. Success data has exactly one untrusted wrapper
  at the MCP boundary and no wrapper inside the handler.
- Polling uses injectable stdlib time dependencies, including bound imports.
  Sleeps must be positive and capped by the remaining monotonic deadline; the
  synchronized append must wake the waiter before that deadline. No helper name
  or exact polling period is mandated by the oracle. Clock/sleep call watchdogs
  bound buggy busy loops without using wall-clock behavior as an assertion.
- Unknown string filters are accepted and match literally; no future operation
  kind is inserted into fixtures in violation of the existing parser contract.
- U87 owns CLI `call room_events` parity. The current CLI has no generic `call`
  command. That conditional A8 clause is out of scope here, not a failing U89 test.
- U96 owns committed-read isolation and push transport; U97 owns authentication;
  U102 owns rotation and authoritative snapshot hydration. Wall/UI changes,
  documentation outside these oracle notes, and `plan_get.since_rev` changes are
  out of scope. Resync signaling itself remains covered here.
- Integration cannot be declared green while the intended stub failures remain,
  while existing Python suites fail, while the secret scan fails, while Vitest
  drops below its existing passing count, or while TypeScript gains diagnostics.
- Integration requires at least 9360 existing Vitest passes and no diagnostics
  beyond the 16-error TypeScript baseline [CITED: `.unit/SPEC.md`, M8]. The current
  TypeScript baseline was checked before oracle edits: 16 existing diagnostics,
  all outside the U89 test files [MEASURED].
- Existing compatibility assertions in `bridge/tests/room/test_mcp.py`,
  `bridge/tests/room/u69/test_contract.py` and
  `bridge/tests/room/u69/test_repair1.py` freeze the complete pre-extension tool
  list or its size. The required additive registration makes those assertions
  fail. Updating those expectations is outside the authorized write surface;
  this is an unresolved integration blocker, not permission to hide the tool.

## Verification receipt

The existing `bridge/room/ext/events.py` stub and its registration were retained
without changes. The oracle's non-stub checks, including all executable negative
controls, pass. Each behavioral error is the public handler's exact
`NotImplementedError: U89 stub`, with no collection or fixture errors.

| Runner | Measured outcome | Exact verdict line |
| --- | --- | --- |
| Python U89 | 119 tests; 111 red, 8 green [MEASURED] | `FAILED (errors=111)` |
| Vitest U89 | 5 tests; 4 red, 1 green [MEASURED] | `Tests  4 failed \| 1 passed (5)` |
| Existing Vitest unit suite, excluding U89 | 9360 green, 2 skipped [MEASURED] | `Tests  9360 passed \| 2 skipped (9362)` |
| Existing Python plan suite | 526 green [MEASURED] | `OK` |
| Existing Python room suite, excluding U89 | 210 tests; 207 green, 3 pre-existing failures [MEASURED] | `FAILED (failures=3)` |
| TypeScript | 16 existing diagnostics, none in U89 [MEASURED] | Existing baseline retained |
| Secret scan | 0 findings [MEASURED] | Clean |

The existing room failures are
`bridge.tests.room.test_mcp.Handshake.test_tools_list`,
`bridge.tests.room.u69.test_contract.Contract.test_a3_append_tools_in_order`, and
`bridge.tests.room.u69.test_repair1.Repair1.test_script_moves_existing_root_to_front`.
These assertions already rejected the retained registration before oracle edits.
They remain integration blockers; they are not classified as another unit's
out-of-scope behavior or excluded from the reported results.

## Runner commands

Run from the repository root; disable Python bytecode writes.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/u89 -t .
PYTHONDONTWRITEBYTECODE=1 npx vitest run tests/unit/u89 --no-cache --configLoader runner --fsModuleCachePath tests/unit/u89/.cache
npx tsc --noEmit -p .
```
