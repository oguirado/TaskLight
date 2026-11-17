# U133 frozen fail-first oracle

Status: DRAFT, STRATEGY_v11_A1 U133, W2. Source: `.unit/SPEC.md`, including binding Amendments B and C. The spec records I0 `4528625` [CITED: spec]; this isolated copy has no Git metadata to reverify that anchor. U132 and U109 ADMIT receipts are AUSENTE — no inventar. Real integration remains HOLD.

## Scope and execution

The sole product addition is `bridge/room/hook.py`, exporting exactly `run_hook_bytes(raw: bytes) -> dict`. Its body raises `NotImplementedError("U133 stub")`. No lifecycle handler, dispatch registration, storage, fold, transport, default Claude hook, backend or UI is implemented here. All remaining authored files belong to `bridge/tests/room/u133/`.

Run the frozen suite with stdlib unittest:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/u133 -t .
```

Every test first calls the actual public export with a valid deployment and a controlled successful dispatch reply. The prerequisite propagates the actual stub error without catching, skipping or accepting it. Downstream assertions are frozen but have not executed against an implementation. Current red results prove the missing public seam; they do not certify downstream behavior or mutant detection.

`support.py` supplies an explicit `app.dispatch` dependency double for the frozen U132 reply and projection contract. Its task releases traverse the shipped `bridge.plan.fold.apply_op_event`, so resetting active microtasks is not a test-side substitute for U109. Its in-memory receipts and synthetic event list are fixture state, not evidence of actual journal persistence. `test_integration.py` separately checks the real dispatch, `events.jsonl`, cross-process replay and `plan_get`; it never replaces production registration. Those checks run only after the public prerequisite and the external admission assertion `U133_INTEGRATION_ADMIT=U132,U109`. Set that assertion only when the corresponding ADMIT receipts exist; the environment value itself is not a receipt.

`cli_probe.py` runs the real neutral module and `hook_claude --lifecycle` in fresh interpreters, with literal stdin bytes and a controlled application boundary. Only that dependency reply is replaced. Identity generation, parsing, lifecycle-mode selection, silence and deadline handling remain product behavior. Process fixtures persist their own dependency state under isolated test scratch directories, allowing identity/replay assertions across fresh interpreters.

All scratch writes stay below this test directory and are cleaned up. Logical clocks are injected. POSIX alarm APIs are replaced with `FakeTimer`; blocked stdin and lock boundaries explicitly deliver the registered handler. No real timer, sleep, network service, provider or model is used. Child watchdogs are infrastructure bounds, not timing measurements. Audit hooks reject sockets, shell execution and process creation inside the entry; thread creation is denied. No timing or mutation result is inferred from a subprocess exit status alone.

## Acceptance mapping

Names refer to methods in the named classes and files. A dependency double establishes the hook contract; only explicitly integrated tests establish real journal behavior.

| Spec case | Frozen tests | Scope and gate |
| --- | --- | --- |
| A1 | `ProtocolOracle.test_a1_exact_dispatch_and_receipt_without_plan`; `ProtocolOracle.test_m3_identical_retry_preserves_original_lamport`; `EntryOracle.test_a1_neutral_without_claude_environment_and_cross_process_replay`; `EntryOracle.test_a1_claude_lifecycle_delegates_equivalent_fixture`; `EntryOracle.test_m3_distinct_processes_have_identical_utf8_ids`; `IntegratedOracle.test_a1_real_journal_deploy_and_cross_process_adapter_replay` | Empty-room deployment, canonical ID, exact dispatch arguments, both entry commands, original receipt and no plan. Real journal integration requires U132 and U109 ADMIT. |
| A2 | `CleanupOracle.test_a2_failed_releases_owned_unfinished_work_and_preserves_payloads`; `CleanupOracle.test_a2_finished_releases_without_completing_or_cancelling`; `CleanupOracle.test_amendment_b_both_terminal_states_exclude_done_cancelled`; `ProtocolOracle.test_m2_undeployed_termination_retains_detail_and_never_cleans`; `IntegratedOracle.test_a2_real_journal_failed_cleanup_matches_plan_get`; `IntegratedOracle.test_a2_real_undeployed_failure_never_appends_or_releases` | Owned unfinished work is released; foreign ownership, terminal tasks, evidence, completed outcomes, memory, phase and plan stay intact. Undeployed failure never starts cleanup. |
| A3 | `CleanupOracle.test_a3_interrupted_after_commit_replays_cleanup_once`; `CleanupOracle.test_a3_interrupted_after_one_release_resumes_remaining_only`; `CleanupOracle.test_a3_delayed_replay_does_not_release_reclaimed_work`; `CleanupOracle.test_a3_successor_run_skips_old_cleanup`; `CleanupOracle.test_a3_reopened_plan_reusing_task_ids_is_not_released`; `CleanupOracle.test_m5_revalidate_generation_owner_claim_and_run_before_release`; `CleanupOracle.test_m5_race_after_projection_read_is_protected_by_claim_fence`; `CleanupOracle.test_m5_reopened_plan_after_read_cannot_release_reused_task` | Explicit crash boundaries, original Lamport replay, partial recovery, successor runs, reclaims and reused task IDs. Race-after-read fixtures preserve the task revision to distinguish a missing claim fence from revision protection. |
| A4 | `EntryOracle.test_a4_events_lock_deadline_is_baseexception_and_no_late_mutation`; `EntryOracle.test_amendment_b_claude_lifecycle_bypasses_hook_state_lock`; `EntryOracle.test_a4_missing_room_is_silent_and_is_not_created`; `EntryOracle.test_a4_incomplete_stdin_deadline_has_no_surviving_worker`; `EntryOracle.test_m6_silence_for_capacity_contention_and_internal_failures`; `EntryOracle.test_m6_malformed_and_oversized_input_are_silent`; `EntryOracle.test_m6_parse_exhaustion_blocks_dispatch`; `EntryOracle.test_m6_import_budget_exhaustion_blocks_dispatch`; `EntryOracle.test_m6_deadline_never_interrupts_dispatch_write`; `EntryOracle.test_m7_default_todo_mirroring_preserves_plan_then_step` | Synthetic contention and incomplete input; registered BaseException deadline passes an `except Exception` boundary. No surviving mutator is possible when process/thread creation is denied. `bridge/tests/room/test_hook.py` remains unedited and is verified separately. |
| A5 | `ProtocolOracle.test_a5_hostile_reason_is_passive_and_not_prompted`; `ProtocolOracle.test_a5_rejects_duplicate_keys_at_every_depth_before_dispatch`; `ProtocolOracle.test_a5_invalid_utf8_and_unencodable_surrogates_never_dispatch`; `ProtocolOracle.test_a5_one_object_only_and_strict_json`; `ProtocolOracle.test_a5_unknown_keys_and_payload_paths_never_dispatch`; `ProtocolOracle.test_m2_invalid_slugs_keep_shared_error_codes`; `ProtocolOracle.test_m1_byte_limit_plus_one_never_dispatches`; `ProtocolOracle.test_a5_conflicting_event_id_state_and_content_reuse_is_rejected`; `EntryOracle.test_a5_denied_network_and_process_creation_still_allows_metadata`; `BoundaryOracle.test_m8_transitive_import_graph_has_no_provider_clients`; `IntegratedOracle.test_a5_real_hostile_metadata_persists_with_sockets_denied` | Hostile text stays literal; rejection occurs before mutation. Runtime audit guards supplement static transitive import inspection. Real hostile-text journal persistence is admission-gated. |
| A6 | `ControlOracle.test_a6_unstable_id_mutant_is_detected_after_throttle_window`; `ControlOracle.test_a6_cleanup_omission_mutant_is_detected`; `ControlOracle.test_a6_claim_fence_omission_mutant_is_detected_after_read_race`; `ControlOracle.test_a6_infrastructure_failure_is_never_mutant_detection`; `CleanupOracle.test_amendment_c_claim_at_or_after_terminal_blocks_that_task` | Mutants alter the public operation boundary, avoiding hook-private patch points. Each runs a nominal premise first. Only the named semantic assertion counts as detection; a stub, import, process, dispatch or infrastructure failure does not. |
| A7 | OUT OF SCOPE: U114 capsule checks with U118/U136 integrated | Swarm landing and read-only detail rendering, “Deployed · no plan yet”, Failed/unassigned parity, frame hashes, viewport sizes `390×844`, `768×1024`, `1440×900` and zoom `200%` [TARGET] belong to that integration. No GUI test, terminal/chat control or invented frame receipt is added. |

## MUST and amendment coverage

| Contract | Tests and oracle |
| --- | --- |
| M1 | `test_m1_exact_byte_limit_is_accepted`, `test_m1_byte_limit_plus_one_never_dispatches`, `test_m1_no_identity_from_environment_or_working_directory`, `test_m1_explicit_identity_wins_over_harness_environment`, `test_m1_required_values_must_be_nonempty_strings`, `test_m1_event_identity_is_validated_before_it_is_removed`, plus A5 rejection tests. Limit `65,536` bytes [TARGET: spec]. |
| M2 | `test_a1_exact_dispatch_and_receipt_without_plan`, `test_m2_invalid_slugs_keep_shared_error_codes`, `test_m2_invalid_lifecycle_retains_bad_op`, `test_m2_undeployed_termination_retains_detail_and_never_cleans`, `test_m2_dispatch_errors_preserve_codes_and_details`, `test_m2_unexpected_exception_uses_existing_internal_code`. Success is exactly `{"untrusted":{"ok":true,"lamport":L}}`; existing errors retain their unwrapped `ok`/`code`/`detail` form. |
| M3 | `test_m3_utf8_canonical_id_and_no_input_mutation`, `test_m3_identical_retry_preserves_original_lamport`, `test_m3_alive_throttling_is_delegated_not_cached_by_hook`, `test_m3_alive_replay_after_window_is_not_a_new_identity`, and cross-process tests. Alive suppression boundary is strictly less than `30` seconds [TARGET: spec]. |
| M4 | `test_m4_current_projection_omits_since_rev_and_uses_subject_slug`, `test_m4_no_plan_does_not_turn_persisted_terminal_into_failure`, `test_m4_deployed_alive_do_not_attempt_cleanup`, plus A2. The dependency permits only `agent_lifecycle`, `plan_get`, `task_release`, rejecting phase/complete/cancel/close/legacy operations. |
| M5 | `test_m5_release_id_contains_captured_generation_and_claim`, `test_m5_missing_generation_or_lifecycle_evidence_blocks_cleanup`, `test_m5_missing_claim_or_revision_never_substitutes_default`, `test_m5_null_bool_or_invalid_fence_evidence_never_passes`, `test_m5_same_run_wrong_lifecycle_skips_cleanup`, `test_m5_stale_revision_retries_with_current_rev_and_same_claim`, `test_m5_claimed_by_other_is_not_retried`, and A3 races. |
| M6 | A4, `test_m6_expired_budget_stops_before_next_mutation`, and `BoundaryOracle.test_m6_documents_wait_only_deadline_and_non_posix_limit`. Logical deadline `2` seconds [TARGET: spec]. Exit status is never the persistence oracle. |
| M7 | `test_a1_claude_lifecycle_delegates_equivalent_fixture`, `test_amendment_b_claude_lifecycle_bypasses_hook_state_lock`, `test_m7_todo_data_cannot_fabricate_lifecycle_identity`, `test_m7_default_todo_mirroring_preserves_plan_then_step`, and existing todo tests. Native Antigravity 2 event names/mappings are AUSENTE; native wiring belongs to U137. |
| M8 | `BoundaryOracle.test_m8_documented_json_fixtures_cover_all_four_states`, `test_m8_documents_commands_home_replay_cleanup_and_identity_trust`, `test_m8_public_documentation_excludes_local_identity_and_paths`, transitive import inspection, socket denial, literal hostile text and silence tests. `docs/HARNESS_HOOKS.md` is expected from implementation, never authored here. Identity is caller-asserted; harness-recorded is not authenticated. |
| Amendment B | Both terminal states filter `done | cancelled`; `plan_get` omits `since_rev`; lifecycle mode bypasses `hook_state.lock`; A7 belongs to U114. `test_amendment_b_stale_revision_has_at_most_three_retries` and `test_amendment_b_no_stale_retry_at_or_below_remaining_budget` discriminate retry limits. |
| Amendment C | `test_amendment_c_exact_exported_signature`, `test_amendment_c_optional_fields_are_nonempty_strings`, `test_amendment_c_optional_character_limits_and_literal_values`, `test_amendment_c_opened_at_or_after_terminal_blocks_cleanup`, `test_amendment_c_claim_at_or_after_terminal_blocks_that_task`, conflicting-identity and BaseException tests. `swarm`/`harness` maximum `128` characters and `reason` maximum `512` characters [TARGET: spec], including Unicode boundary fixtures. |

## Resolved ambiguities and stop rules

* Amendments B/C replace the historical `since_rev:L` read with current `plan_get({room,agent})`. Eligibility uses captured original lifecycle receipt `L`, strict `opened_lamport < L` and `claim_lamport < L`, followed by current generation/owner/claim/run/lifecycle checks. The release carries the current task revision and captured claim fence.
* Amendment B explicitly excludes `done | cancelled` for both failed and finished. Amendment C does not explicitly revoke that exclusion for failed; it remains binding, consistent with the supplied U109 fold rejecting terminal-task release.
* A maximum of `3` retries [TARGET: Amendment B] means an initial attempt plus at most `3` further attempts [TARGET]; equality at `200` ms remaining [TARGET] does not allow a retry. `claimed_by_other`, missing evidence, changed identity and expired budget stop that cleanup attempt. Missing evidence is never converted to a numeric default.
* The POSIX deadline interrupts stdin/lock waits and checks budget before dispatch. A signal during a critical write must be deferred or disarmed, allowing the atomic operation to finish. Consequently a hard wall-clock cutoff during an arbitrarily stalled write cannot simultaneously be guaranteed; the oracle asserts safe interruption boundaries and explicitly leaves host timing INCONCLUSIVE. Non-POSIX lock-wait guarantees remain limited until U121.
* Error codes explicitly specified by M2 are exact. For malformed identity/optional-value cases whose precise validation code is unspecified, tests admit the existing applicable `bad_args`/`bad_op` codes, plus `limit_exceeded` for size/length bounds, rather than inventing a code. Invalid slugs remain exactly `bad_room`/`bad_agent`; invalid lifecycle values remain `bad_op`. Internal exceptions use the existing `internal` code.
* Cleanup, replay, admission and timing are separate gates. No U132/U109 ADMIT receipt, missing integration wiring, missing visual result or failed infrastructure can be reported as a semantic mutant detection or as successful persistence.

## Hardening fixture and deferred measurements

`fixtures.json` freezes executable-shaped deployment/alive/finished/failed metadata and the `hook-lifecycle-burst` sequence of `200` calls [TARGET: spec]. `ControlOracle.test_hardening_200_events_fixed_clock_growth_and_cleanup` includes distinct alive identities in the suppression window, an identical retry after it, later accepted alive activity and terminal cleanup. Expected dependency-boundary growth is `4` lifecycle events plus `2` releases, with `196` calls appending nothing [TARGET: fixture].

The test records input hashes, per-call append outcomes, encoded fixture-event growth and cleanup in disposable scratch data. Synthetic elapsed values are not called wall time. Actual per-call wall times, actual journal-growth measurements, accepted/suppressed operational counts and host benchmark receipts are AUSENTE at this stub stage. No benchmark is started here. Authoritative timing must obey the strategy load gate: load5 at or above `18` [CITED: spec] is INCONCLUSIVE; absent telemetry also cannot pass the timing gate. Real wall timing and cold interpreter/import startup require a separate admitted measurement.

Pinned source SHA-256: `25555b0af2039ea2c787c75fe3e02f073e2a6ca4bd251fe23baa86853e1a1119` [MEASURED].

Pinned fixture SHA-256: `c10bbc400271440031c517b71f36bafeda2af7f584b54d769493d7e6a117b8f6` [MEASURED].

## Adjacent work and regression evidence

| Surface | Disposition |
| --- | --- |
| U132 lifecycle/fold and persistent alive throttling | Implementation OUT OF SCOPE. Frozen dependency contract is tested; real journal integration HOLD until ADMIT. |
| U109 claim fence, release reset and takeover | Implementation OUT OF SCOPE. Existing release fold is exercised. The strict takeover threshold greater than `600,000` ms [CITED: spec, `bridge/plan/fold.py`] is preserved by making no claim/takeover operation or fold edit. |
| U121 | Non-POSIX lock-wait implementation OUT OF SCOPE; documentation must state the limitation. |
| U137 | Native Antigravity 2 wiring OUT OF SCOPE and native mappings AUSENTE. Neutral fixtures use literal harness metadata only. |
| U114 / U118 / U136 | A7 visual capsules and frame receipts OUT OF SCOPE, not failing Python tests. |
| Authentication, launchers, executor cancellation, daemons, family mailboxes, UI | OUT OF SCOPE. No implementation or fabricated receipt. |

`regression_runner.py` runs existing room discovery excluding only the intentionally red U132 suite and this U133 suite. It supports `--snapshot` and `--compare`; `regressions.json` lists pre-existing failing test IDs, preserving subtest identities. Older plan-close, claim-authority and descriptor expectations in this supplied copy are already red; they are not U133 regressions and are not repaired outside the authorized surface. The baseline summary is `FAILED (failures=10, errors=7)` across `804` tests [MEASURED].

Existing default-hook regression command:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest bridge.tests.room.test_hook
```

All changes and conclusions are limited to the supplied corpus and the declared test/stub surface.

## Observed fail-first result

The frozen suite has `81` tests, `81` red errors, no green tests and no skips [MEASURED]. Every error is the actual `NotImplementedError: U133 stub`; import, syntax and other error counts are absent from the error set. Exact unittest summary:

```text
Ran 81 tests in 0.074s
FAILED (errors=81)
```

`verification.json` records these counts. The existing todo-hook suite has `8` green tests [MEASURED], summary `OK`. The full existing room comparison is `UNCHANGED`, retaining exactly the baseline `FAILED (failures=10, errors=7)` across `804` tests [MEASURED]; no formerly green room case became red. U132 remains excluded as an independently intentional fail-first suite.

All changes and conclusions are limited to the supplied corpus and the declared test/stub surface.
