# U90 fail-first oracle

Status: READY [CITED: `.unit/SPEC.md`, Amendment A-U90-1], superseding HOLD.
Amendments A-U90-1 and B-U90 govern these tests. No activity implementation is
provided: the existing import-safe `bridge/room/ext/activity.py` and
`src/app/activity.ts` stubs retain their behavior and signatures.

## Acceptance map

Test paths below are relative to the repository root. Python witnesses are in
`bridge/tests/room/u90/test_activity.py`; TS witnesses are in
`tests/unit/u90/`.

| Case | Executable witnesses | Gate; negative contrast |
| --- | --- | --- |
| A1 | Python `ToolTests.test_a1_real_store_admission_and_unknown_stop`, `test_a1_real_store_preserves_high_entropy_run_identity`; TS `contracts.test.ts`: `A1 direct folds preserve high-entropy identity and reject unknown kinds` | Persist through the real store and fold without admission patches; an unknown kind is rejected without an append. High-entropy run identity is preserved locally. External wall/relay checks are deferred under Amendment B, not counted as passes. |
| A2 | Python `test_a2_exact_response_and_replay_original_committed_clock`, `test_a2_generated_op_id_and_replay_is_scoped_to_agent`, `test_a2_altered_replay_returns_original_receipt_and_live`, `FoldTests.test_a2_full_incremental_json_roundtrip_and_replay`; TS `A2 exact live full fold incremental JSON continuation and replay agree`, `A2 altered replay is agent-scoped and preserves original live` | The shared `tests/unit/u90/fixture.json` gives the exact committed response and live record. Replay retains journal bytes and the original clock, even when task/run fields change; another agent cannot reuse that identity. Omitted op IDs are distinct. Full replay, incremental application and JSON continuation agree. |
| A3 | Python `ToolTests.test_a3_non_assignee_no_append`, `test_a3_unassigned_no_append`, `test_a3_unknown_task_no_append`, `test_a3_missing_micro_no_append`, `test_a3_mismatched_micro_no_append`, `test_a3_no_plan_no_append`, `test_a3_closed_plan_no_append`, `FoldTests.test_a3_authority_is_enforced_inside_fold`; TS `A3 fold rejects %s` | Exact `claimed_by_other`, `not_found`, and `no_plan` codes; rejected calls leave journal bytes intact. Direct fold calls independently enforce authority, including unassigned work. |
| A4 | Python `ValidatorTests.test_m2_exact_shape_valid_boundaries_unicode_codepoints`, `test_a4_shape_missing_null_wrong_unknown_dangerous_and_patterns`, `test_m2_byte_cap_precedence_and_json_safety`, `ToolTests.test_a4_tool_exact_arguments_hostile_inputs_no_append`, `test_m4_unicode_note_boundary_persists_through_real_store`, `test_a4_passive_note_preserves_semantics`; TS `M2 valid run boundary %s and Unicode code points`, `A4 rejects %s`, `M2 byte cap precedes ranges and unknown keys, JSON safety precedes byte cap`, `A4 beats preserve all semantic fields while journal cursors advance` | Required and optional fields, nulls/types, full-match IDs, forbidden keys/base_rev, Unicode note boundaries, byte caps and passive hostile text. Invalid arguments never append; valid note text never becomes a directive or semantic mutation. |
| A5 | Python `FoldTests.test_a5_opaque_runs_retire_after_json_roundtrip`, `test_a5_task_guards_retire_all_active_runs_and_preserve_other_task`, `test_a5_leave_active_completion_block_cancel_release_reassignment`, `test_a5_omitted_micro_only_currently_active_children`, `test_m6_no_applicable_micro_is_success_without_semantic_change`, `ToolTests.test_m6_real_store_accepts_no_applicable_micro_without_semantic_change`; TS `A5 runs %s then %s supersede by receipt and remain fenced after JSON`, `A5 task %s retires every applicable run and beats never undo the guard`, `A5 %s retires runs and resumption needs a fresh run`, `A5 omitted micro applies to active siblings only, inactive target is a no-op` | Retired runs cannot restore live after serialization or lifecycle changes. Reverse lexical names disprove lexical ordering. Beats cannot activate pending/completed work or undo guards; fresh runs resume only active work. Unrelated tasks are preserved. |
| A6 | `activity.test.ts`: table `A6 / M8 activity precedence`, `is pure, accepts frozen inputs and never reads the clock` | Every M8 row, terminal/block/dependency/attention precedence, selected/parent aggregation, mixed child states, exact freshness boundaries, invalid/future time, owner/connection and claim-only cases. Inputs are frozen and Date.now throws if read. |
| A7 | Python `FoldTests.test_a7_ownership_negative_control_is_rejected_by_oracle`, `SeamTests.test_a7_calibration_ownership_assertion_fails_on_bypassed_fold`; TS `A7 ownership oracle fails against a bypassed fold`, `A7 detects the task-status-only working mutant`; `controls.test.ts` calibration cases | The same assertions exercise real functions and deliberately broken test functions. The ownership bypass and task-status-only working mutants must trigger assertion failures. No production patch, admission mock, skip or expected-failure exemption is used. |

## Additional MUST coverage

| Requirement | Witness or boundary |
| --- | --- |
| M1 | Real-store and direct-fold A1 witnesses remain required. `bridge/room/store.py` is unchanged. U85 wall admission and relay identity parity are post-U85 integration checks under Amendment B. |
| M2 | Both validator matrices cover exact shape, limits and precedence. |
| M3 | `M3 direct public types include exact live and the activity operation` compiles a temporary contract against actual exported types. It verifies the live shape/optionality, wire and planning unions, required op fields, optional micro/note, and forbidden base_rev. No module augmentation or false old-op type predicate is used. The temporary contract is removed in finally. |
| M4 | Python `SeamTests.test_import_registers_exact_descriptor_without_executing_handler`, `test_extension_imports_only_allowed_dependencies`, and `ToolTests.test_m4_dispatcher_wraps_result_as_untrusted`, plus receipt/replay/error matrices. Only the dispatch response sink and clock/environment are controlled; storage and authority are real. |
| M5 | Direct fold authority checks in both languages and the existing unassigned `micro.set` behavior protected by Python `test_m5_microtask_set_keeps_existing_unassigned_authority` and TS `M5 micro.set retains unassigned authority and its existing arguments`. |
| M6 | Full public semantic snapshots, including revisions, evidence, acceptance and progress; cursor/idempotency advancement and successful no-target cases. |
| M7 | Lifecycle and cross-language replay/continuation matrices. Public field sets prohibit undocumented projection/task/microtask fields; replay-cache payloads remain opaque. No retirement key name, algorithm or private representation is prescribed. |
| M8 | Pure helper table and clock-read trap. |
| M9 | OUT OF SCOPE: `executor_loop` registration/retrieval and `bridge/room/mcp.py` prompt work belong to U87 under Amendment A-U90-1. |
| M10 | Existing unit tests, Python plan/S0 suites, the TypeScript diagnostic baseline, and the repository secret scan are regression checks. Existing stubs and all external production files remain unchanged. |

## Interpretations and stop rules

The supplied files are treated as the unfinished attempt described in the
assignment, not a completed frozen oracle. Amendment B corrects their blanket
wrapper-error expectation; original JSON-continuation witnesses are retained.

- Amendment B splits tool errors: absent/mistyped room/agent wrapper fields,
  non-object arguments and unknown wrapper keys give `bad_args`; invalid string
  room/agent identifiers give `bad_room`/`bad_agent` through the store. Operation
  fields delegate to `bad_op`/`limit_exceeded`. Missing task/run fields therefore
  give `bad_op`. Wrapper `base_rev` is `bad_args`; op `base_rev` is `bad_op`.
- JSON-safety rejection precedes payload bytes; payload bytes precede op field
  ranges/unknown fields, preserving the existing validators' behavior.
- Omitted micro targets only currently active children. No applicable child is
  a successful journaled no-op, never an activation.
- Omitted connected means connected; explicit false applies after higher guards.
  Empty parents are idle, not vacuously done. Done/pending parents are idle even
  when their derived task state is active. Cancellation outranks selected done;
  selected done outranks blocking. Parent block guards precede child aggregation.
- Original A2/A5 JSON continuation remains required alongside Amendment B's ban
  on undocumented public fields. Tests constrain behavior and public shape, not
  how retirement is stored. A live record describes the current run; the helper
  receives no invented current-run argument.
- Tests are deterministic and bounded: fixed clock/event stamps, temporary room
  journals under the allowed test directory, bounded local subprocesses, no
  network, sleep, polling or real-timer scenarios. Imports remain safe.
- Behavioral Python tests first call the registered handler on the valid A2
  fixture. TS validator/projection tests first exercise the helper's specified
  active-without-live result. These public contract prerequisites deliberately
  expose `U90 stub` today; after implementation the downstream assertions run
  unchanged. Seam/unknown-kind and isolated mutant-calibration cases may be green.
  Import errors, missing exports, skipped tests and mocked admission cannot pass.

## Deferred and external work

| Owner/case | Scope |
| --- | --- |
| U85 / A1 | `src/app/agent_store.ts` wall admission and `bridge/wall/room_relay.py` high-entropy run-id relay parity are post-U85 checks per Amendment B. The valid ID must survive the real relay unchanged; redacted identity is not parity. These are not standalone U90 failures or successful integration witnesses. |
| U87 / M9 | `executor_loop` prompt, including claim, explicit active transition, fresh run-id, beats, evidence and release; no U90 prompt gate remains. |
| U88 | Cancellation-readiness derivation remains separate. |
| U91 | Rendering remains separate. |
| L4-013 | Authenticated identity remains outside scope; callers remain caller asserted. |
| U98 | Stronger fencing/age of unseen tokens is AUSENTE — no inventar. Known-token retirement alone is tested. |
| U102 | Activity side ledger remains separate. |

Historical caller/replay receipts L4-013, L4-019 and L4-020 are source citations,
not newly measured evidence [CITED: `.unit/SPEC.md`].

## Regression debt observed before edits

The supplied `bridge/room/store.py` still has a local `OP_KINDS` allowlist which
omits `activity.beat` [MEASURED]. This contradicts Amendment A's stated admission
precondition; real-store witnesses remain enabled and no bypass is introduced.
Admission must be reconciled by the owner of that external file.

The supplied MCP handshake already fails its exact tool-count assertion in
`bridge/tests/room/test_mcp.py:37`: the unchanged registered stub exposes
23 tools against an expected 22 [MEASURED]. This is outside the writable surface;
it is recorded as pre-existing regression debt, never a green regression result.
The TypeScript baseline is 16 errors outside U90 [MEASURED].

## Reproduce

Run from the repository root:

```sh
npx vitest run tests/unit/u90 --no-cache --configLoader runner --fsModuleCachePath tests/unit/u90/.runtime/cache
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/u90 -t .
npx tsc --noEmit -p .
```

This oracle and its interpretations are scoped to the supplied package and
confirmed repository surfaces.

## Recorded verification

Exact new-test summary lines [MEASURED]:

```text
Tests  131 failed | 2 passed (133)
Ran 33 tests
FAILED (errors=29)
```

Repository secret scan: 0 findings [MEASURED].

All counts below are measured against the unchanged stubs [MEASURED].

| Check | Exact summary and interpretation |
| --- | --- |
| U90 Vitest | `Tests  131 failed &#124; 2 passed (133)`; every failing behavioral case ends in `Error: U90 stub`. No skipped U90 tests. |
| U90 unittest | `Ran 33 tests`; `FAILED (errors=29)`. All errors end in `NotImplementedError: U90 stub`; the remaining cases pass. |
| Existing Vitest | `Tests  9360 passed &#124; 2 skipped (9362)`. Skips are pre-existing. |
| Existing Python plan | `Ran 526 tests`; `OK`. |
| Existing S0 seam | `Ran 3 tests`; `OK`. |
| Existing MCP handshake | `Ran 3 tests`; `FAILED (failures=1)`, the pre-existing tool-count conflict recorded above. |
| TypeScript | Baseline remains 16 errors, none in U90 files; final compiler output is identical to the initial baseline. |

The U90 oracle totals 166 tests: 160 expected red stub witnesses and 6 passing
seam/negative-control checks [MEASURED]. Integration is not declared admitted.
All cited production files and both permitted stubs retain their initial hashes
[MEASURED]. No project files were created outside the permitted test surface.

These verification claims are scoped to the supplied package and confirmed
repository surfaces.
