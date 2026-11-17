# U164 fail-first oracle

The source specification is `.unit/SPEC.md`. The complete supplied file ends at M9;
Amendment sections and a separately numbered acceptance list are AUSENTE.
The numbered acceptance cases for this oracle are therefore M1 through M9.

Only `bridge/tests/room/u164/` and `tests/unit/u164/` contain new files.
The tests use the real store, fold, template loader, application handlers, MCP
adapter, and CLI adapter. There are no substitute production modules.

## Acceptance map

The table below lists concrete Python test names. Route suffixes exercise
`store.post`, `store.post_ops`, and `ext.admission.post` separately. Transport
suffixes exercise MCP JSON-RPC and the CLI `call` command separately.
`refuse` additionally checks unchanged raw journal bytes, the entire projection
(including revisions, replay receipts, progress and Lamport), released locks,
and the next admitted Lamport. `refuse_transport` checks the same preserved
journal/projection and lock release through the public adapters.

| Spec case | Concrete test names |
| --- | --- |
| M1 | `test_admission.AdmissionOracle.test_m1_new_plan_batch_cannot_complete_local_task_without_evidence`<br>`test_admission.AdmissionOracle.test_m1_nonstrict_batch_rolls_back_valid_prefix`<br>`test_admission.AdmissionOracle.test_m1_omitted_admission`<br>`test_admission.AdmissionOracle.test_m1_omitted_batch`<br>`test_admission.AdmissionOracle.test_m1_omitted_single`<br>`test_admission.AdmissionOracle.test_m1_partial_parent_admission`<br>`test_admission.AdmissionOracle.test_m1_partial_parent_batch`<br>`test_admission.AdmissionOracle.test_m1_partial_parent_single`<br>`test_admission.AdmissionOracle.test_m1_second_micro_id_admission`<br>`test_admission.AdmissionOracle.test_m1_second_micro_id_batch`<br>`test_admission.AdmissionOracle.test_m1_second_micro_id_single`<br>`test_admission.AdmissionOracle.test_m1_strict_batch_uses_missing_evidence_not_generic_conformance`<br>`test_transports.TransportOracle.test_m1_omitted_cli`<br>`test_transports.TransportOracle.test_m1_omitted_mcp`<br>`test_transports.TransportOracle.test_m1_plan_create_pending_batch_cli`<br>`test_transports.TransportOracle.test_m1_plan_create_pending_batch_mcp`<br>`test_transports.TransportOracle.test_m1_task_update_cannot_explicitly_set_done`<br>`test_transports.TransportOracle.test_m1_work_report_empty_cli`<br>`test_transports.TransportOracle.test_m1_work_report_empty_mcp` |
| M2 | `test_admission.AdmissionOracle.test_m2_attached_admission`<br>`test_admission.AdmissionOracle.test_m2_attached_batch`<br>`test_admission.AdmissionOracle.test_m2_attached_single`<br>`test_admission.AdmissionOracle.test_m2_batch_can_use_evidence_stored_by_earlier_member`<br>`test_admission.AdmissionOracle.test_m2_empty_admission`<br>`test_admission.AdmissionOracle.test_m2_empty_batch`<br>`test_admission.AdmissionOracle.test_m2_empty_single`<br>`test_admission.AdmissionOracle.test_m2_outcome_text_does_not_substitute_for_evidence`<br>`test_admission.AdmissionOracle.test_m2_sibling_is_not_evidence_admission`<br>`test_admission.AdmissionOracle.test_m2_sibling_is_not_evidence_batch`<br>`test_admission.AdmissionOracle.test_m2_sibling_is_not_evidence_single`<br>`test_admission.AdmissionOracle.test_m2_stored_admission`<br>`test_admission.AdmissionOracle.test_m2_stored_batch`<br>`test_admission.AdmissionOracle.test_m2_stored_single`<br>`test_admission.AdmissionOracle.test_m2_stored_whitespace_admission`<br>`test_admission.AdmissionOracle.test_m2_stored_whitespace_batch`<br>`test_admission.AdmissionOracle.test_m2_stored_whitespace_single`<br>`test_admission.AdmissionOracle.test_m2_whitespace_admission`<br>`test_admission.AdmissionOracle.test_m2_whitespace_batch`<br>`test_admission.AdmissionOracle.test_m2_whitespace_single`<br>`test_transports.TransportOracle.test_m2_blank_path_cli`<br>`test_transports.TransportOracle.test_m2_blank_path_mcp`<br>`test_transports.TransportOracle.test_m2_empty_cli`<br>`test_transports.TransportOracle.test_m2_empty_mcp`<br>`test_transports.TransportOracle.test_m2_stored_cli`<br>`test_transports.TransportOracle.test_m2_stored_mcp`<br>`test_transports.TransportOracle.test_m2_valid_cli`<br>`test_transports.TransportOracle.test_m2_valid_mcp`<br>`test_transports.TransportOracle.test_m2_whitespace_cli`<br>`test_transports.TransportOracle.test_m2_whitespace_mcp`<br>`test_transports.TransportOracle.test_m2_work_report_blank_cli`<br>`test_transports.TransportOracle.test_m2_work_report_blank_mcp`<br>`test_transports.TransportOracle.test_m2_work_report_valid_cli`<br>`test_transports.TransportOracle.test_m2_work_report_valid_mcp`<br>`test_transports.TransportOracle.test_m2_work_report_whitespace_cli`<br>`test_transports.TransportOracle.test_m2_work_report_whitespace_mcp` |
| M3 | `test_admission.AdmissionOracle.test_m3_batch_cannot_clear_valid_evidence_after_completion`<br>`test_admission.AdmissionOracle.test_m3_clear_done_admission`<br>`test_admission.AdmissionOracle.test_m3_clear_done_batch`<br>`test_admission.AdmissionOracle.test_m3_clear_done_single`<br>`test_admission.AdmissionOracle.test_m3_reopen_admission`<br>`test_admission.AdmissionOracle.test_m3_reopen_batch`<br>`test_admission.AdmissionOracle.test_m3_reopen_single`<br>`test_admission.AdmissionOracle.test_m3_retype_admission`<br>`test_admission.AdmissionOracle.test_m3_retype_batch`<br>`test_admission.AdmissionOracle.test_m3_retype_partial_completion_requires_evidence`<br>`test_admission.AdmissionOracle.test_m3_retype_single`<br>`test_admission.AdmissionOracle.test_m3_unblock_admission`<br>`test_admission.AdmissionOracle.test_m3_unblock_batch`<br>`test_admission.AdmissionOracle.test_m3_unblock_single`<br>`test_admission.AdmissionOracle.test_m3_uncancel_admission`<br>`test_admission.AdmissionOracle.test_m3_uncancel_batch`<br>`test_admission.AdmissionOracle.test_m3_uncancel_single`<br>`test_admission.AdmissionOracle.test_m3_valid_evidence_allows_retyping_and_unblocking`<br>`test_transports.TransportOracle.test_m3_clear_done_cli`<br>`test_transports.TransportOracle.test_m3_clear_done_mcp`<br>`test_transports.TransportOracle.test_m3_retype_cli`<br>`test_transports.TransportOracle.test_m3_retype_mcp`<br>`test_transports.TransportOracle.test_m3_unblock_cli`<br>`test_transports.TransportOracle.test_m3_unblock_mcp` |
| M4 | `test_admission.AdmissionOracle.test_m4_corrupt_template_admission`<br>`test_admission.AdmissionOracle.test_m4_corrupt_template_batch`<br>`test_admission.AdmissionOracle.test_m4_corrupt_template_single`<br>`test_admission.AdmissionOracle.test_m4_missing_template_retyping_completion_fails_closed`<br>`test_admission.AdmissionOracle.test_m4_template_unavailable_admission`<br>`test_admission.AdmissionOracle.test_m4_template_unavailable_batch`<br>`test_admission.AdmissionOracle.test_m4_template_unavailable_single`<br>`test_transports.TransportOracle.test_m4_template_unavailable_cli`<br>`test_transports.TransportOracle.test_m4_template_unavailable_mcp`<br>`test_transports.TransportOracle.test_m4_work_report_template_unavailable_cli`<br>`test_transports.TransportOracle.test_m4_work_report_template_unavailable_mcp` |
| M5 | `test_admission.AdmissionOracle.test_m5_batch_receipts_survive_retype_and_template_loss`<br>`test_admission.AdmissionOracle.test_m5_legacy_admission_receipt_replays_before_evidence_and_template_checks`<br>`test_admission.AdmissionOracle.test_m5_legacy_single_receipt_replays_before_evidence_and_template_checks`<br>`test_admission.AdmissionOracle.test_m5_locked_latest_evidence_admission`<br>`test_admission.AdmissionOracle.test_m5_locked_latest_evidence_batch`<br>`test_admission.AdmissionOracle.test_m5_locked_latest_evidence_single`<br>`test_transports.TransportOracle.test_m5_mcp_legacy_retry_returns_original_receipt` |
| M6 | `test_admission.AdmissionOracle.test_m6_legacy_fold_progress_receipts_and_plan_check_are_preserved`<br>`test_admission.AdmissionOracle.test_m6_repairing_legacy_completion_with_evidence_is_allowed`<br>`test_admission.AdmissionOracle.test_m6_unrelated_writes_do_not_reject_legacy_missing_evidence`<br>`test_parity_contract.ParityOracle.test_m6_shared_legacy_history_keeps_progress_and_receipts` |
| M7 | `test_admission.AdmissionOracle.test_m7_optional_admission`<br>`test_admission.AdmissionOracle.test_m7_optional_batch`<br>`test_admission.AdmissionOracle.test_m7_optional_single`<br>`test_admission.AdmissionOracle.test_m7_optional_strict_batch_still_completes_without_evidence`<br>`test_transports.TransportOracle.test_m7_optional_cli`<br>`test_transports.TransportOracle.test_m7_optional_mcp` |
| M8 | `test_parity_contract.ParityOracle.test_m8_active_parent`<br>`test_parity_contract.ParityOracle.test_m8_blocked_parent`<br>`test_parity_contract.ParityOracle.test_m8_cancelled_parent`<br>`test_parity_contract.ParityOracle.test_m8_completed_empty_string`<br>`test_parity_contract.ParityOracle.test_m8_completed_empty_string_list`<br>`test_parity_contract.ParityOracle.test_m8_completed_missing`<br>`test_parity_contract.ParityOracle.test_m8_completed_mixed_micros`<br>`test_parity_contract.ParityOracle.test_m8_completed_only_done_micros`<br>`test_parity_contract.ParityOracle.test_m8_completed_valid`<br>`test_parity_contract.ParityOracle.test_m8_completed_valid_plus_blank`<br>`test_parity_contract.ParityOracle.test_m8_completed_whitespace_list`<br>`test_parity_contract.ParityOracle.test_m8_completed_whitespace_record`<br>`test_parity_contract.ParityOracle.test_m8_optional_completed`<br>`test_parity_contract.ParityOracle.test_m8_optional_with_blank_records`<br>`test_parity_contract.ParityOracle.test_m8_pending_parent`<br>`test_parity_contract.ParityOracle.test_m8_pending_with_blank_records` |
| M9 | `test_parity_contract.PublishedContractOracle.test_m9_docs_publish_both_codes_and_version`<br>`test_parity_contract.PublishedContractOracle.test_m9_rule_headless_md`<br>`test_parity_contract.PublishedContractOracle.test_m9_rule_mcp_md`<br>`test_parity_contract.PublishedContractOracle.test_m9_rule_planning_contract_md`<br>`test_parity_contract.PublishedContractOracle.test_m9_rule_planning_md`<br>`test_parity_contract.PublishedContractOracle.test_m9_server_version_is_shared_unreleased_minor` |

M5's rejection-invariance assertions also run inside every admission and
transport refusal case. The deterministic lock-interleaving cases insert a
committed evidence removal at lock acquisition, then require the completion to
observe that committed state. A pre-lock-only check cannot pass those cases.

M6 is also asserted by `ParityOracle.test_m6_shared_legacy_history_keeps_progress_and_receipts`.
M8 is shared with every `U164 M8 diagnostic parity with Python conformance > M8 <case>`
case in `tests/unit/u164/parity.test.ts`; the `<case>` names and expected diagnostic
paths come from `tests/unit/u164/evidence_cases.json`, consumed by both languages.
The TypeScript history controls are named:

- `M6 historical evidence-free completion preserves fold, progress and receipts`
- `M8 incremental applyOp accepts every historical event`

The fixture includes completed, pending, active, blocked and cancelled parents;
required and optional task types; absent, empty, blank and substantive evidence;
mixed micros and sibling isolation. Diagnostic-only snapshots also ensure that
only completed micros are checked even when a caller supplies other micro states
under a completed parent. These snapshots are not admitted journal events.

## Negative controls and stop rules

| Control | Discriminating tests |
| --- | --- |
| Put the evidence gate in either fold | M6 Python history/progress/replay tests and both TypeScript history tests must fail. Historical journals are seeded independently of new-write admission. |
| Skip the batch writer | `AdmissionOracle.test_m1_omitted_batch`, `test_m1_nonstrict_batch_rolls_back_valid_prefix`, `test_m1_new_plan_batch_cannot_complete_local_task_without_evidence` must fail. |
| Treat whitespace as evidence | Every `test_m2_whitespace_*`, `test_m2_stored_whitespace_*`, and shared `completed_whitespace_record` case must fail. |
| Gate against a stale pre-lock snapshot | Every `test_m5_locked_latest_evidence_*` case must fail. |
| Revalidate a previously admitted retry before lookup | Legacy single, guarded-admission, batch and MCP retry controls must fail. |
| Reject all writes touching legacy invalid plans | `test_m6_unrelated_writes_do_not_reject_legacy_missing_evidence` must fail. |
| Ignore required type when retyping/unblocking | Every `test_m3_retype_*`, `test_m3_unblock_*`, `test_m3_uncancel_*` and partial retype case must fail. |
| Count outcome text or a request override as proof | `test_stop_rule_hostile_outcome_cannot_replace_evidence`, `test_m2_outcome_text_does_not_substitute_for_evidence`, and `test_stop_rule_no_request_override_can_disable_required_evidence` must fail. |

`test_stop_rule_foreign_owner_is_still_rejected_atomically` preserves ownership.
`test_m1_task_update_cannot_explicitly_set_done` preserves derived task completion.
`test_stop_rule_malformed_raw_evidence_is_not_admitted` and
`test_stop_rule_wrong_evidence_type_retains_schema_rejection` preserve structural
validation. Network connections and product sleeps raise assertions. Time and
operation identities are fixed; CLI/MCP are called in process; no network,
subprocess server, timer, polling loop or GUI is needed by the new tests.
Scratch journals, templates and evidence are created under the Python oracle
and removed after each test. The TypeScript configuration confines runner caches
to its own test directory and disables result and filesystem module caches.

## Binding interpretations

- M1/M2 govern otherwise valid completion requests. Omitted or empty evidence,
  blank public path entries, and whitespace-only stored evidence do not satisfy
  a required completion. Those completions require `missing_evidence` and the
  exact message `Evidence required to complete <micro_id>.` Wrong container or
  record types still use existing structural errors; no schema relaxation is
  assumed. In particular raw wire evidence records retain their existing shape.
- `work_report` is explicitly included by M1, so an empty or blank completion
  list member is expected to use `missing_evidence`, even though its old handler
  uses `bad_evidence`. The specification's write-surface list omits
  `bridge/room/ext/acquire.py`, where that earlier rejection lives. The oracle
  follows the normative MUST rather than silently exempting the tool; the author
  may need an explicit surface amendment to implement that error-code change.
- A public `work_report` member still requires the existing fields; the oracle
  does not invent a new schema or remove the evidence field from that schema.
- A corrupt local template counts as unavailable, as does a missing one. A
  completion with valid evidence still fails closed in either situation.
- New-write admission is stronger than historical diagnostics: M1 rejects an
  evidence-free done micro even if its parent has unfinished siblings, whereas
  M8 diagnoses only completed tasks' completed micros. The shared expectations
  preserve that distinction.
- M3 covers retyping partially completed parents and removal of blocked or
  cancelled overrides. Reopening a micro to pending is allowed to clear evidence.
- M5 permits a retry to replay its original receipt despite later retyping,
  missing templates or historically invalid evidence. Tests never reinterpret
  the historical receipt's conformance payload.
- M9 uses the shared unreleased `0.3.0` minor [TARGET], with no additional bump.
  Document checks look for the rule and completion context in each scoped guide;
  error codes and version are checked across those guides collectively. They do
  not prescribe headings, formatting or exact explanatory prose.

The mandate and these expectations are scoped to the supplied U164 specification
and the existing repository interfaces cited above.

## Out of scope

U163 sanitizer/redaction behavior; Firebase deployment and credentials; U161
multi-template recovery; authenticated identities; D4's separate template-hash
ruling; GUI/vision runs; commits, publication and deployment. No test failure is
reported for these units. `0.3.0` is tested only as the explicit shared M9 contract.
No production or existing test file is amended by this oracle.

## Verification

All counts below are [MEASURED] against the supplied, unmodified implementation.

- Python: 134 tests, 81 assertion failures, 53 passes, no errors.
  Exact summary: `FAILED (failures=81)`.
- TypeScript: 18 tests, 8 assertion failures, 10 passes.
  Exact summary: `Tests  8 failed | 10 passed (18)`.
- Adjacent TypeScript U60 suite: 384 passes.
- Direct existing Python selection (`u56_op_store_test`, `u57_mcp_v2_test`,
  `test_u55_conformance_md`): 156 tests, existing 37 failures and 4 errors.
  Exact summary: `FAILED (failures=37, errors=4)`. This selection does not import
  U164. Its stale assertions include bare errors without `detail`, old tool/prompt
  inventories and completing unclaimed tasks. It is not presented as a green
  regression baseline and those existing files remain unchanged.

Commands from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/u164 -t .
node_modules/.bin/vitest run --config tests/unit/u164/vitest.config.ts --configLoader runner --no-cache --no-fsModuleCache tests/unit/u164/parity.test.ts
```
