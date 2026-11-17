# U113 verification receipt

Only files under `tests/unit/u113/` were authored. No production or existing
test file was edited. No network, ports or real timers are used by this oracle.

## Candidate run

Command: `npx vitest run tests/unit/u113 --no-cache --reporter=verbose --silent=false`.
The cache flag suppresses runner disk caches; it does not change AgentStore
behavior. Exit status: `1` [MEASURED]. Captured summary [MEASURED]:

```text
 Test Files  3 failed | 1 passed (4)
      Tests  10 failed | 35 passed (45)
```

All failures below are `AssertionError` failures [MEASURED]. There are no
import, collection or setup failures. The stable-outcome and replacement tests
show repeated full plan/agent folds and history sorts. The dedicated hit tests
pin these violations separately and after an accepted update. The final
failure shows a returned template alias changing subsequent reads.

- `|unit| tests/unit/u113/hits.test.ts > A6 cache hit work > A6 repeated plan reads do not call the full plan fold 14ms`
- `|unit| tests/unit/u113/hits.test.ts > A6 cache hit work > A6 repeated states reads do not call the full agent fold 2ms`
- `|unit| tests/unit/u113/hits.test.ts > A6 cache hit work > A6 warm public reads do not sort event history again 2ms`
- `|unit| tests/unit/u113/hits.test.ts > A6 cache hit work > A6 an accepted update is visible before the next hit of both projections 4ms`
- `|unit| tests/unit/u113/freshness.test.ts > A3 normalized resolver freshness > A3 stable matching outcome still calls resolver and reuses both projections 16ms`
- `|unit| tests/unit/u113/freshness.test.ts > A3 normalized resolver freshness > A3 stable missing outcome still calls resolver and reuses both projections 9ms`
- `|unit| tests/unit/u113/freshness.test.ts > A3 normalized resolver freshness > A3 stable threw outcome still calls resolver and reuses both projections 3ms`
- `|unit| tests/unit/u113/freshness.test.ts > A3 normalized resolver freshness > A3 stable mismatch outcome still calls resolver and reuses both projections 3ms`
- `|unit| tests/unit/u113/freshness.test.ts > A3 normalized resolver freshness > A3 equal template snapshots with different object identity reuse projection work 3ms`
- `|unit| tests/unit/u113/replay.test.ts > A5 hostile inputs and defensive ownership > A5 returned template mutation is isolated 7ms`

Correctness gate: **BLOCK** until the missing U113 behavior is implemented.
The green replay cases pin required preserved behavior.

## Assertion-only negative controls

Both controls are **DETECTED** [MEASURED]. `negative-control-receipts.json`
contains captured assertion names/messages from this run. Each test verifies
that the unmutated public store produces the required result before testing
the deliberately broken wrapper. Only `AssertionError` counts as detection.

## Existing regression

Command: `npx vitest run tests/unit/u85/store.test.ts --no-cache`.
Exit status: `0` [MEASURED]. Captured summary [MEASURED]:

```text
 Test Files  1 passed (1)
      Tests  15 passed (15)
```

The unchanged retention and takeover tests pass, including the
`claimed_by_other` expectation. Other existing suites were not run.

## Typecheck

Command: `npx tsc --noEmit -p .`.
The project has pre-existing diagnostics outside this unit. For comparison,
the same command was also run against a temporary extending config that
excluded only `tests/unit/u113/`; the config was removed afterward.
The diagnostic output was byte-for-byte identical [MEASURED]:

```json
{
  "baselineExit": 1,
  "withOracleExit": 1,
  "baselineDiagnostics": 16,
  "withOracleDiagnostics": 16,
  "identical": true,
  "oracleDiagnostics": 0
}
```

Existing diagnostic locations and codes [MEASURED]:

| File | Code |
| --- | --- |
| `src/ai/config.ts` | `TS7053` |
| `src/ai/hybrid.ts` | `TS7053` |
| `src/ai/parity.ts` | `TS7053` |
| `src/prompts/templates.ts` | `TS2741` |
| `tests/unit/u07/build.test.ts` | `TS2345` |
| `tests/unit/u07/versions.test.ts` | `TS2741` |
| `tests/unit/u11/repair1.test.ts` | `TS2352` |
| `tests/unit/u11/repair2.test.ts` | `TS2375` |
| `tests/unit/u14/harness.ts` | `TS2345` |
| `tests/unit/u36/archive-source.test.ts` | `TS7053` |

## Dependency gates

U114 regression: **INCONCLUSIVE**; the unchanged regression pack is absent.
Its readiness and `load5 < 18` [TARGET] gates remain prerequisites.

U115 `wall-plan-cache`: **INCONCLUSIVE**; paired baseline and required telemetry
are AUSENTE — no inventar. No benchmark was launched. No p50/p95/p99 or peak RSS
claim is inferred from unit runtime. At `load5 >= 18` [TARGET], do not start;
a baseline taken there is INCONCLUSIVE. Missing telemetry cannot pass a gate.

U132 lifecycle and U123 compaction: **OUT OF SCOPE**.
