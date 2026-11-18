# TaskLight CL acceptance oracle

Binding source is the isolated unit's .unit/SPEC.md. The file ends with the
negative controls. Amendments and a separately numbered acceptance list are
AUSENTE. The acceptance numbers below are the spec's MUST numbers.

## Acceptance map

Names in each row are methods in the stated module.

| Spec | Acceptance and tests |
| --- | --- |
| M1 | Owned child session and group, wrapper outside them, literal argv and binary inherited streams. test_run.py methods test_m1_default_is_an_owned_session_and_preserves_binary_io_and_argv and test_m1_no_group_preserves_foreground_group_and_streams. |
| M2 | TERM and INT group forwarding, first-cause latch, monotonic wall limit from spawn, escalation after 2 s [TARGET], and reaping and cleanup before terminal publication. test_run.py methods test_m2_term_escalates_after_leader_exits_and_before_terminal, test_m2_kills_term_ignoring_leader_and_descendant, test_m2_first_cause_wins_over_later_signal_and_wall_limit, test_m3_timeout_uses_monotonic_time_from_spawn_and_zero_exit_stays_failed, and test_m3_wrapper_int_forwarding_preserves_actual_signal_status. |
| M3 | Terminal state and exact reason from observed outcome, including cancellation with successful child exit, native signal status, and launch failures. test_run.py methods test_m3_natural_success_has_exit_zero_reason, test_m3_natural_nonzero_exit, test_m3_natural_signal_exit, test_m3_missing_executable_returns_127, test_m3_permission_denied_returns_126, test_m3_timeout_uses_monotonic_time_from_spawn_and_zero_exit_stays_failed and test_m3_wrapper_int_forwarding_preserves_actual_signal_status. The M2 cases also assert cancellation reasons. |
| M4 | Immediate read, retry after missing or invalid publication, first valid result, status independence and a 2 s [TARGET] grace. test_run.py methods test_m4_result_one_second_after_exit_is_attached, test_m4_retries_invalid_publication_and_freezes_first_valid_result, test_m4_reads_at_exit_and_accepts_exact_byte_limit, test_m4_one_byte_over_limit_is_rejected_through_grace, test_m4_rejects_fifo_without_waiting_for_writer, test_m4_invalid_schema_at_deadline_is_omitted and test_m4_result_arriving_after_deadline_cannot_change_terminal. |
| M5 | Immediate alive followed by the existing cadence and no emissions after return. test_run.py method test_m5_alive_is_immediate_and_periodic_until_exit. The launch error cases check that failed launches emit no alive. |
| M6 admission | Whole-manifest validation, indexed bad_args on lane errors, unique identity pairs and result files, required keys and lane bounds. test_wave.py methods test_m6_bad_lane_is_rejected_before_any_launch_or_registration, test_m6_duplicate_agent_run_pair_is_rejected, test_m6_duplicate_result_file_is_rejected, test_m6_same_result_file_with_dot_alias_is_rejected, test_m6_malformed_lane_values_are_rejected_before_launch, test_m6_missing_required_header_is_rejected, test_m6_missing_required_lane_key_is_rejected, test_m6_empty_lane_list_is_rejected, test_m6_over_lane_limit_is_rejected, test_m6_malformed_json_is_rejected, test_m6_minimum_single_lane_is_admitted and test_m6_maximum_64_lanes_are_admitted. |
| M6 execution | Public entry, concurrent launch, per-lane option forwarding, wait for all, one JSON summary line and exit status based on finished states. test_wave.py methods test_m6_public_cli_routes_manifest_option, test_m6_concurrent_lanes_preserve_run_options_and_wait_for_all, test_m6_mixed_finish_and_failure_returns_all_rows_and_nonzero and test_m6_cancellation_with_zero_child_exit_fails_wave. |
| M7 | Finished and failed history prevent another launch for that pair, including history superseded by a newer run, while a fresh run or a matching pair in another room is admitted. test_wave.py methods test_m7_finished_run_is_skipped_and_new_run_is_admitted, test_m7_failed_historical_run_is_skipped_even_after_newer_run and test_m7_terminal_pair_in_another_room_does_not_block_launch. |
| M8 | docs/WAVES.md describes the manifest, terminal reasons and orchestrator loop with background wave, wait_agents and unit_decide. test_docs.py method test_m8_wave_guide_documents_manifest_reasons_and_orchestrator_loop. |

## Negative controls and stop conditions

| Control | Observable rejection |
| --- | --- |
| Signal only the leader or stop on its exit | The M2 escalation cases observe the surviving descendant, the target group and the terminal event's ordering relative to cleanup. The separate sentinel group survives. |
| Report a timeout as finished | The M3 wall-limit case observes failed with wall_timeout even when the resulting child exit is successful. The M6 zero-exit cancellation case also requires nonzero wave status. |
| Sample the result only once | The M4 delayed-publication case makes a result available 1 s [TARGET] after child exit and checks the attached value. Expiry controls require no result, one diagnostic and one terminal event. |
| Begin launching before validating the whole manifest | Every M6 rejection guards the process boundary, compares journal history and requires bad_args. Lane errors must identify the offending index. |
| Launch again after terminal history | The M7 controls trap any attempt to spawn the old pair and compare the skipped agent's history. Another valid lane still runs. |

Run cases use the public run entry. Timed scenarios use the existing C1b
virtual clock and a simulated process group. The short binary-stream probe
uses a local Python child and checks kernel process-group and session IDs. Its
subprocess timeout and the wave fixture's event wait are deadlock guards.
Publication, heartbeat, wall and escalation scheduling use virtual time.
No test uses a network service.

## Scope and ambiguities

- The spec names a CLI and supplies no Python export or signature. The stub
  follows the existing supervise.main(argv=None) and room CLI convention.
  Coordinator tests enter this adapter directly and a separate test verifies
  routing through bridge.room.__main__.
- Diagnostic text, summary ordering and a skip field versus a skipped state
  with reason already_terminal are open. Indexed lane diagnostics can use
  either array-index or one-based ordinal notation. Result-file uniqueness
  includes a path with a redundant dot segment. Relative path bases and
  symlink policy are unspecified.
- The M5 oracle checks alive at the supervisor boundary. A taskless working
  projection through a reserved swarm marker belongs to the larger draft,
  with bridge/room/ext/inventory.py and src/app/swarm_vm.ts outside this unit's
  implementation surface.
- The larger draft's manifest digest, exclusive durable authorization,
  launcher-loss pipe, boot identity, custody reconciliation, restart-safe
  result grace and persisted waiter cursor are out of scope. C6 waiter and
  result-schema changes are separate; this oracle exercises the existing
  verdict-only result schema and inclusive file cap.
- Earlier C1b signal-forwarding tests expect child-derived reasons for
  wrapper-delivered signals. M3 specifies wrapper-derived reasons while
  preserving the collected status. This oracle tests the CL rule. Existing
  test files stay in their respective units.

## Reproduction

From the repository root:

    PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/cl -t .

Coordinator cases reach NotImplementedError("CL stub") in the isolated
baseline. Standalone run, public routing and docs cases exercise their own
entry points and report observed failures directly. Preserved behavior can
pass on the baseline.
