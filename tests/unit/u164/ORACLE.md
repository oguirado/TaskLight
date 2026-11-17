# U164 TypeScript parity oracle

The full M1-M9 acceptance map, interpretations, stop rules, negative controls and
measured verification are in `bridge/tests/room/u164/ORACLE.md`.

| Spec case | Test ownership |
| --- | --- |
| M1 | Python `test_admission.py` and `test_transports.py`; browser admission is not changed. |
| M2 | Python admission/transport cases; all `M8 <case>` tests share the evidence-content fixtures. |
| M3 | Python clear, retype, unblock and uncancel cases. |
| M4 | Python missing/corrupt template and public completion cases. |
| M5 | Python journal/projection invariance, lock-interleaving and receipt-replay cases. |
| M6 | `M6 historical evidence-free completion preserves fold, progress and receipts`. |
| M7 | `M8 optional_completed` and `M8 optional_with_blank_records`, plus Python optional-write cases. |
| M8 | Every `M8 <case>` in `parity.test.ts`, plus `M8 incremental applyOp accepts every historical event`. |
| M9 | Python `PublishedContractOracle` version and document tests. |

`evidence_cases.json` is consumed by both Python and TypeScript. Each entry names
the expected missing-evidence paths; no production conformance implementation is
used as the expected-value generator. History contains existing evidence-free
completions and must remain foldable without rejection. Diagnostic-only snapshots
exercise both the parent and micro completion guards, including hostile blank
values, without weakening operation validation.

Measured fail-first result: `Tests  8 failed | 10 passed (18)` [MEASURED].
Failures are diagnostic assertions; import errors are absent. The two historical
fold/apply controls pass [MEASURED]. Restoring pre-U164 diagnostic scope or counting
blank evidence must fail these tests; adding rejection to the browser reducer
must fail the historical controls.

U163 redaction, U161 recovery, D4 and GUI/deployment work are out of scope.
No such behavior is reported as a U164 test failure. The oracle is scoped to the
supplied U164 specification and its existing repository interfaces.
