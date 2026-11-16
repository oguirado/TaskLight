# U85 Python relay oracle

Authority: `.unit/SPEC.md`, including final Amendments A-U85-1 and B-U85. Full acceptance,
MUST/seam coverage, corpus gaps and verification are documented in
`tests/unit/u85/ORACLE.md`.

| Acceptance | unittest methods or cross-language test names | Failing contrast |
| --- | --- | --- |
| A1 | `tests/unit/u85/store.test.ts`: `A1 pins every operation and keeps exactly the newest 5000 non-ops after 5001 heartbeats`; `A1 preserves pruned non-op activity and reducer rejection receipts at a small display cap`. `relay_fixture.py` supplies the actual Python fold projection. | Shared-list pruning loses operations/activity required by the fold. |
| A2 | `test_A2_clean_fixture_folds_to_done_half_progress_and_memory`; `test_A2_historical_hash_is_a_separate_synthetic_receipt`; `test_A2_structural_hash_exemption_does_not_exempt_ordinary_strings`. `tests/unit/u85/store.test.ts`: `A2 real relay replay equals both unpruned folds and duplicates change nothing`. | Receipt redaction, changed projection or harmful duplicate application. Exact unavailable-journal reproduction is unproven, not claimed. |
| A3 | `test_A3_live_sanitize_gap_precedes_later_event`; `test_A3_replay_sanitize_gap_precedes_later_event_and_terminal`; `test_A3_live_oversize_gap_precedes_later_event`; `test_A3_replay_oversize_gap_precedes_later_event_and_terminal`; `test_A3_replay_pagination_signals_gap_before_watermark`; `test_A3_sparse_failures_never_coalesce_over_accepted_events`; `test_A3_numeric_discontinuity_does_not_invent_loss`. Page notice/recovery cursor in `tests/unit/u85/hosting.test.ts`: `A3 real relay %s gap shows interval and pins recovery cursor before 8`. | Missing/late gap, leaked payload, wrong replay rid, coalesced accepted event or inferred loss from Lamport arithmetic. |
| A4 | `test_A4_live_failed_gap_stops_and_retries`; `test_A4_replay_failed_gap_stops_and_retries`; `test_A4_live_failed_oversize_gap_stops_and_retries`; `test_A4_replay_failed_oversize_gap_stops_and_retries`; `test_A4_live_failed_event_stops_and_retries`; `test_A4_replay_failed_event_stops_and_retries`. | Cursor or acknowledgement crosses a thrown send; next attempt skips the failure. |
| A5 | `tests/unit/u85/store.test.ts`: `A5 redacted sha256 is invalid and cannot complete the microtask or poison a corrected event`. Hosting: `A5 not_found is exposed by the reducer and makes the hosted page stale`; `M2 consumes fold errors and preserves bad_op diagnostics`; `M2 consumes standalone fold %s diagnostics`. | Silent validation/fold failure or fabricated successful completion. |
| A6 | `tests/unit/u85/link.test.ts`: `A6 rejects %s without callbacks, cursor changes or HTML`; `A6 extension rejects hostile gap %# without consuming the valid replay`; `A6 mismatched envelope/event rooms never reach ingestion`. Hosting: `A6 hostile gap frames do not create markup, change cursors or mutate another room`. | Malicious reason/room/bounds, stale rid or cross-room mutation accepted. |
| A7 | `tests/unit/u85/hosting.test.ts`: `A7 duplicate gap valid suffix terminal and reconnect retain uncertainty; only complete clean replay clears it`; `A7 every unresolved interval must be repaired before a terminal may clear the notice`; `A7 a repeated validation fault in recovery cannot be cleared by more:false`. | Reconnect, later event, duplicate or terminal alone falsely declares completeness. |
| A8 | `test_A8_gap_suppression_negative_control_is_detected`; TS store: `A8 shared-list pruning negative control loses the plan while the public store must retain it`; TS link: `A8 real Python relay %s gap crosses the real extension with rid rewriting`; `A8 matching replay gap uses the production extension and preserves its pending sync until terminal`; `A8 unknown extension frame types are still rejected`. | Deliberately omit gap or restore shared-list pruning. Production forwarding is in U85 after the amendment and must pass before admission. |

## Additional boundary map

| Acceptance | Additional methods or TypeScript names | Failing contrast |
| --- | --- | --- |
| A1 | tests/unit/u85/boundaries.test.ts: A1 equal-Lamport display ties keep deterministic newest IDs without pruning operations | Shared-list pruning or lost tie ordering. |
| A2 | tests/unit/u85/boundaries.test.ts: M2 legacy JSONL remains usable independently of the additive checked method | Existing ingestion results change while adding the checked API. |
| A3 | test_boundaries.py: test_M3_live_sanitizer_exception_emits_content_free_gap; test_M3_replay_sanitizer_exception_emits_content_free_gap; test_M3_live_adjacent_exclusions_emit_one_maximal_same_reason_gap; test_M3_replay_adjacent_exclusions_emit_one_maximal_same_reason_gap. TS: M3 accepts inclusive positive safe bounds [%s,%s] without inferring loss | Silently swallow sanitizer exceptions, leak exception details or reject valid safe bounds. Amendment B requires one gap per maximal contiguous excluded run with the same reason. |
| A4 | test_boundaries.py: test_M4_live_failure_after_signalled_gap_retries_failed_event; test_M4_replay_failure_after_signalled_gap_retries_failed_event | A successful gap incorrectly authorizes skipping the following failed event send. |
| A6 | TS: M5 ignores malformed or obsolete terminal %s without consuming the replay; M5 requires hello membership before any gap or event can reach the page | Malformed terminals consume valid replay, duplicate terminals re-complete it, or pre-hello frames mutate the page. |
| A7 | TS hosting: A7 live repair alone cannot replace a clean replay containing the excluded event; A7 a replay gap overlapping the tracked interval prevents a clean terminal | Live repair or a replay gap overlapping a tracked interval falsely clears the notice. |
| A8 | TS hosting: A8 real relay-extension-link-hosting %s gap preserves visible uncertainty and recovery cursor | Production extension rejects a real relay gap before the hosted notice receives it. |

Sanitizer exceptions are M3 sanitization failures; their messages are never gap
content. Successful signalling permits pagination through that gap, but the
next failed event send must be retried. The full map and resolutions are in
tests/unit/u85/ORACLE.md.

The fixture replaces only `bridge.wall.room_relay.store.read`. The real sanitizer,
frame-size check, relay and Python fold execute. Sanitization failure is injected
at the dependency boundary; oversize is a real oversized ordinary-text event.
Clock values and event order are fixed. No network, real timers or disk journals
are used. Subprocess consumers in the TypeScript suite are bounded.

The original journal is AUSENTE from this workspace. The shared JSON fixture is
a semantic reconstruction, with its test-owned evidence path and supplied current
receipt. The historical receipt is a separate synthetic case. Full provenance
and exact receipts are listed in `tests/unit/u85/ORACLE.md`.

The specification supplies no `sync_notice.ts` export names/signatures: AUSENTE.
No stub export is invented. Existing relay behavior produces assertion failures,
not `U85 stub` exceptions; see the full oracle's explicit limitation.

U90/U91 activity semantics/rendering, U89 tools, U86/U93 composer, U87 dispatcher,
U94 export, U102 snapshots/side ledger, daemon, authentication/privacy-policy and
store-format changes are out of scope and are not counted as failures.

## Final amendments and verification

The binding final Amendment B-U85 is applied: maximal contiguous same-reason
exclusions are coalesced; different reasons remain separate. Missing fields and
unlisted-room faults are rejected at the page boundary. Recovery negatives use
explicit overlapping replay gaps, without inferring loss from numeric Lamport
jumps. The full added test map is in `tests/unit/u85/ORACLE.md`.

The actual native host outbound sender is exercised in memory by
`test_M8_native_host_send_preserves_live_and_replay_gap_fields`. Its implementation
is read-only: it serializes arbitrary outbound frames without a type whitelist,
and is passed directly to RoomRelay. Exclusion-payload and structural-redaction
checks are named in the full map.

Fresh Python result [MEASURED]:

```text
Ran 31 tests
FAILED (failures=23)
```

There are 8 passing tests and no import or execution errors [MEASURED]. The
TypeScript oracle has 93 cases, with 89 red and 4 green [MEASURED]. Stub-only
failure verification and exact missing-journal reproduction remain unproven for
the reasons documented in `tests/unit/u85/ORACLE.md`.

The existing Python wall regression, excluding U85, passes on its standalone
rerun: `Ran 137 tests` / `OK` [MEASURED]. Its initial concurrent run hit an
existing real-clock rate-window assertion; the full oracle records the test name.
All inspected production files remain unchanged [MEASURED].

Secret scanning returns zero findings [MEASURED].
