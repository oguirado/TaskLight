# U138 fail-first oracle

Authority: `.unit/SPEC.md`, read in full through its final Amendment B. Status: **DRAFT — R40 binding; not ADMIT**. The executable oracle targets the MUSTs and acceptance cases; it does not confer ADMIT.

Only `tests/unit/u138/` is authored. Product code and existing oracles remain unchanged. The tests execute `startAgentWall`, `mountWall`, `deriveSwarmViewModel` and `renderSwarmView`; seam observers forward calls to the real functions. `WallMountVM` remains local; `src/views/types.ts` and `src/app/swarm_vm.ts` are unchanged.

## Stub precondition: AUSENTE — no inventar

The complete specification names the new file `src/views/agent_strip.ts`, but supplies **no exported name or exact function signature** for it. No pre-existing strip file exists. The exact-signature precondition for creating a stub is unproven, so no export or stub is invented. Consequently these tests fail on behavioral assertions against the current product, **not** `Error("U138 stub")`. Stub-only red cannot be certified from this specification. No sentinel throw, catch-all setup failure, missing import, skip, or expected product error is used to manufacture red.

## Acceptance mapping

Parameterized test names below retain their declared substitution markers. Every numbered acceptance case is mapped; execution and physical rendering are distinguished from executable behavior.

| Case | Executable test names | Gate and negative contrast |
|---|---|---|
| A1 | `wall.test.ts`: `A1 fresh startup selects Wall with five ordered primary tabs and secondary Swarm`; `A1 explicit initialView %s is accepted by both validators`; `A1 invalid or absent initialView %j falls back to Wall`; `A1 %s click, shortcut and advertised shortcut agree`; `A1 primary End/Home/arrows select Memory/Wall and restore focused tabs`; `A1 shortcuts are suppressed in %s`; `A1 %s suppresses all destination shortcuts`; `A1 invalid runtime navigation %j is a mutation-free no-op`; `M1 legacy direct mount keeps navigation controlled until update` | Actual selected destination, accessible label, advertised shortcut, primary order, secondary placement, focus and mutation records must agree. Explicit Agenda/Archive are valid; runtime invalid inputs must preserve node identity, selection and write silence. Swarm as the landing is rejected. |
| A2 | `wall.test.ts`: `A2 Wall receives the admitted selected-room model through the local seam`; `A2 T01 and multi-task executor-a have correct chips beside unchanged task rings`; `A2 terminal lifecycle on %s overrides a fresh beat`; `A2 unregistered ownership is explicit and null ownership does not fabricate an agent`; `A2 blockers match downstream task identity, including unowned, null and missing upstreams`; `A2 readiness comes from existing card data, not every admitted waiting_on entry`; `A2 %s liveness evidence never becomes Working or a fabricated beat`; `M2 connected:false reaches the Wall derivation and cannot assert Working`; `M3 any supplied registration field preserves U112 registration semantics: %j`; `M3 empty registration fields retain the explicit unregistered label`; `M2 legacy direct mount without swarm keeps its signature and fabricates no model`. `swarm.test.ts`: `A2 M6 %s lifecycle overrides fresh working activity in summary and detail` | Frozen fixture: T01 belongs to executor-b and waits on T02/executor-a; executor-a also owns T03, which waits on T90/executor-c. Task rings remain task-specific. Other downstream blockers cannot leak. Failed/Finished beat activity, null owners and absent registration remain distinguishable. Card readiness wins over a conflicting agent-wide waiting list. |
| A3 | `wall.test.ts`: `A3 strip precedes Plan, caps globally at five, and opens every agent in Swarm`; `A3 strip includes registration-only agents and honest absent work/beat evidence`; `M5 strip floors observed %i ms to %s`; `M5 strip preserves U136 group and urgency order and distinct literal Ungrouped`; `M5 empty membership gives harness guidance and keeps Show all in Swarm available`; `A3 expiry updates %s at the admitted deadline without ingestion or writes`; `A3 workspace updates replace both chips and strip without leaking repeated task IDs`; `A3 replacement cancels the obsolete expiry and destruction clears all scheduled work`; `A3 store refresh replaces removed membership rather than retaining stale registration`; `M2 loaded-history recipients do not become a second registration source` | The cap is global across groups, not a separate allowance per group. Room replacement must remove prior-room identities despite repeated task IDs. A genuine scheduled deadline is required before cancellation can pass; advancing fake time across expiry changes chips/strip/Swarm without ingestion or writes. Destruction clears work and prevents remount. |
| A4 | `wall.test.ts`: `A4 Wall owner/harness/swarm/room/IDs remain passive: %s`; `A4 hostile room replacement cannot contaminate another selected room`. `swarm.test.ts`: `A4 hostile %s remains literal through metadata and local task activation`; `A4 %s identity and grouping use safe lookups through activation`; `A4 registration-only hostile metadata remains inert after disclosure` | Hostile markup, quoted/bracketed IDs, room values, `__proto__`, `constructor`, `toString`, task text, harness, swarm, reasons, outcomes and evidence remain text through disclosure/detail. Check executable nodes, error events, alert calls, prototype descriptors and cross-room replacement. |
| A5 | `wall.test.ts`: `A5 the landing oracle rejects a Swarm-default negative witness`; `A5 the chip/strip oracle rejects missing Wall derivation without fabricating evidence`; `A5 the terminal oracle rejects a working-only model that drops Failed lifecycle` | Inert negative witnesses reuse the positive assertions; no source mutation is allowed. Chip/strip and terminal controls first require a positive witness, preventing absent features from making the negative control pass vacuously. These are bounded discrimination controls, not claimed executions of source mutants. Missing evidence cannot certify implementation. |
| A6 | Verification commands below; existing-suite and diagnostic baseline comparison | A test failure does not certify a successful implementation. No new diagnostics may be introduced in authored files. Existing failures are reported as baseline, not fixed or misreported as green. Whole-suite admission and fresh physical visual receipts remain external gates. |

## Remaining MUST coverage

| MUST | Additional exact test names |
|---|---|
| M1 direct fallback | `M1 direct-mount invalid view %j also falls back to Wall` covers the independent view-level fallback with an admitted model present, avoiding a missing-model error as a substitute for an assertion. |
| M2 read reuse | `M2 extending the existing Swarm seam to Wall adds no store reads` compares projection/history read counts with the admitted Swarm path while requiring actual Wall derivation. |
| M6 compact summary/disclosure | `M6 two-argument renderer shows identity, state, work, progress and floored beat before metadata`; `M6 %j opens labelled metadata without opening task details`; `M6 pointer disclosure activation cannot bubble into card-level task opening`; `M6 registration-only cards expose metadata through a collapsed disclosure without a task action` |
| M6 detail and focus | `M6 task activation with %j exposes read-only detail; Escape returns focus`; `M6 task-bearing card pointer activation preserves local inspection`; `M6 metadata disclosure and task opening remain independently operable` |
| M6 grouping and narrator | `M6 grouping preserves exact labels, missing versus literal Ungrouped, urgency and tie ordering`; `M6 optional narrator node is retained once in its labelled slot`; `M6 omitted narrator supplies no fabricated narration` |
| M7 safety/compatibility | `M7 rendering, disclosure and task detail preserve the frozen model and perform no network request`; `M7 Models and collapsed legacy guidance remain available without activating chat`; `M7 existing Wall task-to-chat activation remains available`; `M7 Swarm disclosure/detail never activates agent_wall message/task handlers` |

## Final Amendment B

| Binding provision | Disposition |
|---|---|
| Local mount contracts and expanded surface | Read `src/app/agent_wall.ts`, `src/views/index.ts`, `src/views/plan.ts`, `src/views/swarm.ts`, `src/app/swarm_vm.ts`, `styles/plan.css`, `styles/swarm.css` and cited hosting startup. No product or shared-type edits are authorized here. |
| Supersede U118 M2 and its Amendment B section 1 | R40 Wall-first, Agenda/Archive validity and Swarm-secondary expectations are encoded in A1. Old Swarm-first assertions do not override these tests. Existing U118 files cannot be amended in this assignment. |
| Rewritten M3–M6 | Test task-specific owner joins, existing readiness, global strip cap, exact grouping and independent disclosures through public behavior. No unprovided strip export signature is assumed. |
| Future `live.ts`, `connected:false`, identity attacks, rooms/IDs, literal `"Ungrouped"`, timer cancellation, message callback non-activation | Covered in A2/A3/A4/A5 and M7 rows. “Future `live.ts`” is interpreted as a future live timestamp: the admitted type has `live.beat_ts` and the existing freshness rules reject future evidence. No new `live.ts` module or field is invented. |

## Interpretation boundaries

- “At most five” is an upper bound [CITED: M5]; a nonempty strip need not fill its entire allowance. No row class, strip export, exact wrapper tag or exact strip accessible label is selected by the tests.
- U136 agent state describes the agent's selected work. A multi-task owner's chip may therefore say Working while another owned task's unchanged ring says Waiting; blockers remain attached to their downstream task identity.
- Current task/microtask IDs and beat ages in the strip come from supplied model fields. Null beat evidence is not zero. The exact `No beat observed` text is required; observed ages are floored as specified.
- Agent-chip adjacency is checked against the existing task header/ring seam; actual dot appearance, spacing and wrapping require physical rendering. A supplied harness containing a state word cannot stand in for state evidence.
- No new input, composer, terminal, lifecycle action, room mutation, transport or provider invocation is introduced. Existing Wall chat activation is exercised without submitting a message.

## External and other-unit gates: out of scope for authoring

| Surface | Required external disposition |
|---|---|
| `tests/unit/u118/wall.test.ts` | Amendment of the old default, explicit views, invalid values and Swarm-specific assertions belongs to its owner. New equivalents live in U138; no old file is changed. |
| `tests/unit/u118/hosting.test.ts` | Models sheet, Escape/focus, policy wording and factory defaults remain its regression authority. U138 observes the existing Models callback; it does not substitute a fake policy or sheet result. |
| `tests/unit/u112/view.test.ts`; `tests/unit/u136/view.test.ts`; `tests/unit/u136/detail.test.ts` | Their specified metadata/disclosure expectation amendments belong to those files' owner. Derivation, lifecycle and registration contracts remain frozen. |
| `tests/unit/u36/` | Preserve compatible destination, shortcut, controlled-selection and editable-focus checks. `structure.test.ts:113` and `keyboard.test.ts:29` require the explicitly specified expectation amendments; U138 cannot edit them. |
| `tests/unit/u38/v6_drawer.test.ts`; `tests/unit/u42/wall_ui.test.ts` | Existing drawer open/close and task/card activation remain external regressions. |
| `tests/unit/u51/o12_o14_static_status.test.ts`; `tests/unit/u61/wall_u61.test.ts`; `tests/unit/u62/memory_a11y.test.ts` | Models/callback containment, Agenda startup/navigation and primary focus/announcements remain external regressions. |
| `tests/unit/u72/static.test.ts`; `tests/unit/u72/repair1.test.ts` | Preserve compatible cascade/demo checks; the stale stylesheet-import expectation requires a separate oracle correction. |
| `tests/unit/u78/interactions.test.ts`; `tests/unit/u78/content.test.ts` | Existing theme/help/phase behavior and Archive wording remain external regressions. |
| Capsule check | Desktop/narrow frames at 1440×900 and 390×844, dark mode, reduced motion, 200% zoom, actual focus appearance, clipping/overlap/page scroll and fresh image/hash receipts are manual physical-rendering gates [TARGET]. jsdom cannot certify them. Visual receipts: **AUSENTE — no inventar**. |
| Outside U138 | Stores, transports, backend gates, error codes, lifecycle authority, providers, narrator inference and legacy messaging features are not modified or reimplemented. Unrelated suite failures are not U138 feature failures. |

## Verification

Run from the repository root with installed dependencies and no network:

```sh
npx vitest run tests/unit/u138 --no-cache
npx tsc --noEmit -p .
npm test -- --no-cache
```

All U138 tests use fake time, fake ports, finite fixtures and bounded event/microtask loops. No test starts a service or makes a network request. Cache output is disabled for verification runs.

Before authoring, the unit baseline was `Test Files  22 failed | 350 passed (372)` and `Tests  82 failed | 11300 passed | 9 skipped (11391)` [MEASURED]. TypeScript already reported 16 diagnostics [MEASURED]. These are pre-existing blockers to an all-green claim, not missing evidence treated as zero. Final execution counts are reported separately after the tests are complete; no local execution paths or machine-specific receipts are published here.

Final verification [MEASURED]:

```text
Test Files  2 failed (2)
     Tests  86 failed | 34 passed (120)
```

The red assertions identify the current Swarm default, missing destinations, absent Wall derivation/chips/dependency ownership/strip, and absent collapsed metadata disclosures. Stub-error occurrences: zero [MEASURED]; the exact-signature precondition above remains unresolved.

Full unit run [MEASURED]:

```text
Test Files  24 failed | 350 passed (374)
     Tests  168 failed | 11334 passed | 9 skipped (11511)
```

The existing failure count remains 82 tests across 22 files [MEASURED]. TypeScript still exits unsuccessfully with the same 16 existing diagnostics and byte-identical diagnostic output; authored-file diagnostics: zero [MEASURED]. This is a fail-first oracle, not an all-green implementation receipt.
