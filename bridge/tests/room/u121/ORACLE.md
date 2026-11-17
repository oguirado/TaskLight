# U121 fail-first oracle

Authority: `.unit/SPEC.md`, read in full including binding Amendments B and C.
The document remains DRAFT; Amendment C places the unit in Wave W2, before
U119 admission, with U109 and U110 ADMIT dependencies. No production code is
modified. The referenced production surface is `bridge/room/store.py`,
`bridge/room/_lock.py`, and `bridge/room/ext/activity.py`. Adapter references
`bridge/room/app.py`, `bridge/room/mcp.py`, and `bridge/room/__main__.py` remain
read-only. All scratch journals, templates and evidence are created under
`bridge/tests/room/u121` and removed by cleanup.

Run from the repository root, with bytecode generation disabled:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/u121 -t .
```

## Acceptance map

The exact discovered test identifiers are listed below. Parameterized tests
are separate unittest methods, not skipped prerequisites or expected failures.

| Spec acceptance | Executable coverage and principal test names |
|---|---|
| A1 / M1 | `LockTests.test_a1_real_process_single`, `test_a1_real_process_batch`: a separate process owns the actual lock. Fake monotonic deadlines and guarded real nonblocking calls prevent the baseline blocking forever. `test_a1_posix_nonblocking_interruptions_then_success`, `test_a1_windows_nonblocking_permission_and_interruptions`, deadline, remaining-time, repeated-interruption and unrelated-error cases cover both backends. The single/batch timeout and OS-error fd-cleanup tests capture bytes/head/projection, check fd-count parity and no unacquired unlock, translate to `internal`, and prove later success. `test_m1_timeout_constant_and_optional_parameter` pins the specified signature/default. |
| A2 / M2 / M5 | `ReplayTests.test_a2_activity_first_and_retry_receipts`, `test_a2_caller_restart_preserves_activity_receipt`, `test_a2_retry_at_real_cap`, `test_a2_store_replay_precedes_full_capacity_and_state_validation`; CLI/MCP replay-envelope tests. `BatchTests.test_a2_batch_replay_preserves_receipts_without_fold_or_capacity` covers reordered object keys, original receipts and no fold. |
| A3 / M2 / M3 | Hostile changed note/run/task/micro tests; changed envelope text/to; message/single/batch-member collisions in both directions; independent agents/rooms; batch content/order/count/strict/member identity/local-key changes; duplicate intra-batch identity; forged hash/batch and NaN/Infinity rejection; canonical single/message/batch hashes; legacy direct single comparison and fail-closed legacy batch replay. `test_m3_replay_avoids_evidence_disk_io` removes prior evidence and makes disk revalidation an assertion failure. CLI/MCP hostile-error tests require the same `bad_op` and `op_id conflict` detail. |
| A4 / M4 | `ReserveTests.test_a4_real_reserve_refuses_beat_but_allows_completion`, `test_a4_batch_reserve_refusal_then_semantic_completion`, `test_a4_mixed_batch_never_silently_drops_a_member`. Boundary matrix: heartbeat, beat, beat_batch, mixed_batch, semantic, semantic_batch × exact_ceiling/one_byte_over × newline/separator. Every matrix case uses multibyte text and actual measured serialized bytes including metadata. `test_m4_constants` pins the specified CAP and reserve. Lifecycle dependency is scoped below. |
| A5 / M6 | `BatchTests.test_a5_fresh_batch_folds_prior_history_once`, `test_m6_each_simulation_receives_isolated_state`, `test_a5_local_keys_dependencies_revisions_and_simulation_identity`, `test_m3_hash_precedes_local_key_rewrite_and_revision_healing`, `test_a5_invalid_final_member_is_atomic_even_without_strict`, strict refusal/success and nonstrict conformance tests. Frozen W1 expectations cover dependency order, local-key mapping, revision healing, simulated/persisted event identity and replay receipts. |
| A6 / M7 | `DurabilityTests.test_a6_single_*` and `test_a6_batch_*`: short/interrupted writes complete; partial-write errors, zero-progress writes and one-shot sync failure refuse and roll back; secondary rollback errors preserve the original `internal` failure; rollback sync is attempted before unlock; reopen, acknowledged prefix, fd parity and lock reuse are checked. Success-after-sync tests observe actual journal fsync before the receipt. |
| A7 | `NegativeControlTests.test_a7_identity_only_replay_mutant_is_detected`, `test_a7_disabled_reserve_mutant_is_detected`, `test_a7_blocking_lock_mutant_is_detected_without_waiting`, `test_a7_double_fold_mutant_is_detected`. Mutants are temporary in-memory patches. The probes require concrete assertion witnesses; infrastructure exceptions do not count as detection. |

## Binding interpretations and preserved behavior

- Amendment C supersedes the initial scheduling/dependency text. Amendments B
  and C add constraints without expanding the production edit surface.
- Hash tests use compact sorted-key UTF-8 JSON with `allow_nan=False`, normalized
  absent `re`/`to` as null and evidence as an empty list. Single hash input is
  `{act,text,re,to,evidence,op}`; message/heartbeat `op` is null. Batch input is
  `{strict,ops}`, before local-key remapping and revision healing. Object key
  order is immaterial; list/member order and strictness are significant.
  Both request hashes live outside `op` and are server-computed.
- Receipt contracts remain: `activity_beat` first success is
  `{ok:true,lamport:L,beat_ts:T}`; an identical retry adds `replayed:true` with
  the original L/T. Store replay returns the original event or batch members
  with that marker. Message receipt remains `{ok:true,id:I,lamport:L}`.
  MCP/CLI activity success retains `{"untrusted":...}`. Batch `member_ids`,
  `key_map`, `conformance`, and `rev` are preserved.
- Unknown metadata inside an operation is `bad_op`; unknown extension envelope
  fields retain the established `bad_args` code. No new public store keyword
  is presumed solely to test rejecting a forged server field.
- Lock expiry is checked with fake monotonic time. Process readiness/join and
  subprocess timeouts are bounded watchdogs, not timing assertions. Blocking
  flags fail before an actual blocking kernel call. Runtime scheduler latency
  is AUSENTE — no inventar; the scheduler allowance remains a measured-host gate.
- Capacity boundary tests scale CAP while retaining the specified reserve and
  derive line lengths from real serialization. Separate cases pin the unchanged
  CAP and fill actual full-capacity/reserve histories. Equality fits; exceeding
  a ceiling refuses; no mixed member is silently omitted.
- Strict conformance refusal aborts atomically; nonstrict conformance findings
  are persisted with their receipt. Errors still abort under either strictness.
  Existing reducers/validators are exercised directly; no substitute plan model
  or production stub is introduced.
- A recoverable secondary rollback failure is injected after real truncation;
  a second sync failure is injected independently. No test claims persistence
  after an irrecoverable filesystem failure or committed-read isolation.

## External hardening gate (not a deterministic unit-test result)

`bridge/tests/bench/run.py` defines `room-concurrency/i0-writes`. Its maximum
acknowledged-latency statistic must be retained. The paired hardening run needs
baseline and implemented candidate, synchronized writers, a quiet serialized
window, fixture hashes, wall latency, lock wait/hold distributions, peak RSS,
fold counts, and serialized bytes including identity metadata. The specified
warmups, observations and percentile budgets remain those in `.unit/SPEC.md`.
Missing telemetry makes timing INCONCLUSIVE; correctness failure is BLOCK.
Do not start a new benchmark when load5 meets/exceeds the specified threshold.
No paired timing run is started by this oracle: the candidate and complete
telemetry are AUSENTE — no inventar. Runtime lock latency and reserve sufficiency
remain unmeasured. This is an explicit uncompleted hardening gate, not a pass.

## Other-unit boundaries

| Owner | Excluded cases |
|---|---|
| U132 | Lifecycle authoring/throttling and its registration/validator admission. `bridge/room/ext/lifecycle.py` is an unimplemented seam in this baseline. Amendment C's `agent.lifecycle` alive reserve classification and deployed/finished/failed CAP cases are conditional on separate admission; no test calls the stub or invents a validator. These cases require a follow-up fixture after U132 admission and are not reported as U121 failures. |
| U134 | Family transport changes. MCP/CLI checks use the existing shared dispatcher only. |
| U96 / U102 | Daemon, snapshots, compaction, committed-read isolation and recovery redesign. |
| Existing ownership units | Authentication, task leases/takeover, U109 ownership/dependency/release/claim-fencing changes. Valid existing task operations are used as preconditions only. |
| UI/provider units | UI and provider changes. |

## Exact discovered identifiers


### `bridge/tests/room/u121/test_batch.py`

- `BatchTests.test_a2_batch_replay_preserves_receipts_without_fold_or_capacity`
- `BatchTests.test_a3_batch_forged_batch`
- `BatchTests.test_a3_batch_forged_hash`
- `BatchTests.test_a3_batch_infinity`
- `BatchTests.test_a3_batch_nan`
- `BatchTests.test_a3_batch_negative_infinity`
- `BatchTests.test_a3_changed_batch_additional_member`
- `BatchTests.test_a3_changed_batch_content`
- `BatchTests.test_a3_changed_batch_count`
- `BatchTests.test_a3_changed_batch_member_identity`
- `BatchTests.test_a3_changed_batch_order`
- `BatchTests.test_a3_changed_batch_strict`
- `BatchTests.test_a3_changing_local_keys_conflicts_before_remapping`
- `BatchTests.test_a3_distinct_agents_can_reuse_batch_identity`
- `BatchTests.test_a3_duplicate_intra_batch_identity_refuses`
- `BatchTests.test_a3_single_forged_batch`
- `BatchTests.test_a3_single_forged_hash`
- `BatchTests.test_a3_single_infinity`
- `BatchTests.test_a3_single_nan`
- `BatchTests.test_a3_single_negative_infinity`
- `BatchTests.test_a5_fresh_batch_folds_prior_history_once`
- `BatchTests.test_a5_invalid_final_member_is_atomic_even_without_strict`
- `BatchTests.test_a5_local_keys_dependencies_revisions_and_simulation_identity`
- `BatchTests.test_a5_strict_conformance_refusal_is_atomic`
- `BatchTests.test_a5_strict_success_preserves_conformance_and_replay`
- `BatchTests.test_m3_batch_hash_covers_original_order_and_strict`
- `BatchTests.test_m3_hash_precedes_local_key_rewrite_and_revision_healing`
- `BatchTests.test_m3_legacy_batch_missing_hash_is_not_replay_evidence`
- `BatchTests.test_m3_one_unverifiable_member_blocks_batch_replay`
- `BatchTests.test_m6_each_simulation_receives_isolated_state`
- `BatchTests.test_m6_nonstrict_conformance_findings_are_recorded`

### `bridge/tests/room/u121/test_controls.py`

- `NegativeControlTests.test_a7_blocking_lock_mutant_is_detected_without_waiting`
- `NegativeControlTests.test_a7_disabled_reserve_mutant_is_detected`
- `NegativeControlTests.test_a7_double_fold_mutant_is_detected`
- `NegativeControlTests.test_a7_identity_only_replay_mutant_is_detected`

### `bridge/tests/room/u121/test_durability.py`

- `DurabilityTests.test_a6_batch_interrupt_writes_complete`
- `DurabilityTests.test_a6_batch_rollback_error_rollback`
- `DurabilityTests.test_a6_batch_rollback_sync_error_rollback`
- `DurabilityTests.test_a6_batch_short_writes_complete`
- `DurabilityTests.test_a6_batch_success_after_sync`
- `DurabilityTests.test_a6_batch_sync_once_rollback`
- `DurabilityTests.test_a6_batch_write_error_rollback`
- `DurabilityTests.test_a6_batch_zero_write_rollback`
- `DurabilityTests.test_a6_single_interrupt_writes_complete`
- `DurabilityTests.test_a6_single_rollback_error_rollback`
- `DurabilityTests.test_a6_single_rollback_sync_error_rollback`
- `DurabilityTests.test_a6_single_short_writes_complete`
- `DurabilityTests.test_a6_single_success_after_sync`
- `DurabilityTests.test_a6_single_sync_once_rollback`
- `DurabilityTests.test_a6_single_write_error_rollback`
- `DurabilityTests.test_a6_single_zero_write_rollback`

### `bridge/tests/room/u121/test_lock.py`

- `LockTests.test_a1_batch_os_error_fd_cleanup`
- `LockTests.test_a1_batch_timeout_fd_cleanup`
- `LockTests.test_a1_posix_deadline_expires`
- `LockTests.test_a1_posix_nonblocking_interruptions_then_success`
- `LockTests.test_a1_real_process_batch`
- `LockTests.test_a1_real_process_single`
- `LockTests.test_a1_remaining_time_bounds_final_sleep`
- `LockTests.test_a1_repeated_interruptions_are_deadline_bounded`
- `LockTests.test_a1_single_os_error_fd_cleanup`
- `LockTests.test_a1_single_timeout_fd_cleanup`
- `LockTests.test_a1_unrelated_os_error_is_not_retried`
- `LockTests.test_a1_windows_deadline_expires`
- `LockTests.test_a1_windows_nonblocking_permission_and_interruptions`
- `LockTests.test_a1_windows_unrelated_os_error_is_not_retried`
- `LockTests.test_m1_timeout_constant_and_optional_parameter`

### `bridge/tests/room/u121/test_replay.py`

- `ReplayTests.test_a2_activity_first_and_retry_receipts`
- `ReplayTests.test_a2_caller_restart_preserves_activity_receipt`
- `ReplayTests.test_a2_cli_replay_envelope`
- `ReplayTests.test_a2_mcp_replay_envelope`
- `ReplayTests.test_a2_retry_at_real_cap`
- `ReplayTests.test_a2_store_replay_precedes_full_capacity_and_state_validation`
- `ReplayTests.test_a3_batch_member_cannot_replay_as_single`
- `ReplayTests.test_a3_batch_then_message_conflicts`
- `ReplayTests.test_a3_cli_hostile_error`
- `ReplayTests.test_a3_different_agents_and_rooms_can_reuse_identity`
- `ReplayTests.test_a3_forged_extension_envelopes_are_rejected`
- `ReplayTests.test_a3_hostile_changed_micro`
- `ReplayTests.test_a3_hostile_changed_note`
- `ReplayTests.test_a3_hostile_changed_run`
- `ReplayTests.test_a3_hostile_changed_task`
- `ReplayTests.test_a3_mcp_hostile_error`
- `ReplayTests.test_a3_message_then_batch_conflicts`
- `ReplayTests.test_a3_message_then_later_batch_member_conflicts`
- `ReplayTests.test_a3_message_then_single_conflicts`
- `ReplayTests.test_a3_single_cannot_be_batch_identity_or_member`
- `ReplayTests.test_a3_single_then_message_conflicts`
- `ReplayTests.test_a3_typed_message_payload_comparison_remains_intact`
- `ReplayTests.test_m3_all_op_id_bearing_post_records_get_hash`
- `ReplayTests.test_m3_changed_envelope_text`
- `ReplayTests.test_m3_changed_envelope_to`
- `ReplayTests.test_m3_hash_covers_envelope_defaults_and_utf8`
- `ReplayTests.test_m3_legacy_single_changed_content_refuses`
- `ReplayTests.test_m3_legacy_single_equal_content_replays_without_rewrite`
- `ReplayTests.test_m3_nonoperation_identity_replays_and_compares_content`
- `ReplayTests.test_m3_replay_avoids_evidence_disk_io`
- `ReplayTests.test_m3_single_hash_is_canonical_server_record`
- `ReplayTests.test_m3_typed_message_keeps_receipt_and_hash`

### `bridge/tests/room/u121/test_reserve.py`

- `ReserveTests.test_a4_batch_reserve_refusal_then_semantic_completion`
- `ReserveTests.test_a4_beat_batch_exact_ceiling_newline`
- `ReserveTests.test_a4_beat_batch_exact_ceiling_separator`
- `ReserveTests.test_a4_beat_batch_one_byte_over_newline`
- `ReserveTests.test_a4_beat_batch_one_byte_over_separator`
- `ReserveTests.test_a4_beat_exact_ceiling_newline`
- `ReserveTests.test_a4_beat_exact_ceiling_separator`
- `ReserveTests.test_a4_beat_one_byte_over_newline`
- `ReserveTests.test_a4_beat_one_byte_over_separator`
- `ReserveTests.test_a4_heartbeat_exact_ceiling_newline`
- `ReserveTests.test_a4_heartbeat_exact_ceiling_separator`
- `ReserveTests.test_a4_heartbeat_one_byte_over_newline`
- `ReserveTests.test_a4_heartbeat_one_byte_over_separator`
- `ReserveTests.test_a4_mixed_batch_exact_ceiling_newline`
- `ReserveTests.test_a4_mixed_batch_exact_ceiling_separator`
- `ReserveTests.test_a4_mixed_batch_never_silently_drops_a_member`
- `ReserveTests.test_a4_mixed_batch_one_byte_over_newline`
- `ReserveTests.test_a4_mixed_batch_one_byte_over_separator`
- `ReserveTests.test_a4_real_reserve_refuses_beat_but_allows_completion`
- `ReserveTests.test_a4_semantic_batch_exact_ceiling_newline`
- `ReserveTests.test_a4_semantic_batch_exact_ceiling_separator`
- `ReserveTests.test_a4_semantic_batch_one_byte_over_newline`
- `ReserveTests.test_a4_semantic_batch_one_byte_over_separator`
- `ReserveTests.test_a4_semantic_exact_ceiling_newline`
- `ReserveTests.test_a4_semantic_exact_ceiling_separator`
- `ReserveTests.test_a4_semantic_one_byte_over_newline`
- `ReserveTests.test_a4_semantic_one_byte_over_separator`
- `ReserveTests.test_m4_constants`

## Verification on the unmodified baseline

| Run | Tests | Assertion failures | Green | Errors |
|---|---|---|---|---|
| U121 discovery | 126 [MEASURED] | 66 [MEASURED] | 60 [MEASURED] | 0 [MEASURED] |
| Existing top-level room, plan, wall_room, wall regression modules | 844 [MEASURED] | 0 [MEASURED] | 844 [MEASURED] | 0 [MEASURED] |
| Existing U109/U110 dependency suites | 213 [MEASURED] | 0 [MEASURED] | 213 [MEASURED] | 0 [MEASURED] |

Exact U121 summary line:

```text
FAILED (failures=66)
```

All failing U121 outcomes are assertion failures for missing behavior, with no
import/test-harness errors. The in-memory negative controls pass. Existing
regressions run with scratch temporary directories redirected into this oracle
directory and with bytecode generation disabled. External paired timing remains
INCONCLUSIVE for the reasons above.
