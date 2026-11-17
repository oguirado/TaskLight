# U159 fail-first keyboard oracle

The binding `.unit/SPEC.md` contains the compact `SPEC_U159` statement. A numbered acceptance list and final Amendment sections are **AUSENTE** in this workspace. The acceptance identifiers below number its clauses for traceability; they do not add a product API or mandate a particular focus-management strategy.

## Acceptance mapping

Every test name below is in `tests/unit/u159/focus.test.ts`.

| Case | Binding behavior | Test names |
| --- | --- | --- |
| AC1 | Exact forward keyboard order over the seeded Wall, including every task control. | `AC1 Tab traverses every control and all thirty tasks in exact DOM order` |
| AC2 | Shift+Tab from any control returns to its DOM predecessor; forward and reverse paths agree. | `AC2 Shift+Tab traverses the complete thirty-task fixture in exact reverse order`; `AC2 every control returns to its actual predecessor and round-trips with Tab` |
| AC3 | Reproduce Tab to Brief, Shift+Tab, Enter without accidentally opening the tail task. Hidden content cannot become a sequential target; an offscreen control is allowed when it truly is adjacent. | `AC3 Tab to Brief then Shift+Tab and Enter cannot accidentally expand T30`; `AC3 an offscreen T30 is allowed only when it really is the previous control`; `AC3 closed legacy Messages and inactive panels never enter sequential navigation` |
| AC4 | Existing focused controls restore predictably after refresh, including roving navigation. Subsequent Tab and Shift+Tab retain their origins. | `AC4 preserved %s focus and adjacent order survive a beat refresh` (phase and microtask variants); `AC4 every task-title control retains focus by identity after a beat refresh`; `AC4 Shift+Tab after a focused title refresh returns to the true predecessor`; `AC4 Tab after a focused title refresh advances to the true successor`; `AC4 fifty beat-only refreshes preserve title focus and the complete keyboard sequence`; `AC4 a selected navigation control restores predictably under either navigation pattern` |
| AC5 | A tabindex leak on the final card must make the order oracle fail. The oracle must also observe application keyboard interception. | `AC5 negative control catches a T30 %s leak` (extra zero tab stop and positive priority variants); `AC5 negative control catches an intercepted Shift+Tab from Brief to T30` |

## Fixture and oracle independence

`tests/unit/u159/helpers.ts` mounts the existing `mountWall` renderer. It consumes the existing fixture constructors in `tests/unit/u136/fixtures.ts`, the existing `toWallVM` projection seam, the unchanged `deriveSwarmViewModel`, and real `applyOp` activity beats. No missing-module imports, substitute product implementations, or stub source files are introduced.

The fixture contains T01 through T30 with distinct microtask identifiers T01.M01 through T30.M01, repeated task titles and microtask labels, and a phase control named Brief. Fixture dimensions are thirty tasks and five agent registrations [TARGET]. The exact persona seed payload is **AUSENTE**; this is an equivalent deterministic keyboard fixture. Brief is rendered through the existing phase API with `brief` and `build` identifiers. All task and microtask controls must be present before any navigation assertion runs, so truncating or emptying the fixture cannot pass.

The reference order uses visible, enabled sequential controls in DOM order, independent of positive tabindex sorting. Within the task list, identifier sequences are additionally pinned to the fixture's declared task and microtask identifiers. Navigation may use plain buttons or roving tabs; unselected roving controls are omitted from sequential traversal. Document sentinels establish entry and exit without requiring browser-chrome focus or an invented wrap policy.

jsdom does not implement the browser defaults for Tab and keyboard activation. The helper dispatches real cancelable keyboard events, honors application `preventDefault` and focus handlers, then supplies only the unimplemented native default. Its Tab default sorts positive tabindex values before zero values; the reference order does not. Its Enter default activates native controls only when handlers have not consumed the event. The intercepted-key negative control prevents a helper that merely focuses the expected predecessor from passing unnoticed.

Both tabindex mutations are applied only to the mounted test DOM. The same complete forward/reverse assertions used by the positive cases must throw a focus-order assertion. A caught negative-control failure is green; introducing the same leak into the product must make its positive order tests red.

“Outside the visible region” does not mean removing offscreen controls from keyboard navigation. Hidden/inert/disabled content and descendants of closed disclosures are excluded. The offscreen-tail case supplies deterministic geometry and proves that the genuine predecessor may be offscreen, while Brief's unrelated predecessor cannot become T30. Actual viewport layout, scrolling and visual order require a rendered-browser receipt, which is **AUSENTE**. These DOM tests do not claim such a receipt.

Refresh continuity requires the same semantic control when it still exists, without requiring retention of the same DOM node. Every task title is checked, and repeated labels cannot substitute for task identity. Accepted activity beats change liveness while task states and rollup remain equal. The hostile sequence uses fifty beat-only refreshes [CITED: supplied U150 continuity scope]. A selected navigation control is exercised through whichever existing navigation pattern is exposed.

## Relevant existing surfaces

| Identifier | Existing path | Relationship |
| --- | --- | --- |
| U159 | `.unit/SPEC.md` | Binding compact focus-order mandate. |
| Wall shell | `src/views/index.ts` | Focus capture/restoration, controlled updates, phase and microtask controls. |
| Plan task controls | `src/views/plan.ts` | Named native task-title disclosures and microtask controls. |
| Wall contract | `src/views/types.ts` | Existing plan, phase and task input types. |
| Projection seam | `src/app/agent_store.ts` | Existing `toWallVM`; no production modifications. |
| Read-only view model | `src/app/swarm_vm.ts` | Existing `deriveSwarmViewModel`; no production modifications. |
| Beat reduction | `src/plan/reducer.ts` | Existing `applyOp` accepts the hostile sequence locally. |
| Shared fixture | `tests/unit/u136/fixtures.ts` | Existing deterministic projection and event constructors. |
| U150 continuity | `tests/unit/u150/continuity.test.ts` | Related workspace and Swarm continuity coverage remains separate. |
| U152 navigation | `tests/unit/u152/navigation.test.ts` | Related navigation-pattern coverage remains separate. |

## Stop rules and exclusions

Fixture absence, missing controls, rejected beat operations, duplicate control identities and exhausted navigation boundaries fail assertions; they are never treated as successful empty runs. Fake clocks and fake timers are installed before mounting, timers are cleared during cleanup, and network entry points throw and are asserted unused. Traversals and refresh loops have explicit bounds. The compact U159 spec supplies no additional numbered stop-rule list: **AUSENTE**.

| Other unit or evidence | Out of scope for U159 |
| --- | --- |
| U150 / `src/views/swarm.ts` | The separate T05 Swarm-detail / worker-a / T01 reproduction, metadata expansion, lifecycle announcements and beat silence. U159 covers sequential focus origins on the Wall, not another copy of these acceptance cases. |
| U148 | Non-article roots, task/agent state distinctions, dependency wording and the full task-detail content contract. Existing controls are consumed without changing their design. |
| U152 | Sidebar layout, provider truth, Models opener count, panel semantics and narrow-screen presentation. Either complete navigation pattern is accepted here. |
| U153 | Selector documentation, raw accessibility-tree receipt separation and authentication claims. |
| U155 / R42 | Persona scoring, actual viewport/zoom geometry and screen-reader output. |
| U138r3 follow-on | Store element validation, stale-map eviction and synchronous timeout re-entrancy in `src/app/agent_wall.ts`. |

No public file contains private host paths, tool names or execution-spool references. No browser, network, external service, product file or existing test is modified. Scope is limited to the provided U159 specification and the existing repository surfaces listed above.

## Verification

Commands:

```sh
npx vitest run tests/unit/u159
npx tsc --noEmit -p .
```

The U159 run contains sixteen tests: four red and twelve green [MEASURED]. Exact summary:

```text
 Test Files  1 failed (1)
      Tests  4 failed | 12 passed (16)
```

All red results are assertion failures in AC4. Every task-title control loses focus to `document.body` after a beat refresh. The continuation checks require restoration before issuing the next key, so their red verdict does not depend on an assumed native browser starting point after a focused node is detached. The hostile beat sequence observes the same loss. There are no import, fixture, timeout or infrastructure failures [MEASURED].

The direct static Brief reproduction, complete forward/reverse walks, preserved phase/microtask and navigation refreshes, hidden-content checks and all negative controls are green [MEASURED]. The package's live Brief observation is preserved as a regression requirement, not represented as a newly captured browser receipt.

The typecheck exits nonzero because of existing errors. Its output is byte-for-byte identical to the baseline captured before creating these tests; it adds no error in `tests/unit/u159` [MEASURED].

Related existing suites were also checked:

```sh
npx vitest run tests/unit/u36 tests/unit/u136 tests/unit/u138 tests/unit/u148 tests/unit/u150 tests/unit/u152
```

Exact regression summary [MEASURED]:

```text
 Test Files  31 passed (31)
      Tests  906 passed (906)
```
