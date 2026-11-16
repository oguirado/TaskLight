# U67 fail-first oracle

Status: R27 W3. Scope: the U67 plan-band repair in `.unit/SPEC.md`.
Evidence cited by the spec: Capsule C2; `strategy/R27/W1_D4_plan_pipeline.md`.
Runtime receipts from those investigations are not included in this workspace spec.

## Acceptance mapping

| Case | Test names in `oracle.test.ts` unless stated otherwise |
| --- | --- |
| A1 | `A1 fixture is six valid MCP-shaped operations without an opening phase`; `A1 starter resolver selects discovery and all ordered phase labels and exits` |
| A2 | `A2 no resolver retains the band and skips the empty opening phase` |
| A3 | `A3 wrong resolved hash falls back to untemplated folding and preserves the band` |
| A4 | `A4 throwing resolver cannot escape plan or wall and uses the untemplated projection` |
| A5 | `A5 independent JSON hashes equal bridge.plan.template canonical hashes`; `M2 A5 %s returns the entire bundled JSON with its real canonical hash`; `A5 %s refuses an incorrect hash`; `A5 unknown or hostile id %j is unresolved` |

## MUST mapping

| Requirement | Additional coverage |
| --- | --- |
| M1 | `M1 passes the pinned id and hash to the supplied resolver`; `M1 resolves the latest opening in event order despite reversed arrival`; `M1 resolves room pins independently`; `M1 unresolved template falls back without dropping the band`; `M1 a resolved template without a hash cannot authorize templated folding`; A3 and A4 |
| M2 | All bundled starter JSON objects compared with `hash` added; unknown ids and mismatches rejected; `hosted.test.ts`: `M2 hosted entry passes a working pinned starter resolver to its actual store` |
| M3 | `M3 uses resolved template order and literal labels and exits rather than capitalized ids`; `M3 hostile plan phase %j is skipped without dropping valid task phases`; A2 |
| M4 | `M4 A1 full store projection equals Python fold with the same pinned template` |
| M5 | `M5 empty store keeps the existing no-plan behavior`; existing unit suites and TypeScript diagnostic baseline checked separately |

## Interpretation and bounds

The complete workspace spec has no Amendment sections. A1 does not specify the
extra operations needed to make six events: `bridge/room/mcp.py` emits one
`plan.open`, three `task.add`, and two `task.set` events for a three-task chain
with two dependencies. This oracle uses that valid public event shape, including
resolved ids and revisions, without opening `phase` or transport batch metadata.
Tasks embed microtasks as the real tool does. The fixture gate asserts every
operation applies with no rejection, so malformed test data cannot manufacture
a missing-template failure.

A5's hash is derived from `templates/planning/*.json` at test time using sorted,
compact UTF-8 JSON excluding the root `hash`, matching
`bridge/plan/template.py:canonical_template_json`. A separate assertion checks
all derived hashes against that Python module. M4 compares the entire projection
against `bridge/plan/fold.py:fold_plan` on identical events and template, rather
than replacing parity with a single phase assertion. Python runs with bytecode
writes disabled and a bounded subprocess timeout and output cap.

Missing additive exports/options use namespace probes and structural option
types: a missing implementation produces assertion failures, never import or
TypeScript errors. Hostile phase values are supplied directly to the public wall
projection boundary; malformed events need not be admitted by the store.
Template label propagation is tested through the store and wall without pinning
any extra metadata property or internal transport between them.

The tests use fixed timestamps, no network, fake hosted timers and ports, and
no advancing real timers. Hosted mocks are removed and observers disconnected.
No production code, existing tests, or fixtures are modified.

## Out of scope and stop rules

The U58 batch-metadata redaction issue, room announcement race, replay
continuation, event-retention checkpoints, custom-template delivery, entirely
unwritten Memory sections, demo expansion, Firebase setup and deployment belong
to other units. They are not U67 oracle failures. The older strategy's unrelated
post-hackathon U67 decomposition-assist identifier does not replace this spec.

Stop on import/setup failures, invalid six-event fixture data, Python reference
failure, or new TypeScript diagnostics in these files: those cannot count as
fail-first success. Preserve existing suite results. Compare TypeScript output
with its pre-write baseline; unrelated existing errors are not U67 regressions.
No commit, push, deploy, real ports, external services, or production edits.

## Verification

Observed U67 summary [MEASURED]:

```text
 Test Files  2 failed (2)
      Tests  31 failed | 3 passed (34)
```

Every failed test reports an assertion failure [MEASURED]. The passing controls
validate the six-event fixture, independent canonical hashes against Python,
and preserved empty-store behavior. No missing import is used as an oracle.

Existing suites run separately with U67 excluded [MEASURED]:

```text
 Test Files  1 failed | 273 passed (274)
      Tests  1 failed | 9077 passed | 1 skipped (9079)
```

The unrelated `tests/unit/zz_r27probe/probe.test.ts` fails because `R27_EVENTS`
is unset when it calls `readFileSync`; this is an external probe prerequisite,
not a U67 regression. The u60, u61, u62 and u64 suites passed in that run.
TypeScript reports the same 16 pre-existing diagnostics [MEASURED], with output
byte-identical to the pre-write baseline and no diagnostic in `tests/unit/u67`.
