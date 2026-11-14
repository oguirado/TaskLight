# U12 oracle (ledger.test.ts, governor.test.ts, helpers.ts)

Run against stubs in `src/perf/`: ledger 11 tests / 9 RED; governor 30 tests / 28 RED (combined with U11: 82 RED, 5 green of 87). Green-vs-stub tests are baseline defaults only (capacity, empty stats, T0 policy, initial T0/0 transitions, valid template).

| Case | Spec rule |
|---|---|
| O10 p95 nearest-rank fixture 1000..100000 (p50 50000, p95 95000, max, overCeiling 89), unsorted input, n=20 and n=1 | B13, O10 |
| ring wrap, lastN newest-first, clamp to capacity, default lastN 120 | B12, B13 |
| strict ceiling boundary 11100 / 11101 | B13 |
| endFrame records now-start; clock skew records 0 without throw | B14, S4 |
| tier table T0..T3 incl. effects/interpolate; `>>` with floor 1 | B15 |
| O11 (a) 119 frames T0, 120 -> T1 (4 patches, effects off); clamp T3 with 3 transitions; (b) 3900 us stays T0; 4000 exact is not over; <60 frames no eval | B16, B17, O11 |
| O12 alternating 4400/3600 windows: after a drop no further transitions, never T0; from T0 zero transitions; band resets streak | B20, O12 |
| O13 T1 at 3rd, T0 at 4th qualifying eval; exactly 2000 does not qualify; one step per upgrade | B19, O13 |
| O14 two spikes -> immediate T1; one spike stays; 11100 not a hit; counter resets after drop | B18, O14 |
| O15 override pins T3, resume needs full streak; override suspends degrade and spikes; initial override; invalid ignored | B21, O15 |

## Ambiguities / AUSENTE (assumptions encoded)
- `createLedger(capacity)` has no budget parameter, yet `overBudget` needs one: tests assume 4 ms default (AMBIGUITY, one isolated test).
- Default `lastN` of `stats()` assumed 120 (windowFrames) at ledger level; ledger does not know cfg.
- O12 spec text ("transitions <= 1, never returns to T0") needs a prior drop; the test makes the drop explicit and uses `windowFrames = evalEveryFrames = 60` so each evaluation sees one non-overlapping window. With the default overlapping 120-frame window, block-alternation semantics are implementation-dependent (AUSENTE).
- O13/O15 also use the 60/60 config for the same reason.
- Whether streaks reset on a tier change is unspecified; tests avoid depending on it (clamp test only checks final state).
- Whether `override` pinning counts in `transitions()` is AUSENTE: not asserted.
- `FrameRecord.applied/deferred/startUs` are not observable via `PaintLedger` (no getter): untested.

## Repair loop 1
Added `repair1.test.ts` (9 tests; 5 fail on the current impl). Covers: B14 unpaired `endFrame` records 0; non-finite/negative ledger capacity never yields NaN stats; B13 `overBudget` follows `GovernorConfig.frameJsBudgetMs` (tested through `gov.ledger`).
Rejected: optional `createLedger(capacity, budgetUs)` parameter (spec signature is `createLedger(capacity)`; budget is asserted via governor config instead); `windowFrames > 256` truncation (B12 fixes capacity at 256, so clamping is spec-conformant); FrameRecord field retention (`LedgerStats` exposes no such field, not observable).

## Repair loop 2
Added `repair2.test.ts` (Hydrogen r1 HOLD). Covers: B13 `overCeiling` follows `GovernorConfig.ceilingMs` via `gov.ledger` (spec states `ceilingMs` is configurable, B18 uses it; the literal 11100 in B13 equals the default); `maxUs` initialised from the first element (negative `jsUs` not floored to 0); B16 evaluation runs every `evalEveryFrames` even when `windowFrames < evalEveryFrames`.
Rejected: optional `createLedger(capacity, ceilingUs)` parameter (spec signature is `createLedger(capacity)`, consistent with loop 1 budget ruling; ceiling asserted through the governor); `jsUs >= 2**31` Int32 overflow (spec sets no range; microsecond frame cost of 35 min is outside the contract).
