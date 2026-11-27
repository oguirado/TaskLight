# C7b fail-first oracle

Scope is `.unit/SPEC.md`. The supplied file ends after its negative controls and contains no amendment or separate numbered acceptance list.

| Acceptance case | Test names |
| --- | --- |
| M1. Authorize exact paths referenced by terminal results in this room. | `test_m1_reads_historical_terminal_receipt`, `test_m1_reads_failed_worker_evidence`, `test_m1_refuses_readable_unrecorded_file`, `test_m1_matches_path_as_written_before_resolving`, `test_m1_refuses_pointer_recorded_only_in_another_room` |
| M1. Constrain canonical paths to the project root. Read only bounded regular files. | `test_m1_refuses_recorded_parent_escape`, `test_m1_refuses_recorded_symlink_escape`, `test_m1_reads_recorded_symlink_to_regular_file_inside_root`, `test_m1_refuses_recorded_fifo_without_blocking`, `test_m1_refuses_recorded_directory`, `test_m1_refuses_oversize_even_for_one_byte`, `test_m1_accepts_exact_file_size_cap` |
| M2. Verify all supplied hashes before returning any content, including when a small page does not include the changed bytes. | `test_m2_verifies_tail_against_recorded_hash_before_returning_prefix`, `test_m2_refuses_bad_recorded_hash_when_no_caller_hash`, `test_m2_verifies_caller_hash_on_receipt_without_recorded_hash`, `test_m2_refuses_bad_caller_hash_when_recorded_hash_matches`, `test_mcp_reviews_a_worker_artifact_before_admitting` |
| M2. Return source byte offsets, actual digest and size, bounded pages and replacement characters for invalid UTF-8. | `test_m2_default_and_maximum_page_sizes_are_measured_in_bytes`, `test_m2_invalid_utf8_is_replaced_and_offsets_count_source_bytes`, `test_m2_refuses_limit_outside_closed_interval` |
| M3. Redact text with the Wall sanitizer, preserve pointer bytes and stop if redaction fails. | `test_m3_uses_wall_redaction_and_preserves_pointer_bytes`, `test_m3_sanitizer_failure_stops_output`, `test_mcp_reviews_a_worker_artifact_before_admitting` |
| M4. Scope export to the selected generation. Advertise integration and its optional integer filter in MCP and list integration in the docs. | `test_m4_current_opening_excludes_prior_rows_with_reused_task_id`, `test_m4_historical_opening_excludes_later_rows`, `test_m4_mcp_export_schema_advertises_integration_and_optional_integer`, `test_m4_mcp_docs_list_integration_as_a_room_export_value`, `test_mcp_reviews_a_worker_artifact_before_admitting` |
| M5. Write unfiltered integration beside the existing CLI outputs. | `test_m5_cli_writes_unfiltered_integration_beside_existing_outputs` |
| M6. Require a reason for HOLD or REJECT on a resultless terminal run. Refuse ADMIT with the specified detail and preserve the journal on rejection. | `test_m6_hold_accepts_finished_and_failed_resultless_runs_with_reason`, `test_m6_reject_accepts_finished_and_failed_resultless_runs_with_reason`, `test_m6_admit_refuses_a_terminal_run_without_result_with_required_detail` |

The MCP workflow captures a worker result with `wait_agents`, reads its evidence with `artifact_read`, records `unit_decide`, and checks `room_export`. Its hash-mismatch control checks the tool error envelope for missing artifact text. The FIFO guard fails an attempted blocking open immediately. Fixtures use temporary rooms and the existing fake clocks, instruction budget and network guards.

The spec gives an MCP argument object. The stub follows the existing extension handler signature `artifact_read(args: dict) -> dict`. A registered tool is checked through real MCP dispatch. Direct handler checks reach the stub even before registration. Export, decision and documentation checks run independently.

The room API and evidence validators expose no room-to-project lookup. Artifact fixtures exercise the specified working-directory fallback. Page limits count file bytes before UTF-8 replacement and redaction. If both a recorded and a caller hash exist, the artifact must satisfy both. Generation fixtures use distinct runs that start and finish within their own plan openings and reuse the same task identifier. The spec does not define ownership for a run that straddles openings.

The wider package also describes C4 segmented journals, C1w detached workers and result-error telemetry, C8 pipeline templates, and C9 envelope and hook changes. These units are out of scope. Earlier C6 and C7 behavior is covered by the existing suites.

### XPLAT_STORE

Without descriptor-relative opens, artifact reads a recorded regular file and refuses a simulated junction.
