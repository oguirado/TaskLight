# U51 oracle (fail-first)

Targets: `src/ui/model_selector.ts` (stub: types/constants final, functions throw `U51 stub`), `src/ui/shell.ts` (`badgeFor` -> `chipLabel`), `src/views/index.ts`, `src/agentsui/index.ts`, `styles/model_selector.css` (absent). Spec: `specs/SPEC_U51.md`.
Stub-phase edits outside tests: `src/views/types.ts` only (type-level: `SourceKind` 5-value, `WallHandlers.onOpenModels`). `src/agentsui/index.ts` NOT touched (drift behaviour left red; `AgentChatVM.drift.source` was already widened by U54).

Files: `helpers.ts`, `o1_o4_render.test.ts`, `o5_o8_interaction.test.ts`, `o9_o11_chips.test.ts`, `o12_o14_static_status.test.ts`.
Result: 101 tests, 88 red (52 "U51 stub", rest real assertions/ENOENT css), 13 green by design (COPY constants, O14 div-without-handler, views/types amendment, static source guard, current behaviour kept: ms 0 -> Rules, device/cloud strings, drift old notes/unknown, 'Private: unavailable', ON_DEVICE badge, empty badge).
`tsc`: no errors in tests/unit/u51, model_selector, views/types, ui/types. u38+u36 (437 tests) and u35/u20/u13 green with the stubs.

Coverage: O1-O14 plus group order/headings, Default tag, five device-line states (detail never leaked), hostile labels, disabled radios cannot emit, render keeps scope, Tab wrap both ways, open(null), dispose, announcer polite-only, CSS hooks and no colour literals.

## Judgement calls (confirm or amend)
- J1 Rows are located by visible text inside `[data-health]` elements that contain the radio; Firebase rows by their fixed copy. Radio `value`/`id` attributes are NOT pinned. Radios: `name="model-choice"`, each with a `<label>` (wrapping or `for`).
- J2 Scope `<select>` option values are `all|capsule|digest|routing|drift`; label found via `label[for]`, wrapping label or `aria-label` containing "Apply choice to". Select is the first focusable; "Close" button the last.
- J3 Tab trap: at the boundary the sheet must `preventDefault` and wrap focus (jsdom has no native tab order). Enter on the trigger is native click; tests use `click()`.
- J4 Announcement text: `<scope option text>: <descriptor.label>` (e.g. "Use for everything: Studio box"). Reset confirmation uses key `models.select`. Health text: `<label>: <full state copy>`; announced for any `data-health` or `blockedReason` copy change between renders, in provider order.
- J5 A `select` not confirmed by the next render is silent. Re-render with identical snapshot is silent.
- J6 `hostPresent:false` drops local/network even if the snapshot lists them. Firebase row text is fixed copy, not `descriptor.label`.
- J7 Downloading progress is 0..1 (`0.4` -> "40%", as in u20 fixtures).
- J8 `aria-expanded` on the trigger is set by `open`/`close` (the sheet owns it); the sheet is not `hidden` while open.
- J9 CSS: `styles/model_selector.css` must hold the frozen tokens/hooks (listed in O12 test) and no hex/rgb/hsl literals; `.source[data-source=local|remote]` rules live there (views.css is outside the surface).
- J10 `MODEL_SHEET_COPY` key names are mine (stub); tests pin values only.

## Ambiguities
- Selection pointing to an unknown id: no radio expectation (not tested).
- Shell badge cannot see `selection`; the "fallback truth" case is asserted as ON_DEVICE card -> "On device".
- "Cloud fallback" wording under deliberate "Cloud only" left as in spec section 7.

## A-U51r1 (repair loop 1, fail-first)
File: `tests/unit/u51/repair1.test.ts` (10 tests). Red run before fix: 10 failed / 0 passed.
- R1 onIntent containment (6): sync-throwing and async-rejecting `onIntent` on open / radio select / reset must not escape (no throw from `open()`, no window "error" from listeners, no process `unhandledRejection`); open state (`data-open`, `aria-expanded`) stays set.
- R1 announcer containment (1): throwing `announcer.say` on open: `open()` does not throw and `{t:"refresh"}` is still emitted.
- R1 model trigger (3): states "needs_gesture", "unknown-state", "" -> `button[aria-controls="model-sheet"]` click calls `onOpenModels(btn)` once; `[data-network]` line stays a div and inert.

## A-U51r2 (repair loop 2, fail-first)
File: `tests/unit/u51/repair2.test.ts` (4 tests). Red run before fix: 4 failed / 0 passed.
- R2 B1 onOpenModels containment (2): sync-throwing and async-rejecting `onOpenModels` on status-line click -> called once, no window "error", no process `unhandledRejection`. Uses a plain counter (a `vi.fn` spy observes returned promises and masks the rejection).
- R2 B2 iframe document (2): sheet built with an iframe `contentDocument` as `doc` -> radio click emits exactly one `select`; `mountWall` on an iframe host -> `.status-line[data-model]` is a BUTTON with `type=button`, `aria-haspopup=dialog`, `aria-controls=model-sheet`, `aria-expanded=false`, and click calls `onOpenModels(btn)` once.
