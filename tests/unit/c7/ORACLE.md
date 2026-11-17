# C7 browser oracle

The full M1–M7 acceptance-to-test map, ambiguity decisions, negative controls,
stop rules and out-of-scope cases are in
`bridge/tests/room/c7/ORACLE.md`. The shared vectors and journals are
`bridge/tests/room/c7/fixtures.json`; the bounded, read-only Python comparison
entry point is `bridge.tests.room.c7.probe`.

| Acceptance | Tests in this directory |
| --- | --- |
| M1 inventory evidence and existing result fields | `inventory.test.ts`: `m1_*`; real Python/browser parity includes an independent expected-evidence check |
| M2 decision schema, positive/negative boundaries, task/micro/result references | `decisions.test.ts`: `m2_shape_*`, positive twin, `m2_context_*`, missing-plan stop rule and the public type consumer |
| M3 Lamport decision history, newest entry, capped projection and full Python/TS parity | `decisions.test.ts`: `m3_history_*`, `m3_python_parity_*`, immutable prior-projection test and public type consumer |
| M4 MCP/CLI tool | Backend cases in `bridge/tests/room/c7/test_decisions.py`; no browser transport is invented |
| M5 integration Markdown | Backend cases in `bridge/tests/room/c7/test_results_export.py` |
| M6 badges, secondary summary text, accessible decisions, success fill, hostile payloads | `board.test.ts`: every `m6_*` case, including finished/failed verdict matrix and real journal-to-board propagation |
| M7 documentation loop | Backend documentation case in `bridge/tests/room/c7/test_results_export.py` |

All files use synthetic repository-relative evidence. Fake timers and blocked
network globals keep browser checks deterministic; no browser service is
started. Type-contract consumers are created only under `tests/unit/c7` and
removed in `finally`. No production file is rewritten to make the oracle pass.

Out of scope: C2/C6 inherited behavior except C7 evidence/display propagation;
C4 rotation; C8 templates; `result.link`/`result_link`; editing/deleting
decisions; expandable receipts and a filesystem integration artifact.

The oracle mandate is limited to `.unit/SPEC.md` and the supplied workspace corpus.
