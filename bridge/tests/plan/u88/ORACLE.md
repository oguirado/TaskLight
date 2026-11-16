# U88 fail-first dependency oracle

Status: R30; Q1 approved. Amendment A-U88-1 permits freezing this oracle before
U90; implementation remains serial after U90 in lane A4. No product file is
modified. Expectations are fixed independently of either reducer.

## Acceptance map

Python names below belong to `DependencyOracle` in
`bridge/tests/plan/u88/test_dependencies.py`, except scheduling names, which
belong to `NextWorkOracle` in `bridge/tests/plan/u88/test_next_work.py`.
TS names belong to `tests/unit/u88/dependencies.test.ts`.

| Case | Python tests | TypeScript tests |
| --- | --- | --- |
| A1 | `test_A1_derived_done`, `test_A1_derived_cancelled`, `test_A1_derived_pending`, `test_A1_derived_active`, `test_A1_derived_blocked`, `test_A1_derived_missing`; `test_A1_done_fold`, `test_A1_cancelled_fold`, `test_A1_pending_fold`, `test_A1_active_fold`, `test_A1_blocked_fold` | `A1 isTaskReady prerequisite %s -> %s` for done, cancelled, pending, active, blocked, missing; the matching `A1_* event fold and incremental application` vectors |
| A2 | `test_A2_incremental_cancellation_recomputes_immediately`, `test_A2_clear_override_recomputes_from_pending_with_latest_revision`, `test_A2_reversed_fold`, `test_A2_op_id_replay_preserves_cancellation_without_extra_revision` | `A2 cancellation immediately recomputes downstream readiness`, `A2 clearing with latest revision restores pending and not-ready dependant`, `A2_reversed event fold and incremental application`, `A2 op_id replay preserves cancellation without an extra task revision` |
| A3 | `test_A3_conjunction_wait_fold`, `test_A3_conjunction_done_fold`, `test_A3_conjunction_cancelled_fold`, `test_A3_chain_fold`, plus their corresponding `test_A3_*_reversed_array` tests | `A3_conjunction_wait`, `A3_conjunction_done`, `A3_conjunction_cancelled`, `A3_chain` in `event fold and incremental application` and `A3 reversed task-array order: %s` |
| A4 | `test_A4_cancellation_preserves_microdata_ownership_revisions_and_progress`, `test_A4_terminal_dependants_and_empty_dependencies`, `test_A4_terminal_done_fold`, `test_A4_terminal_cancelled_fold`, `test_A4_unlocking_never_activates_or_manufactures_liveness`, `test_A4_cancellation_appends_only_the_requested_event` | `A4 preserves microdata, ownership, revisions and completion progress`, `A4 terminal helper guard: %s`, terminal fold vectors, `A4 pending tasks with empty dependencies stay ready`, `A4 unlocking never activates microtasks or manufactures liveness` |
| A5 | `test_A5_cancellation_exposes_exactly_the_dependant_microtask`, `test_A5_blocked_dependant_is_excluded_after_cancellation`, `test_A5_other_owned_dependant_is_excluded_after_cancellation` | Python owns the real MCP server path; no TS server substitute |
| A6 | `test_A6_missing_dependency`, `test_A6_self_dependency`, `test_A6_forged_state`, `test_A6_stale_revision`, `test_A6_missing_task`, `test_A6_transitive_cycle` | `A6 missing dependency -> not_found`, `A6 self dependency -> dep_cycle`, `A6 forged state -> bad_op`, `A6 stale revision -> stale_rev`, `A6 missing task -> not_found`, `A6 transitive cycle -> dep_cycle` |
| A7 | U90 beat/liveness projection is OUT OF SCOPE for this pre-U90 oracle; no missing-module imports or stubs. The A4 unlocking test already guards pending microstate and absent liveness. | `activity.beat`, `activity_beat`, `deriveActivity` and the beat-preservation regression await U90. The A4 unlocking test already guards pending microstate and absent liveness. |
| A8 | The frozen A1 tests reject the done-only and always-ready in-memory controls described below. | The frozen helper and full-fold A1 tests independently reject the done-only and always-ready in-memory controls described below. |

## MUST coverage and interpretation

| Requirement | Verification |
| --- | --- |
| M1 | A1 truth table, A3 conjunction/chain and reversed arrays, A4 terminal/empty-dependency guards |
| M2 | A2 immediate incremental projection, fresh replay equality, reversal using current task revision and optional operation id; A6 rejection invariants |
| M3 | A5 real `tools/call` dispatcher and `next_work`; `test_M3_cancellation_exposes_active_dependant_microtasks`, `test_M3_owned_before_free_order_limits_and_active_microtasks`, `test_M3_dependency_depth_precedes_task_id_order` |
| M4 | A4 compares full microtask data, ownership and revisions; exact completion/progress preservation; persisted cancellation appends only the requested `task.set` |
| M5 | Pending microstate and absent `live` guarded now. U90 activity projection/`deriveActivity` is deferred as A7, without treating absent code as a U88 failure. |
| M6 | Identical `tests/unit/u88/cases.json` vectors feed both languages. `M6 Python and TS canonical task states, readiness and rollups agree` invokes the actual Python fold, compares projections, then checks fixed expectations so agreement on the old bug cannot pass. |

Task states `done` and `active` are produced through valid `micro.set` events;
`task.set` only uses its supported explicit overrides. A missing prerequisite is
tested directly in `_derived` and `isTaskReady`; valid events cannot install a
dangling dependency, so A6 separately verifies that both folds reject it.
Conjunction prerequisites are independent; the chain vector separately tests
that readiness is not transitive completion. Existing blocked-task readiness is
preserved, while the scheduler must exclude blocked tasks.

The real MCP calls use an isolated temporary `CW_HOME` inside the test directory
and a fixed clock. They exercise the full `{"untrusted": {"items": [...]}}`
payload. No socket, network service, timer, sleep, or extension stub is needed.
The cross-language subprocess has bounded input, output and a process deadline.

Other excluded work: UI rendering, `src/app/agent_store.ts` dependency mapping,
scheduling admission/fencing, plan generation, tool schema changes and
cancellation authority. A7 remains an implementation integration gate after U90;
this oracle does not claim that gate passed.

## Frozen expectations and negative controls

The shared expected fixture was frozen before mutation checks:

`tests/unit/u88/cases.json` SHA-256:
`329d360e91648d9f1a179ee270362e7ffd97796e878ddfc69b0d24a61a0381db`.

Controls alter only loaded Python functions or Vite-transformed module strings.
Python's candidate changes only the prerequisite comparison. TS starts from
both comparisons accepting done/cancelled, then restores done-only behavior in
each function independently. Always-ready controls force the selected function
to return readiness regardless of prerequisites. Oracle assertions and fixture
expectations remain unchanged; scratch control files are removed and no mutant
or product edit is retained. Persistent module caching is disabled for TS
controls so one transformed module cannot mask another control.

| In-memory control | Result [MEASURED] |
| --- | --- |
| Python corrected dependency comparison | 41 passed |
| Python `_derived` done-only comparison | 12 failed, 29 passed; cancelled-prerequisite and real scheduler tests fail |
| Python `_derived` always ready | 26 failed, 15 passed; A1 pending and missing cases fail |
| TS both comparisons corrected; Python parity process corrected in memory | 37 passed |
| TS `isTaskReady` alone restored to done-only | 1 failed, 36 passed; `A1 isTaskReady prerequisite cancelled -> true` fails |
| TS private `derived` alone restored to done-only | 10 failed, 27 passed; `A1_cancelled event fold and incremental application` fails |
| TS `isTaskReady` always ready | 6 failed, 31 passed; A1 pending and missing cases fail |
| TS private `derived` always ready | 20 failed, 17 passed; `A1_pending event fold and incremental application` fails |

## Verification and stop rules

Run from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/plan/u88 -t .
npx vitest run tests/unit/u88 --no-cache --no-fsModuleCache
npx tsc --noEmit -p .
```

Unmodified implementation: Python `FAILED (failures=12)` across 41 tests, with
29 passing; TS `Tests  11 failed | 26 passed (37)` [MEASURED]. Every failure is
an assertion about readiness/rollups or newly eligible scheduler items. No
import, setup, unexpected rejection, or missing-module error counts as valid
fail-first evidence. Any such error must stop and invalidate the run.

The baseline Vitest summary is `Tests  9360 passed | 2 skipped (9362)`
[MEASURED]. Typechecking reports 16 existing diagnostics and none in U88 files
[MEASURED]. Existing Python plan and room suites are green. A broader baseline
already fails `bridge/tests/setup/test_setup.py::SetupOracle.test_a5_wall_ready_default`
on the isolated copy's dependency-symlink path expectation; this is outside U88
and is not counted as an oracle failure. `bridge/tests/plan_demo` has no
discoverable tests and is not claimed as passing evidence.

Reject writes outside `bridge/tests/plan/u88/` and `tests/unit/u88/`, including
product fixes and extension stubs. Re-measure the post-U90 baseline and exercise
the deferred A7 regression when authoring U88 after U90 integrates.
This oracle is scoped to the supplied U88 specification, amendments and confirmed repository surfaces.
