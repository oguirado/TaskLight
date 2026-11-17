# U132 frozen fail-first oracle

Status: DRAFT. Integration remains HOLD until both U109 and U110 have ADMIT evidence. That evidence and U116 source histories are AUSENTE in this supplied snapshot; their absence is not a lifecycle test failure. Source: `.unit/SPEC.md`, including final binding Amendments B and C. Its recorded I0 anchor is `4528625` [CITED: spec]; this copy has no Git metadata with which to verify that anchor.

## Frozen inputs and execution

Shared fixture: `tests/unit/u132/fixtures.json`.
Fixture SHA-256: `be7698d395b14c3db38f458eb95a5c4205c8ae16523d133fe32d5d945e49657b` [MEASURED]. A-U132a: U109 MUST reconciliation changes only the A6 setup; frozen lifecycle records and rejection expectations remain unchanged. Expected lifecycle records and rejection codes are authored from the spec, never obtained from either fold.

Python: `python3 -B -m unittest discover -s bridge/tests/room/u132 -t .`.
TypeScript: `npx vitest run tests/unit/u132 --no-cache`.
Typecheck: `npx tsc --noEmit -p .`.

The only new product seam is `agent_lifecycle(args: dict) -> dict` in `bridge/room/ext/lifecycle.py`, using the public tool name and the existing activity-handler convention. Its body intentionally raises `NotImplementedError("U132 stub")`. No registration, loader, validator, reducer, or store implementation is supplied by this oracle.

Each Python test first makes the real A1 deployment in an isolated temporary room. TypeScript uses the same real deployment through `bridge/tests/room/u132/projection_cli.py` before testing its reducer. This prerequisite deliberately propagates the real stub error; it never skips or treats missing functionality as success. Downstream assertions are frozen but have not yet executed against a lifecycle implementation. Discovery and transport behavior are asserted after that prerequisite, without test-side registration or dispatch replacement.

All logical clocks are injected integer event timestamps. MCP `tools/call`/`tools/list` run through the real adapter with only its output sink captured. CLI `call agent_lifecycle --json` and `tools` run through the real CLI parser in process. Fresh interpreters and pipe-barrier races exercise journal-authoritative recovery and cross-process locking. No sleeps, network services, real liveness timers, model calls, or provider calls are used. Subprocess deadlines are watchdog bounds, not logical time. Temporary room data is confined to `bridge/tests/room/u132/` and cleaned up.

## Acceptance mapping

Python names below belong to `LifecycleOracle` in `bridge/tests/room/u132/test_lifecycle.py`; TypeScript titles belong to `tests/unit/u132/lifecycle.test.ts`.

| Spec case | Python tests | TypeScript tests |
| --- | --- | --- |
| A1 | `test_a1_direct_no_plan_commit`, `test_a1_shared_dispatch`, `test_a1_mcp_tools_call`, `test_a1_cli_call`, `test_a1_discovery_and_extension_loader`, `test_a1_generated_identifier` | `A1 deploys before a plan exists with the exact frozen record`; `M4 empty projection owns an empty room map`; `M4 upgrades a serialized older projection without mutating it` |
| A2 | `test_a2_orphans_all_transports`, `test_a2_fold_rejects_orphans` | `A2 %s without deployment is not_conformant` for each non-deployment state; `M5 lifecycle admission applies even when no tool handler is involved` |
| A3 | `test_a3_restart_replay_before_after_supersession`, `test_a3_concurrent_duplicate_deliveries`, `test_a3_payload_conflicts_are_not_replays`, `test_a3_room_agent_identity_scope`, `test_m8_rejected_identity_is_not_committed` | `A3 replay of an old committed deployment cannot restore a retired run`; `A3 changed %s under a committed identity is bad_op`; `A3 identical op_id from a different agent has independent identity`; `A3 rejected identities do not reserve an op_id` |
| A4 | `test_a4_activity_fencing_and_assignee_release`, `test_a4_identical_deployed_and_terminal_noops`, `test_a4_retired_run_rejections_and_alive_noop`, `test_a4_unregistered_activity_compatibility`, `test_a4_takeover_predicate_unchanged` | All tests in `A4/M6 execution activity remains separate from semantic progress`; terminal-repeat and retirement tests in `A2/A3/M5/M8 transition admission and identity` |
| A5 | `test_a5_throttle_restart_equality_and_backward_clock`, `test_a5_concurrent_boundary_appends_once`, `test_a5_new_run_resets_alive_evidence`, `test_a5_committed_replay_precedes_current_throttle` | All tests in `A5/M7 deterministic persisted-alive throttle` |
| A6 | `test_a6_closed_plan_reopen_and_json_continuation`, `test_a6_retirement_order_deduplication_and_churn`, `test_a6_empty_and_older_projection_defaults` | All tests in `A6 room state survives plan boundaries and JSON handoff`; same-run/new-run metadata tests in `A1/M1-M4 public lifecycle projection` |
| A7 | All `test_a7_*` methods | All tests in `A7/M3 hostile operation validation`; `A8 full Python/TS agreement: A7_literal_metadata` |
| A8 | `test_a8_frozen_shared_histories`, `test_a8_disabling_python_fold_fails_frozen_a1_and_a6`, `test_a8_rejected_transition_preserves_input_and_semantics` | All tests in `A8 independent frozen and differential controls` |

## MUST coverage and interpretation

| Requirement | Contract asserted |
| --- | --- |
| M1 | Loader retains existing entries/order; `lifecycle` and optional `acquire` occur once; absent `acquire` skips, nested import failure propagates; no acquire stub. Discovery schema is identical across adapters. Unknown operation kinds remain rejected (`test_m1_unknown_kind_remains_rejected`). |
| M2 | Exact inner and wrapped response; committed subject, `act`, empty `text`, operation fields and server timestamp; generated valid operation identifiers. |
| M3 / Amendment C | Missing required arguments and extra tool keys are `bad_args`; non-string/invalid room and agent use `bad_room`/`bad_agent`; other invalid lifecycle values use `bad_op`; operation byte overflow uses `limit_exceeded`. Labels require non-whitespace and `TITLE_MAX`; reason allows empty text through 512 Unicode scalars [TARGET], overriding legacy `REASON_MAX`. Surrogates and all specified C0/C1 controls are rejected. |
| M4 | Room-level map exists with `plan:null`, survives JSON continuation and close/reopen, mirrors full projection behavior, isolates rooms, retains same-run omitted metadata, clears new-run omitted metadata and alive evidence. Retired IDs remain deduplicated in retirement order. No extra accessor or UI API is invented. |
| M5 | Orphan transitions reject with identifying detail; repeated identical deployment/termination and retired/terminal alive are state-preserving no-ops; retired deployment/termination and conflicting terminal changes reject. Both folds enforce admission. |
| M6 | Registered stale/unknown/terminal beats cannot supersede or refresh current live fields. Unregistered behavior, task ownership/release, semantic revisions/progress and the existing strict takeover threshold are preserved. |
| M7 | First alive persists; less than 30,000 ms [TARGET], equal/backward timestamps suppress without postponement; equality is eligible. Restart and independent-process boundary races assert no append and current record Lamport. Capacity and injected fsync failure preserve store behavior (`test_m7_capacity_noops_and_fsync_failure_keep_journal_contract`). |
| M8 | Committed identity wins before transition/throttle, including after supersession/restart; changed payload is `bad_op`; room/agent scopes stay independent; rejected identities are not committed. Rejections preserve lifecycle/semantic state and caller input. |
| M9 | Baseline suites/typecheck are compared separately. Hostile metadata stays literal with process/network controls guarded. This oracle does not claim authentication or control executors. |

The latest amendment resolves the no-plan accessor ambiguity through `room_events` plus the room fold; it does not require changing `bridge/room/app.py`. Public metadata is compared literally; printable `__proto__` text is allowed while dangerous object keys are rejected. Direct-fold no-op checks preserve lifecycle/semantic fields while allowing existing replay/watermark bookkeeping. Transport wrappers alone are normalized; error codes and details are checked.

A-U132a: U109 MUST reject release of terminal work, so A6 explicitly cancels its completed task before closing. The seed retains the shipped `blank` template, required goal memory and a clean conformance result. Unregistered activity reclaims and reactivates released work before its beat, as U109 MUST reset active microtasks to pending on release. Neither fixture weakens or bypasses U109/U110 gates. The retirement churn case exceeds the existing activity-retirement cap without imposing a new lifecycle cap. Differential cases cover duplicate deliveries, Lamport reordering, replay mutation, orphans, retirement, terminal conflicts and rollback. Full projections, including serialized state, are compared; JSON continuation crosses languages in both directions. Independent frozen records catch the empty/empty agreement mutant.

## Stop rules and adjacent units

| Gate or surface | Disposition |
| --- | --- |
| U109 and U110 | ADMIT evidence required before integration; receipts AUSENTE. Their implementation and admission are outside this assignment. Existing assignee-release and takeover behavior is still tested. |
| M7 / U121 | HOLD M7 unless locked no-append, injectable clock and payload-checked room/agent/operation identity work through existing APIs. Never expand `bridge/room/store.py` here. The oracle asserts the behavior without implementing a storage strategy. |
| `lifecycle-burst` | `test_hardening_bounded_burst_correctness_and_ack_recovery` uses 15 agents [TARGET], independent processes and synthetic timestamps to assert append/replay/suppression budgets and acknowledged-write recovery. This is a deterministic correctness probe, not authoritative host timing. |
| Hardening timing | Authoritative timing must serialize; do not launch it with load5 at or above 18 [CITED: spec / STRATEGY_v11]. Missing telemetry or contaminated timing is INCONCLUSIVE; correctness/durability failure is BLOCK. Host latency percentiles, peak RSS and latency baseline/budget are AUSENTE; timing/RSS certification requires a separate operational measurement and is not a false lifecycle failure. The deterministic burst emits the pinned fixture hash, serialized event-byte counts and journal growth once an implementation can run; these measurements are AUSENTE at the stub stage. |
| U116 | Supplied source histories are AUSENTE. Equivalent extended histories are frozen locally; no unavailable test import is added. |
| U113 / U118 / U120 | Accessor coordination and pin/authentication changes require their own integration. Identity remains caller-asserted. |
| U133 / U134 / U136 | Automatic hooks/release, new transports, rendering and liveness labels are out of scope. Existing MCP/CLI acceptance probes remain in scope. |
| U121 and remaining exclusions | Store edits, journal reserve, provider routing, terminals and human chat are out of scope and never reported as oracle failures. |

## Observed fail-first verification

New suites contain 103 tests [MEASURED]: 63 TypeScript failures and 40 Python errors, with no passing or skipped new tests [MEASURED]. Every current failure reaches the actual `NotImplementedError: U132 stub` prerequisite. Exact summary lines:

```text
Tests 63 failed (63)
Ran 40 tests in 0.014s
FAILED (errors=40)
```

Existing TypeScript unit regression summary: `Tests 10297 passed | 9 skipped (10306)` [MEASURED]. Existing Python suites pass: plan 567, room 591, wall_room 106, wall 168 [MEASURED]. The room regression excludes only the intentionally red U132 tests; its runner uses a command module context compatible with multiprocessing spawn.

`npx tsc --noEmit -p .` retains existing diagnostics outside U132. Its complete output is byte-identical before and after the oracle changes (SHA-256 `63069af808525ab4f55a3749ca53ab2ca4edc110b320c4a0bb7b8031e3b8cfe6`) [MEASURED]; there are no added U132 diagnostics.

All changes and conclusions are limited to the supplied corpus and the declared test/stub surface.
