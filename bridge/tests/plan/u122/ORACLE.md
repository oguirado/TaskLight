# U122 fail-first oracle

Source: `.unit/SPEC.md`, status **DRAFT**, STRATEGY_v11 U122; Amendment A1 **KEEP** and final Amendment B are binding. The oracle adds tests and evidence only. `bridge/plan/fold.py`, existing suites, fixtures, TypeScript, and benchmark infrastructure are unchanged.

Run from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/plan/u122 -t .
PYTHONDONTWRITEBYTECODE=1 python3 -m bridge.tests.plan.u122.regression_runner
```

The first command is intentionally red on the current implementation. The second confines existing-suite scratch files and generated U116 evidence to a temporary directory inside this directory. It preserves existing assertions, records their actual outcomes, and returns failure if any existing gate fails. It runs the entire existing Python plan suite, selected in-process room suites, and the full Python U116 suite. Other room suites and the TypeScript test runner are not claimed as verified.

## Acceptance mapping

Test names below are methods in `test_semantics.py` unless a filename is given.

| Case | Tests and independent witnesses |
|---|---|
| A1 | `test_empty_is_exact_empty_projection`; `test_frozen_fixture_hashes_and_seed_are_pinned`; `test_every_prefix_matches_full_frozen_and_typescript_projections`; `test_independent_history_witnesses_include_lifecycle_close_and_reopen`; `test_sort_filter_first_event_id_and_equal_lamport_order`; `test_conflicting_duplicate_preserves_first_sorted_arrival`; `test_full_fold_inputs_and_post_call_payload_mutation_are_detached`. Complete projections include replay receipts, rejection ordering, archives, retirement, absent optional fields and nulls. |
| A2 | `test_accepted_public_application_detaches_all_nested_inputs`; `test_replay_returns_original_result_and_only_advances_cursor`; `test_post_call_source_state_event_template_and_activity_mutations`; `test_rejecting_public_call_retains_every_input_and_error`; `test_nested_lifecycle_result_receipt_and_source_are_independent`; `test_copy_budget.py::test_public_application_still_detaches_when_fold_copy_budget_changes`. Both directions of aliasing are checked, including evidence and nested lifecycle replay receipts. |
| A3 | `test_hostile_self_dependency_rolls_back_and_same_op_id_can_succeed`; `test_transitive_dependency_cycle_preserves_revisions_and_dependencies`; `test_boolean_integer_traps_are_bad_op_before_domain_checks`; `test_boolean_envelope_integers_filter_or_reject_without_reserving_ids`. Self-dependency leaves title, dependencies, revisions and replay cache unchanged; the same revision and rejected identity are reusable. |
| A4 | `test_micro_dependency_ownership_and_fence_error_precedence`; `test_unknown_operation_fields_precede_domain_and_replay_checks`; `test_byte_cap_precedes_field_range_and_domain_validation`; `test_template_and_revision_gates_do_not_write_or_reserve_replay`. Dependency messages name `T01`; owner, unassigned, fence and unknown-field precedence are asserted before any semantic effects. |
| A5 | `test_release_resets_active_microtasks_fences_and_retires_live_runs`; `test_release_owner_and_fence_errors_do_not_retire_live_activity`; `test_premature_close_and_completed_or_cancelled_closure`; `test_independent_history_witnesses_include_lifecycle_close_and_reopen`; `test_rejected_event_updates_activity_only_after_its_attempt`; `test_replay_identity_is_agent_scoped_and_rejection_never_reserves_it`. Memory, archives and prior-event takeover activity are pinned. Terminal release policy is a U109 blocker below. |
| A6 | `test_task_fault_discards_revision_retirement_rollup_and_replay`; `test_memory_fault_discards_write_revision_and_replay`; `test_injected_plan_error_keeps_its_code_for_task_and_memory`; `test_public_fault_keeps_original_plan_error_message_and_inputs`. A sentinel identifies a tentative write; one exception fires after real recomputation, including retirement. The following operation retries the rejected identity using the unchanged revision. Complete expected projections and explicit live-run/rollup witnesses reject leaked writes. |
| A7 | `test_copy_budget.py::test_valid_suffix_does_not_add_full_projection_deepcopies`; `test_copy_budget.py::test_valid_suffix_does_not_add_projection_container_copy_work`; `test_copy_budget.py::test_public_application_still_detaches_when_fold_copy_budget_changes`. All events are valid. Deepcopy call counts, container entry-copy work and payload copies are measured separately; no latency threshold substitutes for structure. |
| A8 | All methods in `test_controls.py`: `test_public_input_reuse_is_detected_by_a2_assertions`; `test_tentative_task_and_memory_leaks_are_detected_by_a6_assertions`; `test_manual_linear_container_copies_are_detected_separately_from_deepcopy`; `test_boolean_as_integer_mutant_is_detected`; `test_rejection_reserving_op_id_is_detected`; `test_post_call_input_alias_is_detected`; `test_import_crashes_inactive_mutants_and_oracle_crashes_are_not_detection`. Activated/detected records are in `verification.json`; only assertion failures after activation count as detections. |

## MUSTs and binding amendments

| Requirement | Coverage or stop condition |
|---|---|
| M1 | `test_public_signatures_and_projection_type` and complete frozen projections preserve `PlanProjection`, keyword-only public parameters, field absence/null distinctions and serialized state. No mutation flag or projection field is introduced. |
| M2; Amendment B container-copy requirement | Both A7 gates observe projection work across `tasks`, `memory`, `replayed_ops` and `archived_plans`. The tracer counts actual stdlib deepcopy frames, including recursive and imported-alias calls. It also observes new projection containers sharing entries, catching the manual comprehension-copy control without charging legitimate read-only dependency/rollup scans. Small touched-key rollback records are not treated as whole-container copies. |
| M3; Amendment B rollback hook | A3/A4/A6 assert rejection atomicity. The documented internal injection seam is `_recompute(state)` in `bridge/plan/fold.py`, immediately after its original call has derived state and retired live runs, before successful application returns. The hook is one-shot, restores automatically and does not change production source. This is the only production seam required for fault injection; no new helper name or rollback algorithm is prescribed. |
| M4 | A1/A2/A3/A5 assert sorting, first-ID deduplication, prior-agent activity, replay result/cursor behavior, rejected identity reuse, and derived fields after final recomputation. |
| M5 | A3/A4/A5 plus `test_text_is_passive_and_folding_uses_no_external_effects` preserve validation, byte-cap precedence, authority, fencing, dependencies, release, closure, takeover and passive text. The last test forbids file opening, socket creation, subprocess execution and clock/sleep calls during folding. |
| M6; Amendment B lifecycle history | Full frozen Python projections and TypeScript prefix digests in `reference.json` cover lifecycle before any plan, while closed, and after reopening. Lifecycle is present in this workspace, so it is exercised rather than skipped. Authoritative integrated-reference admission remains **BLOCKED** for the U109/integration reasons below. |
| Amendment B post-call mutation, boolean traps, rejected `op_id` | A2/A3 positive preservation tests and A8 activated negative controls cover all of these. Boolean envelope Lamports are filtered; boolean timestamps are eligible rejections; neither becomes an integer by coercion. |

## Frozen data and instrumentation

`reference.json` stores complete expected projections, inputs, templates, arrival seed, fixture hashes and baseline source artifact hashes. The file hash is pinned by `REFERENCE_SHA256` in `test_semantics.py`; tests never regenerate expectations. The current reference is explicitly **PROVISIONAL**, with integration identity `null`.

The mixed, reversed and seeded-shuffled histories each contain **33 events [MEASURED]**, with **102 prefixes [MEASURED]** in total. Arrival seed **122 [CITED: fixture data]** is deterministic. Before test implementation, every frozen prefix was compared with `foldPlan(...).projection` from `src/plan/reducer.ts`, through the existing `tests/bench/loader.mjs`; the adapter exited successfully. TypeScript digests are frozen, so unittest discovery needs only the Python standard library. Integral JSON numeric values are normalized for cross-adapter hashing; keys, nulls and array order are retained. Independent assertions pin outcomes so adapter agreement alone cannot pass.

The copy probe grows a valid suffix from **1 to 5 operations [CITED: fixture design]**, after populating all required projection containers. Full-projection deepcopies currently rise from **34 to 38 [MEASURED]**, producing an assertion failure. The container-work gate independently fails for all required containers. The manual-copy mutant performs shallow list/dict comprehensions; its extra work is isolated from the already-failing baseline to prove detection. Payload and evidence copies remain permitted. The tracer restores the prior trace function after each probe.

## Hardening and unresolved prerequisites

| Item | Status and boundary |
|---|---|
| Named U109/U132 integration | **BLOCKED**: the named integration identity is **AUSENTE — no inventar**. `reference.json` identifies the executed local artifacts by relative paths and hashes; these are provisional characterization evidence, not an invented integrated baseline. |
| U109 terminal-task release ruling | **Out of scope / BLOCKED**: `bridge/plan/fold.py` still rejects terminal releases, whereas A1 requires assignee release at any time. No U122 test freezes either conflicting policy, and no implementation or expectation is repaired here. Resolve through U109, then re-admit the integrated reference. |
| U132 implementation | **Out of scope**: no lifecycle implementation is added. Existing `agent.lifecycle` behavior is mandatory preservation coverage in the frozen histories. |
| Python U116 transport discrepancy | **Out of scope / BLOCKED**: `bridge.tests.property.test_storage.StorageProperties.test_conflicting_same_op_id_retains_first_result_without_other_mutation` errors with `RoomError: bad_op: op_id conflict` from `bridge/room/store.py`. It was reproduced independently with only scratch relocation. `regressions.json` preserves this actual existing error; it is not counted as a U122 failure. Existing transport/store policy requires a separate ruling. |
| `fold-mixed-10k` authoritative timing | **INCONCLUSIVE**: distinct verified pre-U122/candidate artifacts and a granted quiet window are **AUSENTE — no inventar**. No timing or RSS claim is made, and no benchmark infrastructure is edited. |
| Admission stop rules | `test_stop_rules.py` uses synthetic telemetry and callbacks only. Missing quiet grant, missing lock, missing telemetry, load5 at or above **18 [TARGET]**, or available memory below **20 GiB [TARGET]** stops before work; semantic divergence yields **BLOCK**. Unavailable measurements remain null. |
| Eventual hardening run | Requires the identical hashed mixed fixture within the existing room cap; full `fold_plan` timing excluding fixture construction; **5 warmups and 30 paired observations [TARGET]**; raw samples, p50/p95/p99, process-scoped peak RSS, fixture/artifact hashes, interpreter, commands, exit codes and host telemetry. Candidate p95 must be at most **500 ms [TARGET]**. The existing same-callback benchmark is not distinct-artifact improvement evidence. The synthetic schedule test verifies bookkeeping only and explicitly retains the self-comparison label. An RSS budget is **AUSENTE — no inventar**. |

## Verification artifacts

`verification.json` records the new-suite result, exact final summary, failing test identifiers, actual copy counts, mutation activation/detection and source-integrity checks. `regressions.json` records legacy gates without rewriting expectations. No transcript paths, local absolute paths or host identity are published.

This oracle is limited to `.unit/SPEC.md` and the inspected repository surfaces named above.
