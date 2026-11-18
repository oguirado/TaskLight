# C8 acceptance oracle

The acceptance list uses the M1–M7 numbering in `.unit/SPEC.md`. The file ends after its negative controls.

| Case | Tests |
| --- | --- |
| M1 — publish the recipe, create and add units with ordered pending steps and caller ownership, preserve other templates | `test_m1_m7_published_starter_and_documented_loop`, `test_m1_legacy_template_preserves_explicit_microtasks_and_assignment` |
| M2 — bind a registered nonterminal run, enforce owner and opening, require accepted predecessors, consume runs once, constrain replacement, and use the bind Lamport | `test_m2_bind_through_registered_tool_and_attempt_uses_bind_lamport`, `test_m2_out_of_order_step_stops_then_binds_after_predecessor`, `test_m2_owner_registration_and_opening_fence_stop_invalid_binds`, `test_m2_live_finished_undecided_and_accepted_bindings_cannot_be_replaced`, `test_m2_run_is_consumed_once_even_if_repair_clears_its_live_binding`, `test_m2_m3_failed_and_hold_reject_attempts_require_fresh_bindings` |
| M3 — accept finished OK/ADMIT on a matching ADMIT decision in one append, block HOLD/REJECT, reject stale or invalid results, and leave lifecycle-only progress incomplete | `test_m3_finished_ok_and_admit_complete_only_on_the_single_decision_append`, `test_m3_failed_hold_missing_or_live_result_cannot_admit`, `test_m2_m3_failed_and_hold_reject_attempts_require_fresh_bindings`, `test_m3_wrong_or_superseded_source_is_bad_op_with_binding_detail` |
| M4 — owner-only repair after author has bound, inclusive reason limits, repeated suffix resets, preserved prefix and history | `test_m4_repair_stops_before_author_or_with_foreign_actor_and_invalid_reason`, `test_m4_repair_rolls_back_suffix_preserves_attempts_and_can_repeat`, `test_m2_run_is_consumed_once_even_if_repair_clears_its_live_binding` |
| M5 — replay the same journal and attempt history in both languages | `m5_python_and_typescript_match_at_each_pipeline_checkpoint`, `m5_replaying_repair_clears_only_the_suffix_and_keeps_prior_attempts` in `tests/unit/c8/pipeline.test.ts` |
| M6 — ordered owner-lane bubbles, partial bound fill, accepted fraction, no acceptance from ordinary edits, unsuccessful attempt text, literal hostile content | `m6_ordered_bubbles_show_pending_bound_finished_and_accepted_progress`, `m6_failed_and_blocked_attempts_are_text_and_hostile_title_is_literal`, `m6_repair_restores_the_accepted_prefix_fraction` in `tests/unit/c8/board.test.ts` |
| M7 — document create, run or wave, bind, wait, decide, and repair on verify/review HOLD | `test_m1_m7_published_starter_and_documented_loop` |

| Negative control in the spec | Test |
| --- | --- |
| Bind oracle before spec is accepted | `test_m2_out_of_order_step_stops_then_binds_after_predecessor` |
| Bind one run to two steps | `test_m2_run_is_consumed_once_even_if_repair_clears_its_live_binding`. The original run is still live and verify's predecessors have passed. |
| ADMIT on a failed run or a finished HOLD | `test_m3_failed_hold_missing_or_live_result_cannot_admit` |
| Decide against a previous binding | `test_m3_wrong_or_superseded_source_is_bad_op_with_binding_detail` |
| Browser reducer ignores `unit.repair` | `m5_replaying_repair_clears_only_the_suffix_and_keeps_prior_attempts` |
| Board fills a step on lifecycle completion alone | `m6_ordered_bubbles_show_pending_bound_finished_and_accepted_progress` |

The room tests use the existing creation arguments with the pipeline microtasks omitted. The gate tests start from an expanded journal and a schema-valid contract template. The release check loads the shipped starter separately. Rejected writes must leave the journal bytes intact. Only a non-current decision reference pins the rejection code and binding detail. The replay probe uses the real bind, decision and repair handlers and gives the browser tests checkpoints from the Python fold. The browser tests also assert expected states independently of parity.

Out of scope for C8 are trusted artifact/evidence checks and model-family attestation, an authenticated operator approval issuer, and journal-level rejection of ordinary task operations, all assigned to C8b. Process scheduling, import execution and journal rotation are outside this slice.
