# SPEC_CX fail-first oracle

Source: `.unit/SPEC.md`, read completely. AUSENTE: final Amendment sections
and a separately numbered acceptance list. M1-M6 are the numbered acceptance
cases present in this copy; each executable test is mapped below.

Run from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/cx -t .
```

## Verification gates and negative controls

| Case | Gate | Rejected contrast |
| --- | --- | --- |
| M1 | Callable and module entry exit zero, both streams empty; shared executor dispatch; explicit room discovery; bounded input | Normal stdout/stderr, direct journal access, alternate room after invalid explicit configuration, unbounded stream read |
| M2 | Exact event states, parent links, persistent per-agent heartbeat window, successful receipt before throttle state | SessionEnd becomes failed; PostToolUse registers; Stop/Interrupt are suppressed; independent children suppress each other |
| M3 | Exact hashed identities and slug rules; first registered child identity retained across fresh entry namespaces; persisted privacy | Missing agent_type changes a registered child; native IDs, prompts, cwd, tool content, model or transcript paths enter room state |
| M4 | Parse the actual printed settings document; exact mapped event set, command and timeouts; no installation or stdin read | SessionEnd has an async key; ignored events are installed; wrong command or timeout |
| M5 | Malformed, hostile, oversized or unidentified input exits silently, with no dispatch or state changes | Permissive duplicate-key/NaN parsing, non-string native identity, partial JSON acceptance, oversized whitespace accepted |
| M6 | Execute the documented settings command, then read the Codex section, paths, trust instructions and event table | Prose passes while the command is unimplemented; missing trust/setup steps; wrong documented event state; private paths |

The negative controls named in the specification are covered directly:
normal output by every entry test; wrong SessionEnd state by
`MappingOracle.test_m2_session_end_reason_other_is_kept`; PostToolUse by
`MappingOracle.test_m2_ignored_PostToolUse`; identity changes after omitted type
by `IdentityOracle.test_m3_first_registration_survives_omitted_type_on_heartbeat_and_stop`;
async SessionEnd by
`SettingsOracle.test_m4_session_end_and_interrupt_are_synchronous_with_timeout_three`;
and prompt/cwd leaks by both privacy tests in `IdentityOracle`.

## Acceptance-to-test map

Names below are relative to `bridge.tests.room.cx`.

| Acceptance | Test name |
| --- | --- |
| M1 | `test_codex_native.EntryOracle.test_m1_callable_main_is_silent_and_zero` |
| M1 | `test_codex_native.EntryOracle.test_m1_cwd_project_configuration_is_discovered` |
| M1 | `test_codex_native.EntryOracle.test_m1_deadline_expiration_is_silent_and_zero` |
| M1 | `test_codex_native.EntryOracle.test_m1_environment_room_overrides_project` |
| M1 | `test_codex_native.EntryOracle.test_m1_exact_byte_limit_is_accepted` |
| M1 | `test_codex_native.EntryOracle.test_m1_invalid_environment_never_falls_back` |
| M1 | `test_codex_native.EntryOracle.test_m1_invalid_nearest_configuration_never_falls_back` |
| M1 | `test_codex_native.EntryOracle.test_m1_last_of_eight_directories_is_discovered` |
| M1 | `test_codex_native.EntryOracle.test_m1_limit_counts_utf8_bytes` |
| M1 | `test_codex_native.EntryOracle.test_m1_missing_cwd_without_environment_room_skips` |
| M1 | `test_codex_native.EntryOracle.test_m1_missing_room_skips_without_writes` |
| M1 | `test_codex_native.EntryOracle.test_m1_module_entry_uses_existing_lifecycle_executor` |
| M1 | `test_codex_native.EntryOracle.test_m1_nearest_project_room_wins` |
| M1 | `test_codex_native.EntryOracle.test_m1_ninth_directory_is_not_discovered` |
| M1 | `test_codex_native.EntryOracle.test_m1_no_direct_journal_access` |
| M1 | `test_codex_native.EntryOracle.test_m1_oversize_stream_read_is_bounded` |
| M1 | `test_codex_native.EntryOracle.test_m1_real_dispatch_bootstraps_and_persists` |
| M1 | `test_codex_native.EntryOracle.test_m1_store_error_receipt_is_silent_and_zero` |
| M1 | `test_codex_native.EntryOracle.test_m1_store_exception_is_silent_and_zero` |
| M1 | `test_codex_native.EntryOracle.test_m1_unknown_arguments_are_silent_and_do_not_dispatch` |
| M5 | `test_codex_native.EntryOracle.test_m5_one_byte_over_limit_is_rejected` |
| M5 | `test_codex_native.HostileOracle.test_m5_duplicate_nested_keys_are_rejected` |
| M5 | `test_codex_native.HostileOracle.test_m5_duplicate_top_level_keys_are_rejected` |
| M5 | `test_codex_native.HostileOracle.test_m5_json_array` |
| M5 | `test_codex_native.HostileOracle.test_m5_json_boolean` |
| M5 | `test_codex_native.HostileOracle.test_m5_json_deeply_nested` |
| M5 | `test_codex_native.HostileOracle.test_m5_json_empty` |
| M5 | `test_codex_native.HostileOracle.test_m5_json_infinity` |
| M5 | `test_codex_native.HostileOracle.test_m5_json_invalid_utf8` |
| M5 | `test_codex_native.HostileOracle.test_m5_json_multiple_objects` |
| M5 | `test_codex_native.HostileOracle.test_m5_json_nan` |
| M5 | `test_codex_native.HostileOracle.test_m5_json_negative_infinity` |
| M5 | `test_codex_native.HostileOracle.test_m5_json_null` |
| M5 | `test_codex_native.HostileOracle.test_m5_json_number` |
| M5 | `test_codex_native.HostileOracle.test_m5_json_string` |
| M5 | `test_codex_native.HostileOracle.test_m5_json_trailing_garbage` |
| M5 | `test_codex_native.HostileOracle.test_m5_json_truncated` |
| M5 | `test_codex_native.HostileOracle.test_m5_missing_empty_or_non_string_event_is_rejected` |
| M5 | `test_codex_native.HostileOracle.test_m5_missing_or_empty_session_id_is_rejected` |
| M5 | `test_codex_native.HostileOracle.test_m5_missing_or_empty_subagent_id_is_rejected` |
| M5 | `test_codex_native.HostileOracle.test_m5_non_string_child_ids_are_rejected` |
| M5 | `test_codex_native.HostileOracle.test_m5_non_string_session_ids_are_rejected` |
| M5 | `test_codex_native.HostileOracle.test_m5_unpaired_surrogate_native_ids_are_silent` |
| M3 | `test_codex_native.IdentityOracle.test_m3_child_identity_and_run_include_correct_native_digests` |
| M3 | `test_codex_native.IdentityOracle.test_m3_child_prompt_and_tool_events_use_child_identity` |
| M3 | `test_codex_native.IdentityOracle.test_m3_first_fallback_registration_is_retained_when_type_arrives` |
| M3 | `test_codex_native.IdentityOracle.test_m3_first_registration_survives_changed_type` |
| M3 | `test_codex_native.IdentityOracle.test_m3_first_registration_survives_omitted_type_on_heartbeat_and_stop` |
| M3 | `test_codex_native.IdentityOracle.test_m3_no_native_or_private_fields_cross_lifecycle_boundary` |
| M3 | `test_codex_native.IdentityOracle.test_m3_persisted_room_records_never_contain_native_ids_or_content` |
| M3 | `test_codex_native.IdentityOracle.test_m3_same_child_in_different_sessions_has_distinct_runs` |
| M3 | `test_codex_native.IdentityOracle.test_m3_session_identity_has_exact_digest_lengths` |
| M3 | `test_codex_native.IdentityOracle.test_m3_slug_falls_back_for_missing_empty_non_ascii_or_non_string_type` |
| M3 | `test_codex_native.IdentityOracle.test_m3_slug_normalizes_and_bounds_prefix` |
| M2 | `test_codex_native.MappingOracle.test_m2_child_heartbeat_window_survives_fresh_entry_namespace` |
| M2 | `test_codex_native.MappingOracle.test_m2_child_precompact_is_ignored_even_with_native_identity` |
| M2 | `test_codex_native.MappingOracle.test_m2_event_Interrupt` |
| M2 | `test_codex_native.MappingOracle.test_m2_event_PreToolUse` |
| M2 | `test_codex_native.MappingOracle.test_m2_event_SessionEnd` |
| M2 | `test_codex_native.MappingOracle.test_m2_event_SessionStart` |
| M2 | `test_codex_native.MappingOracle.test_m2_event_Stop` |
| M2 | `test_codex_native.MappingOracle.test_m2_event_SubagentStart` |
| M2 | `test_codex_native.MappingOracle.test_m2_event_SubagentStop` |
| M2 | `test_codex_native.MappingOracle.test_m2_event_UserPromptSubmit` |
| M2 | `test_codex_native.MappingOracle.test_m2_failed_heartbeat_receipt_does_not_consume_window` |
| M2 | `test_codex_native.MappingOracle.test_m2_heartbeat_events_share_exact_fifteen_second_window` |
| M2 | `test_codex_native.MappingOracle.test_m2_heartbeat_is_independent_per_agent` |
| M2 | `test_codex_native.MappingOracle.test_m2_heartbeat_is_independent_per_room` |
| M2 | `test_codex_native.MappingOracle.test_m2_heartbeat_is_independent_per_run` |
| M2 | `test_codex_native.MappingOracle.test_m2_heartbeat_store_exception_is_silent_and_retryable` |
| M2 | `test_codex_native.MappingOracle.test_m2_ignored_PermissionRequest` |
| M2 | `test_codex_native.MappingOracle.test_m2_ignored_PostCompact` |
| M2 | `test_codex_native.MappingOracle.test_m2_ignored_PostToolUse` |
| M2 | `test_codex_native.MappingOracle.test_m2_ignored_PreCompact` |
| M2 | `test_codex_native.MappingOracle.test_m2_ignored_StopFailure` |
| M2 | `test_codex_native.MappingOracle.test_m2_ignored_UnknownEvent` |
| M2 | `test_codex_native.MappingOracle.test_m2_session_end_reason_other_is_kept` |
| M2 | `test_codex_native.MappingOracle.test_m2_session_end_without_reason_still_finishes` |
| M2 | `test_codex_native.MappingOracle.test_m2_stop_and_interrupt_are_not_heartbeat_throttled` |
| M2 | `test_codex_native.MappingOracle.test_m2_stop_hook_active_still_means_alive` |
| M2 | `test_codex_native.MappingOracle.test_m2_subagent_start_has_session_parent` |
| M6 | `test_settings_docs.DocumentationOracle.test_m6_codex_setup_contains_no_private_paths` |
| M6 | `test_settings_docs.DocumentationOracle.test_m6_documented_settings_command_and_configuration_locations` |
| M6 | `test_settings_docs.DocumentationOracle.test_m6_documents_review_trust_and_vetted_automation` |
| M6 | `test_settings_docs.DocumentationOracle.test_m6_event_mapping_table_matches_executable_events` |
| M4 | `test_settings_docs.SettingsOracle.test_m4_ignored_events_are_not_installed` |
| M4 | `test_settings_docs.SettingsOracle.test_m4_other_events_are_async_with_timeout_ten` |
| M4 | `test_settings_docs.SettingsOracle.test_m4_print_settings_is_silent_on_stderr_and_does_not_read_or_install` |
| M4 | `test_settings_docs.SettingsOracle.test_m4_session_end_and_interrupt_are_synchronous_with_timeout_three` |
| M4 | `test_settings_docs.SettingsOracle.test_m4_settings_have_exact_mapped_events_and_codex_handler_shape` |

## Binding interpretations and bounded fixtures

- M1 limits the accepted JSON document to 65,536 bytes [CITED: `.unit/SPEC.md` M1/M5].
  A single oversize sentinel byte is permitted, matching the cited Claude
  adapter's bounded read. Tests distinguish UTF-8 byte size from character count
  and reject an otherwise valid document with oversized trailing whitespace.
- `TASKLIGHT_ROOM` is authoritative, including when empty or malformed. Project
  discovery checks cwd and at most eight directories [CITED: the existing
  `bridge/room/hook_claude_native.py`], stopping at the nearest configuration
  even if it is unusable. No missing-room fixture depends on host configuration.
- Explicit null `agent_id` is rejected under M5's non-string identity rule. An
  omitted child `agent_type`, an odd type or a non-string type uses the Claude
  slug fallback. These are different fields with different acceptance rules.
- M2's explicit ignore rule controls PreCompact, including child payloads; M3's
  mention of its optional identity does not make it a heartbeat event.
- SessionEnd can omit `reason` under M2's explicit 'when present' wording. When
  present, the tested installed-contract reason is `other`; it means `finished`,
  without asserting task success. Unsupported reason values are not assigned
  invented meanings.
- Synchronous SessionEnd and Interrupt handlers omit `async`, following M4's
  shape and its explicit negative control. Matcher presence is not constrained:
  the spec says it is unnecessary, without forbidding it.
- No C1cr helper exists in this workspace. Identity-retention assertions observe
  lifecycle records after fresh module executions, without prescribing a cache
  format, helper name, counter, hash input for event_id or persistence algorithm.
- Settings tests never install configuration. Documentation tests invoke that
  same documented command before inspecting the existing document, so their
  initial failure is the missing stub behavior. They will require M6 prose
  once executable settings exist; docs are never edited by this oracle.
- All fixtures, generated homes and runtime state are created under this test
  directory and cleaned up. The entry probe fixes clocks and substitutes timer
  registration, forbids sleeps/network/process launches and records forbidden
  operations even if the adapter swallows their exceptions. No port is opened.
- Capture mode replaces only the shared `bridge.room.hook._execute` boundary;
  parsing, mapping, identity, room selection and throttling remain adapter
  behavior. Real-dispatch cases use that original executor and inspect actual
  room events. Direct journal opens outside that executor fail the probe.
- The only new production exports are `main()` and `_lifecycle(payload)` in
  `bridge/room/hook_codex_native.py`; each body raises
  `NotImplementedError("CX stub")`. The normal module guard calls `main()`.

## Out of scope

| Other unit or surface | Reason |
| --- | --- |
| C1c/C1cq Claude adapter changes and Claude settings generation | Existing behavior is a reference and regression surface; this oracle never edits `bridge/room/hook_claude_native.py`. |
| C1cr shared-helper implementation | No helper is supplied; CX must still preserve its own first registered child identity. |
| C2 parent-field storage/schema implementation | CX verifies parent fields through the existing lifecycle boundary; it does not implement the shared schema. |
| C1c M5 replay algorithm and C1c M7 latency target | These are separate-unit requirements, not added CX acceptance conditions. |
| Installed-CLI research artifacts, live hook trust, native event emission and UI visibility | The supplied hook contract is fixture data; no real CLI session, service, network or UI is launched. |
| Changes to `docs/HARNESS_HOOKS.md` or `docs/MCP.md` | Production documentation edits are outside the oracle write allowlist. M6 remains covered by read-only acceptance tests; no docs edit is reported as completed. |
