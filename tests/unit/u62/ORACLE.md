# U62 fail-first oracle

Authority: `.unit/SPEC.md`, including its binding Amendment W0-R. The public VM names are the rendering contract. Tests exercise public functions and specified DOM classes/ARIA behavior, without requiring an internal component structure.

## Acceptance map

Each name below is an `it` title or its unique prefix; parameterized names expand into separate tests.

| Spec case | Test file | Test names / assertions |
| --- | --- | --- |
| O1 | `plan_view.test.ts` | `O1 published limits are frozen and match the spec`; `O1 computeProgressPct(...)`; `O1 empty plan band shows 0% rather than supplied progress`: zero, negative, non-finite, over-complete and integral positive progress; computed band text. |
| O2 | `plan_view.test.ts` | `O2 band includes ordered active phases...`; `O2 band appears above grouped task cards in mountWall`; `O2 empty tasks retain phase chips...`; `O2 declared phase order...`; `O2 task states and ... verdict reason/source`; `O2 verdict provenance preserves ...`; `O2 dependency line...`; `O2 plan card opens...`: all required card metadata/statuses, phase ordering, unknown-phase retention, progress, active/idle agents, brief and findings. |
| O3 / R11 | `plan_view.test.ts` | `O3 ... expands and collapses done outcome...`; `O3 mountWall announces done-detail expansion and collapse politely`; `O3 ... without detail never opens an empty drawer`: click, Enter, Space; actual visible outcome/evidence; provenance; expanded state; exact announcement messages; negative controls. |
| O4 | `views_mapping.test.ts` | `O4 maps Now, Next and two Blocked items...`; `O4 dependency-ready blocked tasks...`; `O4 archived pending tasks...`; `O4 blocked microtasks...`; `O4 empty agenda...`; `O4 mountWall honors pre-supplied plan agenda`: ordered groups, cardinalities, assignment and blocked/dependency reasons. |
| O5 | `views_mapping.test.ts` | `O5 diary groups same-day microtasks and memory updates...`; `O5 empty diary...`; `O5 mountWall diary routes...`; `O5 archive includes count/duration/outcome/source and restore...`; `O5 mountWall archive routes plan count, outcome and restore`; `O5 archive renders without optional restore callback`: day grouping, timestamps, authors, evidence, duration, taskCount/legacy steps, source, restore callback. |
| O6 | `memory_a11y.test.ts` | `O6 published memory limits are frozen and match the spec`; `O6 populated author/time and required-empty flag...`; `O6 missing/empty memory...`; `O6 optional empty memory...`; `O6 memory is available without an active plan...`: required flags, populated text/metadata, empty-state English copy, no mutation controls. |
| O7 | `memory_a11y.test.ts` | `O7 archive ArrowRight activates/focuses memory...`; `O7 phase selection...`; `O7 destroy removes listeners...`; `O7 valid host renders the plan and invalid hosts...`; `O7 legacy no-plan cards/workspaces/model trigger...`: tab roles/selection, ArrowLeft/ArrowRight/Home/End, controlled updates, focus, polite announcements, exact host error, retained-node/document listener cleanup and existing callbacks. |
| O8 | All test files | All `O8` tests: literal XSS strings in plan/task/memory fields, metadata and evidence; deterministic task/microtask/phase/memory truncation; dependency/evidence/estimate/title/text bounds; malformed outer/nested payloads; missing/empty optional VM fields on update across every view. |
| O9 | `memory_a11y.test.ts` | `O9 view modules exclude unsafe HTML sinks...`; `O9 plan stylesheet has no external assets...`; `O9 memory panels enforce reading width...`; `O9 plan renders dependency text without SVG/Canvas graphs`. Regression and typecheck commands below complete the external verification gate. |

## Behavior-rule cross-reference

| Spec §4 rule | Coverage |
| --- | --- |
| Backward compatibility | O7 legacy regression test; existing `tests/unit/u36` and `tests/unit/u51`. |
| Untrusted text / Stop Rule 1 | O8 literal-text and DOM checks; O9 static checks. |
| Plan band | O1; O2 band and router tests; O8 phase/title bounds. |
| Phase grouping | O2 declared/unknown phase order and empty tasks; O8 global task cap. |
| Task anatomy | O2 states, dependency formatting, provenance; O8 metadata/list bounds. |
| Done detail | O3 standalone and integrated disclosure tests. |
| Agenda | O4 mappings and explicit supplied agenda; W0-R blocked eligibility negative control. |
| Diary | O5 grouping, integrated routing and exact empty-state copy. |
| Archive | O5 metadata, count fallback and callback. |
| Memory | O6; O8 bounds; O9 computed reading width. |
| Keyboard / announcer / destroy | O3 integrated live region and O7 navigation/lifecycle/phase tests. |
| Tokens / copy | O9 CSS token and external-asset checks; specified English strings across O1–O8. |
| Dependency graph exclusion | O9 no SVG/Canvas; O2 textual dependencies. |

## Binding amendments and scope

| W0-R provision | Treatment |
| --- | --- |
| Row 1 | The supplied specs are not declared missing; their upstream implementations are not presumed available. |
| Row 8 | Dependency readiness is distinct from actionable Agenda eligibility. A blocked task with no dependencies is excluded from Next. Memory renders without an active plan. Other reducer lifecycle behavior is out of scope. |
| Row 19 | Use U62 VM shapes. Canonical state/ts/verdict adapters, `plan_get` nesting and room-event folding belong to U61/U63 and are out of scope. |
| U62 stylesheet integration paragraph | `hosting/src/main.ts` is the verified shipped entry: it imports `styles/tokens.css`, `styles/wall.css`, `styles/views.css`, `styles/model_selector.css` and `styles/agents.css`. Connecting `styles/plan.css` at that entry belongs to integration; do not edit it here or count its missing import as an oracle failure. |
| Rows 2–7, 9–18, 20 | Operation validation, revisions, takeover, idempotency, canonical projection/fixtures, atomic posting, MCP envelopes, redaction and AI privacy/budgeting are out of scope: U55–U61/U63. No failures are attributed to those units. |

Also out of scope: editing or persisting plan/memory state, multiple-plan switching (U71), Firestore plan sync (U66), boot wiring (U64), Nano prompt execution (U63), Python reducer/MCP work, and visual dependency graphs. The latter exclusion is verified as a rendering stop rule.

## Resolved ambiguities

- `empty` is a collection state, not a new `TaskStatusVM` value. Unknown/unassigned phases may be named Other or Unassigned. No empty-group body shape is imposed.
- Progress rounding is unspecified. Positive fixtures use an exact integral percentage; invalid and clamped cases follow the explicit rules.
- No ordering between Diary days is specified. Assert membership/grouping, not chronological ordering. No ambiguous mixed active-and-blocked task precedence is imposed.
- Keep the legacy controlled `mountWall` model: navigation calls `onView`; the owner then calls `update`. Focus and live-region assertions follow that update. Native button keyboard activation is simulated because jsdom does not synthesize trusted click defaults; custom disclosure controls must implement keyboard activation themselves.
- `design/tokens.css` and `design/components.css` are AUSENTE in this copy. `styles/tokens.css` exists and is imported by the shipped entry, so it supplies the token vocabulary until the specified design token file exists. No unverified design path is created. `styles/plan.css` is an implementation deliverable tested after band rendering succeeds, rather than an immediate missing-file failure.
- `src/views/types.ts` currently lacks the additive VM types. The permitted stubs temporarily declare the missing structural contracts locally; tests derive public parameter types and use structural fixture extensions. No ambient module augmentation or production type-file edit conceals the missing work.
- Integration tests render reference helper output before comparing router behavior. This gives meaningful helper failures while the stubs remain, and still checks integration once helpers exist. No test asserts that stub behavior is correct; no skips or expected-failure markers are used.

## Verification

Run from the repository root:

```sh
npx vitest run tests/unit/u62
npx vitest run tests/unit/u36 tests/unit/u51
npx tsc --noEmit -p .
```

All fixtures use a fixed fake clock; no network, storage access, real timers or subprocesses run inside tests. Static tests only read repository-relative source/style files. The regression gate was green before changes. The project-wide typecheck already had errors outside the allowed write surface before the oracle was added; compare its diagnostics before/after rather than treating those existing errors as new U62 failures.

Final measured verification:

```text
Test Files  3 failed (3)
     Tests  86 failed | 4 passed (90)

Test Files  20 passed (20)
     Tests  491 passed (491)
```

All failed assertions include `U62 stub` [MEASURED]. The passing oracle checks are the frozen plan limits, frozen memory limits, safe static source and legacy no-plan behavior. Project TypeScript diagnostics are byte-identical to the baseline: 16 existing errors [MEASURED], none in `tests/unit/u62`, `src/views/plan.ts` or `src/views/memory.ts` [MEASURED]. Global typecheck remains red; it is not claimed green.
