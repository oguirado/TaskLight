# U142 fail-first work identity oracle

## Source contract and numbering

The complete `.unit/SPEC.md` was read through its end. A numbered acceptance list and final Amendment sections are **AUSENTE** in this workspace. The acceptance IDs below are local traceability labels derived from its MUSTs, hostile input, negative control, and terminal-run operator decision; they are not claimed to be original spec numbering.

| Acceptance | Contract and verification gate | Rejecting contrast | Test names in `test_work_identity.py` |
| --- | --- | --- | --- |
| A1 | Both terminal lifecycle states receive a defined refusal from both work tools; omission of identity fields cannot bypass it. | Remove the lifecycle predicate; terminal agents obtain eligible work or complete an otherwise valid claim. | `test_a01_failed_slug_cannot_acquire_legacy`<br>`test_a01_failed_slug_cannot_acquire_with_identity`<br>`test_a01_failed_slug_cannot_report_legacy`<br>`test_a01_failed_slug_cannot_report_with_identity`<br>`test_a01_finished_slug_cannot_acquire_legacy`<br>`test_a01_finished_slug_cannot_acquire_with_identity`<br>`test_a01_finished_slug_cannot_report_legacy`<br>`test_a01_finished_slug_cannot_report_with_identity` |
| A2 | Both work tools accept run_id and the plan generation, independently and together, for valid current work. | Reject either supported field, or reject every request. | `test_a02_acquire_accepts_generation`<br>`test_a02_acquire_accepts_run_id`<br>`test_a02_acquire_accepts_run_id_and_generation`<br>`test_a02_report_accepts_generation`<br>`test_a02_report_accepts_run_id`<br>`test_a02_report_accepts_run_id_and_generation` |
| A3 | Tool discovery exposes run_id and expected_opened_lamport to schema-following clients. | Leave either field absent from registered discovery. | `test_a03_acquire_discovery_declares_identity_fields`<br>`test_a03_report_discovery_declares_identity_fields` |
| A4 | Failed/Finished admission stays closed until a fresh deployed registration with a new run_id; the new registration permits work. | Treat alive, same-run deployed, or a changed request run_id as a fresh registration; alternatively refuse the successor forever. | `test_a04_alive_does_not_revive_finished_slug`<br>`test_a04_fresh_deployment_after_failed_allows_new_work`<br>`test_a04_fresh_deployment_after_finished_allows_new_work`<br>`test_a04_new_request_run_without_deployment_is_refused`<br>`test_a04_same_run_deployed_does_not_revive_failed_slug` |
| A5 | Reject stale plan generations with no journal append, including a report carrying the correct current claim_lamport; reject a forged future generation. | Parse the generation and then drop its check before the room writer commits. | `test_a05_acquire_rejects_forged_future_generation`<br>`test_a05_acquire_rejects_stale_generation_without_appends`<br>`test_a05_report_rejects_forged_future_generation`<br>`test_a05_report_rejects_stale_generation_with_correct_current_claim` |
| A6 | A mismatched or retired run beat exposes a distinguishable disposition and preserves execution/lifecycle fields; a matching beat still updates activity. | Silently ignore a stale beat while returning ordinary success, or change activity while reporting it ignored. | `test_a06_matching_beat_still_updates_activity`<br>`test_a06_mismatched_beat_preserves_execution_and_lifecycle`<br>`test_a06_mismatched_beat_returns_defined_disposition`<br>`test_a06_retired_run_beat_returns_defined_disposition` |
| A7 | Preserve identity-omitting callers, valid registered callers, claim fencing, and exact work-request replay with and without the identity fields. | Reject healthy legacy callers, renew claims on exact replay, append duplicate completions, or accept a wrong claim epoch. | `test_a07_identified_acquire_exact_replay_appends_nothing`<br>`test_a07_identified_report_exact_replay_appends_nothing`<br>`test_a07_legacy_acquire_exact_replay_appends_nothing`<br>`test_a07_legacy_report_exact_replay_appends_nothing`<br>`test_a07_registered_live_legacy_work_still_succeeds`<br>`test_a07_unregistered_legacy_acquire_and_report_still_work`<br>`test_a07_wrong_claim_still_refuses_without_appends` |

## Re-pinned source coordinates

| Source | Observed responsibility |
| --- | --- |
| `.unit/SPEC.md:10` and `.unit/SPEC.md:17` | Work identity MUSTs, stale-generation hostile, lifecycle-removal negative, terminal-run decision. |
| `bridge/room/ext/acquire.py:173` and `bridge/room/ext/acquire.py:281` | Existing work handlers reject the new arguments and lack lifecycle admission checks. |
| `bridge/room/ext/acquire.py:306` and `bridge/room/ext/acquire.py:317` | Work-tool discovery currently omits both identity fields. |
| `bridge/room/ext/activity.py:8` | Public beat receipt currently acknowledges success regardless of the fold disposition. |
| `bridge/plan/fold.py:386` and `bridge/plan/fold.py:434` | Registered stale/terminal run beats are ignored in execution state. The package coordinate has moved. |
| `bridge/room/store.py:738` and `bridge/room/store.py:1181` | Existing generation comparison and batch writer accept expected_opened_lamport. |
| `bridge/room/ext/lifecycle.py:15` | Real lifecycle registration used to prepare terminal and successor fixtures. |
| `bridge/room/app.py:1234` | Shared public dispatcher used by every behavioral case. |

## Resolved ambiguities

- Generation parameter: use `expected_opened_lamport` from the existing backend contract and compare it with the actual plan `opened_lamport`. A reopened plan supplies the stale generation; its current task receives a newly valid claim. No error spelling is prescribed.
- Optional identity: "accept" is interpreted as additive support. Identity-omitting healthy callers retain their existing behavior, while a terminal slug is refused even when identity arguments are omitted. Independent-field positives ensure unsupported argument rejection never satisfies the contract.
- Refusal shape: a named `RoomError`, a structured error response, or an explicitly explained no-work result is acceptable. A plain empty selection is insufficient. The tests do not require a new error identifier or a particular message.
- Same-run deployment: lifecycle may reject it or acknowledge a no-op. The oracle asserts only that admission stays closed. Eligible terminal-report claims are seeded directly through the real store after lifecycle registration, keeping cleanup behavior out of the test preconditions.
- Beat result: compare a stale-run receipt with a real matching-run receipt after removing timestamp, correlation, and echoed identity metadata. Any distinct structured disposition or a named error is acceptable. Ignored beats may be journaled; their task/microtask activity and lifecycle must remain unchanged.
- Beat scope: the MUST is exercised at the existing `activity_beat` API even though its handler and fold are outside the unit author surface. This contract/surface tension is retained for reconciliation; it is not silently dropped or repaired by this oracle.
- Replay after later terminal registration or a plan reopen, and mismatched run policy on otherwise active work requests, are unspecified here and are not assigned invented behavior.

## Isolation and stop rules

All product imports already exist. The package initializer enables stdlib discovery and contains no implementation substitute. Tests use the real dispatcher, journal, template, lifecycle handler and fold. Only clocks, randomness, environment and forbidden network/sleep entry points are patched. Fixtures are bounded and self-cleaning beneath this test directory; lock contention fails immediately. Every refusal checks unchanged journal bytes and folded state after a valid fixture is established.

No source mutation is needed for the lifecycle negative: the current implementation already lacks that check. The ready-task terminal cases fail on that implementation. Removing a future check recreates the same failing contrast; healthy and successor positives prevent blanket refusal from passing.

Only `bridge/tests/room/u142/` is an authoring surface. Product code, other tests and `src/app/swarm_vm.ts` remain read-only. There is no network, provider, GUI, mailbox consumer, commit, push or deployment step. An import/setup error is an invalid oracle result, not acceptance evidence.

## Out of scope

| Unit or boundary | Excluded acceptance |
| --- | --- |
| U139 | Durable throttled lifecycle no-op receipts and crash recovery. |
| U140 | Implementing the backend generation primitive or proving its writer-lock race schedules; U142 checks work-tool use of its public generation identity. |
| U141 | Terminal cleanup parity, cleanup receipts, resumable release and bootstrap policy. |
| U143 | Mailbox slice admissions, routing, startup gates and delivery parity. |
| U144 / U145 | Documentation/prompt synchronization and the complete transport scenario. |
| Frontend and runtime capsules | Wall rendering, accessibility, providers and external harness launch receipts. |

## Verification

Run from the repository root with bytecode disabled in the environment:

```sh
python3 -m unittest discover -s bridge/tests/room/u142 -t .
```

Final stdlib discovery ran **36 tests [MEASURED]**: **29 red, 7 green, no errors or skips [MEASURED]**. Every red result is an assertion failure. The first is `test_a01_failed_slug_cannot_acquire_legacy`: a Failed slug receives eligible work. Other red groups expose missing identity arguments/discovery, terminal admission/revival rules, generation forwarding, and indistinguishable stale-beat success.

Exact summary line:

```text
FAILED (failures=29)
```

Existing regression suites were run without product edits, with temporary-directory allocation redirected beneath this oracle directory and bytecode disabled:

| Suite | Result [MEASURED] |
| --- | --- |
| `bridge/tests/room/u119/` | 175 tests; OK |
| `bridge/tests/room/u132/` | 40 tests; OK |
| `bridge/tests/room/u140/` | 29 tests; OK |

Product/spec hashes were checked against the pre-authoring snapshot and remain unchanged. The generated source/documentation scan found no local absolute paths or private tool names; temporary fixture trees were removed.
