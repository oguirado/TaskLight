# U136 fail-first oracle

Status: DRAFT; FAIL-FIRST; not ADMIT. Contract: `.unit/SPEC.md`, including every item in final Amendment B. This oracle imports the existing `src/app/swarm_vm.ts` and `src/views/swarm.ts`; it supplies data fixtures and boundary spies, with no product stubs or source changes.

## Verification gates

| Step | Gate | Negative contrast |
| --- | --- | --- |
| Derivation | Frozen inputs, independent expected membership/fields, current-run fences, cached rollup | A fresh beat cannot override failed/finished lifecycle, a noncurrent run cannot restore activity, and absence cannot become zero progress |
| Rendering | Frozen rows independent of derivation; visible grouping, labels, blockers and literal text | Unsorted rows, merged missing/literal groups, omitted reasons and executable hostile strings must fail assertions |
| Interaction | Selected task detail, keyboard activation, Escape focus restoration, read-only boundary spies | Inert task cards, incorrect task selection, chat navigation and any transport/provider/storage call must fail |
| Verification | New suite red on assertions, U112 green, unchanged TypeScript diagnostics | Import/setup failures, historical receipts and pre-existing errors are not successful evidence |

## Numbered acceptance mapping

Names below are literal test names or parameterized name templates. Tests remain ordinary assertions; none uses expected-failure, skip, todo, network access or real timers.

| Case | Test file and names | Scope |
| --- | --- | --- |
| A1 | `vm.test.ts`: `A1 includes the five lifecycle slugs exactly once, including released and terminal agents`; `A1 preserves current microtask, selected-task done/total, blocker owner and projection rollup`; `A1 shuffled task, microtask and registration input has identical output without mutation`. `view.test.ts`: `A1 renders five cards grouped as alpha (3) and beta (2), with c,b,a then d,e`; `A1 shuffling frozen renderer rows preserves visible content and group order without mutation`; `M2 displays cached plan rollup exactly instead of recomputing it from displayed tasks` | Fully local; renderer expectations do not come from the derivation under test |
| A2 | `vm.test.ts`: `A2 boundary beat %s gives %s with the inclusive freshness deadline`; `A2 reaches refresh_at_ms with a fake clock and no new event, then becomes Liveness unknown`; `A2 rejects %s for activity, last_beat_ts and expiry`; `A2 missing beat evidence cannot become Working or a zero-age observed beat`; `A2 %s lifecycle fences a fresh current-run beat and cannot schedule Working expiry`; `A2 disconnected evidence cannot produce Working or refresh_at_ms`; all `M5` tests. `view.test.ts`: `A2 %s status overrides a fresh Working renderer row`; `A2 failed with retained T03 says Failed · open work, without releasing ownership` | Tests current run, wrong owner, retired/noncurrent runs, malformed/future timestamps, terminal precedence and refresh deadlines |
| A3 | `vm.test.ts`: every test under `A3 / M2-M6 nulls, blockers and observational lifecycle`. `view.test.ts`: every test under `A3 / M3 exact group keys and full bucket order`; the deployed/empty/finished-pending tests under `A2-A3 / M4 terminal status, deployment and missing values`; `A3 shows every blocker with its downstream ID and upstream current owner, Unassigned or Missing task` | Includes missing progress, full bucket order, exact group keys, deterministic ties, terminal-only work and missing/unassigned dependencies |
| A4 | `questions.test.ts`: every test under `A4 / M6 loaded-history scope and answer-chain rules`. `view.test.ts`: `A4 hostile %s is literal text with no executable nodes or handlers`; `Amendment B __proto__ slug and swarm are literal and cannot pollute group objects`; `M2 optional lifecycle reason is visible verbatim alongside lifecycle and harness`. `detail.test.ts`: `Amendment B detail %s stays literal and inert after activation`; `Amendment B hostile task identifiers and __proto__ slug cannot break task activation selectors` | Includes duplicate IDs, ack-only history, foreign rooms, complete/dangling/cyclic answer chains, hostile detail content and selector safety |
| A5 | `detail.test.ts`: every test under `A5 / M7 local read-only detail and focus`; `A5 optional narrator node is mounted once inside a labelled narrator slot`; `A5 omitting narrator preserves the two-argument call and supplies no fabricated narration`. `boundaries.test.ts`: `A5 click, Enter, Space and Escape interactions never call transport, provider, storage or refolding` | Selected task, dependencies, microtasks, outcomes, evidence, keyboard control, focus restoration, registration-only cards, narrator identity and read-only interactions |
| A6 | A2 terminal-precedence tests above; `vm.test.ts`: `M1 preserves exported types, the input shape, required row fields and two-argument rendering`. `boundaries.test.ts`: all tests. Separate U112 regression and TypeScript commands below | The supplied implementation already exhibits the prohibited fresh-beat-wins behavior. Those A2 tests fail directly. Historical I0 execution and a separate source-mutant run are not claimed |

## MUST and Amendment B coverage

| Requirement | Additional discriminating tests |
| --- | --- |
| M1 / Amendment B whole replacement | `M1 committed lifecycle replaces the entire compatibility registration without inheriting harness, swarm or reason`; `M1 committed lifecycle reason reaches an existing owner row verbatim`; `M1 compatibility-only registrations and non-null owners remain members without inferring registration`; cached-projection and boundary tests |
| M2 / Amendment B reason and age | Current-task/active-microtask selection, terminal fallback, null progress and missing-value labels; `Amendment B observed age %s ms is floored to %s`; hostile reason and literal reason tests |
| M3 / Amendment B ordering | Full bucket fixture; code-unit group/slug ordering; separate missing and literal `Ungrouped`; `M3 unanswered question counts alone never promote a Working card into Needs you`; preserved activity vocabulary |
| M4 / Amendment B released work | Failed/finished override fresh Working; failed with retained work; done/cancelled work excluded from open work; finished pending work; explicit unregistered Working; observational projection checks |
| M5 / Amendment B run fencing | `M5 registration without a current run cannot accept otherwise fresh evidence`; `M5 a fresh retired sibling cannot replace the stale current-run last beat or restore Working`; `M5 expiry is the earliest eligible Working-card deadline, ignoring earlier blocked and retired beats`; disconnected/nonworking/terminal cards do not schedule expiry |
| M6 / Amendment B loaded history | Every unsatisfied dependency of every unfinished owned task, owner/null/missing distinctions, literal blocked reasons; bounded complete chains, cycles and inert `__proto__` event IDs |
| M7 / Amendment B local detail | Card click, focused Enter/Space, Escape/focus return, selected task rather than first owned task, no registration-only action, no composer/terminal/mutation controls, hostile detail identifiers/content, optional labelled narrator slot |

## Interpretations and boundaries

- Amendment B governs the apparent M4 tension: done/cancelled tasks do not count as retained open work for `Failed · tasks released`.
- `PlanProjection.agent_lifecycle` is supplied using a structural fixture extension of the existing public projection type. U132 owns shared-type/storage changes. No shared file is patched and no missing export is synthesized.
- For a registration without a current run, evidence cannot satisfy equality with the current run; liveness and observed beat remain absent/unknown. Unregistered owners may still be Working using U112 evidence checks.
- Future activity timestamps use the cited existing `live.beat_ts` field. No additional `live.ts` API is invented.
- Activity vocabulary is preserved. M3 controls ordering buckets; task Done/Cancelled does not assert process termination. Question counts alone never mean Needs you.
- A1 and M3 agree on c,b,a and d,e ordering. Shuffled input checks normalize source microtask array order when comparing retained task objects, and independently check identical visible output.
- Narrator support is tested through a compatible optional-argument function type so the current renderer can import and execute before it supports that option. A failure must be the missing supplied node, not a compile/import error.
- DOM helpers use visible identity/content, preferring semantic headings when present. No new CSS class, group wrapper, dialog tag, detail layout or generated ID is prescribed. Native button keyboard defaults are simulated because jsdom does not implement them.
- The available snapshot contains the U112 modules. Historical missing-view failures at revision `4528625acafa5e435c4b34b6d1fd6adfacee6dd3` [CITED] cannot be reproduced from this snapshot. They are AUSENTE — no inventar; this run is not branded as historical I0 evidence.
- A6 source mutation is not executed: the write boundary excludes product code and no completed lifecycle-precedence implementation is available to mutate. The failed/finished plus fresh-Working renderer fixtures are the discriminating negative inputs; a future source-mutant run must make those A2 assertions fail. No mutation PASS is claimed.

## Integration, visual and performance exclusions

| Item | Status and ownership |
| --- | --- |
| Capsule navigation and landing mount | OUT OF SCOPE: U118 owns mounting/navigation; no landing or legacy-chat test is reported failed here |
| Lifecycle persistence/run gates and hook-triggered release checked against `plan_get` | OUT OF SCOPE: U132/U133; this oracle consumes committed lifecycle and ownership snapshots only |
| Live question delivery | OUT OF SCOPE: U128 dependency cited as `ext/events.py:30`; that path is absent in the supplied snapshot. Loaded-history counting is tested locally |
| Narrator inference | OUT OF SCOPE: U135 owns inference; the supplied narrator-node slot is tested here |
| Fresh-clone capsule frames, responsive dimensions, zoom, light/dark, focus appearance, reduced motion and overflow | DEFERRED tier-2 visual evidence. jsdom cannot certify layout or pixels; static CSS/string inspection is not a visual pass |
| Launchers, shared-store/type edits, chat investment and historical regression frames | OUT OF SCOPE; no edits and no fresh-pass claims |
| Hardening correctness | `hardening.test.ts`: `Hardening correctness: frozen swarm-vm-derive fixture agrees with every projection task and selected-task count`; frozen 15-agent, 40-task, 12-microtask fixture [TARGET]. Disagreement is BLOCK, not a performance result |
| Hardening timings and DOM mutations per beat | INCONCLUSIVE: load telemetry is AUSENTE, so no benchmark is started. At load5 ≥ 18 [CITED], do not benchmark; any previously obtained timings at that load remain INCONCLUSIVE. Numeric latency/mutation ceilings are AUSENTE — no inventar. No windowing or speculative optimization |

Hardening correctness fixture SHA-256 [MEASURED]: `7d5c21afdd2fa6aae4e1fb05bdcd40b7b919648ebb871e833666a71e3cc93b19`. This hash identifies the frozen fixture, not performance or ADMIT evidence.

## Commands and observed results

Run from the repository root using the locally installed tools. Disable runner caching; no network or dependency installation is required.

```sh
npx vitest run tests/unit/u136 --no-cache --maxWorkers=2
npx vitest run tests/unit/u112 --no-cache --maxWorkers=2
npx tsc --noEmit -p .
```

Final oracle run: assertion failures only; no import, setup, syntax or unhandled errors [MEASURED]. Exact console summary:

```text
 Test Files  6 failed (6)
      Tests  53 failed | 66 passed (119)
```

| Test file | Total [MEASURED] | Red [MEASURED] | Green [MEASURED] |
| --- | ---: | ---: | ---: |
| `vm.test.ts` | 40 | 12 | 28 |
| `view.test.ts` | 43 | 25 | 18 |
| `detail.test.ts` | 17 | 13 | 4 |
| `boundaries.test.ts` | 4 | 1 | 3 |
| `questions.test.ts` | 14 | 1 | 13 |
| `hardening.test.ts` | 1 | 1 | 0 |

Red cases detect ignored committed lifecycle, absent lifecycle-only members, unfenced current runs/observed beats/deadlines, missing groups/order, terminal/deployment wording, floored beat-age formatting, omitted reasons, missing local task detail/keyboard controls and the ignored narrator node. They do not pass because a module is absent or a forbidden dependency was substituted.

U112 regression rerun remains green [MEASURED]; exact summary:

```text
 Test Files  7 passed (7)
      Tests  145 passed (145)
```

TypeScript exits nonzero with the same 16 pre-existing diagnostics and zero diagnostics in `tests/unit/u136` [MEASURED]. The complete before/after diagnostic streams have identical SHA-256: `63069af808525ab4f55a3749ca53ab2ca4edc110b320c4a0bb7b8031e3b8cfe6` [MEASURED]. This is an unchanged-baseline result, not a clean whole-project typecheck.

The broader existing unit-suite baseline already fails independently of this oracle, including an existing U111 check for missing `docs/SWARM.md`. It is not represented as green, nor as a U136 failure. The known TypeScript baseline is compared byte-for-byte; this assignment does not repair unrelated diagnostics.

This oracle is limited to the supplied specification and repository files inspected within the isolated workspace.
