# C6 browser result-shape oracle

Source: `.unit/SPEC.md`; the full acceptance and ambiguity map is `bridge/tests/room/c6/ORACLE.md`.

| Acceptance | Tests |
| --- | --- |
| M1: browser accepts valid terminal results, including every verdict and exact bounds | `result_shape.test.ts` cases `m1_shape_*`, sharing `bridge/tests/room/c6/result_cases.json` with the Python admission oracle |
| M1: wrong types, missing verdict (A-C6b), unknown keys, oversize values, hostile nested objects and results on nonterminal states are rejected | Invalid shared `m1_shape_*` vectors and `m1_unknown_key_negative_control_has_valid_positive_twin` |
| M1: the existing public type accepts the optional field | `m1_existing_AgentLifecycleOp_type_accepts_optional_results`; a bounded local compiler checks a temporary consumer, emits nothing, and removes the consumer in `finally` |
| M1: preserved legacy browser validation | `m1_legacy_deployed_without_result_still_valid`, `m1_legacy_alive_without_result_still_valid`, `m1_legacy_finished_without_result_still_valid`, `m1_legacy_failed_without_result_still_valid` |
| M2 | Python `SupervisorOracle.test_m2_*`; subprocess supervision is outside the browser shape surface |
| M3 | Python `WaitOracle.test_m3_*`; tool waiting is outside the browser shape surface |
| M4 | Python `WaitOracle.test_m4_*`; cursor delivery is outside the browser shape surface |
| M5 | Python `WaitOracle.test_m5_*`; MCP/CLI output sanitation is outside the browser shape surface |
| M6 | Python `ResultOracle.test_m6_*`; no browser inventory/result rendering change is specified for C6 |
| M7 | Python `DocumentationOracle.test_m7_*`; guide verification is outside the browser shape surface |

Shared fixtures use repository-relative receipt and evidence pointers and only synthetic text. Character limits follow the existing code-point convention; both hex letter cases are accepted. An absent `result` stays valid. A-C6b: a present result requires only `verdict`; `summary`, `receipt` and `evidence` are optional and validated when present. Browser rejection uses its existing error vocabulary rather than importing Python's `bad_args` into an unrelated TypeScript error union. Tests invoke no network and depend on no real-time waiting. Missing behavior produces assertions, never an import of the future waiter module.

The positive twin prevents a reject-all validator from satisfying the unknown-key negative control. Product code is unchanged; there are no stubs.

```sh
node_modules/.bin/vitest run --project unit --no-cache tests/unit/c6/result_shape.test.ts
```
