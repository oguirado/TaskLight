# U125 fail-first oracle

Scope: `.unit/SPEC.md`, including its complete, binding Amendment B. Status: fail-first oracle; product implementation and integration admission are pending. U118 ADMIT remains an integration prerequisite; its admission receipt is AUSENTE — no inventar. The oracle does not grant ADMIT.

Only this test directory is authored. The product surfaces are read-only: `src/views/index.ts`, `src/app/agent_wall.ts`, `hosting/src/main.ts`. Dependencies inspected include `src/app/agent_store.ts`, `src/app/agent_link.ts`, `src/app/types.ts`, `src/app/swarm_vm.ts`, `src/views/swarm.ts`, `src/plan/types.ts`, `src/plan/reducer.ts`, `src/app/starter_templates.ts`, `templates/planning/blank.json`, `docs/HEADLESS.md`, `docs/MCP.md`, and `bridge/room/mcp.py`. In particular, `deriveSwarmViewModel` and the swarm renderer remain unchanged.

## Acceptance mapping

Names below are exact test names or parameterized test-name templates. `guidance.test.ts` runs the real controller, wall, store and plan fold. `hosting.test.ts` imports the actual hosted entry, captures its real controller, and supplies deterministic fake link/provider boundaries. `fixtures.ts` contains test data and assertions, not replacement product modules.

| Acceptance | Tests | Observable gate / negative contrast |
|---|---|---|
| A1 | `guidance.test.ts`: `A1 %s takes precedence over projection failures and M3 notices` for connecting, unreachable, resyncing, linked without hello, selected replay incomplete; `A1 synchronized empty room has an Empty workspace heading and help action`; `A1 exposes hello-listed rooms before any event and keeps the chosen room across refreshes`; `A1 ready room still shows syncing separately until its selected replay completes`; `M4 Bridge connected requires both linked state and current hello membership`. `hosting.test.ts`: `A1 hosted connecting to linked to hello to terminal replay follows the required headings`; `M1 hosting supplies current link state and hello rooms through the optional observation seam`; `A1 hosted hello exposes rooms with no events and selecting an unsynced peer stays syncing`; `A1 more:true never completes replay and more:false does even without a recovery fault`. | Exact visible headings and next actions; current hello membership; per-room completion; selection preservation. A linked transport, old data, or a nonterminal replay cannot certify readiness. |
| A2 | `guidance.test.ts`: `A2 legacy-only history is distinct from empty and planning memory`; `A2 accepted memory-only history with null plan is No plan yet`; `A2 accepted lifecycle-only history takes precedence over legacy activity`; `A2 a valid plan without tasks is No tasks yet`; `A2 empty history wins over a compatibility projection with null plan`; `A2 %s produces Workspace unavailable rather than Empty workspace` for missing projection, throwing projection reader, throwing event reader, fold failure; `A2 a ready plan with work has no empty-state overlay even when a phase filters out its tasks`. | Accepted history and inspected projection determine the state. Errors and unavailable projections cannot become empty; phase filtering cannot erase work. |
| A3 | `guidance.test.ts`: `A3 an explicit empty lifecycle map shows both independent notices and verbatim actions`; `A3 %s lifecycle map yields unknown labels and never empty-map claims` for missing and explicit undefined; `A3 %s without a non-empty harness still needs harness registration` for deployed and alive; `A3 %s registration retains its card but is not an active deployment` for finished and failed; `A3 the specified deployed fixture retains Deployed · no plan yet and has no false notices`; `A3 ownership and fresh activity keep unregistered owners but prove neither harness nor deployment`; `A3 Amendment B suppresses every registration/deployment notice while %s` for connecting, unreachable, resyncing, unsynced, unknown. | Registration and active deployment are independent room-scoped predicates. The specified alpha/r1/Fixture harness fixture is exercised. Terminal cards and unregistered owners remain. Absence is never an empty map, and beats/ownership never certify registration. |
| A4 | `guidance.test.ts`: `A4 goal mission rules and the strict scratch plan appear without reload, including alpha`; `A4 switching rooms and back never leaks plan title or harness registration`. | Seed goal/mission/rules, fold the blank scratch plan and task, claim T01 as alpha, and verify conformance before UI checks. Refresh and room changes preserve Scratch verification and alpha only in their room. |
| A5 | `guidance.test.ts`: `A5 %s workspace observation remains Connection unknown despite a linked fallback` for missing, throwing, null link; `A5 link-only disconnect is visible within 1000ms while browser is online, retaining qualified saved work`; `M4 destroys every observer timer and prevents late observation or transport calls`. `hosting.test.ts`: `A5 a gap-held refreshWall cannot hide a link-only disconnect or delete saved progress`; `A5 A7 %s cannot reuse a prior session's completed replay` for reconnect and resync; `M4 pagehide cancels status observation without a late review or provider call`. | A link-only transition must update without a store refresh, even behind the gap/stale guard. Browser online and provider policy are independent. Saved title/owner remain qualified. New hello/replay is required after reconnect/resync. A nonempty legacy reviewer fixture makes the no-extra-review check nonvacuous. |
| A6 | `guidance.test.ts`: `A6 hostile plan title stays literal without an executable element or URL`; `A6 Amendment B hostile room slug is literal in room-specific guidance`; `A6 throwing reader error is passive text, never an executable URL`; `M5 Open workspace help opens existing registration help, focuses heading, and Close restores its trigger`; `M6 changed guidance is announced politely and unchanged refreshes make no repeated announcement`; `M6 guidance leaves existing landing navigation, Models and Messages (legacy) available`. `hosting.test.ts`: `A6 %s guidance actions never write or invoke a provider` for unknown, connecting, unreachable, syncing, empty, legacy, memory, no tasks, unavailable. | Literal hostile strings; no injected executable node, event attribute or javascript URL. Help keeps installer Preview/Install, --apply, python3 -m bridge.room.mcp and shared CW_HOME registration. Check transport posts, raw port posts, journal cursors, reviewer calls, provider generation and provider-adapter calls against pre-action counts. Guidance names swarm_coordinator and documented hook setup. Changes announce politely with room identity; unchanged refreshes do not rewrite live announcements. |
| A7 | `guidance.test.ts`: `A7 a constant empty panel cannot pass the A1-A2 heading oracle`; `A7 a forged connected claim cannot pass the A5 disconnect oracle`; `A7 forced-connected observation fails the independently expected disconnect check`; `A7 unknown lifecycle must not be replaced by empty-map notices`. `hosting.test.ts`: both `A5 A7 %s cannot reuse a prior session's completed replay` cases. | In-memory wrong observations and empty/connected renderings are rejected by the same state assertion used by nominal tests. A1/A2/A5 are the eventual product mutant-killing tests. Coercing an absent lifecycle map to empty fails A3 and the A7 unknown-map test. Reusing completion fails the hosted reconnect/resync cases. No product file is mutated to run a negative control. |

## MUST coverage and ambiguity decisions

- M1: `ObservedDeps` structurally adds the exact optional `workspaceStatus` contract to the existing dependency type. No nonexistent runtime export is imported. The hosted seam test asserts its presence at runtime; missing implementation produces an assertion failure. Link observation, current hello membership and terminal replay completion remain separate evidence.
- M2: Amendment B controls classification precedence: empty, then accepted memory/lifecycle with null plan, then other null-plan history, then a taskless plan. Transport/sync/read-failure gates come first. The oracle selects Swarm explicitly for guidance scenarios and Wall explicitly for plan content; it does not change another unit's current default landing/navigation contract.
- M3: Non-empty harness strings certify recorded registration only. Deployed/alive certify active deployment independently; finished/failed do not. Both omitted and explicitly undefined maps mean unknown. All registration/deployment notices are suppressed behind the Amendment B gates. Notices and their next-action text identify the selected room.
- M4: The deadline is 1,000 virtual milliseconds [CITED, spec target], advanced through fake timers without a refresh call. No polling implementation or timer period is prescribed. Standalone destruction and hosted teardown check cancellation of pending timers and cessation of link reads/review/provider activity. The hosted fixture normalizes fake timer handles to browser-style numeric IDs; Node timer objects cannot create an unrelated clock-contract failure.
- M5: Only Open workspace help is required to be an actionable control. Other next-action strings may be passive directions; if exposed as controls they are activated and checked for side effects. swarm_coordinator and hook-setup references are body copy, while the supplied action strings stay verbatim. Focus must return to the corresponding visible help trigger; its DOM node identity is not prescribed.
- M6: Heading tags, notice classes and observer implementation remain open. Semantic headings, visible text, room identity, polite announcements and safe DOM output are asserted. Raw reader-error disclosure uses the literal hostile acceptance string; a throwing observation remains Connection unknown. No new protocol/error code, composer, chat route or terminal control is introduced by these tests.
- A4 verifies the client projection of the documented strict scratch recipe through the real plan fold and conformance checker. Dispatch/CLI/MCP strict-creation and backend claim behavior are other units' responsibilities; no backend process is launched here.

## Determinism and stop rules

All suites use fake time, fixed timestamps, local accepted events and finite microtask drains. Fetch is denied. The hosted fixture fakes external ports, provider construction and boot services while retaining the real hosting/controller/view path. A bounded DOM-observer guard prevents runaway test infrastructure; exceeding it fails a fixture precondition. No real timer, network request, capsule, provider or agent process is required.

Fixture acceptance and conformance checks are prerequisites, not substitutes for UI assertions. A fixture or import failure stops certification; an assertion failure caused by absent U125 behavior is the required pre-authoring result. No skipped or expected-failing test hides the red state.

## Verification receipt

Commands run from the isolated project root, with caching disabled to keep verification artifacts out of other repository directories:

```sh
npx vitest run tests/unit/u125 --no-cache
npx tsc --noEmit -p .
npx vitest run tests/unit/u108 tests/unit/u118 tests/unit/u136 --no-cache
```

Current U125 result: 67 tests [MEASURED], 58 red and 9 green [MEASURED]. Exact summary:

```text
 Test Files  2 failed (2)
      Tests  58 failed | 9 passed (67)
```

The red cases are assertion failures for absent headings/actions, hello-only room selection, registration/deployment truth, the hosted observation seam and saved connection guidance. Runtime imports resolve. No import failure or unhandled runtime error is the fail-first signal. Green cases cover preserved ready plans, existing navigation and safe title rendering, destruction, and negative-control assertion checks.

Type checking exits nonzero on 16 preexisting diagnostics [MEASURED], unchanged from the pre-oracle baseline. New-file diagnostics: 0 [MEASURED]. U125 product-surface diagnostics: 0 [MEASURED]. The adjacent U108/U118/U136 suites pass: 213 tests [MEASURED]. This is targeted regression evidence, not a full-repository suite claim.

## Deferred capsule gates and out of scope

The spec's capsule checks require U118 ADMIT, a fresh integration clone, scratch CW_HOME and load5 < 18 [CITED]. Their results and frame SHA-256 receipts are AUSENTE — no inventar. No historical receipt is treated as current proof, and no capsule script is added.

| Integration-only gate | Required observation |
|---|---|
| Host admission | Prove load5 < 18 [CITED] before launch; otherwise hold. Respect the shared-host capsule cap and never restart a desktop/session. |
| Historical defect contrast | Independently show the defect oracle red on I0; no current run on I0 is claimed here. |
| Responsive capsule | 390×844, 768×1024, 1440×900 and 200% zoom [CITED]: no clipping or horizontal page scroll; help registration visible; Close returns focus. |
| Interaction and live update | Tab/Enter, fresh/legacy/memory room distinctions, external Scratch verification/alpha creation without reload, online-browser bridge disconnect with qualified saved content, and reconnect replay before ready. |
| Hostile/negative capsule inputs | Hostile title/room/error, throwing workspaceStatus, forced connected observation and stale completion across reconnect. Record frame hashes and distinguish failed preconditions from passes. |

Authentication, live MCP-session detection, hook implementation/event contracts, provider policy changes, backend/protocol changes, CSS, other units' navigation redesigns, and live browser/screen-reader receipts are out of scope, not U125 oracle failures. U108 help, U118 Models/navigation and U136 cards are preserved via their existing regression suites. The mandate is limited to the supplied specification and the read-only project surfaces inspected above.
