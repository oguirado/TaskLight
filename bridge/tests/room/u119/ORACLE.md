# U119 fail-first oracle

Source: `.unit/SPEC.md`, read through its final Amendment B. The unit remains
**DRAFT**; campaign decision **RESCOPE**; integration **HOLD** until U132
registers the module. Prerequisites: U109, U110, and Amendment B's U121.

This is a stdlib `unittest` contract oracle, not the implementation. The only
production file supplied here is `bridge/room/ext/acquire.py`, exporting
`work_acquire(args: dict) -> dict` and `work_report(args: dict) -> dict`.
Both bodies raise `NotImplementedError("U119 stub")`. A stub exception must
escape the tests; it is never accepted as a successful negative control.

## Run and gates

Run from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/u119 -t .
```

| Step | Gate | Negative contrast |
| --- | --- | --- |
| Fixture preparation | Real existing store operations fold without rejected events | Missing files, malformed fixtures, import failures or an absent prerequisite must not impersonate a handler stub |
| Fail-first verification | Every discovered test ends at the actual U119 handler stub | Assertions, transport `internal` conversion, skips or unrelated exceptions do not establish the red phase |
| Implemented behavior | Contract assertions below hold against actual handlers, journal bytes and folded state | A returned success without a durable atomic group is a failure |
| Atomicity controls | Deliberate writer mutations violate the same journal invariants as the positive race cases | A stub or unrelated fixture failure cannot count as a killed mutation |
| Regressions | Existing prerequisite and core room behavior stays unchanged; pre-existing legacy failures remain baseline debt | A fail-first oracle does not certify a broken baseline as green |
| Hardening | Timing remains INCONCLUSIVE without the required telemetry and quiet window | Missing telemetry never passes a timing gate |

Temporary homes, templates and evidence are created under this test directory
and removed after each test. Filesystem evidence paths are computed at runtime;
no local absolute paths are embedded in the published files. Clocks and event
identities are fixed. Sockets and real sleeps are forbidden. Process barriers
create contention without sleeps; finite waits are cleanup/deadlock watchdogs,
not performance measurements. No providers, launchers, terminals or human chat
are introduced. `restart_probe.py` is a fresh stdlib interpreter, not a model.

## Acceptance mapping

Names below are unittest method names. The module column is relative to
`bridge/tests/room/u119/`.

| Spec case | Module | Executable coverage |
| --- | --- | --- |
| A1: exported schemas through the extension seam | `test_replay_protocol.py` | `ProtocolOracle.test_a1_descriptors_and_shared_dispatch_after_import_seam` checks both descriptors, exact required/allowed fields, nested completion schema, and real shared registry handlers. The permanent module-list edit belongs to U132 and is OUT OF SCOPE. |
| A1: MCP/CLI successes and failures | `test_replay_protocol.py` | `ProtocolOracle.test_a1_acquire_mcp_cli_success_and_failure_parity`; `ProtocolOracle.test_a1_report_mcp_cli_success_and_failure_parity`. Real in-process MCP `tools/call` and CLI `call` execute shared dispatch. Successes have the untrusted envelope; errors use existing adapter codes and flags. |
| A2: concurrent independent acquisition | `test_acquire.py` | `AcquireOracle.test_a2_eight_barrier_processes_acquire_distinct_tasks`: eight processes [TARGET], distinct agents and operation identities, eight free tasks [TARGET], unique tasks/fences and matching persisted owners. |
| A2: repeated fresh epochs and no pending activation when already active | `test_acquire.py` | `test_a2_repeated_fresh_acquisition_renews_epoch`; `test_a2_existing_active_prevents_pending_activation`; `test_a2_fresh_claim_activates_first_pending_in_one_group`. |
| A2: M3 ownership/depth/ID ordering and preferences | `test_acquire.py` | `test_a2_caller_owned_precedes_preferred_free_task`; `test_a2_preference_wins_within_ownership_tier`; `test_a2_owned_preference_wins_within_owned_tier`; `test_a2_unavailable_preference_falls_back`; `test_a2_depth_precedes_task_id`; `test_a2_equal_depth_uses_task_id`; `test_a2_unsatisfied_dependency_preference_is_skipped`. |
| A2: blocked and foreign preferred tasks | `test_acquire.py` | `test_a2_blocked_preference_is_skipped`; `test_a2_foreign_preference_is_never_taken_even_if_silent`; `test_a3_micro_blocked_task_is_excluded`. No takeover request is permitted, even beyond the existing silence threshold. |
| A3: exact transient empty result and no durable empty receipt | `test_acquire.py` | `test_a3_empty_eligible_pool_is_exact_and_read_only` also makes work available and reuses the original empty-observation identity; `test_a3_terminal_and_no_micro_tasks_are_excluded`; `test_a3_all_done_task_is_excluded`. |
| A3: missing/closed plans | `test_acquire.py` | `test_a3_missing_plan_is_no_plan`; `test_a3_closed_plan_is_no_plan`. |
| A3: refold/reselect and bounded conflicts | `test_acquire.py` | `test_a3_conflict_refolds_reselects_and_preserves_identity`; `test_a3_stale_revision_exhaustion_is_bounded`; `test_a3_foreign_claim_exhaustion_is_bounded`. The bound comes from `bridge/plan/limits.py:TASKS_MAX`; exhaustion must be explicit `stale_rev` with detail. |
| A4: acquire active M01, complete it, persist digest and activate M02 | `test_report.py` | `ReportOracle.test_a4_digest_next_active_unchanged_fence_one_group` checks canonical evidence, shared evidence validation, the unchanged title guard, claim fence on every micro operation, one `post_ops`, one append group and fsync. |
| A4: all remaining complete, active null and open plan | `test_report.py` | `test_a4_all_remaining_done_returns_null_and_keeps_plan_open`; `test_a4_completion_order_and_final_member_lamport`; `test_a4_retains_first_remaining_active`; `test_a4_never_completes_or_activates_another_task`. |
| A5: ownership, assignment, fences and dependency readiness | `test_report.py` | `test_a5_other_slug_is_claimed_by_other`; `test_a5_unassigned_task_is_not_conformant`; `test_a5_stale_fence_is_stale_rev`; `test_a5_unsatisfied_dependency_names_upstream`; `test_a5_blocked_completion_is_not_conformant`; `test_a5_finished_completion_is_not_conformant`; `test_a5_cross_task_completion_is_not_conformant`. Every rejection compares journal bytes and folded state. |
| A5: evidence hostility | `test_report.py`, `test_validation.py` | `test_a5_evidence_inside_room_is_bad_evidence`; `test_a5_evidence_symlink_resolving_into_room_is_bad_evidence`; `test_a5_missing_evidence_file_is_bad_evidence`; `test_a5_directory_evidence_is_bad_evidence`; `test_a5_credential_basename_is_bad_evidence`; generated `ValidationOracle.test_a5_report_*_evidence` cases cover relative paths, `../x`, supplied digest objects, missing/empty/wrong types and evidence cap. |
| A5: extra takeover and boolean fences (Amendment B) | `test_validation.py` | `test_a5_report_extra_takeover`; `test_m9_acquire_extra_takeover`; `test_a5_report_true_fence`; `test_a5_report_false_fence`. All map to `bad_args`. |
| A6: restart/lost reply, later progress and vanished evidence | `test_replay_protocol.py` | `ReplayOracle.test_a6_acquire_restart_lost_reply_after_progress_returns_original`; `test_a6_report_restart_after_progress_and_evidence_deletion`; `test_a6_replay_precedes_evidence_validation_and_batch_construction`. Each exact replay compares original response and unchanged journal bytes. |
| A6: content-bound operation identity | `test_replay_protocol.py` | `test_a6_acquire_changed_prefer_task_is_bad_op`; `test_a6_report_changed_payload_is_bad_op_before_evidence_hashing`; `test_a6_report_changed_completion_order_is_bad_op`; `test_a6_canonical_key_order_does_not_change_request_identity`; `test_a6_reusing_acquire_identity_for_report_is_bad_op`. |
| A6: historical replay grants no authority | `test_replay_protocol.py` | `test_a6_historical_acquire_replay_does_not_renew_authority`; `test_a6_acquire_replay_uses_committed_prefix_after_plan_close`; `test_a6_report_replay_uses_committed_prefix_after_plan_close`; `test_a6_report_replay_survives_release_and_foreign_reclaim`. Release/close are explicit fixture operations, never implicit handler behavior. |
| A7: invalid final report member | `test_atomicity.py` | `AtomicityOracle.test_a7_invalid_final_submitted_completion_has_no_partial_commit`; `test_a7_invalid_final_writer_member_has_no_partial_commit`; `test_a7_negative_control_separate_writes_is_detected`. The writer injection rejects the final member after earlier members have simulated successfully; separate durable writes must violate the journal-byte oracle. |
| A7: dependency changes after selection | `test_atomicity.py` | `test_a7_dependency_change_at_commit_is_atomic`; `test_a7_existing_active_still_guards_dependency_readiness`; `test_a7_negative_control_removing_acquisition_activation_is_detected`; `test_a7_negative_control_omitting_existing_active_guard_is_detected`. The upstream microtask changes without changing the selected task revision, so a claim revision check alone cannot mask a missing activation guard. |
| A7: concurrent completion of the proposed next item | `test_atomicity.py` | `test_a7_concurrent_next_completion_does_not_reactivate`; `test_a7_negative_control_removing_report_revision_guard_is_detected`. The external completion remains durable; the stale report appends nothing and cannot reopen it. |

## Additional MUST coverage

| Requirement | Tests |
| --- | --- |
| M2 stored-order items and exact committed task | `test_m2_items_exclude_completed_microtasks_in_stored_order` and `assert_acquired` used by all successful acquisition scenarios |
| M5/M9 completion limits and exact errors | Generated `ValidationOracle.test_a5_report_*` cases: all missing fields, unknown keys, wrong containers, empty/oversized/duplicate done, safe integer boundaries, invalid/unknown IDs, bounded outcomes/durations; `test_a4_maximum_batch_and_field_lengths_are_accepted` tests inclusive limits |
| M6 passive data and canonical evidence | `test_a4_passive_outcome_and_file_contents`; `test_a4_symlink_evidence_persists_canonical_target`; A4 canonical digest assertion |
| M7 no remaining active/pending work | `test_m7_only_blocked_remaining_returns_null_without_lifecycle` checks active null, unchanged assignee/fence and no lifecycle operations |
| M8 acknowledgement after durability | `test_m8_report_acknowledgement_follows_fsync`; A4 group instrumentation |
| M8/M9 capacity/write/fsync failure | `test_a5_durable_failure_and_room_cap_never_return_success`; `test_m8_acquisition_full_room_and_write_failures_are_not_success` check `room_full`/`internal`, unchanged bytes/state and no success |
| M9 acquisition shape and identifiers | Generated `ValidationOracle.test_m9_acquire_*` cases check unknown/missing/wrong-container arguments and existing `bad_room`, `bad_agent`, `bad_op` mappings |

## Completed partial-oracle coverage

These cases extend the acceptance mapping above; names are relative to the
same test modules. The existing handler stub behavior is retained.

| Spec case | Additional executable coverage |
| --- | --- |
| A2 / M4 first active guard and fresh acquisitions without an identity | `AcquireOracle.test_a2_first_stored_active_is_the_readiness_guard`; `test_a2_omitted_identity_is_a_fresh_acquisition_each_time` |
| A3 empty plan, no durable empty receipt, and conflict consuming the last free task | `AcquireOracle.test_a3_active_plan_without_tasks_is_transient_empty`; strengthened `test_a3_empty_eligible_pool_is_exact_and_read_only`; `test_a3_conflict_consuming_last_task_is_not_empty_success` |
| A5 / M6 hostile evidence | `ReportOracle.test_a5_supplied_digest_object_is_rejected_even_when_correct`; `test_a5_absolute_traversal_resolving_inside_room_is_bad_evidence`; `test_a5_null_byte_evidence_is_bad_evidence`; `test_a5_credential_target_behind_innocent_symlink_is_bad_evidence` |
| A5 / M9 wrong containers and unsafe numeric fences | Generated `ValidationOracle.test_m9_acquire_boolean_args`, `test_m9_acquire_integer_args`, `test_m9_acquire_tuple_args`; corresponding `test_a5_report_*_args`; `test_a5_report_tuple_done`, `test_a5_report_boolean_done`, `test_a5_report_tuple_evidence`, `test_a5_report_infinite_fence`, `test_a5_report_nan_fence`, `test_a5_report_null_member`, `test_a5_report_list_member`, `test_a5_report_boolean_member` |
| A6 identity bounds, changed input, later ownership and full-room replay | `ReplayOracle.test_a6_maximum_length_id_derives_valid_stable_member_ids`; `test_a6_acquire_replay_survives_foreign_reclaim_without_renewal`; `test_a6_report_changed_claim_fence_is_bad_op`; `test_a6_report_changed_evidence_path_is_bad_op`; `test_a6_replay_needs_no_append_capacity` |
| A7 race fixture validity | The dependency race compares the selected task with its state after the external dependency change. Its derived readiness may legitimately change. Existing ownership and the old claim epoch must survive the failed acquisition. Both unassigned and already-owned scenarios run the same byte and state oracle. |
| M8 no nested writer or separate receipt store | `AtomicityOracle.test_m8_tools_use_writer_without_nesting_or_receipt_files` checks real writer locking and the resulting home file set |
| M8 partial-write rollback and durable acquisition acknowledgement | `AtomicityOracle.test_m8_acquire_partial_write_is_rolled_back`; `test_m8_report_partial_write_is_rolled_back`; `ReportOracle.test_m8_acquire_acknowledgement_follows_fsync` |

Writer-seam preflight: eight probes passed [MEASURED], using temporary in-memory
batch producers and the real existing writer. These establish that the race
fixtures and their negative controls discriminate; they do not establish
implementation coverage or turn stub-red U119 tests green. No probe producer
is installed as a handler or written into production code.

## Regression disposition

| Existing suite | Result |
| --- | --- |
| U109 and U110 | 213 tests passed [MEASURED], exact summary `OK` |
| Core room and S0 | 133 tests passed [MEASURED], exact summary `OK` |
| Legacy plan baseline | 567 tests [MEASURED]; pre-existing summary `FAILED (failures=15, errors=16)` [MEASURED] |
| Remaining existing room suites | 621 tests [MEASURED]; pre-existing summary `FAILED (failures=36, errors=128, skipped=8)` [MEASURED]. Findings are in U69, U87, U90, U94, and the other-unit U132/U133/U137 oracles. These are not U119 acceptance failures. |

Regression subprocesses disable bytecode writes, and their temporary directories
stay under this oracle. No existing production or regression files are edited.
Other-unit stubs and missing U137 artifacts are OUT OF SCOPE. Existing legacy
failures are reported as baseline debt, never as a passing regression suite.

## Interpretations and scope boundaries

| Question | Resolution |
| --- | --- |
| Handler spelling/signature | Use the extension seam's `handler(args: dict) -> dict` contract for the spec's exported names `work_acquire` and `work_report`; descriptor variable names are intentionally unconstrained. |
| M4 activation wording versus Amendment B | Reassert the first stored active microtask as the commit-time readiness guard; activate the first pending item only when no active item exists. A caller-owned acquisition still emits a fresh `task.claim`. |
| Blank outcome error code | Nonblank is mandatory, but no exact code is specified for a blank string. Require `bad_args` or `bad_op` and no append, rather than invent a stricter mapping. Field container errors and explicit Amendment B mappings remain exact. |
| Replay response shape | Acquisition returns exactly its original committed task/items/fence; it gains no replay flag. Reporting returns its original fields with `replayed: true` on exact retry. |
| Adapter envelopes | Use existing shared-dispatch untrusted envelopes on success and existing top-level adapter error payloads on failure; fixture-specific journal event identities are not compared across rooms. |
| Registration after U132 | In-memory extension module-list injection exercises the existing import seam; U119 does not edit `bridge/room/ext/__init__.py`. Permanent registration and production tools/list availability are U132 integration work, OUT OF SCOPE here. |
| U121 | Content-bound, lock-safe replay is a prerequisite implemented in `bridge/room/store.py`, OUT OF SCOPE for edits. U119's observable replay contract remains tested; no guessed new store API is required by this oracle. |
| Race outcomes | Readiness failure propagates existing `not_conformant` naming the upstream task; a report revision race propagates `stale_rev`. Only explicitly injected concurrent fixture events may remain in the journal. |
| Last-task selection conflict | Once selection has conflicted, losing the last eligible task is `stale_rev` with detail, rather than a successful empty observation. This follows A3's explicit prohibition on false empty success. No arbitrary retry count is required beyond the `TASKS_MAX` bound. |
| Other units | U120/U131 prompt/document integration; U124 visual soak; authentication, expiring leases, scheduling, lifecycle hooks and UI: OUT OF SCOPE, not oracle failures. |

## Hardening disposition

`room-concurrency` performance is **INCONCLUSIVE**. Runtime measurements:
**AUSENTE — no inventar**. The deterministic process test covers correctness,
not latency qualification. No timing benchmark is started by this oracle.

The hardening target is eight writers [TARGET], acknowledgement p95 at most
50 ms [TARGET] and p99 at most 100 ms [TARGET]. The supplied stop condition is
load5 at least 18 [CITED: spec Hardening check]; at or above it, start no benchmark.
Absent load, full quiet-window evidence or required telemetry also leaves timing
INCONCLUSIVE. Any correctness failure is BLOCK. Fixture hashes, load, wall time,
RSS, retry counts, journal-byte and bookkeeping metrics for a qualifying hardening
run are AUSENTE. Negative controls are executable assertions for the implemented
phase; stub-red results do not claim a measured mutation kill.

The mandate and all conclusions above are scoped to the supplied specification
and cited files inside this isolated workspace.
