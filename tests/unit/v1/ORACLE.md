# V1 fail-first oracle

Authority: the supplied `SPEC_V1`, acceptance cases M1–M9 [CITED]. It contains no final amendments. `strategy/R46/V1d_design.md`: AUSENTE — no inventar. The numbered MUST list governs where the earlier context differs.

## Acceptance mapping

Parameterized test names below identify the complete family, including every generated case.

| Acceptance | Tests and observable gate | Negative contrast |
|---|---|---|
| M1 | `navigation_sync.test.ts`: `M1 fresh controller mount selects swarm and labels it Agents`; `M1 More exposes every secondary destination, Models and narration`; `M1 preserved shortcut %s reaches %s`; `M1 shortcuts remain inert inside editable fields`. Uses `startAgentWall` for the default and `mountWall` for navigation. | A fresh `wall` default, missing More destination, changed shortcut mapping, or shortcuts consuming input fails. |
| M2 | `board.test.ts`: `M2 sums waiting idle registered, keeps finished separate, and includes nonzero failed unknown`; `M2 zero failed unknown are omitted and a genuine empty healthy room has zero totals`; `M2 a refresh publishes one summary change and an unchanged refresh does not reannounce`. Checks actual totals, copy, polite semantics and observed live-region mutations. | Counting only waiting, counting failed as finished, repeated live summaries, or a missing zero count fails. |
| M3 | `board.test.ts`: `M3 preserves inventory order despite lexical and legacy activity grouping order`; `M3 children and grandchildren are inside their own parent lane, never sibling roots`; `M3 every lane exposes harness and inventory state without opening agent metadata`; `M3 renders all owned tasks in plan order`; `M3 retains taskless inventory agents with No tasks yet`. `presentation.test.ts`: `M3 at %ipx child nesting declares %ipx indentation`. | Flat child lanes, activity/lexical regrouping, omitted taskless members or noncurrent tasks, and incorrect child indentation fail. |
| M4 | `board.test.ts`: `M4 every task, including a noncurrent task, is a collapsed named disclosure`; `M4 expansion exposes every microtask title state and completion alternative`; `M4 completion alternative handles %j without assuming completion from lifecycle`; `M4 hostile task microtask and harness strings remain passive text; rendering cannot mutate the snapshot`. `presentation.test.ts`: `M4 task and microtask bubbles reserve their distinct diameters`; `M4 partial task fill represents a fraction, with equal ratios sharing the same drawing`; `M4 pending active done blocked have distinct drawings plus independent text alternatives`; `M4 active arc obeys reduced-motion=%s with a static partial-fill alternative`. | Missing accessible state/count text, colour-only distinctions, all fractions drawing alike, unequal drawings for equal fractions, nonzero empty fill, or motion under reduced motion fails. |
| M5 | `board.test.ts`: `M5 %s has a name marker and preserves authoritative task and microtask states`. Failed and unknown fixtures deliberately own mixed-state work. | Missing identity marker or propagating agent failure/unknown into task or microtask state fails. |
| M6 | `navigation_sync.test.ts`: `M6 %s read failure retains the last good lanes below its reason banner`; `M6 reported projection sync faults are errors even when transport remains linked`; `M6 room unavailability shows a reason and retains the last good inventory`; `M6 first unavailable read is explicit, has a literal hostile reason and never invents healthy lanes`; `M6 recovery replaces retained content with current lanes and clears the error`; `M6 a genuine healthy empty inventory is distinct from an unavailable room`. `presentation.test.ts`: `M6 read failure dims last-good lanes without hiding or deleting them`. | A healthy empty fallback, omitted/blank error reason, lost cached lanes, undimmed retained data or an error persisting through recovery fails. |
| M7 | `interaction.test.ts`: `M7 each task independently retains expansion and semantic identity across state refreshes`; `M7/U166 a %s focus restoration preserves identity and both scroll roots`; `M7/U165 changing view resets the scrolling root after focus restoration`; `M7 a same-view refresh preserves scroll and does not align reopened disclosure content`; `M7 collapsing a task and refreshing cannot reopen it or move expansion to a sibling`. `presentation.test.ts`: `M7 state changes preserve the declared task bubble footprint`. | Recreated disclosure identities, lost/crossed expansion state, refresh-induced scrolling, detached content alignment, or a changing bubble footprint fails. |
| M8 | `interaction.test.ts`: `M8 Tab order contains each lane including taskless agents and every task disclosure`; `M8 %j opens and closes each task once, with Escape returning focus to its bubble`. | Removing a lane/button from sequential focus, double activation, missing collapse or Escape focus restoration fails. |
| M9 | `presentation.test.ts`: `M9 board state colours and keyboard focus use existing tokens without literal colour values`; `M9 %s theme preserves accessible states and resolves the state palette`. Paint-token traversal permits aliases; it does not prescribe a variable or CSS class name. | Hardcoded colours, missing state/focus token derivation, unresolved palette references or missing text alternatives fails. |

## Binding interpretations

- Header copy follows M2 exactly: `N working · M waiting · K finished`, rather than the older design text containing “agents working”. Failed and unknown are appended only when nonzero.
- A microtask's completion alternative is `1/1` when done and `0/1` otherwise [CITED: M4, interpreting the singular work item]. A task with no microtasks reports `0/0` and has zero fill [CITED: M4]. These alternatives describe known counts, without inventing completion.
- Agent and task order are consumed from the supplied inventory and task arrays. The microtask display order is not prescribed beyond stability. Runtime C2 inventory fields are represented by fixture types because the existing compatibility display type omits them; no product export is invented.
- A lane is located by visible agent identity and a containing semantic/focusable element. A task disclosure is located by its title and `aria-expanded`. Generated IDs, CSS classes, wrapper tags and state variable names are not prescribed. Stable existing IDs are checked only when present.
- Existing shortcut mappings are retained, independent of the new primary navigation order. More may be a disclosure, a menu or a labelled group.
- Errors are injected through existing `AgentStore.events`, `AgentStore.plan`, `PlanProjectionResult.errors`/`invalidOps`, and `workspaceStatus` seams. No new C5 port is assumed. A successful read after a fault must stop displaying the error and expose current inventory.

## Bounds, controls and stop rules

All fixtures use a fixed clock and fake timers; no real timer is advanced. Network constructors and fetch throw and are checked during cleanup. Mounts are destroyed, observers disconnected, globals restored and styles removed. View snapshots are deeply frozen. Hostile text is never interpreted as markup. The read-error tests assert that no room post is issued.

The oracle imports existing production exports only. A missing behavior must fail an assertion; an import, runtime, network or fixture/type error is an oracle defect and must be fixed before accepting the red run. Product code must not be changed to make this oracle collect. The four spec negative controls are represented explicitly in M1, M3, M4 and M6 [CITED]. No mutation of production code is required to run them.

CSSOM probes inspect matching declarations, inherited custom properties, pseudo-element declarations, media conditions and SVG paint attributes. They check task/microtask diameter declarations of 24/16 px [CITED: M4] and child indentation of 12/16/24 px at 390/768/1440 px [CITED: M3]. Fraction controls compare empty, partial and full drawings and equal-ratio drawings. State drawing comparisons normalize literal palette values so colour changes alone cannot satisfy them.

## Out of scope and remaining visual evidence

- C2 membership, freshness, lifecycle admission, parent-cycle rejection, reducers, inventory parity and totals derivation belong to C2. V1 consumes its inventory; an inventory fixture is not a second inventory implementation.
- Full C5 relay/transport propagation, recovery protocols, deadlines and MCP faults belong to C5. V1 covers the existing store and room-availability observations only.
- Native keyboard Tab traversal, rendered pixel geometry, exact arc coverage, vector check/pause shape, text wrapping, responsive layout and browser layout-shift measurements require browser visual receipts. JSDOM cannot certify these; visual receipts are AUSENTE. The CSS/DOM tests are declaration and semantic gates, not a claim of pixel verification.
- Existing U159/U165/U166 suites remain independent regression gates. These tests add board-specific focus/scroll cases without rewriting those suites or changing old default/navigation assertions.

## Verification

The V1 run collected 55 tests: 45 red and 10 green [MEASURED]. Every red diagnostic was an `AssertionError`; import and runtime errors were absent [MEASURED]. The exact test summary was:

```text
Tests  45 failed | 10 passed (55)
```

The summary above is [MEASURED]. The passing cases preserve existing keyboard shortcuts, editable-field exclusion, same-view navigation focus, changed-view scroll reset and genuine healthy-empty behavior. Red cases expose the absent board behavior; no production stubs were introduced.

`npx tsc --noEmit -p .` reports no diagnostics in `tests/unit/v1` and 16 diagnostics elsewhere [MEASURED]. The existing-suite run excludes V1 and reports:

```text
Test Files  1 failed | 420 passed (421)
Tests  8 failed | 12707 passed | 9 skipped (12724)
```

Those summaries are [MEASURED]. The failing file is `tests/unit/u164/parity.test.ts`, exclusively the existing U164/Python diagnostic-parity cases: `pending_parent`, `cancelled_parent`, `active_parent`, `blocked_parent`, `completed_whitespace_record`, `completed_empty_string_list`, `completed_whitespace_list`, and `completed_only_done_micros`. They are out of V1 scope and are not attributed to this oracle. Existing test files were not amended.

Final runs used `--no-cache --no-fsModuleCache --configLoader runner --maxWorkers=2` [MEASURED] to avoid dependency-directory cache and bundled-config writes. Final verification output is captured in memory; no receipt or spool is included here.

The oracle's mandate is limited to the supplied SPEC_V1 and the cited project code available in this workspace.
