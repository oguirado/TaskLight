# C1c fail-first oracle

The binding corpus is `.unit/SPEC.md`, read in full. Its acceptance identifiers
are M1–M8; there is no separate numbered acceptance list and no Amendment section.
The cited `strategy/R46/claude_code_hook_contracts.md` is AUSENTE in this workspace;
the event fields and documented SessionEnd reason enum come from the supplied
contract package. No network lookup is required.

Run from the repository root with stdlib unittest:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/c1c -t .
```

## Acceptance map

Test names below are qualified by class. They live in
`bridge/tests/room/c1c/test_native.py`, except DocumentationOracle in
`bridge/tests/room/c1c/test_docs.py`.

| Spec case | Test names |
|---|---|
| M1 | `EntryOracle.test_m1_valid_stdin_is_silent_and_exit_zero`<br>`EntryOracle.test_m1_malformed_json_and_utf8_are_swallowed`<br>`EntryOracle.test_m1_non_object_json_is_rejected`<br>`EntryOracle.test_m1_missing_or_invalid_identity_and_event_are_rejected`<br>`EntryOracle.test_m1_exactly_one_json_object_is_required`<br>`EntryOracle.test_m1_input_at_byte_limit_is_accepted`<br>`EntryOracle.test_m1_input_over_byte_limit_is_rejected_before_dispatch`<br>`EntryOracle.test_m1_limit_counts_utf8_bytes_not_characters`<br>`EntryOracle.test_m1_unknown_events_do_not_mutate_lifecycle`<br>`EntryOracle.test_m1_store_exception_and_error_receipt_are_swallowed`<br>`EntryOracle.test_m1_real_filesystem_store_failure_is_swallowed`<br>`EntryOracle.test_m1_hostile_strings_remain_passive_data` |
| M2 | `RoomSelectionOracle.test_m2_environment_overrides_nearest_project_config`<br>`RoomSelectionOracle.test_m2_nearest_config_wins`<br>`RoomSelectionOracle.test_m2_last_of_eight_directories_is_searched`<br>`RoomSelectionOracle.test_m2_ninth_directory_is_outside_search_bound`<br>`RoomSelectionOracle.test_m2_no_configuration_means_silent_skip_without_cwd_or_cw_room_fallback`<br>`RoomSelectionOracle.test_m2_invalid_config_never_becomes_a_room`<br>`RoomSelectionOracle.test_m2_invalid_explicit_room_does_not_fall_back`<br>`RoomSelectionOracle.test_m2_missing_or_invalid_cwd_without_environment_skips`<br>`RoomSelectionOracle.test_m2_bootstrap_respects_cw_home_and_does_not_create_a_plan` |
| M3 | `IdentityOracle.test_m3_session_slug_and_run_use_session_hash`<br>`IdentityOracle.test_m3_child_slug_normalization_and_prefix_cap`<br>`IdentityOracle.test_m3_distinct_native_ids_have_distinct_agent_and_run_ids`<br>`IdentityOracle.test_m3_run_identity_is_stable_across_events_and_processes`<br>`IdentityOracle.test_m3_raw_content_is_absent_from_all_room_files`<br>`PrivacyOracle.test_m3_session_content_never_reaches_journal_state_or_logs`<br>`PrivacyOracle.test_m3_every_event_discards_raw_content_at_the_lifecycle_boundary` |
| M4 | `MappingOracle.test_m4_session_start_is_deployed`<br>`MappingOracle.test_m4_user_prompt_submit_is_alive_for_session`<br>`MappingOracle.test_m4_pre_tool_use_is_alive_for_session`<br>`MappingOracle.test_m4_heartbeat_uses_child_when_agent_id_is_present`<br>`MappingOracle.test_m4_stop_is_alive_without_finishing_the_session`<br>`MappingOracle.test_m4_stop_failure_is_failed`<br>`MappingOracle.test_m4_session_end_is_finished_and_keeps_documented_reason`<br>`MappingOracle.test_m4_session_end_never_persists_an_undocumented_reason`<br>`MappingOracle.test_m4_subagent_start_is_deployed_with_both_parent_links`<br>`MappingOracle.test_m4_subagent_stop_is_finished_for_the_child_run`<br>`MappingOracle.test_m4_prompt_and_tool_events_share_the_fifteen_second_throttle`<br>`MappingOracle.test_m4_throttle_window_is_half_open_and_does_not_slide_on_ignored_events`<br>`MappingOracle.test_m4_throttle_is_independent_per_acting_agent`<br>`MappingOracle.test_m4_throttle_survives_a_fresh_process_with_state_inside_the_room`<br>`MappingOracle.test_m4_stop_is_not_suppressed_by_prompt_tool_throttle` |
| M5 | `IdempotencyOracle.test_m5_identical_retry_after_throttle_expiry_does_not_append`<br>`IdempotencyOracle.test_m5_event_identity_is_stable_in_separate_processes_without_tool_id`<br>`IdempotencyOracle.test_m5_json_key_order_does_not_change_retry_identity`<br>`IdempotencyOracle.test_m5_distinct_tool_use_ids_do_not_collapse_into_one_event`<br>`IdempotencyOracle.test_m5_hook_name_and_child_id_both_contribute_to_event_identity` |
| M6 | `SettingsOracle.test_m6_settings_cover_every_event_with_async_command_and_matcher_star`<br>`SettingsOracle.test_m6_settings_mode_does_not_read_stdin_or_require_a_room`<br>`SettingsOracle.test_m6_adapter_never_edits_project_settings_files` |
| M7 | `LatencyOracle.test_m7_invocation_on_ten_thousand_events_is_bounded_and_persists` |
| M8 | `DocumentationOracle.test_m8_native_adapter_setup_is_documented_in_at_most_six_steps`<br>`DocumentationOracle.test_m8_desktop_setup_explains_how_to_enable_native_adapter` |

## Fixtures and observation

`bridge/tests/room/c1c/fixtures.json` provides stdin fixtures for every mapped hook
event. Unknown, malformed, oversized and hostile inputs are constructed explicitly
by the tests. IDs and content are synthetic public test data.

`bridge/tests/room/c1c/support.py` discovers the native module before executing it.
A missing entry fails an assertion with an explicit missing-behavior message;
it never causes a module import error or creates a substitute adapter.
`bridge/tests/room/c1c/cli_probe.py` uses the actual module entry through
`runpy.run_module(..., run_name="__main__")`, matching the `python3 -m` entry
semantics. Each invocation runs in a fresh interpreter with a fresh module namespace.

Wall and monotonic clocks are fixed. Product sleeps, network connections and
process launches are forbidden; POSIX alarm functions are replaced with inert test
doubles. No service, socket listener or real alarm is started. Temporary homes,
project configurations, reports and journals stay in temporary directories under
`bridge/tests/room/c1c/` and are removed after each test. Settings JSON is parsed,
never executed as a shell command. The parent subprocess watchdog is only a test
hang guard, as in the existing hook oracles.

Session cases use the real lifecycle journal. The parent schema is not integrated
in the current workspace. Sub-agent mapping and adapter-side throttling use the
existing `app.dispatch("agent_lifecycle", ...)` seam with a frozen successful
receipt. That double captures arguments only: it supplies no parsing, room lookup,
identity, mapping, throttle state or idempotency implementation. Both parent fields
are checked against the session deployment captured through that same seam.
A matching child finish must keep the child run identity. These are adapter
contract checks, not evidence that C2 admission/replay already works.

The real journal retains its existing thirty-second [CITED: existing lifecycle
fold] alive suppression. The adapter's fifteen-second [CITED: M4] gate is therefore
measured at dispatch, independently of that inherited suppression. Journal tests
space fresh events beyond the inherited window; replay tests retry after the
window has expired, so downstream throttling cannot hide duplicate append bugs.

## Interpretations of underspecified details

| Topic | Oracle interpretation |
|---|---|
| Directory bound | Eight [CITED: M2] candidate directories, starting with payload cwd and then its ancestors. The next directory is outside the bound. |
| Invalid explicit room | A malformed TASKLIGHT_ROOM cannot silently choose a different room from project configuration. Missing configuration is silent; no legacy CW_ROOM or cwd-name fallback is allowed. |
| Required identity | Missing/non-string/empty session_id or hook_event_name is invalid input and produces no lifecycle operation. |
| Child normalization | ASCII role fixtures pin lowercasing and punctuation-to-hyphen normalization; the role prefix is capped at twenty-four [CITED: M3] characters. No transliteration or empty-role fallback spelling is prescribed. |
| Run encoding | Run IDs must contain the corresponding session or child hash prefix and satisfy the existing run syntax. No wrapper prefix or canonical digest serialization is prescribed. |
| Heartbeat boundary | The fifteen-second [CITED: M4] window is half-open. Suppressed attempts do not slide it. The limit applies to UserPromptSubmit/PreToolUse; Stop still maps to alive. |
| Missing native event ID | M5 deterministic retry behavior takes precedence over the ambiguous per-process-counter suggestion. Identical input remains idempotent across separate processes and after an intervening event. |
| Invalid SessionEnd reason | Rejection, omission or substitution with a documented enum value is permitted. An undocumented value must never persist. All documented values must round-trip unchanged. |
| Performance | Seed ten thousand [TARGET: M7] valid journal events; require a real append and measure the entire child invocation, including startup. The deterministic oracle admits under two seconds [CITED: M7 suggested generous bound]; the production target remains under three hundred milliseconds [TARGET: M7]. |
| Documentation wording | Test field concepts and the specified section/setup entry, allowing spaces or underscores for privacy field names. Numbered setup items cannot exceed six [CITED: M8]; prose is allowed. |

## Negative controls and preserved behavior

The following tests remain green while the feature is absent. Negative controls
feed corrupted observations to the same assertions used by acceptance tests.
They prove rejection of stdout/nonzero exit, raw IDs/tool content, either missing
parent field and duplicate operation identity. Legacy entries retain explicit
identity, silence and room bootstrap behavior.

- `PreservedLegacyOracle.test_legacy_explicit_lifecycle_entry_still_bootstraps_silently`
- `PreservedLegacyOracle.test_legacy_claude_lifecycle_mode_preserves_explicit_identity`
- `NegativeControlOracle.test_control_stdout_and_nonzero_exit_fail_m1_gate`
- `NegativeControlOracle.test_control_raw_ids_or_tool_input_fail_m3_gate`
- `NegativeControlOracle.test_control_either_missing_parent_field_fails_m4_gate`
- `NegativeControlOracle.test_control_duplicate_operation_fails_m5_gate`

## Out of scope and stop rules

| Surface | Treatment |
|---|---|
| C2 lifecycle admission, parent cycles, unresolved-parent replay, inventory and Python/TS parity | Dependency-owned; captured parent fields are checked here, but absent C2 schema is not reported as a C1c failure. |
| Existing shared lifecycle suppression and cleanup fences | Preserved behavior; adapter checks do not change their thresholds or assert task completion. |
| Bootstrap prose outside the new native-adapter section | The stale legacy bootstrap paragraph is assigned to C2 by its spec. C1c tests require its own native setup and actual bootstrap behavior. |
| Other harness adapters, desktop-native events, CLI supervisors, agent waiting and result transport | Separate units; no acceptance claims or failures here. |
| Hook installation | Only print settings and check them. Never edit settings, install hooks, run generated shell commands, commit, push or deploy. |
| Missing adapter or failed precondition | Stop that test at its assertion gate. Never write a stub module or change production/docs to manufacture a green result. |

The mandate and oracle claims are limited to the supplied specification and the
existing code inside this isolated project corpus.


## Verified fail-first result

The new suite ran sixty tests [MEASURED]: fifty-four assertion failures
[MEASURED], six green tests [MEASURED], and no errors [MEASURED]. The failures
are fifty-two missing-adapter assertions [MEASURED] and two missing-documentation
assertions [MEASURED]. The green tests are the preserved legacy checks and the
negative controls. There are no production stubs or import-error failures.

Exact unittest summary [MEASURED]:

```text
Ran 60 tests in 0.210s

FAILED (failures=54)
```

The existing hook/lifecycle regression selection ran two hundred twenty tests
[MEASURED] with four pre-existing skips [MEASURED] and no failures [MEASURED]:

```text
OK (skipped=4)
```

Its performance diagnostic reported correctness PASS and timing INCONCLUSIVE.
The new adapter latency case remains gated by the missing entry; no latency
success is claimed.
