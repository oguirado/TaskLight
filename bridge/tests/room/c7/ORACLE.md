# C7 acceptance oracle

Authority: `.unit/SPEC.md`, read through its final Negative controls section.
It contains M1–M7 and no final Amendments or separately numbered acceptance
list. The MUST identifiers below are the acceptance identifiers.

| Acceptance | Python tests | Browser tests |
| --- | --- | --- |
| M1 inventory evidence, first eight, existing fields | `InventoryOracle.test_m1_*` in `test_results_export.py` | `m1_evidence_first_eight_of_*`, `m1_absent_evidence_is_omitted`, `m1_verdict_only_result_keeps_optional_fields_null`, `m1_failed_result_keeps_evidence`, `m1_empty_evidence_remains_empty`, `m1_existing_result_hash_case_and_unicode_path_keep_their_bytes`, `m1_redeployment_resets_old_result_evidence`, `m1_legacy_terminal_has_null_result`, `m1_inventory_result_parity_uses_real_python_and_browser_implementations` in `tests/unit/c7/inventory.test.ts` |
| M2 exact op schema and bounds | `ShapeOracle.test_m2_shape_*`, `test_m2_negative_control_has_valid_positive_twin` in `test_decisions.py`; vectors in `fixtures.json` | The same `m2_shape_*` vectors and positive-twin test in `tests/unit/c7/decisions.test.ts` |
| M2 current task, microtask ownership, result references | `DecisionOracle.test_m2_unknown_task_negative_control_does_not_append`, `test_m2_unknown_micro_does_not_append`, `test_m2_micro_of_another_task_does_not_append`, `test_m2_unknown_result_agent_does_not_append`, `test_m2_unknown_result_run_does_not_append`, `test_m2_live_run_without_result_is_not_a_result_reference`, `test_m2_terminal_without_result_is_not_a_result_reference` | `m2_context_*_is_bad_op_and_leaves_input_unchanged` |
| M2 stop rules and immutable rejection | `test_m2_reason_241_negative_control_does_not_append`, `test_m2_no_open_plan_stops_without_append`, `test_m2_existing_plan_fence_*`, `test_m2_post_admission_rejection_preserves_journal_bytes`, `test_m2_all_rejected_shape_vectors_leave_journal_unchanged` | `m2_no_open_plan_stops_reducer_without_mutating_input`, context negative controls |
| M2 idempotent retry versus conflict | `test_m2_identical_retry_does_not_append_or_change_decisions`, `test_m2_reordered_object_keys_are_an_identical_retry`, `test_m2_conflicting_retry_uses_existing_conflict_error` | `m3_history_identical_retry`, `m3_history_conflicting_retry` and their Python parity twins |
| M3 Lamport history, newest decision, projection bound, parity | `HistoryOracle.test_m3_history_*`, `test_m3_rejection_cannot_replace_a_prior_valid_decision`, `test_m3_new_plan_does_not_inherit_an_old_task_decision` | `m3_history_*`, `m3_python_parity_*`, `m3_accepting_a_decision_does_not_mutate_prior_projection`, `m2_m3_public_types_accept_decision_ops_and_history_without_test_type_errors` |
| M4 handler, MCP, CLI, sanitized pointers, output stop | `test_m2_valid_tool_appends_exactly_one_decision`, `test_m2_op_without_optional_source_or_evidence_is_accepted`, `test_m4_registered_mcp_and_cli_preserve_idempotence_and_op_bytes`, `test_m4_sanitizes_free_text_but_preserves_evidence_pointers`, `test_m4_sanitizer_failure_stops_output_without_raw_fallback` | Backend transport contract; no browser substitute |
| M5 header and empty line | `ExportOracle.test_m5_empty_room_has_header_and_exact_empty_line`, `test_m5_nonterminal_and_legacy_terminal_events_add_no_rows` | Backend export contract |
| M5 every result and decision, titles, evidence counts, Lamport order | `test_m5_terminal_result_and_each_accepted_decision_share_lamport_order`, `test_m5_every_result_event_not_only_latest_run_is_exported`, `test_m5_projection_cap_does_not_drop_older_integration_decisions` | Backend export contract |
| M5 excluded rejections, retries, bounded sanitized text | `test_m5_rejected_records_and_conflicting_retries_are_excluded`, `test_m5_duplicate_event_and_identical_op_retry_emit_one_line`, `test_m5_reject_verdict_is_an_accepted_decision_not_a_rejected_record`, `test_m5_summary_truncated_to_200_and_optional_fields_supported`, `test_m5_sanitized_text_preserves_receipt_bytes_and_owner_journal`, `test_m5_multiline_content_stays_on_one_line_per_record`, `test_m5_export_mcp_and_cli_have_identical_output`, `test_m5_sanitizer_failure_has_no_unsanitized_fallback` | Backend export contract |
| M6 finished and failed lanes, verdict badge, visible summary | Backend inventory propagation above | `m6_finished_*_badge_and_summary_are_visible`, `m6_failed_*_badge_and_summary_are_visible`, `m6_long_summary_is_truncated_to_200_characters`, `m6_verdict_only_result_is_renderable`, `m6_legacy_terminal_without_result_has_no_fabricated_verdict`, `m6_real_journal_to_vm_to_board_keeps_unbound_result_visible` in `tests/unit/c7/board.test.ts` |
| M6 accessible task verdict, success fill, non-colour markers | Backend decisions above | `m6_task_*_in_accessible_name_and_visible_text`, `m6_admit_task_reuses_existing_done_fill_even_while_work_is_pending`, `m6_result_*_uses_done_fill` |
| M6 hostile summary, reason and evidence paths | Passive-text positive vector in `fixtures.json` | `m6_hostile_summary_is_visible_text_never_markup`, `m6_hostile_reason_and_path_remain_passive_after_expansion`, task verdict tests |
| M7 dedicated ordered orchestrator loop | `DocumentationOracle.test_m7_results_document_contains_the_ordered_orchestrator_loop` | Backend documentation contract |

## Decisions on underspecified details

- `unit_decide(args: dict) -> dict` follows the existing extension-handler
  convention. Its only stub body raises `NotImplementedError("C7 stub")`.
  Tests call this real handler and real transports without registering a fake
  tool or replacing admission, folding, rendering or sanitizing.
- The tool envelope follows existing `task.*` tools: `room`, an `agent`
  identity and optional `expected_opened_lamport`. A source reference uses
  the specified op fields `agent` and `run_id`. Tool fixtures choose the same
  actor and source identity, because no separate actor/source argument name
  is specified. Raw-op tests separately cover source omission. No new alias
  is invented or required.
- Plan scope follows existing active-plan conventions, rather than the
  superseded proposal's `plan_lamport` or `result_lamport`. Existing fencing
  returns `stale_rev`; a missing active plan returns `no_plan`; malformed
  decisions, unknown bindings and conflicting retries return `bad_op`.
- A result reference must resolve to a terminal event carrying a result for
  that agent/run. Merely deploying or terminating without a result is not
  sufficient. No lifecycle ownership policy beyond that is imposed.
- Absent evidence is omitted. Explicit empty lifecycle evidence stays an
  empty array; a decision evidence array, when present, must be nonempty.
  Summary and receipt retain the existing C6 null representation when absent.
- Decision history comparisons assert verdict/reason order and newest-entry
  equality without choosing additional metadata keys. Full projections from
  the actual Python fold and TS reducer must match. Independent expected
  histories prevent two implementations that both reject decisions from
  producing a false parity pass.
- Integration Markdown punctuation, columns and heading text are open.
  Assertions require the specified values on one record line, the exact
  empty-state line, and Lamport ordering. Projection history trimming must
  not trim the exported journal. Multiline payloads must remain one line per
  record. No filesystem `INTEGRATION_LOG.md` export is required by M5.
- ADMIT task accessibility is required without prescribing visible badge
  wording; HOLD/REJECT and terminal result verdicts also have visible text.
  Success paint compares the existing done theme using a concrete test
  colour, without prescribing a new selector, badge class or palette.
- All pointer data is synthetic and repository-relative. Redaction assertions
  use a synthetic bearer token; pointer tests use harmless high-entropy names,
  respecting the existing sanitizer's treatment of actual credential classes.

## Bounded execution and red-state interpretation

Room homes and temporary type consumers live inside these oracle directories
and are removed after each test. Python uses a fixed clock, deterministic
identity generation, forbidden network/wait operations and an instruction
budget. Browser tests use fake timers and blocked network globals. Local
Python/compiler subprocesses have bounded input, output and deadlines.

Handler-dependent tests currently stop at `NotImplementedError: C7 stub`.
Existing non-stub seams have independent behavioral assertions: missing
inventory evidence, unsupported decisions, unsupported integration export,
missing board text/public types and missing docs are legitimate C7 reds,
not import failures. Existing legacy and invalid-shape controls may be green.
No test expects a stub error as its success condition.

## Out of scope

| Unit or proposal | Disposition |
| --- | --- |
| C2 lifecycle membership, parent graph, state precedence and general inventory fixtures | Existing `bridge/tests/room/c2` and `tests/unit/c2`; no new unrelated failures |
| C6 result schema, result-file cap, process supervision, cursor waiter and lost-wakeup tests | Existing `bridge/tests/room/c6` and `tests/unit/c6`; only C7 evidence/display regressions are added |
| `result.link`, `result_link`, receipt expansion and a filesystem `INTEGRATION_LOG.md` artifact | Not required; `result.link` is an explicit C7 non-goal |
| C8 pipeline templates | Explicit non-goal |
| C4 journal rotation | Explicit non-goal |
| Editing or deleting decisions | Explicit non-goal |
| Generic non-JSON accessor hardening and arbitrary validator object graphs | Existing validator hardening; not a new C7 acceptance requirement |

The oracle mandate is limited to `.unit/SPEC.md` and the supplied workspace corpus.
