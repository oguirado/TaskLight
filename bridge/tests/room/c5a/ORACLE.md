# C5a fail-first oracle

Authority: `.unit/SPEC.md`, read through its end. The supplied file contains M1–M6 and the Negative controls section. Amendment sections and a separate numbered acceptance list: AUSENTE. M1–M6 are the numbered acceptance cases mapped here. The broader C5 draft does not override this narrower contract.

## Acceptance map

| Case | Acceptance boundary | Exact test names and families |
|---|---|---|
| M1 | Checked read preserves healthy events, ordering and duplicates; existing empty/blank files succeed. | `CheckedReads.test_m1_healthy_events_equal_legacy_read_without_mutation`, `test_m1_existing_empty_journal_succeeds`, `test_m1_existing_blank_journal_succeeds`; empty/blank query controls in the manifest. |
| M1 | Missing, nonregular, malformed complete, invalid-envelope, wrong-room and I/O failures raise `RoomError(room_read_failed)`. | Every `CheckedReads.test_m1_rejects_*` in the manifest; `test_m1_dangling_journal_symlink_is_missing_storage`. |
| M1 | A final line without newline is ignored, including valid JSON, invalid JSON, partial UTF-8 and another room's uncommitted record. | Every `CheckedReads.test_m1_ignores_torn_*`; every `QueryControls.test_m1_torn_*`. |
| M1 | Reads create no home, room, journal or lock and change no files. | `CheckedReads.test_m1_absent_home_is_not_created_by_checked_read`, `test_m1_absent_room_is_not_created_by_checked_read`, `QueryControls.test_m1_public_queries_do_not_recreate_a_removed_writer_lock`; every storage/error test also snapshots its entire temporary tree. |
| M2 | Never-created rooms preserve existing explicit tool errors; an existing room with a missing journal is broken. | `QueryControls.test_m2_never_created_plan_room_keeps_its_existing_no_plan_error`, `test_m2_never_created_plan_room_keeps_mcp_no_plan`, `test_m2_never_created_plan_room_keeps_cli_no_plan`; all `QueryErrors.test_agents_list_missing_*` and `test_plan_get_missing_*`. |
| M2 | Hostile room identifiers stop before filesystem mutation. | Every `QueryControls.test_m2_hostile_*`. |
| M3 | Broken inventory is an application error, MCP `isError: true`, and CLI failure carrying `room_read_failed`; no successful empty/partial inventory. | All `QueryErrors.test_agents_list_*`; `test_m3_cli_agents_list_error_code_is_reported`, `test_m3_failed_room_does_not_hide_healthy_room_inventory`. |
| M4 | Broken plan reads raise `room_read_failed`, including corruption outside a requested revision; unavailable required templates raise `template_unavailable`. | All `QueryErrors.test_plan_get_*`, `test_m4_required_template_*`, `test_m4_missing_required_template_is_not_reported_as_no_plan`, `test_m4_template_loader_failure_has_fixed_public_detail`, `test_m4_since_rev_does_not_hide_a_broken_complete_record`. |
| M4 | Healthy projection/revision behavior remains; unrelated invalid templates do not become required dependencies; repaired dependencies recover. | `QueryControls.test_m4_healthy_plan_and_inventory_match_mcp_and_cli`, `test_m4_since_rev_healthy_projection_is_preserved`, `test_m4_unrelated_invalid_template_does_not_break_a_required_healthy_one`, `QueryErrors.test_m4_repaired_template_restores_the_healthy_plan`. |
| M5 | Only fixed reasons and codes escape; no path, exception or rejected record; shared sanitizer is still used. | Every checked/query error test asserts fixed text and nondisclosure; `QueryErrors.test_m5_mcp_error_still_passes_through_sanitize_output`, `test_m5_cli_error_still_passes_through_sanitize_output`. |
| M6 | Tolerant read, waiter, inbox, status observer and export retain their semantics; strict snapshot keeps its own refusal code. | Every `LegacyTolerance.test_m6_*`; `QueryControls.test_m6_snapshot_still_rejects_torn_tail_that_checked_queries_accept`. Existing regression suites are run without editing them. |

## Negative controls and stop rules

| Prohibited behavior | Discriminating tests |
|---|---|
| A missing journal produces a healthy empty result. | `CheckedReads.test_m1_rejects_missing`; `QueryErrors.test_agents_list_missing_direct`, `test_agents_list_missing_mcp`, `test_agents_list_missing_cli`. |
| A torn last line is rejected. | `CheckedReads.test_m1_ignores_torn_json_fragment`, `test_m1_ignores_torn_invalid_utf8`, `test_m1_ignores_torn_complete_json_without_newline`; all torn query controls. |
| Corrupt inventory becomes empty or partial success. | `QueryErrors.test_agents_list_malformed_json_direct`, `test_agents_list_malformed_json_mcp`, `test_agents_list_malformed_json_cli`; each starts with a real admitted agent. |
| Journal path, rejected record or I/O exception reaches the public error. | Every query-error family checks fixed public text; open/read failures inject a private marker and the dynamic target path at actual I/O boundaries. |
| Reads initialize storage or a writer lock. | Entire-tree snapshots surround success and failure; missing-home/missing-room controls and `test_m1_public_queries_do_not_recreate_a_removed_writer_lock`. |
| Failure of one room is treated as a healthy observation or poisons another room. | `CheckedReads.test_m1_room_failures_do_not_poison_an_independent_healthy_room`, `QueryErrors.test_m3_failed_room_does_not_hide_healthy_room_inventory`. |
| A template load failure is silently downgraded to `no_plan`. | Required-template missing/corrupt/directory/open/read families and `test_m4_template_loader_failure_has_fixed_public_detail`. |

Every broken read must stop that query with the specified error. Tests do not prescribe internal helper call order, caching strategy, file-opening API or projection implementation. The assertion guarding the absent `store.read_checked` entry point is deliberate: discovery must succeed and missing behavior must be an assertion failure, never an import error. No replacement reader or production stub is installed.

## Contract interpretations and unresolved conflict

- `read_checked(room)` is called as specified using the isolated `CW_HOME`. Its event contents are checked without choosing between an event list and the legacy `(events, diagnostics)` pair; the spec does not settle that return-container detail.
- Today's tolerant reader accepts a readable symlink. The conditional symlink clause therefore preserves that acceptance, tested by `test_m1_existing_symlink_matches_legacy_acceptance_policy`; a dangling link still fails as missing storage. No universal symlink prohibition is invented.
- `plan_get` currently returns `no_plan` for a never-created room. M2 preserves that explicit error. Never-created `agents_list` currently succeeds empty; M2 does not specify a replacement code for that non-error case, so this oracle does not ratify either outcome. Existing room directories with missing journals are fully covered.
- A template is made required by first creating and reading an accepted active plan using a unique user template. Failures occur only after fixture admission. An unrelated malformed template is a healthy control. Generation/hash policy is unchanged.
- M3 expressly requires the CLI code on stderr, while the protected `bridge/room/__main__.py` currently emits caught errors as JSON on stdout. The literal stderr assertion remains in scope. This is an unresolved specification/surface conflict, not permission to edit the adapter or silently weaken the assertion.
- File access times may change on reads. Mutation checks compare names, types, inode/mode/size, modification/change times, symlink targets and file bytes; access time is excluded.

## Isolation and execution

All runtime files are temporary children of `bridge/tests/room/c5a` and are cleaned up. Clocks and generated event IDs are deterministic. Sockets, network connections, real sleep and real timers are forbidden. FIFO fixtures are real FIFOs with nonblocking failure guards, so a tolerant open cannot hang discovery. Permission/read failures are injected at existing file-I/O boundaries instead of relying on the account's permission privileges. MCP uses the real stdio parser; CLI uses its real entry point in process. No network service or subprocess is needed.

Run from the repository root with bytecode disabled:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/c5a -t .
```

## Out of scope

| Other unit or draft area | Status |
|---|---|
| C5 draft M2–M8 browser ingestion, mapping, relay/link errors, transport deadlines, UI and replay recovery | Out of scope; no failures attributed to C5a. |
| C5 draft stricter torn-tail/coherent-capture policy | Out of scope; C5a explicitly ignores the incomplete final line. |
| Generic `room_projection_failed` / mapper/resolver redesign beyond required-template availability | Out of scope; no error names imported from the broader draft. |
| C2 inventory membership, lifecycle schema, parent/child and browser parity changes | Out of scope; existing lifecycle admission is used only to establish a healthy fixture. |
| D4 hash-policy changes; U161 generation/recovery changes | Out of scope; no hash or phase semantics are altered. |
| `bridge/room/mcp.py`, `bridge/room/__main__.py`, `bridge/wall/emit.py`, `bridge/room/ext/orchestrator_snapshot.py`, relay implementation | Protected production surface; no edits. Existing transport behavior is exercised. |

## Exact test manifest

Names below include every generated matrix member; they are discoverable stdlib unittest method names.

| Module | Class | Exact test method |
|---|---|---|
| `test_checked_reads.py` | `CheckedReads` | `test_m1_absent_home_is_not_created_by_checked_read` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_absent_room_is_not_created_by_checked_read` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_dangling_journal_symlink_is_missing_storage` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_existing_blank_journal_succeeds` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_existing_empty_journal_succeeds` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_existing_symlink_matches_legacy_acceptance_policy` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_healthy_events_equal_legacy_read_without_mutation` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_ignores_torn_complete_json_without_newline` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_ignores_torn_invalid_non_json_without_newline` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_ignores_torn_invalid_utf8` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_ignores_torn_json_fragment` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_ignores_torn_wrong_room_without_newline` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_rejects_complete_invalid_event_envelope` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_rejects_complete_invalid_op_envelope` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_rejects_complete_null` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_rejects_complete_object_without_event_fields` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_rejects_complete_scalar` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_rejects_directory` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_rejects_fifo` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_rejects_invalid_shape` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_rejects_invalid_utf8` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_rejects_malformed_json` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_rejects_missing` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_rejects_open_denied` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_rejects_read_failed` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_rejects_wrong_room` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_repair_is_observed_without_persisted_read_state` |
| `test_checked_reads.py` | `CheckedReads` | `test_m1_room_failures_do_not_poison_an_independent_healthy_room` |
| `test_checked_reads.py` | `LegacyTolerance` | `test_m6_directory_journal_remains_tolerant` |
| `test_checked_reads.py` | `LegacyTolerance` | `test_m6_export_keeps_tolerant_empty_projection` |
| `test_checked_reads.py` | `LegacyTolerance` | `test_m6_inbox_still_filters_tolerant_events` |
| `test_checked_reads.py` | `LegacyTolerance` | `test_m6_malformed_lines_are_counted_and_healthy_events_survive` |
| `test_checked_reads.py` | `LegacyTolerance` | `test_m6_missing_journal_remains_tolerant_without_creation` |
| `test_checked_reads.py` | `LegacyTolerance` | `test_m6_since_filter_and_parse_diagnostics_are_preserved` |
| `test_checked_reads.py` | `LegacyTolerance` | `test_m6_snapshot_keeps_its_distinct_snapshot_unavailable_code` |
| `test_checked_reads.py` | `LegacyTolerance` | `test_m6_status_observer_keeps_tolerant_valid_content` |
| `test_checked_reads.py` | `LegacyTolerance` | `test_m6_torn_tail_remains_ignored_by_legacy_read` |
| `test_checked_reads.py` | `LegacyTolerance` | `test_m6_waiter_still_skips_corruption_without_sleeping` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_directory_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_directory_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_directory_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_fifo_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_fifo_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_fifo_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_invalid_shape_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_invalid_shape_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_invalid_shape_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_invalid_utf8_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_invalid_utf8_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_invalid_utf8_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_malformed_json_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_malformed_json_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_malformed_json_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_missing_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_missing_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_missing_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_open_denied_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_open_denied_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_open_denied_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_read_failed_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_read_failed_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_read_failed_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_wrong_room_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_wrong_room_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_agents_list_wrong_room_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_m3_cli_agents_list_error_code_is_reported` |
| `test_query_errors.py` | `QueryErrors` | `test_m3_failed_room_does_not_hide_healthy_room_inventory` |
| `test_query_errors.py` | `QueryErrors` | `test_m4_missing_required_template_is_not_reported_as_no_plan` |
| `test_query_errors.py` | `QueryErrors` | `test_m4_repaired_template_restores_the_healthy_plan` |
| `test_query_errors.py` | `QueryErrors` | `test_m4_required_template_corrupt_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_m4_required_template_corrupt_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_m4_required_template_corrupt_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_m4_required_template_directory_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_m4_required_template_directory_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_m4_required_template_directory_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_m4_required_template_missing_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_m4_required_template_missing_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_m4_required_template_missing_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_m4_required_template_open_denied_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_m4_required_template_open_denied_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_m4_required_template_open_denied_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_m4_required_template_read_failed_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_m4_required_template_read_failed_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_m4_required_template_read_failed_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_m4_since_rev_does_not_hide_a_broken_complete_record` |
| `test_query_errors.py` | `QueryErrors` | `test_m4_template_loader_failure_has_fixed_public_detail` |
| `test_query_errors.py` | `QueryErrors` | `test_m5_cli_error_still_passes_through_sanitize_output` |
| `test_query_errors.py` | `QueryErrors` | `test_m5_mcp_error_still_passes_through_sanitize_output` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_directory_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_directory_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_directory_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_fifo_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_fifo_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_fifo_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_invalid_shape_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_invalid_shape_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_invalid_shape_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_invalid_utf8_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_invalid_utf8_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_invalid_utf8_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_malformed_json_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_malformed_json_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_malformed_json_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_missing_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_missing_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_missing_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_open_denied_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_open_denied_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_open_denied_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_read_failed_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_read_failed_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_read_failed_mcp` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_wrong_room_cli` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_wrong_room_direct` |
| `test_query_errors.py` | `QueryErrors` | `test_plan_get_wrong_room_mcp` |
| `test_query_errors.py` | `QueryControls` | `test_m1_blank_agents_list_cli` |
| `test_query_errors.py` | `QueryControls` | `test_m1_blank_agents_list_direct` |
| `test_query_errors.py` | `QueryControls` | `test_m1_blank_agents_list_mcp` |
| `test_query_errors.py` | `QueryControls` | `test_m1_blank_plan_get_cli` |
| `test_query_errors.py` | `QueryControls` | `test_m1_blank_plan_get_direct` |
| `test_query_errors.py` | `QueryControls` | `test_m1_blank_plan_get_mcp` |
| `test_query_errors.py` | `QueryControls` | `test_m1_empty_agents_list_cli` |
| `test_query_errors.py` | `QueryControls` | `test_m1_empty_agents_list_direct` |
| `test_query_errors.py` | `QueryControls` | `test_m1_empty_agents_list_mcp` |
| `test_query_errors.py` | `QueryControls` | `test_m1_empty_plan_get_cli` |
| `test_query_errors.py` | `QueryControls` | `test_m1_empty_plan_get_direct` |
| `test_query_errors.py` | `QueryControls` | `test_m1_empty_plan_get_mcp` |
| `test_query_errors.py` | `QueryControls` | `test_m1_public_queries_do_not_recreate_a_removed_writer_lock` |
| `test_query_errors.py` | `QueryControls` | `test_m1_torn_agents_list_cli` |
| `test_query_errors.py` | `QueryControls` | `test_m1_torn_agents_list_direct` |
| `test_query_errors.py` | `QueryControls` | `test_m1_torn_agents_list_mcp` |
| `test_query_errors.py` | `QueryControls` | `test_m1_torn_plan_get_cli` |
| `test_query_errors.py` | `QueryControls` | `test_m1_torn_plan_get_direct` |
| `test_query_errors.py` | `QueryControls` | `test_m1_torn_plan_get_mcp` |
| `test_query_errors.py` | `QueryControls` | `test_m2_hostile_agents_list_control` |
| `test_query_errors.py` | `QueryControls` | `test_m2_hostile_agents_list_non_string` |
| `test_query_errors.py` | `QueryControls` | `test_m2_hostile_agents_list_traversal` |
| `test_query_errors.py` | `QueryControls` | `test_m2_hostile_plan_get_control` |
| `test_query_errors.py` | `QueryControls` | `test_m2_hostile_plan_get_non_string` |
| `test_query_errors.py` | `QueryControls` | `test_m2_hostile_plan_get_traversal` |
| `test_query_errors.py` | `QueryControls` | `test_m2_never_created_plan_room_keeps_cli_no_plan` |
| `test_query_errors.py` | `QueryControls` | `test_m2_never_created_plan_room_keeps_its_existing_no_plan_error` |
| `test_query_errors.py` | `QueryControls` | `test_m2_never_created_plan_room_keeps_mcp_no_plan` |
| `test_query_errors.py` | `QueryControls` | `test_m4_healthy_plan_and_inventory_match_mcp_and_cli` |
| `test_query_errors.py` | `QueryControls` | `test_m4_since_rev_healthy_projection_is_preserved` |
| `test_query_errors.py` | `QueryControls` | `test_m4_unrelated_invalid_template_does_not_break_a_required_healthy_one` |
| `test_query_errors.py` | `QueryControls` | `test_m6_snapshot_still_rejects_torn_tail_that_checked_queries_accept` |
