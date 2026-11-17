# C6 fail-first oracle

Source: `.unit/SPEC.md`, read in full. It has no Amendment sections and no separate numbered acceptance list. The MUST cases below are the acceptance map. Only the designated test directories are changed; there are no product stubs.

| Acceptance | Tests |
| --- | --- |
| M1: terminal result schema; verdicts ADMIT, HOLD, NO_PUDE, OK, FAIL | `ResultOracle.test_m1_shape_*`, driven by `result_cases.json`; the same named vectors run in `tests/unit/c6/result_shape.test.ts` |
| M1: bounds, wrong types, unknown keys, hostile nested objects | `test_m1_shape_summary_limit`, `test_m1_shape_unicode_summary_limit`, `test_m1_shape_receipt_limit`, `test_m1_shape_evidence_path_limit`, `test_m1_shape_evidence_count_limit`, every invalid vector, and `test_m1_unknown_key_negative_control_has_valid_positive_twin` |
| M1: legacy admission and byte-identical replay | `test_m1_legacy_events_still_admit_without_result`, `test_m1_legacy_fixture_fold_is_byte_identical`; existing C2 legacy fixture is read without changing it |
| M1: admitted result persistence/replay and retry | Every valid vector checks the admitted journal and replay; `test_m1_exact_result_retry_is_idempotent` |
| M2: valid result after child exit, on success/failure/signal | `SupervisorOracle.test_m2_valid_result_is_read_after_child_exit_and_attached_to_finished`, `test_m2_valid_result_is_attached_to_failed_nonzero_exit`, `test_m2_valid_result_is_attached_to_failed_signal_exit` |
| M2: invalid/missing file still writes terminal event, no result, one stderr line; A-C6b permits omitted receipt | `test_m2_missing_result_still_finishes_with_one_diagnostic`, `test_m2_missing_result_still_preserves_failed_child_exit`, `test_m2_malformed_json_still_emits_terminal_event`, `test_m2_invalid_encoding_still_emits_terminal_event`, `test_m2_directory_instead_of_file_still_emits_terminal_event`, `test_m2_json_null_is_invalid_result`, `test_m2_json_array_is_invalid_result`, `test_m2_unknown_result_key_is_not_attached`, `test_m2_oversize_result_summary_is_not_attached`, `test_m2_invalid_evidence_hash_is_not_attached`, `test_m2_missing_optional_receipt_is_attached` (A-C6b: accepted without a receipt, with no diagnostic) |
| M2: preserved run behavior; parser stop before launch | `test_m2_legacy_run_without_result_option_is_unchanged`, `test_m2_legacy_failed_run_without_result_option_is_unchanged`, `test_m2_missing_result_file_flag_value_stops_before_launch`; the shared supervisor assertion checks exit status and terminal identity |
| M3: registration and complete ordered batches | `WaitOracle.test_m3_tool_discovery_advertises_the_spec_arguments`, `test_m3_returns_all_existing_terminals_in_lamport_order`, `test_m3_never_silently_limits_a_batch_to_the_first_event`, `test_m3_all_runs_of_the_same_agent_remain_waitable` |
| M3: exclusive cursor; agent, direct-parent, state, room and act filters | `test_m3_since_cursor_is_strictly_exclusive`, `test_m3_agents_filter_is_an_exact_allowlist`, `test_m3_parent_selects_direct_children_not_grandchildren`, `test_m3_terminal_inherits_parent_from_its_deployment`, `test_m3_agents_parent_and_states_filters_intersect`, `test_m3_explicit_states_can_select_nonterminal_lifecycle`, `test_m3_room_filter_never_returns_another_rooms_completion`, `test_m3_other_acts_do_not_count_as_lifecycle_completions` |
| M3: parent/result projection and legacy result omission | `test_m3_result_and_parent_are_returned_with_the_event`; `assert_wait_rows` checks every event's agent, run_id, state, parent, lamport and optional result |
| M3: block, wake and timeout | `test_m3_wait_blocks_until_a_later_matching_event`, `test_m3_nonmatching_event_does_not_end_the_wait`, `test_m3_default_timeout_is_sixty_virtual_seconds`, `test_m3_minimum_timeout_is_one_virtual_second`, `test_m3_maximum_timeout_is_six_hundred_virtual_seconds`, `test_m3_empty_room_timeout_has_an_empty_stateless_cursor` |
| M3: hostile arguments and early stop | Every `test_m3_bad_args_*`; discovery is checked first so an unknown-tool rejection cannot count as validation; invalid arguments append nothing and never advance time |
| M4: no consumption and no between-call loss | `test_m4_same_cursor_replays_matches_without_consuming_them`, `test_m4_append_between_calls_is_delivered_using_the_previous_cursor`, `test_m4_independent_parent_filters_do_not_consume_each_others_events` |
| M5: MCP/CLI parity and shared sanitizer | `test_m5_mcp_and_cli_return_identical_wait_data`, `test_m5_legacy_wait_data_is_identical_on_mcp_and_cli`, `test_m5_shared_sanitizer_redacts_summary_but_preserves_result_pointers` |
| M6: nullable, compact, current-run inventory result | Every `ResultOracle.test_m6_*`: no result, truncation, unchanged short summary, agent isolation, redeployment reset and MCP/CLI parity |
| M7: guide and complete orchestrator loop | `DocumentationOracle.test_m7_wait_agents_guide_contains_launch_wait_cursor_and_completion_loop` |

## Contract choices

- `result` is optional as a whole. A-C6b: when present, only `verdict` is required; `summary`, `receipt` and `evidence` are optional and validated when supplied. Null is invalid. Empty strings and an empty evidence list are permitted because the spec gives no minimum lengths.
- Length means Unicode characters, matching the existing Python/browser code-point convention. The inclusive summary, pointer and evidence limits are tested [CITED: M1]. Hex digests may use either letter case.
- Result data belongs only to `finished`/`failed`, never `deployed`/`alive`. Path values are passive pointers; tests never dereference a reported receipt or evidence path.
- An omitted `since_lamport` starts from the beginning. Parent uses the existing C2 `{agent, run_id}` shape or null; its filter selects direct children. When terminal metadata omits the parent, the existing run link retained by C2 supplies it. Explicit states can select any valid lifecycle state.
- Filtered cursor advancement is unspecified: assertions permit either the last matching event or a later examined journal position, without permitting missed matches. Empty-room timeout starts at the initial cursor; no-new-event timeout retains the supplied cursor. Empty filter-list semantics and cursors beyond the journal head are not invented.
- Inventory truncation may use an ellipsis; it must retain the leading summary text and stay within the stated character cap [CITED: M6]. Short summaries and pointer bytes remain unchanged.
- Browser validators retain their existing error-code vocabulary; invalid shapes must be rejected. The Python lifecycle API must specifically return `bad_args`.
- M7 accepts either cursor CLI flags or the documented `call wait_agents` JSON form, without prescribing the guide's programming language.

## Determinism and negative controls

Room files are temporary children of this test directory and are cleaned after each case. Wall time, monotonic time, sleeps, Event waits and Condition waits are virtual. Network access raises immediately. Lifecycle fixtures first deploy their run, preserving the C2 admission prerequisite. The supervisor uses the existing CLI entry with a fake stdlib process boundary, while admission, validation, cleanup and persistence stay real. The result is published by the fake child only at exit in the positive timing case. Wait operations have finite virtual-time, iteration and instruction budgets; a busy loop cannot hang discovery. Tests import only existing modules, and missing tool registration fails an assertion.

Consuming a result fails M4's same-cursor replay. Returning a single match fails M3's complete batch, including a batch beyond the existing journal-reader default size. Accepting an unknown result key fails both the shared shape vector and its valid-positive-twin control. Redacting the stored journal or altering a receipt/evidence pointer fails M5.

## Out of scope

C2 membership/state precedence, parent-cycle admission and browser inventory derivation; C1b heartbeat cadence, stream/signal forwarding and room bootstrap; C1 harness adapters; C3 snapshots; C4 rotation; C5 sync state; C7 exports; C8 templates; U163's existing sanitizer implementation and its other transports. Existing suites own those rules. C6 only adds terminal results, their supervisor ingestion, waiting, current-run inventory result exposure, browser shape parity and its dedicated guide.

## Verification commands

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/c6 -t .
node_modules/.bin/vitest run --project unit --no-cache tests/unit/c6/result_shape.test.ts
```
