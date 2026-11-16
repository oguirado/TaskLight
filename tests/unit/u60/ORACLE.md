# U60 fail-first oracle

Authority: `.unit/SPEC.md`, including the final binding Amendment W0-R. Production function bodies are deliberately `throw new Error("U60 stub")`. Constants, regular expressions, types and barrel re-exports are declarations. Tests call public exports from `src/plan/index.ts`; none asserts that stub exceptions are successful behavior.

## Acceptance map

| Spec acceptance | Tests |
|---|---|
| V1 / Stop rule 3 | `vectors.test.ts`: `V1 <case.id>: exact canonical projection and rejected receipts` for every case in `fixtures/plan/vectors.v1.json`; compares the full canonical projection and `expected_rejected`. Any disagreement blocks integration of U55 and U60. |
| V2 | `vectors.test.ts`: `V2 <case.id>: reverse preserves canonical projection`, `V2 <case.id>: shuffle preserves canonical projection`; deterministic seeded permutations and frozen inputs. |
| R1 | `reducer.test.ts`: `R1 happy path includes T01..T03 and parent revisions` covers all ten kinds, including `task.set`; `R1 micro mutations advance task and micro revision but not plan`; `R1 input and nested output snapshots are independent`; `R1 emptyProjection matches canonical empty shared vector`. |
| R2 | `reducer.test.ts`: every `R2` test; V1 negative vectors `no_plan`, `plan_exists`, `unknown_template`, `bad_hash`, `bad_op`, `not_found`, `missing_dep`, `stale_rev`, `self_cycle`, `cycle_2`, `cycle_3`, `claimed_by_other`, `task_capacity`, `micro_capacity`, `limit_deps`, `duplicate_deps`, `missing_base_rev`, `micro_base_rev_forbidden`, `null_op_id`. Direct tests cover ninth evidence and all required/optional revision gates. Error-code coverage limits are stated below. |
| R3 | `reducer.test.ts`: `R3 claim silence 600000`, `R3 claim silence 600001`, `R3 legacy heartbeat restarts silence: 600000`, `R3 legacy heartbeat restarts silence: 600001`. |
| R4 | `reducer.test.ts`: all `R4` tests cover conflicting payload replay, agent scope, duplicate event suppression, replay statistics, JSON-array replay keys, preserved replay history, isolated fold state and consumed cancelled IDs. |
| R5 | `reducer.test.ts`: all `R5` tests cover state precedence, empty/partial progress, all-dependency readiness, blocked readiness, missing dependencies, completion recomputation and ordinal tie ordering. |
| T1 | `validate.test.ts`: all `T1` tests cover normalized/raw starter templates; required/unknown fields, types/version, collection caps, character caps, duplicate IDs, granularity, nested unsafe text, and control/code rejection at every template text position. |
| T2 | `validate.test.ts`: all `T2` tests cover positive conformance, required brief/memory, micro bounds, acceptance/evidence requirements, unknown phases/types, deterministic finding envelopes and purity; reducer acceptance without implicit strict mode. |
| H1 | `hostile.test.ts`: all `H1` tests cover each public defensive boundary with primitives, null/undefined, cycles, non-finite/unsafe/boolean integers, non-JSON values, getters/revoked proxies, invalid identifiers, UTF-8 text/payload bounds and Unicode code-point field limits. |
| H2 | `hostile.test.ts`: all `H2` tests reject dangerous own keys in operations, brief, envelopes, templates and event arrays; JSON.parse canaries verify Object.prototype remains unpolluted. |
| H3 | `hostile.test.ts`: `H3 valid legacy events ignored without increasing invalid`, `H3 structurally malformed act=op increments invalid`; R3 additionally verifies valid legacy activity affects takeover. |

## Numbered behavior rules

| Rule in spec section 4 | Oracle |
|---|---|
| 1 Never throw | H1 public-boundary families; malformed envelope and serialization cases. |
| 2 Safe keys | H2; R4 JSON-array replay keys. Internal data-structure choices are not inspected. |
| 3 Ordering/deduplication | V2; R4 duplicate IDs; R5 ordinal ties; H3 invalid accounting. |
| 4 Envelope bounds | H1 malformed envelopes, UTF-8 inclusive boundaries, safe integer and timestamp boundaries; operation validation tests. |
| 5 Idempotency | R4 conflicting payload, agent scope, history retention, state isolation. |
| 6 Lifecycle | R1 memory/reopen; R2 absent/closed/active-plan cases; V1 `plan_close`, `reopen_preserves_memory`, `memory_before_plan`. Amendment memory exception applies. |
| 7 Revisions | R1 parent revisions; all R2 required/optional revision tests; V1 exact entity revisions. |
| 8 IDs/limits/references | R1 sequential IDs; R2 capacity/reference cases; R4 cancellation; H1 string/evidence/byte limits. |
| 9 DAG | R2 self-dependency and duplicate-dependency tests; V1 `cycle_2`, `cycle_3`, `missing_dep`. |
| 10 Claims/locks | R1 claim/release; R2 claim/release/micro locks; R3 boundary and legacy activity cases. |
| 11 Derived fields | R5 helpers and folded readiness; V1 canonical rollup. Amendment allows blocked readiness. |
| 12 Template/conformance | T1 and T2. |
| 13 Immutability | R1 snapshots; frozen V1/V2 inputs; R2 rejected-domain-data identity; T2 purity. |

## Binding amendment map

| W0-R item | Resolution / oracle |
|---|---|
| 1 | Supplied spec is available. Implementation receipts are not inferred from supplied documents. |
| 2 | R1 covers the ten operation kinds; operation-validation tests cover optional/invalid/boundary `op_id`. |
| 3 | `micro_id` and nested `op.evidence` are canonical; R2 rejects legacy `id` and forbidden `micro.set.base_rev`; V1 `micro_set` pins evidence. MCP mapping belongs to U57. |
| 4 | R2 rejects task `status`/`assignee`, accepts nullable `state`/`reason`/`estimate` and task-add assignee. Types match these amended fields. |
| 5 | R2 missing/mismatched required and mismatched optional revisions; R1 first memory write uses revision zero. |
| 6 | R1 parent revisions; V1 rejected receipts/last_lamport; R4 replay advances ingestion watermark without changing domain state. |
| 7 | Canonical types and V1 exact projections use `plan`, `tasks`, `memory`, `archived_plans`, `rollup`, `replayed_ops`, `rejected`, `last_lamport`; nullable fields and canonical `state`/`ts` names remain serialized. `PlanFoldResult.stats` stays external. |
| 8 | R1 memory before/after plan and reopen/archive preservation; R5 blocked readiness. Agenda rendering belongs to U61/U62. |
| 9 | R1 sequential IDs; R4 cancellation/deduplication; R5 ordinal ties; V2 permutations. |
| 10 | R4 conflicting payload retains first accepted result and compact JSON-array replay-map keys. U56 ingestion result persistence is out of scope. |
| 11 | R3 evaluates prior valid legacy room activity before operation filtering. Standalone context signature remains an explicit gap below. |
| 12 | V1 authoritative error receipts; R2 malformed/dependency/cycle/capacity mappings; H1 operation UTF-8 byte boundaries. |
| 13 | H1 safe integers and symmetric timestamp cap, non-JSON rejection, code-point lengths; H2 dangerous keys. Ordinary operation newline/tab remains valid. |
| 14 | T1 accepts normalized `hash`; T2 canonical `{ok,findings}` with severity `error`, path/code/message strings and deterministic repeat order. Python template loading/hash functions and strict composite creation are outside U60 exports. |
| 15 | Helpers read exact `fixtures/plan/templates.v1.json` and `fixtures/plan/vectors.v1.json` envelopes. V1 compares canonical projections, not TypeScript diagnostics. |
| 16 | OUT OF SCOPE: U56 `post_ops` atomic composite creation and strict `not_conformant` rejection; do not fabricate a reducer failure. |
| 17 | OUT OF SCOPE: U57 MCP resources, wrappers and URI errors. |
| 18 | OUT OF SCOPE: U58 relay redaction, traversal/drop accounting and paging. |
| 19 | OUT OF SCOPE: U61/U62/U63 view-model adapters and rendering. |
| 20 | OUT OF SCOPE: U63 prompt budgeting/fencing/privacy routing. |

## Explicit contract gaps and scope

- Exact canonical projection/null/default/archive fields come from the read-only U55 vectors, overriding the obsolete base-spec serialization fields. `src/agents/types.ts`, `src/app/agent_store.ts`, `src/template/types.ts`, `src/template/limits.ts`, `src/template/validate.ts`, `src/template/hash.ts`, `src/agents/index.ts` and `bridge/room/store.py` were consulted without edits.
- Finding-code vocabulary, diagnostic path syntax, message text and ordering across different failures: AUSENTE — no inventar. T2 isolates each required condition and checks canonical structure and repeat determinism without inventing golden strings or path syntax. Supplied projection vectors contain no conformance diagnostics.
- Accepted replay-result summary fields: AUSENTE — no inventar. Shared vectors contain empty `replayed_ops`; direct R4 tests verify key encoding, first-result behavior and preserved domain state without inventing serialized result values. Full replay-map golden parity awaits U55 fixtures.
- The amended Python-style optional `last_by_agent` context has no frozen TypeScript parameter shape. Preserve the exact published `applyOp(proj, ev, template?)` signature; exercise activity semantics through full-history `foldPlan`. Standalone explicit-context conformance awaits a TypeScript signature; no speculative fourth argument is added.
- A compile-time `Record<PlanOpErrorCode, true>` contract in `reducer.test.ts` preserves exactly all eleven `PlanOpErrorCode` members. Nine reducer-reachable codes have specified tests/vectors. `not_conformant` belongs to strict U56 composite creation. A concrete public U60 trigger for `bad_template` is AUSENTE — no inventar: malformed template validation is tested separately rather than prescribing an undocumented reducer template-loader behavior. No claim of eleven-code runtime coverage is made.
- The public `foldPlan` accepts one optional `PlanningTemplate`; every supplied case has one normalized template. A multi-template registry API is AUSENTE — no inventar; tests use each case's supplied template and assert its entire canonical expected projection.
- No fractional-percentage rounding rule, archive-retention cap, hash implementation, UI status adapter, Markdown layout, real filesystem evidence resolution or private service integration is invented. Evidence test paths are inert repository-relative strings, never opened.
- U55 owns `fixtures/plan/**` and `schemas/planning-template.v1.schema.json`; both are read-only prerequisites. U61 owns `src/agents/types.ts`, U62 owns `src/views/types.ts`; boot wiring, UI/CSS, relay/storage/MCP, AI adapters, exports and Firestore sync remain out of scope.

## Verification gates

From the repository root:

```sh
npx vitest run tests/unit/u60
npx tsc --noEmit -p .
npx vitest run --project unit --exclude 'tests/unit/u60/**'
```

Fail-first gate: every new test must fail because a public U60 function throws `U60 stub`. Negative contrast: missing modules/exports, fixture errors, unrelated exceptions, accidentally green tests or missing tests invalidate that receipt. No test treats a stub exception as a passing expectation.

TypeScript gate: no diagnostics in `src/plan/**` or `tests/unit/u60/**`. Negative contrast: any new diagnostic in these files blocks delivery; unrelated baseline errors are reported without editing other units.

Regression gate: existing suite results must match the baseline. Negative contrast: new existing-suite failures block compatibility claims. The baseline already contains failures and cannot honestly be reported as green.

Tests use fixed event timestamps, seeded permutations and bounded inputs. They run in the node environment without DOM, network, real timers, ports, spawned models or production reducer implementations as expected-value generators. Shared expectations are read-only fixture data.

## Verification receipt

New oracle: 379 tests [MEASURED], all 379 red [MEASURED], zero green [MEASURED], zero skipped [MEASURED]. Every individual failure message contains `U60 stub`; there are no import, fixture, unrelated assertion or other exception failures [MEASURED]. Exact final console summary:

```text
 Test Files  4 failed (4)
      Tests  379 failed (379)
```

The four suites are `reducer.test.ts`, `validate.test.ts`, `vectors.test.ts` and `hostile.test.ts`. All 36 shared cases [MEASURED] are exercised in their original order, reversed, and deterministically shuffled. These receipts establish fail-first execution, not reducer implementation parity; Stop rule 3 remains closed until implementations agree.

`npx tsc --noEmit -p .`: exit status 1 [MEASURED]; 16 diagnostics outside U60 [MEASURED], zero diagnostics in `src/plan/**` or `tests/unit/u60/**` [MEASURED]. No changes were made to those other units.

Existing unit tests were run before and after creating the oracle. Both runs have the same exact result [MEASURED]:

```text
 Test Files  4 failed | 237 passed (241)
      Tests  57 failed | 8120 passed | 1 skipped (8178)
```

Existing-suite green status is not claimed: the baseline already has failures. No new existing-suite failure is observed in the result comparison. No report artifacts are retained outside the authorized test/stub surface.
