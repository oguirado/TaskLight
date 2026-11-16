# U88 TypeScript fail-first oracle

Status: R30; Q1 approved. Amendment A-U88-1 allows this oracle before U90.
The complete acceptance map, MUST coverage, assumptions, negative-control
results and stop rules are in `bridge/tests/plan/u88/ORACLE.md`.

All TS tests below are in `tests/unit/u88/dependencies.test.ts`.

| Acceptance | Test names / disposition |
| --- | --- |
| A1 | `A1 isTaskReady prerequisite %s -> %s` covers done, cancelled, pending, active, blocked and missing; `A1_pending`, `A1_active`, `A1_blocked`, `A1_done`, `A1_cancelled` each run as `event fold and incremental application`. |
| A2 | `A2 cancellation immediately recomputes downstream readiness`; `A2 clearing with latest revision restores pending and not-ready dependant`; `A2_reversed event fold and incremental application`; `A2 op_id replay preserves cancellation without an extra task revision`. |
| A3 | `A3_conjunction_wait`, `A3_conjunction_done`, `A3_conjunction_cancelled`, `A3_chain`, each run as `event fold and incremental application` and `A3 reversed task-array order: %s`. |
| A4 | `A4 preserves microdata, ownership, revisions and completion progress`; `A4 terminal helper guard: %s`; `A4_terminal_done` and `A4_terminal_cancelled` fold vectors; `A4 pending tasks with empty dependencies stay ready`; `A4 unlocking never activates microtasks or manufactures liveness`. The Python `test_A4_cancellation_appends_only_the_requested_event` covers persisted event emission. |
| A5 | Real MCP path belongs to `bridge/tests/plan/u88/test_next_work.py`: `test_A5_cancellation_exposes_exactly_the_dependant_microtask`, `test_A5_blocked_dependant_is_excluded_after_cancellation`, `test_A5_other_owned_dependant_is_excluded_after_cancellation`; the `test_M3_*` tests preserve active-work eligibility, owner priority, order and limits. |
| A6 | `A6 missing dependency -> not_found`; `A6 self dependency -> dep_cycle`; `A6 forged state -> bad_op`; `A6 stale revision -> stale_rev`; `A6 missing task -> not_found`; `A6 transitive cycle -> dep_cycle`. |
| A7 | OUT OF SCOPE before U90: `activity.beat`, `activity_beat`, `deriveActivity` and beat-preservation projections are absent. No missing-module imports, skipped tests or stubs. The A4 unlocking test already asserts pending microstate and absent `live`. U88 implementation must exercise A7 after U90 integrates. |
| A8 | Independent in-memory done-only mutations of `isTaskReady` and private `derived` fail the corresponding A1 cancelled cases. Always-ready mutations fail A1 pending/missing cases. Exact observed results and frozen-fixture hash are recorded in the Python ORACLE. No product mutation is retained. |

`M6 Python and TS canonical task states, readiness and rollups agree` sends the
same finite event fixtures to the actual Python fold. It compares both
projections and independently checks the fixed expected canonical snapshots in
`tests/unit/u88/cases.json`. Agreement on the missing behavior cannot pass.

Missing dependencies are probed directly in each readiness predicate; A6
verifies rejection on the valid event API, which cannot create dangling edges.
Task completion/activation uses `micro.set`, while cancellation/reversal uses
revision-correct `task.set`. Other existing readiness rules remain unchanged.

```sh
npx vitest run tests/unit/u88 --no-cache --no-fsModuleCache
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/plan/u88 -t .
npx tsc --noEmit -p .
```

Unmodified TS summary: `Tests  11 failed | 26 passed (37)` [MEASURED].
Unmodified Python summary: `FAILED (failures=12)` across 41 tests [MEASURED].
Failures must be assertions about the missing dependency behavior; import,
setup, fixture rejection or missing-module errors invalidate the run.
Typechecking retains the 16 existing diagnostics, with no error in U88 files
[MEASURED]. No network or behavioral timers are used; event timestamps are
fixed and the parity subprocess has bounded output and a process deadline.
This oracle is scoped to the supplied U88 specification, amendments and confirmed repository surfaces.
