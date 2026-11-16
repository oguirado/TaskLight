# U61 fail-first oracle

Authority: `.unit/SPEC.md`, including its final binding Amendment W0-R. Tests exercise existing modules only. No production files or dependency stubs were created or changed.

## Acceptance coverage

Test names start with the numbered acceptance case. Parameterized rows are separate tests.

| Case | Test file | Test names / assertions |
| --- | --- | --- |
| O1 | `store_op.test.ts` | `accepts %s without an op_id` covers all ten operation kinds; `accepts op_id boundary %s`; `permits ordinary operation text containing markup and Unicode`; `enforces the configured room buffer while preserving the high-water mark`. |
| O2 | `store_op.test.ts` | `mixed complete lines survive a torn final op`; `a valid final line needs no newline; malformed complete JSON counts as malformed`; `preserved legacy torn-line handling remains green`. |
| O3 | `store_op.test.ts`, `fold_wiring.test.ts` | `rejects duplicate event IDs through both entry points`; `retains distinct IDs sharing op_id, including conflicting payloads and different agents`; `repeated op_id records reach U60 unchanged; no store-level suppression`. |
| O4 | `store_op.test.ts`, `fold_wiring.test.ts`, `plan_vm.test.ts` | `hostile envelopes are rejected without throwing` parameterizes missing/null/array bodies, kind/id/revision/byte errors, payload mixing, unsafe event numbers, evidence and dangerous own keys. `non-JSON operation %s is contained` covers cycles, bigint, function, symbol and non-finite values. `an invalid event never poisons deduplication of a corrected event`; `delegates operation validation to U60 (accepted=%s)`; `projection boundaries never throw on hostile values` covers adapter and VM inputs. |
| O5 | `store_op.test.ts` | `clones nested operation input and returned events before later folding`; `clones operation evidence independently of top-level legacy evidence`; `preserves deterministic lamport then ordinal ID ordering`; `preserved legacy states match the existing folder`. |
| O6 | `fold_wiring.test.ts` | `exposes safe empty-room plan/plans queries`; `forwards %s in deterministic order and returns the canonical reducer result` uses `task_add`, `stale_rev`, `cycle_2`, `claimed_by_other`, `takeover_600000`, `takeover_600001`, `memory_before_plan`, `reopen_preserves_memory`; `tie-break uses ordinal event ID rather than arrival order`; `W0-R passes complete room activity including human and legacy events for takeover`. See dependency qualification below. |
| O7 | `plan_vm.test.ts` | `maps twelve steps and completion detail to one canonical T01`; `missing step states default to pending, without mutating inputs`; `empty legacy steps have zero progress; steps beyond twelve are bounded`; `no contract means no synthetic plan`. Checks T01.M01 through T01.M12, assignee, contract revision, dependencies, acceptance text, outcome, took, rollup progress and unchanged stored events. |
| O8 | `plan_vm.test.ts`, `fold_wiring.test.ts` | `v2 and legacy tasks coexist when v2 room is %s` covers separate and shared rooms; `mixed op history leaves legacy folding bit-for-bit unchanged`; `legacy WallVM fields retain the established mapping exactly`; `mixed room keeps v2 projection and legacy states independently`. |
| O9 | `plan_vm.test.ts`, `fold_wiring.test.ts` | `legacy human %s never produces a task` covers open/question/plan and addressed chat visibility; `adapter excludes the configured user even with a contract`; `human-assigned v2 task is excluded while other tasks remain`; complete-history forwarding retains human events. |
| O10 | `plan_vm.test.ts` | `Plan band maps title, phases, progress and assigned-agent dots`; `Agenda maps %s and excludes blocked-ready tasks from Next`; `dependency wait and explicit blocked reason reach TaskVM`; `done microtask detail and memory changes enter Diary with day buckets`; `Archive maps closed plans from %s`; `Memory maps ts to changedAt, author, text and template metadata`; `Memory flags a required empty section and works without an active plan`; `plan verdict reason/source map to nanoVerdict without inventing latency`; `op strings stay literal plain strings in VM fields`; `view/workspace/archive selections are honored`. |
| O11 | `wall_u61.test.ts` | `reads store.plans and sends v2 and legacy content to mountWall`; `refresh projects newly ingested op room state`; `interval refreshes Plan projections at WALL_REFRESH_MS`; `destroy cancels the interval, destroys handles, cleans drawer attributes and prevents later work`; `%s changes local selection and re-renders`; `optional initialView reaches the renderer`; `legacy task selection opens chat; unknown IDs are ignored`. |
| O12 | External regression/typecheck gates below | Existing suites run directly, rather than spawning nested test runners inside unit tests. The inherited U38 failure prevents declaring this gate green; it is not a new U61 failure. |
| O13 | `wall_u61.test.ts` | `%s contains no prohibited executable identifiers` checks `src/agents/types.ts`, `src/app/agent_store.ts`, `src/app/agent_wall.ts` after stripping comments for `innerHTML`, `eval`, `Function`, `fetch`, `XMLHttpRequest`. |

## Behavioral MUST mapping

| Spec rule | Coverage |
| --- | --- |
| 4.1 allow-list / envelope validation | O1, O4, U60 validation port probe |
| 4.2 payload exclusion | O4 op/plan/step/question mixing rows |
| 4.3 hostile-input containment | O4 ingestion, adapter, VM; O6 safe plan/plans queries |
| 4.4 defensive ownership | O5 |
| 4.5 deduplication and torn lines | O2, O3 |
| 4.6 reducer delegation and legacy folding | O6, O8 |
| 4.7 legacy adapter | O7 |
| 4.8 human exclusion and chat visibility | O9 |
| 4.9 view models | O10, O8 legacy compatibility |
| 4.10 wall mount and controls | O11, O13 |

## Binding resolutions and dependency boundaries

- W0-R supersedes the original mandatory `op_id`: omission is accepted; present values must match the specified alphabet and length; null is rejected.
- Envelope ingestion is structurally validated. A statefully rejected operation remains a replay record; standalone task edits need not have an active plan merely to enter the event buffer. Per-kind shape validation belongs to U60 `validateOpEvent`; the delegation probe tests both outcomes without implementing that validator in tests.
- `micro.set` uses `micro_id`, operation-local evidence and no `base_rev`. Required revisions on the other kinds follow W0-R. Deep cloning checks operation evidence separately from legacy top-level evidence.
- Canonical data comes from `fixtures/plan/vectors.v1.json`: `plan`, `tasks`, `memory`, `archived_plans`, `rollup`, `replayed_ops`, `rejected`, `last_lamport`. No alternate serialized `status` or top-level `progress` is assumed.
- The complete sorted room history, including human and legacy activity, crosses the U60 fold boundary. Tests inspect the supplied history; they do not duplicate takeover or idempotency algorithms.
- `src/plan/reducer.ts` and `src/plan/validate.ts` contain throwing U60 stubs in this snapshot. O6 uses a reducer spy returning canonical fixture projections to test U61 ordering and result propagation. This is an explicit boundary probe, **not a cross-language parity receipt**. Running the real reducer against all fixture projections, including exact replay results, rejection codes, lifecycle and takeover equality/strictness, belongs to U55/U60 and remains a dependency gate outside U61. The canonical fixture expected projections are not passed off as measured reducer output.
- U62 contracts exist locally in `src/views/plan.ts`; extended `src/views/types.ts` definitions remain absent. Type-only imports use the existing local contracts, with test-side structural casts for additive U61 APIs. Missing exports/methods are first asserted to be functions, so failures are assertions rather than missing-module or missing-export errors. Casts provide no implementation.
- Dependency waits are checked as `TaskVM.waitsFor: ["T03"]`; U62 owns rendering this as `Waits for T03`. U61 tests plain strings, metadata and projections; U62 DOM structure, styling, accessibility, grouping renderer internals and visual output are out of scope. The wall mount probe captures actual VM arguments at the renderer port without invoking U62 stubs.
- Diary tests require nonempty day buckets, preserving completion detail and same-day memory entries, without prescribing a day-label format. Archive tests require task counts, duration text and final outcome without prescribing duration formatting. No default-phase identifier, synthetic template identifier, projection-wrapper task ID encoding, diagnostic aggregation policy or verdict latency is invented.
- W0-R says to exclude human-authored/assigned tasks. Human legacy authors, assigned v2 tasks, addressed chat and retained human history are covered. A v2 task has no creator field in canonical `PlanProjection`; attribution of an unassigned human-authored task cannot be established from the pure VM API. Exact creator provenance is unresolved and not guessed.
- U56 atomic creation, U57 resources/MCP, U58 relay redaction, U63 inference/privacy and U64 boot integration are out of scope. No such dependency failure is counted as a U61 test failure.

## Determinism and validation

All event IDs, fixture orders and times are fixed. `FakeAppClock` supplies intervals; the wall uses fake post/reviewer/renderer ports. No network or real timers are used. No implementation stub files were created.

Commands run from the repository root:

```sh
npx vitest run tests/unit/u61
npx tsc --noEmit -p .
npx vitest run tests/unit/u34 tests/unit/u35 tests/unit/u36 tests/unit/u37b tests/unit/u37c tests/unit/u38 tests/unit/u42 tests/unit/u61
```

Measured U61 result:

```text
Test Files  4 failed (4)
     Tests  81 failed | 55 passed (136)
```

All reported failure groups are `AssertionError`; no collection/import errors, unhandled errors or U60/U62 stub exceptions occur. Red assertions identify missing U61 operation acceptance, additive store/adapter APIs, hostile-input protection, projections and wall selection handlers. Green tests pin rejection/containment and preserved legacy behavior. A rejected operation alone does not prove the new validator works: positive acceptance and delegation probes supply the necessary negative contrast.

The typecheck exits nonzero before and after these additions. Its complete output is byte-for-byte unchanged; no diagnostic references `tests/unit/u61`. This is a no-new-errors receipt, not a clean-project typecheck receipt.

The baseline legacy-only run reports:

```text
Test Files  1 failed | 62 passed (63)
     Tests  1 failed | 1414 passed (1415)
```

The inherited failure is `tests/unit/u38/v2_progress.test.ts`, test `hosted cascade: the progress track keeps the token track colour (wall.css [role=progressbar] must not paint it)`: its stylesheet-count assertion expects four sheets and receives five. Fixing styles or U38 tests is outside the write surface.

The combined run reports:

```text
Test Files  5 failed | 62 passed (67)
     Tests  82 failed | 1469 passed (1551)
```

Subtracting the U61 result leaves exactly the baseline legacy result. O12 therefore has no introduced regressions, but remains blocked by the pre-existing U38 failure and inherited typecheck errors. No green O12 receipt is claimed.
