# C3 fail-first oracle

Authority: the complete workspace `.unit/SPEC.md`, MUST cases M1–M8.
A-C3o and A-C3b amend the inventory comparisons and default budget below.
The design and schema cited under `strategy/R46/` are AUSENTE in this copy.
The workspace spec's byte budget and integer `since` take precedence over the
earlier design's tokenizer, opaque cursor, and pagination proposals.

All test names below live in `test_orchestrator_snapshot.py` in this directory.
`support.py` supplies accepted journal fixtures and existing transport adapters;
it contains no implementation of the missing snapshot handler. No missing product
module is imported, fabricated, or patched into registration.

## Acceptance map

| Case | Tests and observable gate | Negative contrast |
|---|---|---|
| M1 | `TransportOracle.test_m1_discovery_exposes_current_request_contract`; `test_m1_cli_and_mcp_json_parity`; `test_m1_optional_clock_uses_the_same_captured_now`; `test_m1_no_tokenizer_dependency`; `test_m1_hostile_room_and_clock_are_rejected` | Missing registration, CLI-only behavior, differing payloads, coerced hostile arguments, or a tokenizer requirement fail. |
| M2 | Every `InventoryOracle` test listed below; `TransportOracle.test_m2_empty_existing_journal_is_a_complete_current_snapshot`; `test_m2_unavailable_storage_never_certifies_a_healthy_empty_room`; every `AttentionOracle.test_m2_*` listed below; `SinceOracle.test_m3_completions_are_strictly_after_since_and_inventory_is_current` | Dropped plan-independent agents, wrong C2 states/totals, absent blockers/owners, ack-as-answer, evidence checked only on done tasks, or unavailable-as-empty fail. |
| M3 | `SinceOracle.test_m3_completions_are_strictly_after_since_and_inventory_is_current`; `test_m3_since_head_has_no_completions_or_old_attention`; `test_m3_attention_changes_exclude_old_failures_and_include_new_blocks`; `test_m3_repeated_done_and_idempotent_operations_are_not_new_completions`; `test_m3_completion_survives_later_reopening`; `test_m3_invalid_since_types_do_not_coerce` | Inclusive boundaries, historical inventory, old attention, duplicate completion requests, or erasing accepted transitions after reopening fail. |
| M4 | `BudgetOracle.test_m4_default_budget_is_16384_bytes`; `test_m4_minimum_and_maximum_budgets_are_accepted`; `test_m4_out_of_range_or_noninteger_budgets_are_rejected`; `test_m4_first_trim_is_completions_and_omissions_are_exact`; `test_m4_all_trim_stages_preserve_totals_and_urgent_attention`; `test_m4_utf8_multibyte_payload_obeys_byte_budget`; `test_m4_impossible_urgent_budget_refuses_without_trimming_urgent_rows` | Character counting, hidden omissions, changed totals, dropping failed/blocked attention, wrong trim priority, trimming non-finished agents, or complete-with-omissions fail. |
| M5 | `AttentionOracle.test_m5_attention_order_is_urgency_then_lamport`; `SafetyAndDocsOracle.test_m5_identical_requests_are_byte_identical`; `test_m5_replay_iteration_order_does_not_change_snapshot`; `AttentionOracle.test_m2_available_work_is_ready_and_stably_sorted`; C2 tree cases below | Alphabetical failure sorting ahead of Lamport, unstable replay, changed response bytes, or unstable available-work order fail. |
| M6 | `SafetyAndDocsOracle.test_m6_free_text_is_redacted_on_both_transports`; `test_m6_clean_text_and_structural_agent_ids_keep_bytes`; `test_m6_sanitizer_exception_refuses_mcp_and_cli_without_raw_fallback`; `test_legacy_shared_sanitizer_preserves_safe_ids_hashes_and_evidence` | Raw synthetic secrets, a different marker, identity damage, or successful/raw output after the actual shared sanitizer raises fail. |
| M7 | `SafetyAndDocsOracle.test_m7_full_delta_and_trimmed_reads_leave_journal_bytes_identical`; all successful calls through `SnapshotCase.snapshot`; invalid calls through `assert_refusal`; transport parity and inventory cases | Any change to the raw journal on full, delta, budgeted, or rejected reads fails. |
| M8 | `SafetyAndDocsOracle.test_m8_documented_call_fields_budget_since_loop_and_example` | Missing `docs/ORCHESTRATOR.md`, absent fields/call/cursor/budget documentation or example, or exceeding the specified line limit fails. |

The M8 line limit is 120 [TARGET]. Budget boundaries are 1,024–65,536 bytes
[TARGET], with 16,384 bytes [TARGET] as the default (A-C3b). The oracle measures compact
UTF-8 JSON including the existing `untrusted` envelope, excluding transport framing.
A-C3b: the default-budget fixture includes 50 agents [TARGET] and must return
complete above 8,192 bytes [TARGET], distinguishing the amended handler default.

### Explicit attention test names

- `AttentionOracle.test_m2_failed_and_blocked_report_entities_and_blocker_owners`
- `AttentionOracle.test_m2_explicit_task_and_microtask_blocks_are_in_attention`
- `AttentionOracle.test_m2_stale_or_unknown_with_work_needs_attention`
- `AttentionOracle.test_m2_unknown_without_work_does_not_create_work_attention`
- `AttentionOracle.test_m2_unaddressed_and_unanswered_questions_but_not_answered`
- `AttentionOracle.test_m2_missing_evidence_in_a_partially_completed_task`
- `AttentionOracle.test_m2_optional_evidence_does_not_create_false_attention`
- `AttentionOracle.test_m2_available_work_is_ready_and_stably_sorted`

### Explicit C2 integration test names

Expected inventory comes directly from
`bridge/tests/room/c2/fixtures/inventories.json`, including A-C2a membership.
These are C3 consumption checks; they do not reimplement or extend C2's reducer.

A-C3o: `membership_only` cases compare exact membership, and `state_only`
cases compare the specified agents' states. Their placeholder totals and rows
are not full expectations. All other cases retain exact totals and row checks.

- `InventoryOracle.test_m2_c2_empty_room`
- `InventoryOracle.test_m2_c2_message_only_authors`
- `InventoryOracle.test_m2_c2_fresh_deployment`
- `InventoryOracle.test_m2_c2_fresh_alive`
- `InventoryOracle.test_m2_c2_freshness_inclusive_boundary`
- `InventoryOracle.test_m2_c2_stale_alive_is_unknown`
- `InventoryOracle.test_m2_c2_stale_deployed_is_unknown`
- `InventoryOracle.test_m2_c2_explicit_finished_survives_staleness`
- `InventoryOracle.test_m2_c2_explicit_failed_survives_staleness`
- `InventoryOracle.test_m2_c2_redeploy_resets_terminal`
- `InventoryOracle.test_m2_c2_unresolved_parent`
- `InventoryOracle.test_m2_c2_tree_first_seen_order`
- `InventoryOracle.test_m2_c2_parent_arrives_after_child`
- `InventoryOracle.test_m2_c2_working_current_and_counts`
- `InventoryOracle.test_m2_c2_assignee_only_member`
- `InventoryOracle.test_m2_c2_active_work_without_beat_is_unknown`
- `InventoryOracle.test_m2_c2_working_becomes_unknown_not_finished`
- `InventoryOracle.test_m2_c2_dependency_waiting_beats_idle`
- `InventoryOracle.test_m2_c2_staleness_beats_dependency_waiting`
- `InventoryOracle.test_m2_c2_ignored_retired_beat_cannot_refresh`
- `InventoryOracle.test_m2_c2_redeploy_does_not_reuse_old_beat`
- `InventoryOracle.test_m2_c2_sync_gap_is_unknown`
- `InventoryOracle.test_m2_c2_duplicate_delivery_is_stable`
- `InventoryOracle.test_m2_c2_counts_cover_all_owned_tasks`
- `InventoryOracle.test_m2_c2_dependency_waiting_precedes_fresh_beat`
- `InventoryOracle.test_m2_c2_future_beat_is_not_valid_evidence`

## Resolved ambiguities and scope

- `agents` exposes `totals` and `rows`, as described in M2. Parent and current-work
  values preserve C2's existing shapes and tree order, including `waiting`.
- Attention accepts the equivalent labels `stale`/`unknown`,
  `question`/`open_question`, and `evidence_missing`/`missing_evidence`.
  IDs may be plain or generation-qualified. Available work may use IDs or records.
  Unspecified detail fields, exact error codes, and the timestamp format are not pinned.
- C2's unknown owner with stale work makes freshness stale. Unknown agents without
  work do not create stale-work attention. Missing storage must either refuse or
  explicitly return unavailable/incomplete; no recovery algorithm is prescribed.
- `since` is an exclusive Lamport boundary. Completions mean accepted transitions
  into done, including derived task completion; repeated done requests add none.
  Inventory remains current. No opaque cursors or removal/tombstone format is required.
- If protected totals and urgent rows cannot fit the minimum legal budget, refuse
  with an ordinary transport error. The oracle does not prescribe its error code.
- Evidence pointers are not required snapshot fields. The legacy control verifies
  the existing U163 sanitizer's safe-pointer/hash policy, without requiring C3 to
  expose evidence contents. U163q secret-bearing pointers are intentionally not
  treated as byte-preserving exceptions.
- C1 harness launch/signals, C2 admission changes and browser parity, C4 rotation,
  and C5 store/relay corruption, race, checkpoint and sync-recovery mechanisms
  belong to other units and are out of scope. C3 must consume their current state
  honestly; their implementation is not an oracle failure here.
- The older design's token target, dependency installation, opaque/page cursors,
  retained-history proofs and continuation conservation are not current C3 MUSTs.
- No product edits, new product stubs, dependency installs, network, real timers,
  worker launches, commits, pushes, deployments or GUI actions are part of this oracle.

## Execution and failure classification

Run from the repository root with bytecode writes disabled:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/c3 -t .
```

Fixtures, generated templates and temporary owner journals live only under this
test directory and are cleaned afterward. Clocks are fixed; sleeping and network
calls raise immediately. Both adapters execute in process using their real dispatch.
Every negative-argument test first proves registration, preventing an unknown-tool
response from passing as validation. Fixture folds are checked before C3 assertions.

The fail-first run contains 63 tests [MEASURED]: 62 red [MEASURED], one green
[MEASURED], no errors [MEASURED] and no skips [MEASURED]. Red assertions identify
missing registration/dispatch or the missing M8 document. The green case pins the
preserved shared sanitizer. The exact unittest result is `FAILED (failures=62)`.

Existing C2, C2q, U163 and U163q regression suites pass: 226 tests [MEASURED], `OK`.
Their temporary directories were redirected into this test directory during the
check; their source files and fixtures were not changed.

This oracle's mandate is limited to the supplied C3 spec and the inspected isolated
workspace corpus.
