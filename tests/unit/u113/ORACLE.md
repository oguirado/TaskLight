# U113 fail-first oracle

Authority: `.unit/SPEC.md`, status **DRAFT**, including **Amendment B** in full.
Implementation surface: `src/app/agent_store.ts`. Oracle files live only in
`tests/unit/u113/`; production code and existing tests remain unchanged.

## Frozen replay reference

`uncached-reference.ts` was written and hashed before the candidate tests.
SHA-256: `5c142f756da316033b114506901df9dd1946492332e6ccbecbb4448401a56a49`
[MEASURED]. **A-U113 (SPEC_U161):** this is the historical pre-amendment
reference digest; the generation-aware reference below supersedes its latest-opening
selection. Spec SHA-256:
`05a53dc7effb3302400f24e9ce0995f3c56a68dbbeb6b85467a41ea84306ad8b`
[MEASURED].

The reference freezes the baseline store orchestration: accepted events are
cloned, retained without display pruning, and deduplicated globally by event id;
room events sort by Lamport then ordinal id. **A-U113 (SPEC_U161):** each
opening supplies its own resolver arguments, and only an admitted generation
changes the template context; rejected and replayed openings retain that context.
Matching declared hashes admit templates and
exceptions fall back to no template. It calls captured, real `Plan.foldPlan`
and `foldRoomWithStats`, never `createAgentStore`, `plan`, `plans`, `events`, or
`states` on the candidate. Baseline reducers remain shared because reducer edits
are outside this unit. Tests assert admission independently before feeding known
accepted events to the reference. Explicit ownership, memory revisions,
progress, diagnostics, archive, ordering and legacy expectations supplement
prefix comparisons.

## Numbered acceptance mapping

| Case | Test names and files | Gate and negative contrast |
| --- | --- | --- |
| A1 | `replay.test.ts`: `A1 seed %i: mixed reordered arrivals, duplicate ids, two rooms and two instances`; `A1 equal-Lamport arrivals use ordinal event ids rather than arrival order`; `M1 preserves undefined cases, public result shape and plans room ordering`; `M5 display retention keeps all operations and pruned legacy activity in both folds` | Every arrival and repeated read equals the reference for full `PlanProjectionResult`, `states()`, `plans()` and `since()`. Arrival order, display-only history and shared instance state cannot substitute for full replay. Unchanged `tests/unit/u85/store.test.ts` retention and takeover regressions must pass, including `claimed_by_other`. |
| A2 | `replay.test.ts`: `A2 withheld fixture claim invalidates both reads without increasing since`; `negative-controls.test.ts`: `A2 rejects a cache invalidated only by maximum Lamport and records the assertion receipt` | Withhold the existing fixture claim, warm both reads, then admit it after larger Lamports. `T01` becomes assigned to `alice` while `since()` stays unchanged. The deliberately broken cache must throw `AssertionError`; a setup exception cannot count. |
| A3 | `freshness.test.ts`: `A3 missing, matching, throwing and mismatched outcomes preserve complete replay diagnostics`; `A3 resolver object replacement and in-place content changes are visible with unchanged declared hash`; `A3 template content changes refold constraints and rejection receipts without new events`; `A3 stable %s outcome still calls resolver and reuses both projections`; `A3 equal template snapshots with different object identity reuse projection work`; `M4 resolver retains the admitted sorted generation across equal-Lamport and rejected opens` (A-U113, SPEC_U161); `M5 template snapshots are room-local and store-local even with equal declared hashes`; `negative-controls.test.ts`: `A3 rejects a template cache comparing identity/id/hash without content and records the assertion receipt` | Resolve on every applicable read. Compare missing, matching, threw and hash-mismatch outcomes; content changes affect both returned templates and reducer rejection receipts. Stable snapshots must reuse folds and event ordering, including freshly allocated equal template objects. Identity/hash-only negative control must fail the in-place name assertion. |
| A4 | `replay.test.ts`: `A4 memory before any plan invalidates cached undefined; heartbeat updates states`; `M3 activity.beat invalidates live receipts without changing semantic revisions`; `M6 room memory survives before-plan, close and reopen at every prefix` | Initial memory yields a non-undefined projection with `plan === null`, `goal.text === "updated"` and revision equal to event Lamport. Legacy heartbeat changes agent state. Activity beats update live receipts without changing progress/revisions. Memory remains room-scoped across reopen. |
| A5 | `replay.test.ts`: `A5 own %s operation key is invalid and cannot change projections or cursors`; `A5 __proto__ room is rejected and constructor room remains isolated`; `A5 conflicting valid payload with an accepted id is duplicate globally; invalid payload remains invalid`; `A5 mutating post-ingest caller events and returned events cannot alter either projection`; `A5 returned nested projections and states cannot mutate retained results`; `A5 returned %s mutation is isolated` | Own dangerous keys created by `JSON.parse` are invalid, do not poison corrected identities, and cannot change prototypes, cursors or projections. Conflicting accepted ids stay duplicate. Mutating errors/counts/template, nested projections/states or caller events cannot change later reads. |
| A6 | `hits.test.ts`: `A6 repeated plan reads do not call the full plan fold`; `A6 repeated states reads do not call the full agent fold`; `A6 warm public reads do not sort event history again`; `A6 an accepted update is visible before the next hit of both projections`; `A6 cached empty reads cannot hide the first accepted event`; plus the stable-outcome cases in `freshness.test.ts` | Test-local reducer spies and event-history sort instrumentation distinguish a hit from replay. Accepted events must become visible before another hit. Template key canonicalization is permitted. U114 dependency status is recorded below. |

The saved seeded histories use seeds `275`, `133`, `51966` [MEASURED], derived
from `0x113`, `0x85`, `0xcafe`. `histories.ts` supplies deterministic shuffles,
duplicate ids, equal Lamports, plan operations, activity beats, room memory and
legacy plan/step/question/answer/heartbeat events. Each generated history is
bounded. Fake time is fixed by `CLOCK`; these tests use no network, ports or
real timers.

## MUST coverage

| MUST | Coverage |
| --- | --- |
| M1 | Existing `AgentStoreOptions`, `TemplateResolver`, `AgentStore`, `PlanProjectionResult` imports and calls; unchanged signatures; undefined cases and `source: "v2"` shape; ordered `plans()` omitting undefined rooms. |
| M2 | Frozen reference, per-prefix complete equality and explicit replay expectations in A1–A4. Baseline source anchors: `src/app/agent_store.ts:204`, `:308`, `:335`, `:354`; `src/agents/index.ts:251`. |
| M3 | Earlier/equal Lamports, every required event family, semantic rejection receipts, duplicate/invalid outcomes and max-Lamport `since()` semantics. Additional `replay.test.ts`: `M3 accepted semantic rejection updates complete diagnostic receipts`; `M3 late legacy heartbeat changes takeover despite unchanged maximum Lamport`. |
| M4, Amendment B | **A-U113 (SPEC_U161):** Every applicable read resolves historical opening identities; only admitted generations change template context. Stable normalized outcomes permit no additional full-fold or history-sort work. Same-object mutation, changed constraints, replacement and per-room outcomes are covered. |
| M5 | Instance/room isolation, all retained fold history, display-only capping, takeover, nested defensive copies and `M5 invalid maxPerRoom %s still throws RangeError` in `replay.test.ts`. |
| M6, Amendment B | Mixed seeded histories and explicit memory before open and across close/reopen. No lifecycle facts are synthesized. No invalidation whitelist is prescribed. Advancing fake wall time alone must not alter stored activity projections. |

## Interpretation and dependency boundaries

| Issue | Resolution or status |
| --- | --- |
| `__proto__` room | Preserve existing room validation: this spelling is invalid; no acceptance requirement is invented. `constructor` is a valid room slug and must remain isolated. |
| Template hashing | Preserve declared-hash admission; do not recalculate hashes to reject the mandated same-hash content mutation. Resolver source mutations must be detected, while mutations of returned templates must not alias resolver-owned data. |
| Template normalization | Missing, threw, hash-mismatch and canonical matching template snapshots are distinct outcomes. A fresh equal template object is unchanged content. No private cache structure, hash algorithm or recomputation location is prescribed. |
| Readonly results | A frozen returned value is allowed; mutation attempts may throw `TypeError`. The invariant is unchanged subsequent results. |
| Closed plans | **A-U113 (SPEC_U161):** A closed generation retains its opening template; a subsequent admitted generation selects its own template without reinterpreting archived history. Rejected openings retain the admitted context. |
| U132 `agent.lifecycle` | OUT OF SCOPE. Implementation is AUSENTE — no inventar. Future integration must extend the same mixed-history oracle before a plan and across close/reopen. No lifecycle fixture is fabricated. |
| U114 regression pack | INCONCLUSIVE. The readiness dependency is absent from the supplied test surface. Amendment B requires readiness and `load5 < 18` [TARGET] before running its unchanged pack. No capsule check is added. |
| U115 `wall-plan-cache` | INCONCLUSIVE. Paired baseline and required telemetry are AUSENTE — no inventar. Benchmark infrastructure is OUT OF SCOPE; no benchmark is launched. Unit execution duration is not cache latency evidence. |
| U123 and remaining exclusions | OUT OF SCOPE: history compaction, reducer/backend edits, lifecycle implementation, swarm UI, DOM patches, provider calls, chat investment and benchmark infrastructure. |

## Hardening gates reserved for U115 integration

| Gate | Required evidence or stop rule |
| --- | --- |
| Warm public reads | Paired p95 at most `2 ms` [TARGET]. |
| Accepted update plus both reads | Paired p95 at most `4 ms` [TARGET], including deferred work, freshness checks and defensive copies. |
| Sampling and telemetry | `5` warmups and `30` paired runs [TARGET], identical fixture hashes/environment, separate and combined read paths, p50/p95/p99, peak RSS, event/fixture counts, hashes and host load; serial quiet window. |
| Load stop | Do not start at `load5 >= 18` [TARGET]; any baseline taken there is INCONCLUSIVE. |
| Evidence stop | Missing baseline or required telemetry is INCONCLUSIVE. A correctness failure is BLOCK. No missing measurement is treated as zero or as a pass. |

See `verification.md` for measured results and
`negative-control-receipts.json` for captured assertion failures. The mandate
is limited to the supplied specification and the cited surfaces in this isolated project.
