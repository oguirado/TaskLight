# U118 fail-first oracle

Specification status: DRAFT [CITED].

Scope: `.unit/SPEC.md`, including its final Amendment B. Production code is unchanged. These tests use the real wall, the existing U112 derivation and renderer, and the existing Models sheet. Only clocks, transport, store read seams, and model services are injected. Test fixtures are not production stubs. Run `npx vitest run tests/unit/u118`.

## Acceptance map

Names below are test-title prefixes; parameterized titles expand to the individual input values in the results table. Titles containing more than one acceptance identifier exercise both cases.

| Case | File | Test names and observable contract |
| --- | --- | --- |
| A1 | `wall.test.ts` | `A1 defaults to Swarm`; `A1 preserves explicit initialView`; `A1 Amendment B invalid initialView`; `A1 navigates Swarm Wall Memory Swarm`; `A1 Amendment B invalid runtime navigation`; `A1 refresh consumes changed projection`; `A1 clock-driven refresh`; `A1 U112 current task active microtask progress`; `A1 replacement and repeated refresh`; `A1 refresh recomputes read-only loaded questions`; `A1 destroy clears scheduled work`. These cover selected-room mounting, navigation, room replacement, question events, freshness, disposal, and invalid-input no-op behavior. |
| A2 | `wall.test.ts`, `hosting.test.ts` | `A2 standalone wall`; `A2 A6 AgentWall forwards onOpenModels`; `A2 contains a`; `A2 hosting passes its wall-owned Models callback`; `A2 opens and closes by mouse`; `A2 keyboard`; `A2 refresh while open then Escape`; `A2 missing services still opens`. These require one visible enabled native button named Models, the specified ARIA attributes, callback forwarding and failure containment, real-sheet opening, policy and health text, focus restoration, and unavailable-state opening. |
| A3 | `hosting.test.ts` | Every `A3` test: private cloud blocking, standard-room named availability, all non-available health states, resolver blocking reasons, absent/hostile/unknown floors, unavailable services, live floor/workspace/selection updates, private hybrid safeguards, conditional on-device readiness. `M5 merely rendering and opening` checks generation, network and room-write silence independently. |
| A4 | `wall.test.ts`, `hosting.test.ts` | `A4 hostile agent task and microtask labels`; `A4 existing workspace display names`; `A4 Amendment B hostile workspace names`; `A4 hostile provider labels`; `A4 forged agent cloud permission`. Hostile floor variants also exercise the Amendment B unknown-policy path. Literal text must create no executable elements, handlers, or URLs. |
| A5 | `wall.test.ts`, `hosting.test.ts` | `A5 no lifecycle input`; `A5 Swarm has no composer`; `A5 Amendment B Swarm card selection`; `A5 Messages legacy is initially collapsed`; `A5 explicit Wall card still opens`; `A5 Messages legacy gates access`; `A5 preserved Wall chat and liaison`. These cover registration uncertainty, read-only Swarm, no chat callback from Swarm, collapsed legacy access with guidance, and preserved chat/liaison operation. |
| A6 | `wall.test.ts`, `hosting.test.ts` | `A2 A6 AgentWall forwards onOpenModels` observes the actual trigger and fails if forwarding is absent. `A3 A6 online private room blocks healthy cloud without a fallback claim` fails for network-only availability wording. The present baseline already exhibits both negative conditions. Candidate mutation trials remain pending; no product files are rewritten to manufacture a pass. |

## MUST and stop-rule coverage

| MUST | Verification |
| --- | --- |
| M1 | `M1 exercises existing U112 contracts before functional assertions` confirms the existing runtime exports. Imports resolve without fallback modules, empty renderers, or skipped functional tests. Formal U108/U112 ADMIT evidence and a frozen-contract receipt are AUSENTE in the supplied test surface; implementation admission remains HOLD. The oracle does not claim that symbol existence proves ADMIT. |
| M2 | A1 default, explicit and invalid initial-view tests; semantic primary navigation and runtime invalid-input mutation records. |
| M3 | A1 real renderer, current task/microtask/progress/dependency data, same-room question events, clock expiry, room replacement and destruction. A5 registration uncertainty and read-only controls. |
| M4 | A2 wall and hosted callback tests, single named opener, expanded state, mouse/keyboard activation, live-trigger focus and callback-error isolation. |
| M5 | A3 selected-room/floor/selection/health/policy cases and the independent no-generation/no-room-write test. Registry `list()` and `resolve()` are observed through their existing contracts. |
| M6 | A5 legacy entry and existing Wall/card/chat/liaison regressions. `M6 factory selection remains firebase-hybrid for every task group` preserves all existing factory defaults. |
| M7 | A4 passive-text tests and `M7 retains U108 workspace help and theme switching`. Existing focus/reduced-motion/theme stylesheet behavior remains subject to the browser capsule and existing regression suites. |
| M8 | `M8 refresh does not rely on an observer to reinject the Models opener`; `M8 repeated refresh beats workspace and sheet cycles`. The latter records DOM mutations, opener/subscriber counts, and callback invocations and checks quiescence between actions. Verification results and limits follow below. |

Missing dependency imports or exports, harness errors, timeouts, network activity, or non-assertion failures must stop oracle certification; they are not functional fail-first evidence. A candidate PASS must be recorded separately from baseline RED. Existing baseline failures must not be attributed to U118.

## Decisions and limits

- Amendment B wins over the earlier view union: only `swarm`, `wall`, `diary`, and `memory` are accepted. `agenda` and `archive` are invalid here. Invalid initial values fall back to Swarm; invalid runtime values preserve DOM node identity and produce no mutation records.
- Only `ONLY_ON_DEVICE` and `PREFER_ON_DEVICE` establish known room policy. Absent values, privacy-tier strings in the floor field, cloud-mode strings, hostile markup, numbers, and objects remain unknown. Room policy comes from the active workspace, independently of an open chat task.
- Private hybrid health cannot establish cloud readiness. On-device readiness is tested with its own resolved, available provider. Provider health remains visible alongside the room-policy reason; health alone never grants permission.
- The spec leaves the availability summary's task-group aggregation unspecified. Policy fixtures use uniform global selections; the existing per-group factory defaults are checked without inventing an aggregation rule.
- jsdom does not implement trusted keyboard activation or Tab traversal. Keyboard tests focus the required native button and reproduce its uncancelled browser default activation after key events. Native Tab navigation, pixels, focus outlines, theme contrast, reduced motion, clipping, viewport sizes, zoom and screenshot hashes require the separate browser capsule; no visual pass is claimed.
- The U112 fixture supplies three executors, initially two Working and one Liveness unknown. Fake time expires the remaining working evidence without changing the projection. Existing dependency identifiers and owners are checked. An additional blocked dependency reason is out of scope under Amendment B and belongs to U136.
- U132 lifecycle storage, U135 narrator/slot, U112/U136 renderer changes, provider-policy/registry changes, backend/protocol changes, chat recovery and receipt states are out of scope, not oracle failures.
- The original historical I0 checkout and a fresh integration clone are AUSENTE here. The baseline below is the supplied isolated U118 workspace. No claim is made about a historical commit or integration-clone pass.
- The hardening loop has a test-runner observer safety guard, not a product performance budget. The specification supplies no numerical performance budget and no improvement is claimed.

## Verification

Baseline typecheck before these files: 16 diagnostics [MEASURED], outside `tests/unit/u118`. Current `npx tsc --noEmit -p .` must preserve that baseline with no diagnostics in this directory. A globally green typecheck is not claimed. The final run has the same 16 diagnostics [MEASURED] and zero diagnostics [MEASURED] in this directory.

Baseline existing-suite run excluding this directory:

```text
Test Files  15 failed | 343 passed (358)
     Tests  112 failed | 10995 passed | 9 skipped (11116)
```

Full `npm test` after adding this oracle:

```text
Test Files  17 failed | 343 passed (360)
     Tests  174 failed | 11013 passed | 9 skipped (11196)
```

The difference is exactly this oracle's 62 assertion failures and 18 passing tests [MEASURED]. Existing failure-file identities and existing failure totals are unchanged; no unhandled errors were reported [MEASURED]. Both secret-scan scripts passed [MEASURED]. Content and naming checks found no private paths or private tooling in the new files [MEASURED]. The production/specification file manifest remained unchanged [MEASURED].

Those failures predate this oracle. A complete existing-suite pass is not available from this input. Formal candidate ADMIT, candidate mutation trials, the browser capsule, screenshot hashes and fresh integration-clone results are AUSENTE; they must be supplied separately.

## Additional verification

The requested Python suites were run without bytecode writes. These results are [MEASURED]; no globally green Python result is claimed. They are outside the new TypeScript oracle, and no Python source or tests were edited.

| Existing Python suite | Tests | Failures | Errors | Result |
| --- | --- | --- | --- | --- |
| `bridge/tests/room` | 844 | 10 | 47 | FAILED |
| `bridge/tests/plan` | 567 | 15 | 16 | FAILED |
| `bridge/tests/wall_room` | 106 | 1 | 0 | FAILED |
| `bridge/tests/wall` | 168 | 0 | 0 | OK |

`bash tests/secret_scan/run.sh` and `bash tools/secret_scan.sh` both returned success [MEASURED]. The new file set is `tests/unit/u118/fixtures.ts`, `tests/unit/u118/wall.test.ts`, `tests/unit/u118/hosting.test.ts`, and `tests/unit/u118/ORACLE.md`. No production file was changed. The isolated copy has no Git metadata, so a Git-diff naming gate is AUSENTE; direct file/content checks and an unchanged production/specification hash manifest provide the available checks.

## Baseline results

The per-test table below is generated from the measured baseline run. GREEN means preserved behavior or a functioning prerequisite; RED means an assertion about missing U118 behavior. Candidate results remain separate and unmeasured.

```text
Test Files  2 failed (2)
     Tests  62 failed | 18 passed (80)
```

Counts are [MEASURED]. Every failed case reaches an assertion; no import errors or unhandled runtime errors were accepted.

| File | Test name | Baseline | Candidate |
| --- | --- | --- | --- |
| `hosting.test.ts` | `A2 hosting passes its wall-owned Models callback` | RED | AUSENTE |
| `hosting.test.ts` | `A2 opens and closes by mouse with correct expanded state and focus` | RED | AUSENTE |
| `hosting.test.ts` | `A2 keyboard "Enter" opens the same sheet exactly once` | RED | AUSENTE |
| `hosting.test.ts` | `A2 keyboard " " opens the same sheet exactly once` | RED | AUSENTE |
| `hosting.test.ts` | `A2 refresh while open then Escape restores focus to the live named trigger` | RED | AUSENTE |
| `hosting.test.ts` | `A2 missing services still opens the unavailable-state sheet` | RED | AUSENTE |
| `hosting.test.ts` | `M8 refresh does not rely on an observer to reinject the Models opener` | RED | AUSENTE |
| `hosting.test.ts` | `M8 repeated refresh beats workspace and sheet cycles keep one opener and one callback per activation` | RED | AUSENTE |
| `hosting.test.ts` | `A3 A6 online private room blocks healthy cloud without a fallback claim` | RED | AUSENTE |
| `hosting.test.ts` | `A3 selected healthy permitted provider is named as available` | RED | AUSENTE |
| `hosting.test.ts` | `A3 health needs_setup removes the selected provider availability in rail and open sheet` | RED | AUSENTE |
| `hosting.test.ts` | `A3 health offline removes the selected provider availability in rail and open sheet` | RED | AUSENTE |
| `hosting.test.ts` | `A3 health blocked removes the selected provider availability in rail and open sheet` | RED | AUSENTE |
| `hosting.test.ts` | `A3 resolver blocking reason policy suppresses healthy-provider availability` | RED | AUSENTE |
| `hosting.test.ts` | `A3 resolver blocking reason remote_config suppresses healthy-provider availability` | RED | AUSENTE |
| `hosting.test.ts` | `A3 resolver blocking reason unknown_id suppresses healthy-provider availability` | RED | AUSENTE |
| `hosting.test.ts` | `A3 Amendment B unknown or hostile host floor undefined makes no availability claim` | RED | AUSENTE |
| `hosting.test.ts` | `A3 Amendment B unknown or hostile host floor null makes no availability claim` | RED | AUSENTE |
| `hosting.test.ts` | `A3 Amendment B unknown or hostile host floor "" makes no availability claim` | RED | AUSENTE |
| `hosting.test.ts` | `A3 Amendment B unknown or hostile host floor "ALLOW_CLOUD" makes no availability claim` | RED | AUSENTE |
| `hosting.test.ts` | `A3 Amendment B unknown or hostile host floor "standard" makes no availability claim` | RED | AUSENTE |
| `hosting.test.ts` | `A3 Amendment B unknown or hostile host floor "ONLY_IN_CLOUD" makes no availability claim` | RED | AUSENTE |
| `hosting.test.ts` | `A3 Amendment B unknown or hostile host floor "<img src=x onerror=alert(1)>" makes no availability claim` | RED | AUSENTE |
| `hosting.test.ts` | `A3 Amendment B unknown or hostile host floor 7 makes no availability claim` | RED | AUSENTE |
| `hosting.test.ts` | `A3 Amendment B unknown or hostile host floor {"cloud":true} makes no availability claim` | RED | AUSENTE |
| `hosting.test.ts` | `A3 no received host floor is unknown even with a healthy provider` | RED | AUSENTE |
| `hosting.test.ts` | `A3 missing model services says Models unavailable without a cloud claim` | RED | AUSENTE |
| `hosting.test.ts` | `A3 room floor updates refresh both rail and already-open sheet` | RED | AUSENTE |
| `hosting.test.ts` | `A3 workspace policy follows the active room rather than the selected chat task` | RED | AUSENTE |
| `hosting.test.ts` | `A3 selection changes refresh rail and open sheet without a wall refresh` | RED | AUSENTE |
| `hosting.test.ts` | `A3 Amendment B private healthy hybrid with on-device health available never claims cloud readiness` | RED | AUSENTE |
| `hosting.test.ts` | `A3 Amendment B private healthy hybrid with on-device health needs_setup never claims cloud readiness` | RED | AUSENTE |
| `hosting.test.ts` | `A3 available on-device selection in a private room may be named available` | RED | AUSENTE |
| `hosting.test.ts` | `M5 merely rendering and opening the existing sheet performs no inference or room mutation` | GREEN | AUSENTE |
| `hosting.test.ts` | `A4 hostile provider labels stay literal in the real sheet` | GREEN | AUSENTE |
| `hosting.test.ts` | `A4 forged agent cloud permission cannot override private-room policy` | RED | AUSENTE |
| `hosting.test.ts` | `A5 Messages legacy gates access and preserves existing chat and liaison` | RED | AUSENTE |
| `hosting.test.ts` | `A5 preserved Wall chat and liaison operate independently of legacy navigation placement` | GREEN | AUSENTE |
| `hosting.test.ts` | `M6 factory selection remains firebase-hybrid for every task group` | GREEN | AUSENTE |
| `wall.test.ts` | `M1 exercises existing U112 contracts before functional assertions; no missing-import failure` | GREEN | AUSENTE |
| `wall.test.ts` | `A1 defaults to Swarm as the first primary view and renders selected-room agents` | RED | AUSENTE |
| `wall.test.ts` | `A1 preserves explicit initialView diary` | GREEN | AUSENTE |
| `wall.test.ts` | `A1 preserves explicit initialView wall` | GREEN | AUSENTE |
| `wall.test.ts` | `A1 preserves explicit initialView memory` | GREEN | AUSENTE |
| `wall.test.ts` | `A1 preserves explicit initialView swarm` | RED | AUSENTE |
| `wall.test.ts` | `A1 Amendment B invalid initialView "agenda" falls back to Swarm` | RED | AUSENTE |
| `wall.test.ts` | `A1 Amendment B invalid initialView "archive" falls back to Swarm` | RED | AUSENTE |
| `wall.test.ts` | `A1 Amendment B invalid initialView "__proto__" falls back to Swarm` | RED | AUSENTE |
| `wall.test.ts` | `A1 Amendment B invalid initialView "<img src=x onerror=alert(1)>" falls back to Swarm` | RED | AUSENTE |
| `wall.test.ts` | `A1 Amendment B invalid initialView "" falls back to Swarm` | RED | AUSENTE |
| `wall.test.ts` | `A1 Amendment B invalid initialView null falls back to Swarm` | RED | AUSENTE |
| `wall.test.ts` | `A1 Amendment B invalid initialView 7 falls back to Swarm` | RED | AUSENTE |
| `wall.test.ts` | `A1 navigates Swarm Wall Memory Swarm and replaces previous-room cards` | RED | AUSENTE |
| `wall.test.ts` | `A1 Amendment B invalid runtime navigation "agenda" performs zero DOM or selection mutation` | RED | AUSENTE |
| `wall.test.ts` | `A1 Amendment B invalid runtime navigation "archive" performs zero DOM or selection mutation` | RED | AUSENTE |
| `wall.test.ts` | `A1 Amendment B invalid runtime navigation "bogus" performs zero DOM or selection mutation` | GREEN | AUSENTE |
| `wall.test.ts` | `A1 Amendment B invalid runtime navigation "__proto__" performs zero DOM or selection mutation` | GREEN | AUSENTE |
| `wall.test.ts` | `A1 Amendment B invalid runtime navigation "" performs zero DOM or selection mutation` | GREEN | AUSENTE |
| `wall.test.ts` | `A1 Amendment B invalid runtime navigation null performs zero DOM or selection mutation` | GREEN | AUSENTE |
| `wall.test.ts` | `A1 Amendment B invalid runtime navigation {} performs zero DOM or selection mutation` | GREEN | AUSENTE |
| `wall.test.ts` | `A1 Amendment B invalid runtime navigation 7 performs zero DOM or selection mutation` | GREEN | AUSENTE |
| `wall.test.ts` | `A1 refresh consumes changed projection and same-room unanswered questions` | RED | AUSENTE |
| `wall.test.ts` | `A1 clock-driven refresh expires working evidence without a store mutation` | RED | AUSENTE |
| `wall.test.ts` | `A1 U112 current task active microtask progress and read-only question count reach the mount` | RED | AUSENTE |
| `wall.test.ts` | `A1 replacement and repeated refresh never retain another room's cards` | RED | AUSENTE |
| `wall.test.ts` | `A1 refresh recomputes read-only loaded questions after an answer` | RED | AUSENTE |
| `wall.test.ts` | `A1 destroy clears scheduled work and refresh cannot remount a destroyed wall` | GREEN | AUSENTE |
| `wall.test.ts` | `A2 standalone wall has exactly one named enabled Models opener` | RED | AUSENTE |
| `wall.test.ts` | `A2 A6 AgentWall forwards onOpenModels with the actual trigger` | RED | AUSENTE |
| `wall.test.ts` | `A2 contains a sync Models callback failure` | RED | AUSENTE |
| `wall.test.ts` | `A2 contains a async Models callback failure` | RED | AUSENTE |
| `wall.test.ts` | `A4 hostile agent task and microtask labels are literal text` | RED | AUSENTE |
| `wall.test.ts` | `A4 existing workspace display names render hostile markup literally` | GREEN | AUSENTE |
| `wall.test.ts` | `A4 Amendment B hostile workspace names remain passive text` | RED | AUSENTE |
| `wall.test.ts` | `A5 no lifecycle input means Not registered by a harness and no invented deployment` | RED | AUSENTE |
| `wall.test.ts` | `A5 Swarm has no composer message input or terminal controls` | RED | AUSENTE |
| `wall.test.ts` | `A5 Amendment B Swarm card selection never activates the Wall chat callback` | RED | AUSENTE |
| `wall.test.ts` | `A5 Messages legacy is initially collapsed and gives harness guidance when opened` | RED | AUSENTE |
| `wall.test.ts` | `A5 explicit Wall card still opens the selected task chat and can send` | GREEN | AUSENTE |
| `wall.test.ts` | `M7 retains U108 workspace help and theme switching` | GREEN | AUSENTE |
