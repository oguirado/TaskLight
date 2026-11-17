# U153 fail-first oracle

Scope: `docs/MACHINE_OPERABILITY.md` and the shared oracle fixture in `tests/unit/u153/`.
The supplied `.unit/SPEC.md` has no numbered acceptance list or Amendment sections.
The case numbers below map its requirements in source order; they add no product API.

| Case | Spec requirement | Test names in this directory |
| --- | --- | --- |
| A1 | Document all required selectors | `A1 documents the exact public hook %s` (one case per hook) |
| A2 | Hooks are not authentication | `A2 explicitly states that hooks are not authentication` |
| A3 | Keep raw CDP, pruned and AT-SPI receipts separate | `A3 distinguishes raw CDP, pruned and AT-SPI receipts as separate evidence`; `A3 %s: actual document content and a present target pass independently`; `A3 raw CDP success cannot substitute for pruned CDP or AT-SPI receipts` |
| A4 | Every documented selector has a unique target in the active workspace | `A4 all documented hooks identify one qualified target in the active workspace`; `A4/A5 negative calibration: duplicate selector targets and broken or duplicate ARIA IDs are rejected` |
| A5 | Every ARIA reference resolves | `A5 every ARIA ID reference resolves before and after opening the real Models sheet`; the A4/A5 negative calibration; the A6 hostile case |
| A6 | Hostile: the local task ID occurs in two workspaces | `A6 hostile duplicate T01 in two workspaces is reacquired after each workspace switch` |
| A7 | Negative/stop: an empty accessibility tree fails its precondition | `A7 reports an empty accessibility tree as a failed precondition`; `A7 %s: an empty tree fails the precondition, including an empty expectation list`; `A7 %s: an absent tree is not a successful empty audit`; `A7 absent receipt and browser-only exposure stop before content assertions`; `A7 an available tree with no acceptance targets cannot pass vacuously` |
| A8 | Hold the shared opaque-article pruning fixture | `A8 pruning emits the article, drops its descendants and preserves non-article controls`; `A8 DOM surrogate respects the %s boundary` |

## Hook coverage and scope

| Required hook | Concrete target used by the DOM oracle |
| --- | --- |
| `.app[data-view][data-workspace]` | The single mounted app, then assert its current view and workspace |
| `button[data-nav]` | `button[data-nav="wall"]` inside the active app |
| `button[data-wsid]` | `button[data-wsid="alpha"]`, then `beta`, inside that app |
| `[data-task-id]` | `.task[data-task-id="T01"]` inside that app |
| `[data-task-vm-id]` | `.task[data-task-vm-id="plan:alpha:T01"]`, then the selected workspace value |
| `button.step-row[data-micro-id]` | `button.step-row[data-micro-id="T01.M01"]` inside the selected task card |
| `[data-phase-id]` | `button[data-phase-id="P01"]` inside that app |
| `[data-plan-id]` | `[data-plan-id="plan-alpha"]`, then the selected workspace plan |
| `button[aria-controls="model-sheet"]` | The single Models opener inside that app |
| `[id="step-T01.M01"]` | The literal attribute selector inside the selected task card |

Generic hooks describe families of nodes, not singleton queries. Value qualification and task-card scope
are necessary because message controls, task cards and microtask controls can share a task ID.
The test does not require globally unique local task IDs or a new workspace attribute on every control.
Dotted IDs use literal attribute selection, avoiding the interpretation of dots as CSS classes.
Workspace-switch tests reacquire nodes and never use retained geometry or stale node references.

The ARIA audit checks all DOM ID-reference attributes: `aria-activedescendant`, `aria-controls`,
`aria-describedby`, `aria-details`, `aria-errormessage`, `aria-flowto`, `aria-labelledby`, and `aria-owns`.
Every token must match exactly one ID in the composed document, including hidden disclosure panels.
The actual `createModelSheet` is mounted alongside `mountWall`; there is no fabricated dialog stub.

## Fail-first signal and negative controls

Only existing product exports are imported. Missing `docs/MACHINE_OPERABILITY.md` is converted to empty
text so the required contract assertions fail, rather than failing module loading or file access.
The documentation tests require the exact mandated hooks and the authentication/receipt/stop statements;
they do not prescribe headings, receipt filenames, JSON schemas, or a production receipt-gate API.
Document wording checks accept alternatives such as separate, distinct, or independent receipts.

`pruning_fixture.ts` is a real test utility, not a stub for missing product code. Its gate is test-local:
empty or absent trees return `failed_precondition`; an available document missing a target returns
`fail`; a populated document with the required target returns `pass` for that receipt lane only.
A browser shell alone cannot prove document accessibility. A missing acceptance list cannot pass.
An always-pass mutation fails the A7 controls. Omitting article pruning fails A8; dropping ordinary
non-article descendants also fails A8. DOM duplicate-target and broken-ID mutations fail A4/A5.
No mutation is written to product files. Fixture calibration tests may be green on the baseline;
they establish that the oracle rejects known-bad evidence. Existing DOM-hook preservation may also be green.

All timers are fake, all inputs are local and bounded, and tests perform no network requests.
The test clock is fixed. Cleanup disposes both real components and removes the DOM after each case.

## Verified baseline [MEASURED]

`npx vitest run tests/unit/u153` exits with the expected assertion failures:

```text
 Test Files  1 failed | 1 passed (2)
      Tests  13 failed | 20 passed (33)
```

All red cases assert the missing `docs/MACHINE_OPERABILITY.md` contract. There are no import or runtime
loading failures. The DOM preservation and receipt/pruning calibration cases pass.

`npx tsc --noEmit -p .` reports the same baseline 16 errors [MEASURED], with no diagnostic in
`tests/unit/u153/`. The related `tests/unit/u51/` and `tests/unit/u62/plan_view.test.ts` suites retain
163 passing tests [MEASURED] before and after this oracle was added. This is a targeted regression
check, not a claim that every pre-existing suite is green.

## Out of scope and evidence limits

| Related unit or surface | Disposition |
| --- | --- |
| U146, `src/views/swarm.ts` | Non-article Swarm cards, metadata identity and focus movement are out of scope; the fixture is supplied for that unit's pruning assertions |
| U148, `src/views/plan.ts` | Task-card redesign, read-only details, both microtask branches and stable accessible names are out of scope |
| U150, `src/views/index.ts` | Fallback article removal, focus/expansion continuity and lifecycle announcements are out of scope |
| U152, `src/views/index.ts`, `styles/views.css` | Navigation pattern, opener consolidation and narrow layout are out of scope; existing hook uniqueness is checked without redesigning them |
| U155, U114/U130 | Live browser and accessibility captures, persona scoring, zoom, rendered contrast and screen-reader output are out of scope |
| `src/app/swarm_vm.ts`, `deriveSwarmViewModel` | Read-only; no new state authority or projection behavior is introduced |

Live raw CDP receipt: AUSENTE. Live pruned receipt: AUSENTE. Live AT-SPI receipt: AUSENTE.
The normalized trees and DOM pruning surrogate are synthetic oracle evidence, never live interoperability receipts.
Hooks are not authentication; these tests do not change caller-asserted trust or room authorization.
No commit, push, deploy, external accessibility-tree automation client, or visual engine is run.
This oracle's mandate is confined to the supplied spec and the isolated project corpus.
