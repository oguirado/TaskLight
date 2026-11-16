# U55 fail-first oracle

Source: `.unit/SPEC.md`, including binding Amendment W0-R. Only the isolated workspace is used. Production U55 functions are stubs; tests use public interfaces, explicit JSON-shaped builders, fixed event timestamps, and bounded histories. No network, ports, sleeps, or timers are used by the new tests. Loader fixtures are real files under `fixtures/plan`; no assumption about `open` versus `Path` is imposed.

## Acceptance map

Numbered cases refer to SPEC §5. Generated method suffixes identify independent hostile inputs; no subtest count inflation is used.

| Acceptance | Test module | Test names / fixture cases |
|---|---|---|
| 1 / T1 | `bridge/tests/plan/test_u55_template.py` | `test_T1_load_validate_canonical_hash`, `test_T1_resolve_missing`, `test_T1_load_invalid_json`, `test_T1_load_missing_file` |
| 2 / T2 | same | `test_T2_*` (boolean/non-finite integer fields, unknown nested keys, flags, version, dangerous keys) |
| 3 / T3 | same | `test_T3_string_*` (every string position, each control/code-like payload) |
| 4 / T4 | same | `test_T4_*` (collection/text bounds, uniqueness, reversed bounds) |
| 5 / T5 | same | `test_T5_schema_json_and_neutrality` |
| 6 / O1 | `bridge/tests/plan/test_u55_ops_fold.py` | `test_O1_all_ten_ops`, `test_derived_*`, `test_dependency_readiness`, `test_shape_valid_*` |
| 7 / O2 | same | `test_O2_*`, `test_O2_error_class_*`; actual reducer errors plus public error code preservation |
| 8 / O3 | same | `test_O3_self_cycle`, `test_O3_two_cycle`, `test_O3_three_cycle`, `test_O3_over_eight_deps`, `test_O3_task_add_self_cycle`; vectors `self_cycle`, `cycle_2`, `cycle_3`, `limit_deps` |
| 9 / O4 | same | `test_O4_*`, `test_shape_rev_*`, `test_shape_over_*`, `test_shape_evidence_*`; vectors `task_capacity`, `micro_capacity` |
| 10 / O5 | same | `test_O5_replay_agent_scope_and_first_result`, `test_replay_history_survives_reopen`, `test_last_lamport_includes_replay_and_rejection` |
| 11 / O6 | same | `test_O6_takeover_claim_boundary`, `test_O6_takeover_legacy_room_activity`, `test_O6_explicit_activity_context`; vectors `takeover_600000`, `takeover_600001` |
| 12 / O7 | same | `test_O7_*`; vectors `memory_before_plan`, `claimed_by_other` |
| 13 / O8 | same | `test_O8_*`, `test_hostile_*`, `test_lifecycle_archive_memory_and_cancelled_ids`, `test_closed_plan_rejects_*`, `test_optional_revisions`, `test_invalid_phase_transition`; vectors `reject_then_continue`, `duplicate_event_id`, `reopen_preserves_memory` |
| 14 / C1 | `bridge/tests/plan/test_u55_conformance_md.py` | `test_C1_*`: independent missing/invalid requirements, bounds, positive conformance, evidence, finding shape/determinism/purity |
| 15 / C2 | same | `test_C2_*`: empty exports, closed plan, pre-plan memory, control sanitization, determinism |
| 16 / V1 | `bridge/tests/plan/test_u55_vectors.py` | `test_V1_<case.id>` for every case in `fixtures/plan/vectors.v1.json`; exact projection and rejection equality |

## Resolutions and explicit gaps

- Amendment W0-R overrides the base spec: optional revision checks, `micro_id`, nested operation evidence, null handling, compact JSON replay keys, closed-plan restrictions, fresh per-plan IDs, retained archives/memory/replay history, ordinal event ordering, duplicate event-ID suppression, and prior legacy room activity are tested.
- `apply_op_event` adds the explicitly amended optional keyword `last_by_agent=None`. Constants and regexes are literal spec declarations, not executable implementation. Every new production function/method body is exactly `raise NotImplementedError("U55 stub")`.
- Canonical template fixture hashes use sorted compact UTF-8 JSON without `hash`; public tests additionally verify key-order independence and the hash/canonicalizer relationship. All optional template shape fields are supplied, so omitted-field normalization is not invented.
- Timestamp boundary source: `src/app/agent_store.ts` defines `TS_MAX_ABS = 8.64e15` [CITED]. Safe integer rejection follows Amendment W0-R. String lengths count code points; operation byte caps use compact UTF-8 JSON. Only explicit collection/payload overflows assert `limit_exceeded`; malformed scalar ranges assert `bad_op`.
- T5: `schemas/planning-template.v1.schema.json` is not created: the user excludes that path from writes. Test first gates on valid-template processing, then requires the schema and inspects metadata/neutrality. The future schema check cannot pass until the implementation supplies it. This is an explicit prerequisite, not a skip or a fake schema.
- V1 limitation: the accepted operation result-summary fields are AUSENTE — no inventar. Exact vectors therefore avoid nonempty `replayed_ops`; replay behavior and first-result identity are tested directly without inventing result keys. Duplicate event-ID suppression has an exact vector. Complete replay-result parity needs that upstream contract frozen.
- Conformance finding code vocabulary, path syntax, message text, and ordering across *different* failures are AUSENTE — no inventar. Tests enforce the specified envelope, nonempty diagnostics, deterministic repeat ordering and independent conditions; they do not prescribe invented diagnostic strings. Full finding-code golden vectors need the missing contract.
- `not_conformant` rejection belongs to strict composite creation in U56 `post_ops(room, agent, ops, *, strict=False, home=None, clock=None)` (Amendment W0-R), not U55 `fold_plan`. The error class preserves `not_conformant`, and C1 checks non-conformance. The strict composite rejection oracle is external to U55 and is not fabricated or skipped as a reducer case. Acceptance V1 cannot literally cover that rejection on the U55-only API.
- No Markdown layout, progress rounding at fractional percentages, task-release claim-history clearing policy, unknown-memory-section policy, or unspecified result summary is frozen. Vectors use only unambiguous defaults and exact half/full progress.

## Execution and gates

Run from `the repository root`:

```sh
cd the repository root && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/plan -t the repository root
```

Gate: each new test must error with `NotImplementedError: U55 stub`; contrast: import errors, fixture errors, assertion failures or missing tests invalidate the fail-first receipt. Existing suites must remain green; contrast: any regression blocks claiming compatibility. Fixture expectations are hand-authored independently of production reducer code.

## Verification receipt

New oracle: 519 tests [MEASURED], 519 red stub errors [MEASURED], 0 green [MEASURED], no unrelated exceptions or assertion failures [MEASURED]. Exact unittest summary:

```text
Ran 519 tests in 0.038s

FAILED (errors=519)
```

Every error ends `NotImplementedError: U55 stub` [MEASURED]. All production function/method bodies were checked structurally using stdlib `ast` and have exactly that raise [MEASURED]. Shared fixture count: 36 cases [MEASURED]; identifiers are unique and rejection arrays match the expected projections [MEASURED].

Existing suites were each run with `python3 -B -m unittest discover -s <absolute directory> -t the repository root`, from the required workspace. `PYTHONDONTWRITEBYTECODE=1` and `TMPDIR=fixtures/plan` were supplied. Regression total: 775 green tests [MEASURED], no red tests [MEASURED]. Exact per-suite summaries:

| Existing test directory | Exact run line [MEASURED] | Exact result |
|---|---|---|
| `bridge/tests/ctx` | `Ran 154 tests in 4.711s` | `OK` |
| `bridge/tests/models` | `Ran 176 tests in 36.372s` | `OK` |
| `bridge/tests/room` | `Ran 130 tests in 29.385s` | `OK` |
| `bridge/tests/viewpoint` | `Ran 87 tests in 4.635s` | `OK` |
| `bridge/tests/wall` | `Ran 109 tests in 44.516s` | `OK` |
| `bridge/tests/wall_host_room` | `Ran 40 tests in 12.732s` | `OK` |
| `bridge/tests/wall_room` | `Ran 79 tests in 0.357s` | `OK` |

These receipts establish fail-first behavior and existing-suite compatibility; they do not establish U55 implementation conformance. Full replay-result golden vectors, named finding-code vectors and U56 strict composite rejection remain blocked by the explicit contract/surface gaps above.
