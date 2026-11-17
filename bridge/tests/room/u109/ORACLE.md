# U109 fail-first oracle

Status: FAIL_FIRST_FROZEN against the supplied I0 behavior; specification base `4528625` [CITED: `.unit/SPEC.md`]. Amendments B and C are binding. No implementation files are changed.

The normative input is `.unit/SPEC.md`, read through its final Amendment C. Relevant read-only surfaces are `bridge/plan/fold.py`, `bridge/plan/ops.py`, `bridge/plan/conformance.py`, `bridge/room/app.py`, `bridge/room/store.py`, `bridge/room/mcp.py`, `bridge/room/__main__.py`, `src/plan/reducer.ts`, `src/plan/validate.ts`, and `src/plan/types.ts`.

## Acceptance map

Names beginning `test_` below are methods of `FoldOracle` in `bridge/tests/room/u109/test_fold.py` or `LifecycleProtocolOracle` in `bridge/tests/room/u109/test_protocol.py`. Shared names without `test_` are Vitest test names in `tests/unit/u109/lifecycle.test.ts`; Python generates the corresponding `FoldOracle.test_<name>`. `cases.json` supplies independently authored input projections and explicit codes/states, never results captured from either implementation. Braced suffixes designate the individually named generated tests.

| Case | Python tests | TypeScript tests | Expected boundary |
|---|---|---|---|
| A1 | `test_a1_unassigned_{pending,active,blocked,done}`; protocol `test_a1_{pending,active,blocked,done}_strict_{false,true}` | `a1_unassigned_{pending,active,blocked,done}` | Every legal target rejects unassigned writes with claim guidance, regardless of strict creation. |
| A2 | `test_a2_pending_dep_{active,done}`, `test_a2_all_unsatisfied_{active,done}`, `test_a2_{done,cancelled,blocked}_dep_{active,done}`, `test_a2_terminal_ready_false`; protocol `test_a2_lists_all_unsatisfied_dependencies`, `test_a2_owner_precedes_dependencies`, `test_a2_{pending,blocked,done,cancelled}_prerequisite_{active,done}` | Matching shared names; `a2_ownership_before_deps_{active,done}` | All unsatisfied IDs, including absent dependencies, appear in detail. Ownership wins over dependency validation. Done/cancelled permits work; blocked does not. Existing terminal readiness is not itself a dependency gate. Prerequisites remain unchanged. |
| A3 | `test_a3_foreign_{pending,active,blocked,done}`, `test_a3_ownership_before_fence_{pending,active,blocked,done}`; protocol `test_a3_hostile_outcome_grants_no_authority`, `test_amendment_c_foreign_task_update_cancellation`, `test_amendment_c_foreign_legacy_close_task` | Matching shared names, `amendment_c_foreign_cancel` | Foreign writes reject as `claimed_by_other`; hostile outcome text grants no authority. |
| A4 | `test_a4_release_{mixed,mixed_deps,live,pending,active,blocked}`, `test_a4_release_terminal_{done,cancelled}`, `test_a4_foreign_release`, `test_a4_closed_plan`, `test_a4_retired_run_cannot_reappear_after_release_and_reclaim`; protocol `test_a4_release_mixed_preserves_other_states_and_payloads`, `test_a4_release_mixed_with_unsatisfied_dependencies`, `test_a4_release_active_without_acceptance_evidence_or_lifecycle`, `test_a4_terminal_release_{done,cancelled}`, `test_a4_release_requires_active_plan` | Matching shared names; history `a4 retired live run cannot return after release and reacquisition` | Release resets every active microtask, retains all other states/payloads/revisions, clears claim fields and projected live activity, and recomputes readiness. Terminal task release rejects under Amendment C. |
| A5 | `test_a5_stale_{pending,active,blocked,done}`, `test_a5_current_{pending,active,blocked,done}`, `test_a5_unfenced_{pending,active,blocked,done}`, `test_a5_unassigned_before_fence`, `test_a5_owned_without_claim`, `test_a5_release_{stale,current_not_rev,revision_first,owner_first}`, `test_a5_unassigned_release_{fenced,unfenced}`; protocol `test_a5_old_claim_after_reacquisition_{pending,active,blocked,done,release}`, `test_a5_current_fence_uses_claim_not_task_revision`, `test_a5_release_base_revision_remains_independent`, `test_a5_cross_agent_reclaim_race`, `test_a5_supplied_fence_on_unassigned_release_is_stale` | Matching shared names; history `a5 history rejects old same-slug fence on {pending,active,blocked,done}`, `a5 history rejects old same-slug release fence`, `a5 current fence survives intervening task revisions`, `a5 cross-agent reacquisition race preserves the winning claim` | A supplied valid fence matches claim Lamport, independently of task revision. Omission preserves eligibility. Ownership and existing revision checks retain precedence. |
| A6 | `test_a6_{micro,release}_{null,true,false,string,zero,negative,fraction,unsafe,array,object}`, `test_a6_valid_{micro,release}_{1,9007199254740991}`, `test_a6_validator_accepts_{micro_set,task_release}_{1,9007199254740991}`, `test_a6_python_integral_float_is_bad_op`; protocol `test_a6_{micro,release}_invalid_{null,true,false,string,zero,negative,fraction,integral_float,unsafe}`, `test_a6_identical_release_replay_returns_original_receipt`, `test_a6_altered_valid_fence_replay_keeps_first_identity`, `test_a6_bad_state_and_evidence_validation_preserved` | Matching shared names; `a6 validator accepts ...`, `a6 validator rejects ...`; history `a6 accepted release replay after reassignment changed-fence={false,true}` | Invalid fences are `bad_op`; both safe boundaries are legal shapes. Identical identity returns its first receipt without append or effect on reassignment, even when a valid fence is altered. Existing state/evidence validation remains. |
| A7 | `test_a7_close_{pending,active,blocked,lists_all,stale_first,terminal_mix,empty}`, `test_a7_markup_no_authority`, `test_amendment_c_owner_cancel`; protocol `test_a7_close_unfinished_{pending,active,blocked}`, `test_a7_close_lists_all_unfinished_ids_and_markup_has_no_authority`, `test_a7_stale_revision_precedes_unfinished_gate`, `test_a7_close_done_and_cancelled_archives_separately` | Matching shared names | Current revision is checked before lifecycle closure. Rejection lists every unfinished task and does not archive. Explicit cancellation remains distinct from completion. Markup is passive outcome data. |
| A8 | `test_a1_unassigned_done`, `test_a2_pending_dep_done`, `test_a4_release_live`, `test_a7_close_pending`, `test_amendment_c_foreign_cancel`, protocol `test_a8_full_python_fold_semantic_witness` | Same explicit cases; `a8 full event fold rejects an otherwise valid unassigned write`; `a8 matches real codes, details and domain projections for every shared case` | Baseline semantic witnesses have valid existing schemas and fail on ownership/dependency/close/reset assertions. Each witness isolates a gate; deleting that gate leaves its explicit expectation red. Python/TS agreement alone cannot pass the oracle. No single-gate deletion experiment is claimed before implementation. |
| A9 | OUT OF SCOPE | OUT OF SCOPE | Amendment C moves viewport/zoom observation to U130 / Wall regression under A1 section 4.3, superseding U114 in the original paragraph. No UI test is counted as failed here. |

## MUST and amendment coverage

| Requirement | Gate and negative contrast |
|---|---|
| M1 | `test_m1_shared_dispatch_is_not_bypassed`, `test_m1_conformance_remains_pure_and_does_not_enforce_authority`, A1 strict/non-strict probes, and full-fold witnesses. A warning without rejection fails. |
| M2 | `test_m2_metadata_{microtask_set,task_release}`, valid fence boundary validator tests, protocol fence forwarding, successful `untrusted` envelopes, and preserved state/evidence validation. An unknown-field rejection for a valid fence fails the shape contract, not a semantic mutation control. |
| M3 | A1-A3, complete dependency-ID details, foreign cancellation in Amendment C. |
| M4 | A5-A6 positive/invalid/stale/omitted fences, claim-versus-task-revision contrast, base revision independence. |
| M5 | A4 reset/live/revision/payload retention cases and terminal release rejection from A-U109-1. |
| M6 | A7 close gate, passive markup, terminal archive and cancellation accounting. |
| M7 | Every protocol rejection checks decoded `ok`, `code`, nonempty `detail`, unchanged journal bytes/head/full projection. Both adapters execute every protocol scenario and their decoded results, journals and projections are compared. Direct apply checks untouched inputs; TS rejection compares semantic domain fields while allowing documented rejection cursors. Replay probes preserve current claim and journal. |
| M8 | Oracle only; separate reconciliation list below; no implementation edits. Explicit outcomes precede cross-language parity checks. |
| A-U109-1 | A4 terminal release/reset revisions/live clearing and A5 unassigned fence precedence. |
| A-U109-2 | Foreign `task_update` cancellation and `close_task` probes, shared dispatch, and step-level `{code,detail}` parity. |
| A-U109-3 | Reconciliation coordinates below; A9 assigned to U130. |

## Fixture and ambiguity rulings

- Environmental clocks and opaque IDs are deterministic. Sockets and sleeps are forbidden in adapter fixtures; no benchmark or server is started. Runtime scratch is created under `bridge/tests/room/u109` and removed. Process watchdog timeouts bound subprocesses; they are not application timer tests.
- MCP uses real `tools/call`. A child process executes the real `bridge.room` module entrypoint with `call TOOL --json JSON` after fixing environmental clocks/IDs. No dispatcher, store, reducer, validator or protocol implementation is stubbed.
- Amendment C overrides earlier release wording: pending/active/blocked work may be released; done/cancelled tasks reject. Revisions retain the existing operation-Lamport convention: one accepted operation revision for the task and each reset active microtask; unaffected microtask revisions persist.
- Identical `(agent,op_id)` retains first-result replay semantics. The altered-fence replay probe alters a valid fence, avoiding confusion with malformed-input validation precedence. The existing `replayed` response flag may differ from the original receipt.
- Python integral floats are rejected. JavaScript has a single numeric representation, so safe integer numbers are checked with integer semantics; no test demands distinguishing JavaScript numeric literals with equivalent values.
- `task_update` retains its existing state shape: cancellation is the legal terminal update; a new `done` argument is not invented. The legacy `close_task` hostile probe uses a sole task claimed by another agent, avoiding an unspecified task-selection rule in a room with multiple candidates.
- The absent-dependency case uses a canonical direct projection, because public task creation already prevents missing dependency references. The blocked release fixture models active work whose dependencies changed after activation, which is legal through existing task updates.
- Safe-integer boundary values are accepted by shape validators and rejected as stale against a different actual claim. No fixture requires a claim at the maximum Lamport followed by an impossible larger event.
- No exact error wording is invented: required IDs/guidance/nonempty detail are asserted. Python and TS must nevertheless agree on the detail they return.

## Separate-lane reconciliation

These existing permissive expectations are flagged for orchestrator reconciliation, not edited or exempted globally. They are not reported as failures of this fail-first oracle; they pass against I0 and may conflict with a completed U109 implementation.

| Existing coordinate | Superseded assumption |
|---|---|
| `bridge/tests/room/u57_mcp_v2_test.py:195` | Successful micro writes after release without another claim. |
| `bridge/tests/room/u57_mcp_v2_test.py:206` | Successful unassigned prerequisite completion. |
| `bridge/tests/room/u57_mcp_v2_test.py:217` | Successful unassigned evidence-bearing completion. |
| `bridge/tests/plan/test_u55_ops_fold.py:20` | Release of an already completed task. |
| `bridge/tests/plan/test_u55_ops_fold.py:199` | Plan closure with unfinished work. |
| `tests/unit/u60/reducer.test.ts:35` | Happy-path close despite unfinished tasks. |
| `tests/unit/u60/reducer.test.ts:46` | Unassigned microtask activation. |
| `tests/unit/u60/reducer.test.ts:68` | Close a newly added pending task. |

## Out-of-scope and stop rules

U132 agent lifecycle registration/hooks, authentication, mandatory leases, phase admission, process control, acquisition, store hardening and transport implementation are outside this oracle. U116 owns generated-history campaigns, published seeds/fixture hashes/shrunk failures. U115 owns `fold-mixed-10k` paired latency/RSS benchmarks. No benchmark was started; a U109-specific timing ceiling is AUSENTE — no inventar. U115 must not start a benchmark at the specification's load threshold and must report contaminated timings as INCONCLUSIVE.

A fixture/import/schema crash does not count as a semantic mutation detection. Valid-fence shape-contract assertions are reported separately from the valid-schema lifecycle witnesses. A complete implementation must make these assertions green before claiming success. 
## Verification receipt

Results are from the frozen oracle against the supplied implementation [MEASURED]. Assertion failures are expected; no fixture/import exceptions occurred.

| Check | Exact summary / finding |
|---|---|
| New Vitest | `Tests  88 failed \| 37 passed (125)` [MEASURED] |
| New unittest | `FAILED (failures=87)`; 165 tests, 78 passed, no errors [MEASURED] |
| Existing Vitest unit suite, U109 excluded | `Tests  10297 passed \| 9 skipped (10306)` [MEASURED] |
| Existing Python plan suite | `Ran 567 tests`; `OK` [MEASURED] |
| Typecheck | No U109 diagnostic. Existing 16 diagnostics are byte-identical with U109 included or excluded [MEASURED]. Overall compiler status remains nonzero due to the existing diagnostics. |
| Public-source path check | PASS: created sources contain no local absolute paths, private tool names or machine identities [MEASURED]. |

The compiler's existing diagnostics are at `src/ai/config.ts:19`, `src/ai/config.ts:34`, `src/ai/hybrid.ts:81`, `src/ai/parity.ts:25`, `src/ai/parity.ts:181`, `src/ai/parity.ts:182`, `src/ai/parity.ts:202`, `src/ai/parity.ts:203`, `src/prompts/templates.ts:9`, `tests/unit/u07/build.test.ts:26`, `tests/unit/u07/versions.test.ts:20`, `tests/unit/u11/repair1.test.ts:58`, `tests/unit/u11/repair2.test.ts:82`, `tests/unit/u14/harness.ts:174`, `tests/unit/u14/harness.ts:179`, and `tests/unit/u36/archive-source.test.ts:122` [MEASURED].

Commands from the repository root:

```sh
npx vitest run tests/unit/u109 --no-cache --maxWorkers=2
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/u109 -t .
npx tsc --noEmit -p .
```

The mandate is limited to the supplied corpus and verified repository surfaces.
