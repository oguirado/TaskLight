# U85 frozen fail-first oracle

Authority: `.unit/SPEC.md`, including final Amendments A-U85-1 and B-U85. Status: R30,
Wave A, lane A1 [CITED]. Integration remains unproven: the amendment puts
`extension/src/agent_relay.ts` forwarding inside U85 and supersedes the original
external-prerequisite HOLD. These tests do not implement U85.

## Acceptance map

Parameterized rows are individual test cases. The names below are the literal
Vitest test-name templates; the Python names are unittest method names.

| Acceptance | Test paths and names | Gate and negative contrast |
| --- | --- | --- |
| A1 | `store.test.ts`: `A1 pins every operation and keeps exactly the newest 5000 non-ops after 5001 heartbeats`; `A1 preserves pruned non-op activity and reducer rejection receipts at a small display cap`; `A1 ordering, deduplication and defensive copies survive retention` | Public `plan("demo")`, complete projection (including memory, revisions, rollups and rejection receipts), sorted defensive event copies, and bounded non-op display must survive. Compare the real Python fold and the unpruned TypeScript fold. Shared-list pruning is the failing contrast. |
| A2 | `store.test.ts`: `A2 real relay replay equals both unpruned folds and duplicates change nothing`; `M2 preserves boolean ingestion and JSONL duplicate malformed and torn compatibility`. `bridge/tests/wall/u85/test_relay.py`: `test_A2_clean_fixture_folds_to_done_half_progress_and_memory`; `test_A2_historical_hash_is_a_separate_synthetic_receipt`; `test_A2_structural_hash_exemption_does_not_exempt_ordinary_strings` | The shared fixture crosses the actual Python sanitizer/relay and actual page store/reducer. Require T01 done, progress 50% [TARGET], goal/decisions memory, unchanged receipt hashes, and harmless duplicates. Hash redaction or double application must fail. Exact historical-journal reproduction remains unproven; see the corpus gap below. |
| A3 | `link.test.ts`: `A3 validates and exposes live and matching replay %s gaps`. `hosting.test.ts`: `A3 real relay %s gap shows interval and pins recovery cursor before 8`; `M4 numeric Lamport discontinuity without a gap does not invent stale state`. Python: `test_A3_live_sanitize_gap_precedes_later_event`; `test_A3_replay_sanitize_gap_precedes_later_event_and_terminal`; `test_A3_live_oversize_gap_precedes_later_event`; `test_A3_replay_oversize_gap_precedes_later_event_and_terminal`; `test_A3_replay_pagination_signals_gap_before_watermark`; `test_A3_sparse_failures_never_coalesce_over_accepted_events`; `test_A3_numeric_discontinuity_does_not_invent_loss` | Require explicit inclusive gap at the excluded event, before the later event/terminal; live omits rid, replay preserves rid, gap carries no event content. Transport pagination may cross a signalled gap, but reconnect recovery still starts before it. Silent skipping and coalescing over an accepted event fail. |
| A4 | Python: `test_A4_live_failed_gap_stops_and_retries`; `test_A4_replay_failed_gap_stops_and_retries`; `test_A4_live_failed_oversize_gap_stops_and_retries`; `test_A4_replay_failed_oversize_gap_stops_and_retries`; `test_A4_live_failed_event_stops_and_retries`; `test_A4_replay_failed_event_stops_and_retries` | A throwing send stops traversal; no later event/crossing acknowledgement is delivered. The next attempt starts before the failed interval. Missing send attempts and advancement past failed sends both fail. |
| A5 | `store.test.ts`: `A5 redacted sha256 is invalid and cannot complete the microtask or poison a corrected event`. `hosting.test.ts`: `A5 hosting uses checked ingestion for redacted evidence and preserves the last complete projection`; `A5 not_found is exposed by the reducer and makes the hosted page stale`; `M2 consumes fold errors and preserves bad_op diagnostics`; `M2 consumes standalone fold %s diagnostics` | Redacted evidence is rejected; accepted history is unchanged; corrected evidence with the same ID can be accepted. Shape-valid missing microtask exposes `not_found`. Independently exercise invalid, rejected and errors diagnostics, preserving `bad_op` rather than inventing completion. Silent failure is the contrast. |
| A6 | `link.test.ts`: `A6 rejects %s without callbacks, cursor changes or HTML`; `A6 mismatched envelope/event rooms never reach ingestion`; `M5 room_event replay must match the outstanding room and rid`; `M5 room_hello membership is required for live gaps and events`; `A6 extension rejects hostile gap %# without consuming the valid replay`. `hosting.test.ts`: `A6 hostile gap frames do not create markup, change cursors or mutate another room` | Invalid room, reversed/unsafe/nonpositive/noninteger bounds, wrong version, malicious reason, unknown membership, stale rid and cross-room envelopes cannot mutate another room or advance cursors. Every all-dropped gap test has a valid positive witness. |
| A7 | `hosting.test.ts`: `A7 duplicate gap valid suffix terminal and reconnect retain uncertainty; only complete clean replay clears it`; `A7 every unresolved interval must be repaired before a terminal may clear the notice`; `A7 a repeated validation fault in recovery cannot be cleared by more:false`; `M6 refresh and duplicate delivery announce a fault once and schedule no automatic retry`; `M6 announces a changed fault once without re-announcing duplicate faults`; `M6 a later valid operation cannot replace the last complete visible progress`. `link.test.ts`: `M5 exposes only matching room_synced frames, including continuation then terminal`; `M5 ignores obsolete ports after reconnect and accepts the current port` | Notice is literal text with role status and polite live region. Keep uncertainty through duplicates, refresh, reconnect, later valid events, wrong-rid terminals and incomplete replay. Only a clean matching terminal after every fault is repaired clears it. Preserve the visible complete progress. No automatic retry or dismiss-to-current action. |
| A8 | `store.test.ts`: `A8 shared-list pruning negative control loses the plan while the public store must retain it`. Python: `test_A8_gap_suppression_negative_control_is_detected`. `link.test.ts`: `A8 real Python relay %s gap crosses the real extension with rid rewriting`; `A8 live gap fans out only to subscribed ports; other frame types remain rejected`; `A8 matching replay gap uses the production extension and preserves its pending sync until terminal`; `A8 unknown extension frame types are still rejected`; `A8 real extension-link-store chain preserves clean replay and rejects cross-room mutation` | Primary A1 rejects the shared-list-pruning mutant; primary A3 rejects gap suppression. Gap-positive assertions precede the suppression contrast. Production extension routing is exercised, including rid rewriting, subscription isolation and pending-sync lifetime. Injected page callbacks alone cannot admit U85. |

## MUST and seam coverage

| Rule | Coverage |
| --- | --- |
| M1 | A1 full history, non-op activity used by takeover, operation pinning, ordering, defensive copies and A8 pruning contrast. |
| M2 | A2 checked/boolean/JSONL compatibility, A5 invalid/duplicate distinction and reducer diagnostics; `M2 hostile checked input %# is invalid without accepted-history mutation`. |
| M3 | A3 live/replay exact gap shape, both reasons, safe inclusive intervals and content-free gap assertions. |
| M4 | A3 ordering/pagination/no inferred loss, A4 stopped traversal/retry, A5/A7 outgoing recovery cursor. |
| M5 | Actual link, hosting and extension paths; hello membership, room/rid validation, callback delivery, obsolete-port rejection and envelope-room equality. |
| M6 | Actual hosted DOM, retained projection, text safety, polite status, deduplicated announcements, multiple unresolved faults and terminal recovery. |
| M7 | `M7 passes activity.beat unchanged when the integrated validator accepts it`; `M7 preserves the optional S2 live projection from the integrated reducer`; `M7 unknown operations remain rejected by the delegated validator`. The validator/reducer spies provide only future S2 boundary results; they implement no activity semantics. |
| M8 | Restricted write surface, existing-suite regression, unchanged typecheck output, secret scan and actual production extension tests. |

## Determinism and scope

`helpers.ts`, `fixture.json`, `evidence.md` and
`bridge/tests/wall/u85/relay_fixture.py` are test-owned support. Events, clocks,
nonces, hashes and port deliveries are deterministic. App timers use
`FakeAppClock` or Vitest fake timers; extension timers use `FakeExtClock`.
No network, wall-clock sleeps, persistent journal writes or model calls occur in
these tests. The bounded Python subprocess runs a local fixture driver; only the
journal reader is replaced, while RoomRelay, sanitization, frame sizing and
folding remain real. Sanitizer failure is injected as a dependency returning
None; oversize uses an actually oversized ordinary-text event.

The hosting harness substitutes inert external AI/Firebase/connector and model
sheet boundaries. Hosting, AgentLink, AgentStore, the reducer, AgentWall, its
renderer and the eventual sync notice remain real. Diagnostic/seam probes mock
only the named reducer/validator boundary for their own test and restore it.
No test-side synchronization state machine supplies missing production behavior.

## Binding resolutions and unavailable evidence

- A-U85-1 supersedes the original prohibition on extension forwarding changes.
  Production forwarding acceptance is in scope and currently red, not an
  out-of-scope dependency failure.
- `src/views/sync_notice.ts` has no specified export name or signature in M6 or
  the amendment: AUSENTE. No constructor signature was invented and no stub
  file was created. Notice behavior is observed through `hosting/src/main.ts`.
- The permitted production modules contain existing behavior, not throwing U85
  stubs. The only new allowed stub has no specified API. Accordingly, the new
  failures are behavioral AssertionErrors and an explicit missing-ingestChecked
  assertion, **not** `Error("U85 stub")` failures. A requirement that every red
  result be a stub error cannot be fulfilled within the authorized write set.
- The source journal identified in SPEC A2 is AUSENTE from the isolated
  workspace. Its private location is deliberately not copied into this public oracle. `fixture.json` is a self-contained
  semantic reconstruction from the acceptance facts, not an exact reproduction
  of unavailable event bytes. Exact journal parity is an unproven A2 gate.
- The current receipt
  `2b504639f69d0f5ced71cbee6bd4363d838aa6536b37d69b6cf21154060fbe65`
  is preserved as supplied [CITED]. The absent historical receipt
  `19e0b7d9f2aebc331061f4d9199343ef28b2f2f1302395319f52b2394574bf1f`
  is tested only in a separate synthetic event [CITED]. `evidence.md` is a
  test-owned path, not a claim that its bytes hash to either receipt.
- Source references supplied with the spec are J11
  `6abf0fd95e8c9eb7550c8b1e1b473ffa0a5209380337701513b226d02d6d5b8a`
  and S3 `2d77af3fd12de36d96f0af3ed545003e92347e6ccfcb8a332bd72c9ae3d892ac`
  [CITED]. They are provenance, not independently verified implementation receipts.
- M2's shape validation and stateful fold rejection are distinct: a shape-valid
  missing-task operation need not be labelled invalid by ingestion, but its
  `not_found` receipt and hosted uncertainty are mandatory.
- M4 permits transport continuation over successfully signalled gaps. The oracle
  checks the next recovery request, rather than forbidding transport pagination.
- S2's exact beat shape and optional live fields are only a U85 admission/
  passthrough seam. U90 validator/reducer semantics, U91 rendering, U89 tools,
  U86/U93 composer behavior, U87 dispatcher extraction, U94 export, U102
  snapshots/side ledger, daemon/authentication/privacy-policy changes and store
  format changes are out of scope and are not reported as U85 failures.

## Additional boundary gates

These extend the acceptance map without changing the production surface.

| Acceptance | Additional literal test names | Gate and negative contrast |
| --- | --- | --- |
| A1 | boundaries.test.ts: A1 equal-Lamport display ties keep deterministic newest IDs without pruning operations | Equal Lamports sort by event ID; retain pinned operations and only the newest display items. A pruned display item remains deduplicated. Shared-list pruning fails this gate. |
| A2 / M2 | boundaries.test.ts: M2 legacy JSONL remains usable independently of the additive checked method | Exercise existing accepted/duplicate/malformed/torn results independently of the unavailable additive method. |
| A3 / M3 | boundaries.test.ts: M3 accepts inclusive positive safe bounds [%s,%s] without inferring loss. bridge/tests/wall/u85/test_boundaries.py: test_M3_live_sanitizer_exception_emits_content_free_gap; test_M3_replay_sanitizer_exception_emits_content_free_gap; test_M3_live_adjacent_exclusions_emit_one_maximal_same_reason_gap; test_M3_replay_adjacent_exclusions_emit_one_maximal_same_reason_gap | Accept the positive safe-integer boundaries, signal sanitizer exceptions without revealing their messages, and require maximal same-reason intervals containing only excluded events. Dropping all frames, splitting a same-reason run, or coalescing across accepted events fails. |
| A4 / M4 | bridge/tests/wall/u85/test_boundaries.py: test_M4_live_failure_after_signalled_gap_retries_failed_event; test_M4_replay_failure_after_signalled_gap_retries_failed_event | After a successfully signalled gap, fail delivery of the following valid event. Suppress any crossing acknowledgement and retry the failed event from its preceding cursor. |
| A6 / M5 | boundaries.test.ts: M5 ignores malformed or obsolete terminal %s without consuming the replay; M5 requires hello membership before any gap or event can reach the page | Malformed or obsolete terminals leave the valid outstanding replay usable; duplicate terminals cannot complete it again. Reject pre-hello frames; the same room works after hello. Each negative gate has a positive witness. |
| A7 / M6 | hosting.test.ts: A7 live repair alone cannot replace a clean replay containing the excluded event; A7 a replay gap overlapping the tracked interval prevents a clean terminal | Live delivery alone is insufficient recovery. Accepted endpoint events cannot hide an overlapping replay gap. Complete replay plus a matching clean terminal must clear the notice. |
| A8 / amendment | hosting.test.ts: A8 real relay-extension-link-hosting %s gap preserves visible uncertainty and recovery cursor | Both reasons cross the real Python relay, production extension, AgentLink and hosted store/notice path. Only clocks, ports and external service boundaries are fake. Extension rejection is in scope after A-U85-1. |

Binding ambiguity resolutions:

- M3's sanitizer failure includes a returned failure value and a raised exception;
  either requires a content-free sanitize_failed gap.
- Recovery uses a replay beginning before all tracked faults, no overlapping
  replay gap, no ingestion/fold failure, and a matching clean terminal. Negative
  recovery cases report explicit gaps; no density of Lamport integers is assumed.
- A successful gap permits a transport cursor to advance through that gap.
  It cannot authorize advancing across the next failed event send or certify
  the page projection complete.
- Additional terminal tests retain the existing nonnegative-integer upto
  contract; they invent no new synchronization fields or notice APIs.


## Final amendment gates

The supplied final Amendment B-U85 supersedes the original integration HOLD:
specification status READY [CITED], production admission still unproven. The
extension forwarding prerequisite is inside U85. The complete gap frame keeps
`t`, `v`, `room`, `from_lamport`, `to_lamport`, `reason` and optional replay `rid`;
production routing rewrites the rid back to the requesting page's rid.

The earlier attempt is a partial oracle, with no supplied freeze receipt. Its
per-event/coalesced allowance is updated to Amendment B's maximal contiguous
same-reason run. Recovery negatives now explicitly report overlapping gaps,
rather than assuming that an absent Lamport integer proves incomplete replay.
All earlier acceptance cases remain mapped above. No new activity, snapshot,
composer, export or dispatcher semantics are introduced.

| Acceptance / MUST | Additional tests | Gate and negative contrast |
| --- | --- | --- |
| A3 / M3 | `bridge/tests/wall/u85/test_boundaries.py`: `test_M3_live_adjacent_different_reasons_remain_separate`; `test_M3_replay_adjacent_different_reasons_remain_separate` | Adjacent sanitizer/size exclusions remain separate because their reasons differ. Equal-reason adjacent exclusions use the maximal-run tests above. |
| A3 / M3 | `test_M3_live_sanitize_gap_has_no_event_op_or_evidence_payload`; `test_M3_replay_sanitize_gap_has_no_event_op_or_evidence_payload`; `test_M3_live_oversize_gap_has_no_event_op_or_evidence_payload`; `test_M3_replay_oversize_gap_has_no_event_op_or_evidence_payload` | Exact content-free gap shape. Excluded text, operation outcome, evidence path/hash and exception payload must never appear. Sanitizer-exception tests separately exclude exception details. |
| A6 / M5 | `tests/unit/u85/link.test.ts`: `A6 rejects %s without callbacks, cursor changes or HTML`; `tests/unit/u85/hosting.test.ts`: `A6 hostile gap frames do not create markup, change cursors or mutate another room` | Added missing fields and both bound endpoints, non-integer/nonpositive/unsafe bounds, and an unlisted private room. No callback, name rendering, history mutation, or cursor change. A valid listed-room fault is the positive witness. |
| A8 / M8 | `test_M8_native_host_send_preserves_live_and_replay_gap_fields` | The actual native host outbound sender writes the complete live/replay gap as length-prefixed JSON into an in-memory stream. Read-only inspection confirms RoomRelay receives that sender directly and it has no frame-type whitelist. This green boundary check does not replace the red production relay-extension-link-hosting gates. |
| A2 / M8 | `test_M8_hash_exemptions_are_structural_not_key_based` | Preserve template/evidence structural hashes while redacting the same hash in ordinary text, outcome, an unrelated nested sha256 field, and an evidence label. Broad key-based exemptions fail. |

## Verification

Run from the repository root. Disabling caches and using the runner config loader
keeps verification from writing generated configuration bundles into dependency
locations. U85's Python tests use stdlib unittest only.

```sh
npx vitest run tests/unit/u85 --no-cache --configLoader runner
python3 -m unittest discover -s bridge/tests/wall/u85 -t .
npx tsc --noEmit -p .
npx vitest run --project unit --exclude 'tests/unit/u85/**' --no-cache --configLoader runner
```

Fresh U85 results [MEASURED]:

```text
Test Files  4 failed (4)
     Tests  89 failed | 4 passed (93)
Ran 31 tests
FAILED (failures=23)
```

Across the complete oracle: 124 cases, 112 red and 12 green [MEASURED]. There are
no collection/import, fixture-driver, unexpected execution, timeout, or new
TypeScript diagnostics [MEASURED]. Failures expose missing U85 behavior; the
permitted production modules have no throwing U85 stubs, and no unspecified
notice export is invented to manufacture a stub-error result.

Existing TypeScript unit regression [MEASURED]:

```text
Test Files  296 passed (296)
     Tests  9360 passed | 2 skipped (9362)
```

Typecheck returns the same 16 pre-existing diagnostics byte-for-byte, with zero
diagnostics in U85 files [MEASURED]. The baseline count in the package is not
being substituted for this measured comparison.

Existing Python wall regression, excluding U85 [MEASURED]:

```text
Ran 137 tests
OK
```

An initial concurrent regression run failed the existing real-clock rate-window
assertion in `bridge.tests.wall.test_repair3.RateAtomicityTests.test_concurrent_processes_actual_appends_within_rate`.
The complete standalone rerun passed without a source change [MEASURED]. No
claim is made about a fresh run of unrelated Python areas.

Read-only preflight/final SHA-256 comparison confirms unchanged
`src/app/agent_store.ts`, `src/app/agent_link.ts`, `hosting/src/main.ts`,
`bridge/wall/room_relay.py`, `extension/src/agent_relay.ts` and
`bridge/wall/native_host.py` [MEASURED]. No production stub file was created.

Secret scanning returns zero findings [MEASURED]. Verification logs and temporary
files were removed from the publishable test directories.
