# U148 fail-first oracle

Status: **FAIL-FIRST — not ADMIT**.

Authority: `.unit/SPEC.md`, read completely through its final carried-debt paragraph. A numbered acceptance list and Amendment sections are **AUSENTE — no inventar** in that file. A1–A9 below are local traceability labels for the supplied MUSTs, oracle, hostile/negative cases and carried debt; they do not invent additional specification sections.

Only `tests/unit/u148/` is authored. The product and existing suites are unchanged. No stub, missing import, expected product exception, skip, or `it.fails` manufactures red.

## Source and fixture surface

| Relative path | Use |
|---|---|
| `.unit/SPEC.md` | Binding task-card requirements and non-blocking carried debt. |
| `src/views/plan.ts` | Existing `renderPhaseTaskCards`, `renderStepRow`, `groupTasksByPhase`, `PLAN_VIEW_LIMITS`, `formatWaitsFor`, dependency ownership and question handling. Current coordinates were re-pinned before writing the oracle. |
| `tests/unit/u62/plan_view.test.ts`, `tests/unit/u62/helpers.ts` | Existing card, disclosure and deterministic-mount contracts and compatible fixtures. |
| `tests/unit/u138/ORACLE.md` | Independent task/agent state interpretation: an owner's Working chip can coexist with a Waiting task ring. |
| `tests/unit/u138/helpers.ts`, `tests/unit/u136/fixtures.ts` | Existing plan projection, lifecycle, ownership, dependency and Wall fixtures. |
| `src/views/index.ts` | Read-only inspection of `mountWall` cloning and delegated disclosure handling; full mounts exercise the actual integration. |
| `src/views/agent_strip.ts` | Existing lifecycle precedence and owner chip seam; no authoring here. |
| `tests/unit/u153/pruning_fixture.ts` | Shared `elementsAfterOpaqueArticlePruning` surrogate for accessibility-tree automation clients. |
| `src/app/swarm_vm.ts` | `deriveSwarmViewModel` remains read-only and unchanged; no model replacement is used. |

## Acceptance mapping

Every test name below belongs to `plan_card.test.ts`. Parameter placeholders retain the declared test-name pattern. The expected contrast is stated before interpreting the result.

| Local case | Supplied requirement | Exact test names | Gate and negative contrast |
|---|---|---|---|
| A1 | Non-article task root with preserved identity; operator's named-container decision. | `A1 %s retains a named non-article task identity` | Both renderer and mounted Wall must preserve `.task[data-task-id]`, resolve an explicit task name and avoid article semantics. Restoring an article fails. |
| A2 | Header order: task id, title, done/total, ring beside one owner chip. | `A2 header reads id then title then persisted done/total then ring beside one owner chip`; `A2 completion count uses done state rather than volatile done activity` | DOM reading order, visible completion count and adjacent owner identity must agree. Counting a transient Done activity or repeating the owner fails. Count text may use a slash or “of”, with text nodes or nested wrappers. |
| A3 | Title is the keyboard-operable, read-only detail control; hostile identical titles. | `A3 mounted title %j opens read-only task detail without chat`; `A3 identical task titles have distinct detail-control names carrying task identity` | Click, Enter and Space reveal read-only detail through the mounted integration. Identical titles retain distinct task names. An inert heading, editor, no-op activation or message callback fails. |
| A4 | `data-micro-id` on both microtask branches. | `A4 both disclosure and plain microtask branches expose exact dotted IDs` | Detail-bearing and plain rows retain their literal IDs, including `T01.M01`. Omitting the plain-row attribute fails. |
| A5 | Microtask names carry identity; volatile activity belongs in the description; hostile repeated labels. | `A5 repeated microtask labels have distinct names carrying their IDs across both branches`; `A5 same-state duplicate labels on separate tasks remain independently named`; `A5 %s name stays stable while Working moves to the description` | Names include identity and label, distinguish equal labels even with equal activity, and remain stable as Working changes to Waiting. The activity is still described. Dropping identity or moving activity back into the name fails. |
| A6 | Pruning keeps disclosures; no activation opens chat; local evidence remains operable. | `A6 pruning preserves every existing microtask disclosure on the mounted Wall`; `A6 pruning preserves the task-title detail control`; `A6 negative calibration: opaque article pruning actually removes nested disclosures`; `A6 mounted dotted-ID disclosure %j reveals local evidence and never chat`; `A6 identical labels and dotted IDs disclose only their own task's panel`; `A6 preserved card-background activation is read-only with a live legacy callback` | Existing disclosures must survive the shared transform. Literal dotted panel IDs resolve, local evidence opens and closes, equal labels do not open a sibling panel, and live message spies stay silent. The calibration proves that an opaque article removes descendants; an empty disclosure fixture cannot pass. |
| A7 | Preserve upstream ownership, unassigned/Missing task, and independent task/agent state. | `A7 blockers preserve upstream identity, unassigned and Missing task without cross-task leakage`; `A7 Waiting task ring remains separate from its Working multi-task owner chip` | Preserve “Waiting on T02 · executor-a”, “unassigned”, “Missing task” and each downstream task's own blockers. Reusing the downstream owner or another task's blockers fails. Waiting remains explicit apart from the owner's Working state. |
| A8 | Hostile Failed lifecycle with fresh activity; negative collapsed task/agent state. | `A8 negative calibration rejects collapsing %s state to %s`; `A8 %s fresh working activity never replaces %s lifecycle` | Supplied Working activity cannot replace Failed or Finished lifecycle. Independent-state assertions reject either direction of a local collapsed-state output mutant. Only detached DOM copies are mutated; no source file is patched. |
| A9 | Non-blocking carried debt: bounded, normalized waits; empty owner; aligned question object check. | `A9 dependency owner lines obey the published DEPS_MAX bound`; `A9 asStr normalization precedes dependency ownership lookup`; `A9 non-string dependency objects remain passive rather than becoming fabricated IDs`; `A9 empty-string upstream owner renders unassigned`; `A9 non-object operatorQuestion %j cannot manufacture Needs you`; `A9 a valid operatorQuestion preserves Needs you and its literal read-only prompt` | Dependency presentation obeys the existing bound and primitive string normalization before lookup. Objects must not become fabricated IDs. Empty owner means unassigned. Null/absent/primitive questions cannot change activity; a valid object preserves its literal prompt and Needs you. These debt failures retain the specification's NON-BLOCKING classification. |

## Interpretation and stop rules

- Completion counts use persisted microtask state, not live activity. The fixtures deliberately disagree on those values.
- The title may use native disclosure, an explicitly controlled panel, or a newly visible dialog/region. No new export, selector, detail-copy wording or wrapper tag is prescribed. The named root needs task identity; its title need not be repeated in its accessible name.
- Descriptions may use `aria-describedby`, `aria-description`, or the native title description. Description references must resolve. The existing name helper is a DOM surrogate, not a screen-reader receipt.
- The terminal projection already normalizes activity to Unknown. To test the supplied hostile case on the plan-card surface, the admitted view fixture explicitly supplies terminal lifecycle with fresh Working activity, keeping task activity separate. The test does not demand that `deriveSwarmViewModel` change.
- Negative state-collapse calibration mutates detached rendered output and requires the same assertions to reject it. It does not claim execution of a patched product implementation.
- A missing fixture, absent control, empty disclosure set or dangling panel/description reference is an assertion failure, never a pass. Import/setup errors do not establish fail-first behavior.
- Fake clocks cover every test and mounts are destroyed afterward. Fetch, XMLHttpRequest and WebSocket are blocked and asserted unused. No network, service, real timer wait, provider or backend transport is required.
- The carried debt stays non-blocking; the core failures independently establish missing U148 behavior. This oracle does not confer ADMIT or prove external launch prerequisites.

## Other-unit cases: out of scope

| Owner | Excluded work |
|---|---|
| U138p | Re-authoring removal of creation paths/card-to-chat routing and legacy Messages behavior. Existing read-only behavior is preserved and tested, not reported as missing. |
| U146 | Swarm card roots, metadata identity, detail focus and Escape return. |
| U149 | Agent-strip grouping, identity rows, global cap and liveness wording. |
| U150 | Fallback cards, refresh focus/expansion and lifecycle announcements. |
| U151 | CSS density, spinner motion, themes, reflow, contrast and reduced motion. |
| U152 | Navigation order, tab semantics, responsive sidebar and Models consolidation. |
| U153 | Shared receipt gates, active-workspace selector uniqueness and live accessibility receipts. Only its existing pruning fixture is reused. |
| U139–U145 | Backend lifecycle persistence, generation fencing, cleanup, work admission, mailbox delivery, transport scenarios and contract documentation. |
| U155 | Persona scoring and visual capsules. |

Live browser, accessibility-service, rendered contrast and persona receipts are **AUSENTE — no inventar**. Their absence is not an executable U148 failure.

## Verification

Commands run at the isolated project root:

- `npx vitest run tests/unit/u148`
- `npx vitest run tests/unit/u62 tests/unit/u138 tests/unit/u136 tests/unit/u153/pruning_fixture.test.ts --reporter=dot`
- `npx tsc --noEmit -p .`

Observed U148 result: **37 tests; 22 red and 15 green** [MEASURED]. All red cases are behavioral assertion failures, with no import, setup or unhandled-runtime failures. Core requirements account for 15 red cases and carried non-blocking debt for 7 [MEASURED].

Exact summary [MEASURED]:

```text
 Test Files  1 failed (1)
      Tests  22 failed | 15 passed (37)
```

Related existing-suite summary [MEASURED]:

```text
 Test Files  16 passed (16)
      Tests  512 passed | 1 skipped (513)
```

Typechecking retains the same 16 pre-existing diagnostics as the pre-authoring baseline, with no diagnostic in `tests/unit/u148/` [MEASURED]. A repository-wide clean typecheck is not claimed.
