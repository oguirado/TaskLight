# U123 fail-first oracle

Contract: `.unit/SPEC.md`, including its final Amendment B. Product surface:
`src/app/agent_store.ts`. No product or existing oracle files are changed.
The independent expectations and negative controls are frozen before any product
implementation. These tests use the real admitted event shapes and real reducers;
there are no production stubs, validator replacements, network calls or scheduled
delays. Freshness uses a fake wall clock.

## Acceptance mapping

Names below are the literal test names (parameterized names expand at runtime).

| Acceptance | Tests and evidence |
| --- | --- |
| A1 | `retention.test.ts`: `A1 default keeps all semantic operations and exactly the newest 5000 of 5001 heartbeats`; `A1 maxPerRoom:2 combines non-ops and exact activity.beat operations after every arrival`; `A1 default byte budget is 16 MiB and includes envelope and payload`; `A1 late and equal-Lamport arrivals select by compareEvents and preserve all semantic payloads`; `A1 rejected semantic operations remain pinned with identity, payload, evidence and order`. `storage.test.ts`: `A1 default storage retains at most 5000 recent raw objects after 5001 accepted heartbeats`; `A1/M6 small combined recent cap also bounds activity.beat objects held by replay caches`. The default retention fixture and its complete replay are checked independently of retained storage. |
| A2 | `replay.test.ts`: `A2 unchanged U85 owner heartbeat fixture rejects Bob with claimed_by_other`; `A2 takeover silence is strictly greater than 600000 ms (%s)`; `A2 release/reclaim fences stale micro writes and retires old live activity`; `A2 sibling supersession retires old runs but retired receipts still fence takeover`; `A2 beat receipts on another task protect the same owner's earlier task`. The U85 owner-heartbeat fixture values are reused exactly, and `tests/unit/u85/store.test.ts` is run unchanged. Timestamp regression tests distinguish maximum takeover activity from ordered legacy `lastSeen`. |
| A3 | `replay.test.ts`: `A3 deterministic shuffled multi-room history seed %s`; `A3 reversed delivery and late predecessors preserve archives, replay identities and diagnostics`; `A3 late semantic predecessors reclassify an already evicted rejected beat`; `A3 duplicate IDs keep the first payload across rooms after recent eviction`; `A3 explicit ownership/progress before close and successful cancellation/close/reopen`; `A3 changed resolver content with unchanged identity/hash refolds after activity compaction`; `A3 a late evicted non-op changes an earlier takeover receipt without advancing high-water`; `M2/M4 memory before plan, while closed and after reopen stays pinned under beat pressure`. `FullHistory` compares complete `plan(room)`, `plans()`, `states()` and `since()` after every arrival, including duplicates. Explicit expectations cover ownership, progress, replay identities, revisions, archived plans, memory, live/retired runs, `stale_rev`, `not_conformant`, `bad_op` and `claimed_by_other`. |
| A4 | `retention.test.ts`: `A4 oversized owner activity still fences takeover when recent display is empty`; `A4 exact suffix uses UTF-8 bytes for %s` (accented and four-byte text); `A4 nested operation evidence is exempt when pinned and full envelopes count when recent`; `A4 oversized non-op is accepted, updates activity, stays out of display and remains duplicate`; `A4 an oversized newest event empties the suffix rather than backfilling older small events`; `A4 both budgets apply independently per room after late arrivals`; `A4 invalid maxBytesPerRoom=%s throws RangeError`; `M3 legacy invalid maxPerRoom=%s still throws RangeError`. `storage.test.ts`: `A4/M6 byte-evicted raw envelopes are absent internally even after projection refresh`. Both budget validation tables contain zero, negative, fractional, NaN and Infinity inputs. |
| A5 | `ownership.test.ts`: `A5 own op.__proto__ and top-level prototype keys are invalid after %s pressure events`; `A5 originals, events, evidence, states, plans, templates and cursors are defensively owned after compaction`; `A5 recent originals and returned nested evidence remain defensive after pressure`; `A5/M7 torn JSONL tails and accepted/duplicate/malformed summary shape survive evicted IDs`; `M2 validation still delegates admission and rejects unsupported operation shapes`. Hostile JSON has otherwise-valid envelopes; top-level and operation-level `__proto__`, `constructor` and `prototype` keys are covered before and after pressure, including corrected-ID reuse and unchanged projections/cursors/prototype descriptors. |
| A6 | `negative-controls.test.ts`: `A6 display-only replay mutant fails the A2 ownership/receipt oracle`; `A6 returned-array-only mutant fails the same heap storage gate while bounded control passes`; `A6 byte-limit-disabled mutant fails the A4 UTF-8 envelope oracle`. These execute the faulty algorithms, observe their incorrect output or retained objects, and assert rejection by the independent gates. They do not merely assert that hypothetical mutants would fail. |
| A7 | `ownership.test.ts`: `A7 connected active work remains working at +90000 and unknown at +90001 before and after compaction`. Checks microtask and task derivations, independent replay, unchanged live-beat timestamps and cursors, and no ingestion between the freshness boundary reads. |
| A8 | Pending U132; out of scope. `agent.lifecycle` deployed/finished/failed admission is AUSENTE — no inventar. No passing lifecycle integration claim, mock admission or widened product surface. |

## MUST coverage and interpretation

- M1–M3: `retention.test.ts` and `storage.test.ts` require real payload eviction,
  semantic pinning and both recent budgets. Only exact `activity.beat` is unpinned.
  Successfully ingested but reducer-rejected semantic ops remain pinned.
- M4–M5: `oracle.ts` retains accepted full history exclusively on the reference side
  and calls `Plan.foldPlan` and `foldRoomWithStats` directly. It never calls the
  candidate's `events()` to rebuild projections. Ordered activity and takeover
  maxima intentionally have different timestamp-regression expectations.
- M6: late-predecessor and resolver-content tests warm the caches before invalidation;
  storage probes refresh `plan(room)` and `states()` before measuring.
- M7: hostile inputs, defensive copies, evicted-ID duplicates, torn tails and room
  high-water cursors are checked. Accepted oversized events have ordinary ingestion
  results. No retention error or cursor advance is introduced by compaction.
- M8: preserve existing suites as read-only inputs and check TypeScript diagnostics.
  No server, transport, model or error-code API is introduced.

The recent suffix is computed only over non-ops and exact beat ops sorted by
Lamport then ordinal event ID. An oversized newest event empties this suffix;
older small events are not backfilled. Pinned operations are then merged in sort
order, outside both budgets. Byte length is UTF-8 `JSON.stringify(event)` over the
entire envelope, including nested evidence. The optional future byte option is
passed using a structural test type so baseline failures are assertions rather
than import or type errors.

No implementation data structure is required. `retained-heap.ts` reads a GC heap
snapshot and counts live envelopes by fixture room and ID, after input objects and
returned event arrays leave scope. Shared references to the same object count
once; separate cache-held copies count separately. A bounded control calibrates
the probe and a hidden-history mutant demonstrates rejection. A separate test-owned marker locates the candidate's heap root; it neither modifies
the public store nor reads product-private fields. A frozen control also passes
probe calibration, so an extensible store object is not a precondition.
The probe reports pinned/recent JSON bytes and shallow bytes separately from
auxiliary exclusive retained bytes (objects disconnected from GC roots when the
marked store is removed, excluding raw payload subgraphs). Shared allocations are
excluded from exclusive bytes. This finite probe does not prove asymptotic metadata
complexity or claim bounded total-store memory.

## Hardening and stop rules

`wall-history-soak.mjs` is an offline, fixed-seed driver over 100,000 events [TARGET].
It hashes the exact JSONL fixture before measurement and records runtime and product
source hashes. It mixes semantic operations, non-op activity and beat supersession.
It reports pinned/recent payloads, auxiliary metadata, dedup ID counts/bytes, peak
RSS before heap instrumentation, post-GC heap, heap slope, and read/update latency.
The process heap slope explicitly includes measurement metadata; exclusive store
bytes are reported separately. Logical public replay receipt/state sizes are
reported separately from accepted-ID metadata. Allocation attribution between
implementation-private replay summaries and dedup structures is AUSENTE — no inventar;
these logical sizes are not additive to the measured exclusive auxiliary heap. No heap-slope threshold is invented:
AUSENTE — no inventar. Read measurements cover `plan`, `plans` and `states` together.

```sh
node --expose-gc --experimental-vm-modules tests/unit/u123/wall-history-soak.mjs --label baseline
node --expose-gc --experimental-vm-modules tests/unit/u123/wall-history-soak.mjs --label candidate --compare tests/unit/u123/soak-baseline.json
```

`hardening.test.ts` freezes the fixture SHA-256 and category counts and exercises
these literal test names without starting a benchmark or using real timers:

| Hardening requirement | Test |
| --- | --- |
| Fixed seed, fixture hash, semantic/non-op/beat pressure | `wall-history-soak freezes the 100000-event seed, fixture hash and mixed operation categories` |
| Quiet-window admission, including equality at the limit | `wall-history-soak refuses timing at unsafe or missing load5=%s` |
| Explicit GC admission | `wall-history-soak requires explicit GC and admits a quiet measurement only with GC` |
| Missing/contaminated timing and missing pair | `wall-history-soak marks missing or contaminated timing INCONCLUSIVE` |
| Semantic or retention violation takes precedence | `wall-history-soak semantic divergence and raw retention violations are BLOCK even with missing timing` |
| Same runtime/fixture and complete measured baseline/candidate | `wall-history-soak comparisons require measured baseline/candidate with identical fixture/runtime` |

The fixture SHA-256 is `f2781bacb8ea18a7ede6c70a402c466e439a1a8e6ba3ba0de79c7951b6545918`.
Run the second command after implementation under the same runtime and fixture.
The driver writes only JSON under this directory. Quiet-window admission is
checked again immediately before measurements begin. It refuses to start timing at
load5 >= 18 [TARGET], refuses measurements without explicit GC, and samples load at
checkpoints and at the end. Missing/contaminated timing or missing paired runs is
INCONCLUSIVE; semantic divergence or raw-retention violations are BLOCK. Timing is
observational, with no invented latency or heap-slope pass threshold. The reference
full history is constructed after memory/timing samples so it cannot masquerade as
candidate retention. Ordinary tests use smaller bounded fixtures and no timings.

U102 snapshot hydration, server journal compaction, dedup eviction, lifecycle
implementation, UI controls and new human-to-agent chat remain out of scope.
This mitigates MEM-1; it does not resolve it.

## Verification

- `npx vitest run tests/unit/u123 --no-cache`: baseline should be red exclusively
  through behavior assertions. Gate: retention/byte failures; negative contrast:
  preserved legacy replay assertions and the calibrated controls remain green.
- `npx vitest run tests/unit/u85/store.test.ts tests/unit/u113 --no-cache`: existing
  suites, unchanged. Their pre-existing failures are recorded rather than repaired. The isolated
  baseline already fails the shuffled-history rejection counts and the close-state
  expectation in `tests/unit/u113/replay.test.ts`; those files remain byte-identical.
- `npx tsc --noEmit -p .`: no added U123 diagnostics. Existing unrelated diagnostics
  do not become a clean global typecheck by omission.

## Interpretation and evidence limits

- A newest oversized recent event produces an empty contiguous suffix. Later small
  entries can form a new suffix; older small entries are never backfilled.
- Duplicate event IDs preserve the first admitted payload globally, even if a retry
  changes its room, Lamport or contents. Replayed `op_id` identities remain a separate
  reducer concern and are compared in full projections.
- Rejected-but-admitted beat operations are recent entries too. Late semantic
  predecessors can reclassify their receipts, so a final snapshot is insufficient.
- A8 is pending U132 and is not counted as a passing or failing executable case.
- Finite heap samples detect hidden raw history but do not prove asymptotic
  O(agents + seen_ids) auxiliary complexity. No total-store or heap-slope bound is claimed.
- The current product is the baseline. A post-implementation candidate does not yet
  exist, so the paired comparison remains INCONCLUSIVE.
- `verification.json` records measured assertion failures, negative controls, baseline
  regression failures, TypeScript diagnostics and protected-file hashes using only
  repository-relative paths. Test caching is disabled to keep writes within this directory.

## Measured baseline results

| Gate | Result |
| --- | --- |
| U123 executable oracle | `Test Files  4 failed | 2 passed (6)`; `Tests  22 failed | 39 passed (61)` [MEASURED]. All failures are missing recent retention or byte-budget assertions. |
| Negative controls | Display-only replay, hidden raw history, and disabled byte-limit mutants all REJECTED [MEASURED]. |
| Existing U85/U113 regressions | `Test Files  1 failed | 4 passed (5)`; `Tests  4 failed | 56 passed (60)` [MEASURED]. Same pre-existing U113 failures before and after oracle edits; protected files are byte-identical. |
| TypeScript | No diagnostics in `tests/unit/u123/`; 16 unrelated pre-existing diagnostics remain [MEASURED]. |
| Hardening baseline | Semantic PASS, retention BLOCK, timing MEASURED over 100,000 accepted events [MEASURED]. Recent raw envelopes: 99,991 against the 5,000 cap [MEASURED]. Candidate comparison INCONCLUSIVE until implementation. |

Detailed relative-path results and protected-file hashes are in `verification.json`;
physical and logical storage accounting is in `soak-baseline.json`.
