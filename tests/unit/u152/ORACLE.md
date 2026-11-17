# U152 navigation and sidebar oracle

The supplied `.unit/SPEC.md` ends after its operator-decisions paragraph. Numbered
acceptance cases and final Amendment sections are **AUSENTE**. The cases below
number the stated MUSTs, oracle, hostile input and negative control; they do not
add requirements from another unit. Scope is limited to the provided U152 corpus.

| Case | Spec requirement | Test names |
| --- | --- | --- |
| AC1 | Preserve Wall 1, Agenda 2, Diary 3, Archive 4, Memory 5, Swarm 6. | `AC1 keeps Wall, Agenda, Diary, Archive, Memory, Swarm in order with shortcuts 1 through 6`; `AC1 clicking %s selects its view once`; `AC1 shortcut for %s selects its view once` in `navigation.test.ts`. |
| AC2 | Complete the tab/panel pattern or use plain navigation buttons; check selected-tab focusability and panel relationships. | `AC2 %s keeps its selected control focusable and completes roving focus when using tabs`; `AC2 %s has resolving tab/panel relationships or removes tab semantics`; `AC2 %s works for complete tabs; plain buttons retain native focus`; `AC2 tab/panel ids remain unique and local when two walls are mounted` in `navigation.test.ts`. |
| AC3 | Keep one Models opener with consolidated status copy. | `AC3 keeps one working Models opener across every destination and status refresh`; `AC3 %s has one passive record containing provider, reviewer and room policy` in `models.test.ts`. |
| AC4 | Collapse navigation at 390 px [TARGET]. | `AC4 collapses navigation at 390px instead of only stacking the expanded sidebar`; `AC4 all six destinations remain named and usable at 390px, after opening a collapsed menu if present` in `responsive.test.ts`. |
| AC5 | Hostile: an unavailable provider in a private room is never labelled active. | `AC5 an unavailable on-device provider with cloud disabled is never described as active`; `AC5 a ready-to-unavailable refresh removes a stale active-provider claim in the private room` in `models.test.ts`. |
| AC6 | Negative: a second Models opener must turn the oracle red. | The production-facing `AC3 keeps one working Models opener across every destination and status refresh` calls `assertSingleModels`; `AC6 the same production-facing opener assertion rejects a second Models opener` inserts a temporary duplicate and proves that exact assertion rejects it. |

Every path in the table is relative to `tests/unit/u152/`.

## Interpretation and boundaries

- Both semantic implementations are accepted. Plain buttons remove tablist and
  selected-tab ARIA; tabs use roving focus, resolving unique ids, visible selected
  panels and reciprocal labels. Tab keyboard handling accepts automatic or manual
  activation. The existing separation of primary views and secondary Swarm is
  allowed; no test requires Swarm to join the primary tablist.
- No exact ids, new exports, new components or new product files are assumed.
  Tests import the existing `mountWall` and mount contracts from `src/views/index.ts`.
- "Collapse" is underspecified. An accessible disclosure, a compact icon rail
  retaining names, or compact horizontal/multi-column navigation is accepted.
  Merely moving the unchanged expanded menu above the main view does not satisfy
  the case. No exact breakpoint, toggle label, selector or icon is required.
- The responsive fixture projects applicable width media rules from
  `styles/views.css` into the DOM environment. It checks CSS declarations and DOM
  accessibility, not pixel geometry. Unsupported media syntax fails its explicit
  precondition. Live layout, overflow, CDP, pruned and AT-SPI receipts are
  **AUSENTE**; this oracle does not claim them.
- Consolidated status means a passive readable record containing provider health,
  reviewer and room policy, with no repeated provider-label copy. Models remains
  the sole opener. `Rules` may truthfully be active while an unavailable provider
  is not. Availability comes through the existing read-only `availability` input;
  this unit does not invent a policy API or test inference routing.
- The duplicate-opener control mutates only the mounted test DOM and removes the
  duplicate afterward. It is a sensitivity check, not a substituted implementation
  or evidence of a production fix.

## Fail-first gates and stop rules

- Run `npx vitest run tests/unit/u152 --no-cache --no-fsModuleCache
  --no-file-parallelism`. Missing roving focus, tab/panel associations and responsive
  collapse must fail by assertion on the current product. Imports and collection
  must succeed. Preserved navigation and Models behavior may be green.
- Run `npx tsc --noEmit -p .`. Existing errors outside this directory remain
  baseline failures; any diagnostic inside `tests/unit/u152/` blocks acceptance.
- Re-run the cited suites: `tests/unit/u118/wall.test.ts`,
  `tests/unit/u36/keyboard.test.ts`, `tests/unit/u36/structure.test.ts`.
  No existing test or product file is edited.
- Time is frozen, timers are fake and cleared during cleanup, callbacks are
  in-memory ports, and unexpected `fetch` calls fail. No server, browser, real
  timer, package installation or network request is needed. Test caches are
  disabled. A missing dependency or collection error is a failed precondition,
  never a substitute for a fail-first assertion.
- Only `tests/unit/u152/` is writable. Do not alter `src/app/swarm_vm.ts` or
  `deriveSwarmViewModel`. No commit, push or deploy belongs to this oracle.

## Out of scope

| Unit or rule | Excluded case |
| --- | --- |
| U138p | Primary-card chat removal and legacy Messages changes. |
| U146 / U148 | Card-root replacement and opaque-article pruning. |
| U147 | Hosted model/narrator announcements and inference routing. |
| U149 | Agent-strip records, caps and lifecycle wording. |
| U150 | Wall refresh focus/expansion continuity and agent lifecycle announcements. |
| U151 | Density tokens, long-slug layout and microtask motion. |
| U153 | Machine-operability contract and live accessibility receipt gates. |
| U155 | Persona scores, zoom, theme and rendered layout capsules. |
| Backend units | Mailbox slices, terminal work admission and run identity. |

Operator decisions about those surfaces are preserved as boundaries, not reported
as U152 failures. Visual receipts from the context package are not rerun or used
as evidence that these unit assertions pass.

## Verification on the supplied tree

All tests collect and execute. Observed summary [MEASURED]:

```text
Test Files  2 failed | 1 passed (3)
     Tests  13 failed | 26 passed (39)
```

The failures are assertion failures: selected-tab roving focus, missing tab/panel
relationships and uncollapsed narrow navigation. No import, runtime fixture or
media-query precondition failure remains. The Models duplicate negative control
and private-room hostile cases pass on the preserved implementation.

The cited existing suites pass before and after adding this oracle [MEASURED]:

```text
Test Files  3 passed (3)
     Tests  110 passed (110)
```

`npx tsc --noEmit -p .` retains the same baseline of 16 diagnostics [MEASURED],
all outside `tests/unit/u152/`; no diagnostic is added by these files.
