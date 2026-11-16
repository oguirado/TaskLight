# U69 fail-first oracle

Contract: `.unit/SPEC.md`, status R27 W3, wave B. The supplied file ends after A7; final Amendment sections are AUSENTE. Its M6 references A-U69a; changing the existing U57 count assertions belongs to the orchestrator.

Run from the repository root:

```sh
python3 -m unittest discover -s bridge/tests/room/u69 -t .
```

All names below are methods of `test_contract.Contract`.

| Acceptance | Tests | Gate and negative contrast |
| --- | --- | --- |
| A1 | `test_a1_absolute_script_outside_repo`, `test_m1_import_has_no_bootstrap_or_output` | Absolute script invocation from an unrelated temporary directory must initialize and list tools without inherited PYTHONPATH. Importing the module must leave sys.path unchanged and print nothing. Startup failure is an assertion, never an oracle import error. |
| A2 | `test_a2_ascii_locale_roundtrips_memory`, `test_m2_binary_wire_and_per_reply_flush` | Real subprocess under ASCII encoding and C locale must return the exact Unicode memory text as UTF-8 JSON. Binary sink checks one newline frame and flush per response; text-only output fails. |
| A3 | `test_a3_append_tools_in_order`, `test_m3_preserve_entire_twenty_tool_prefix`, `test_m3_new_tool_schemas` | Exact appended names and required/optional schema fields; canonical hash independently freezes the existing full tool prefix, including schemas and descriptions. Missing or reordered tools fail. |
| A4 | `test_a4_phase_to_design_single_op_and_envelope`, `test_a4_unknown_phase_rejected_without_write`, `test_a4_stale_phase_rejected_without_write`, `test_a4_zero_phase_revision_is_stale`, `test_m3_phase_op_id_replay_is_single_write` | Web-app phase changes to design through one plan.phase event; unknown phase and stale revisions cannot append; replay cannot append twice. |
| A5 | `test_a5_close_with_passive_unicode_outcome`, `test_a5_close_without_optional_outcome`, `test_m3_close_empty_outcome_is_valid`, `test_m3_close_stale_revision`, `test_m3_close_replay_does_not_duplicate_archive` | One plan.close event; U55 fold reports closed plan and one archive entry, retaining outcome and task counts. Omitted outcome is null; empty outcome is allowed. Stale writes and replay cannot create extra archive entries. |
| A6 | `test_a6_other_agent_claim_is_never_returned`, `test_a6_own_claim_precedes_lower_id_unassigned_task`, `test_m4_filter_ownership_before_limit`, `test_m4_readiness_and_terminal_states_preserved`, `test_m4_invalid_limits_remain_rejected` | Bob's claimed T01 is absent for Alice and first for Bob. Alice's own higher-id claim outranks unassigned work. Filtering precedes limit. Dependencies, blocked/cancelled/done tasks and blocked microtasks remain excluded; dependency completion unlocks work. |
| A7 | `test_a7_demo_accepts_both_identity_literals` | Source-grep check restricted to mcpInitialize requires the tasklight and legacy context-wall literals; no Chrome, Node, network or demo execution. |

M3 hostile/negative gates: `test_m3_hostile_arguments_are_rejected_atomically` and `test_m3_missing_base_revision_cannot_write` cover malformed phase, boolean revision, null/object/oversize outcome, unknown argument and missing revision. They use existing single-op validation/error mapping (`bad_op`, `limit_exceeded`) and compare log bytes before and after rejection. All successful v2 replies must use the existing content/isError envelope and passive `untrusted` payload. Successful new single-op calls must include `rev`, without inventing unspecified additional result fields.

M6 preservation gate: `test_m6_first_phase_injection_preserved` checks the first web-app phase remains discovery in the observable projection. The stronger U66 requirement that plan.open itself contain that phase is out of scope as a missing dependency: the supplied implementation lacks U66's injection. This oracle does not report that absence as a U69 failure or edit `_do_plan_create`.

## Scope and ambiguity decisions

- A5 does not require changing plan_get's active-plan-only contract: after close it returns `no_plan`, as the existing MCP path defines. Closed state and archive are inspected through the existing U55 fold, not a new archive API. `next_work` also reports `no_plan` after close.
- M4's claim priority is applied within ready eligible work. No relative order is required among equally eligible unassigned tasks; the existing response remains `items` containing microtasks.
- A1 necessarily exposes the production script's current import-path defect. The unittest process imports the installed repository module normally, then asserts child startup success; there are no missing-module test errors or stubs.
- A7 is the requested textual check. It does not claim a current-client or full launcher execution receipt.
- Native Windows locking, client registration guides, protocol negotiation, cancellable wait_inbox, native-host installation, Chrome discovery and process cleanup are outside U69's assigned surface. They are not failure gates here.
- Existing room, plan and plan_demo suites remain external regression gates. A-U69a's U57 tool-count amendment is orchestrator-owned; no existing tests are edited.
- Tests use a fixed store clock, isolated temporary storage, finite pipe input and bounded subprocess timeouts. No sockets, sleeps, real timeout-driven application behavior, or model calls are used. Runtime temporary paths are computed, never embedded host locations.

## Fail-first verification

Measured initial result: 26 test methods [MEASURED], 21 red [MEASURED], 5 green [MEASURED], no test errors [MEASURED]. Exact unittest verdict: `FAILED (failures=21)`.

Green preservation gates: module import, full tool-prefix digest, first-phase projection, readiness/terminal-state exclusions and invalid limits. Red gates correspond to missing bootstrap, UTF-8 binary output, new tools, claim-aware selection and launcher identity acceptance.

Existing regression suites: all root-level test modules under `bridge/tests/room`, `bridge/tests/plan` and `bridge/tests/plan_demo` ran through the standard unittest CLI: 880 tests [MEASURED], verdict `OK`, no failures or errors [MEASURED]. This includes the `u57_*_test.py` naming pattern that default discovery would omit. No existing tool-count assertions were amended.
