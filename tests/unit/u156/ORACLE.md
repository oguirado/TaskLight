# U156 legacy Messages composer

Product surface: `styles/agents.css`. Existing markup in `src/agentsui/index.ts`
already keeps the input, suggestion button and Send in keyboard order, so it is
unchanged. Suggestion routing and private-room policy are unchanged.

`composer.test.ts` mounts the real component and renders its serialized DOM in
offline Chromium using `browser.ts`. The browser helper follows the existing
unit-suite pipe transport and keeps its disposable profile inside this directory.
The draft value is copied into the serialized textarea explicitly.

## Gates

| Gate | Evidence and rejected contrast |
| --- | --- |
| Usable typing space | At viewport widths 1280, 480 and 390 px [TARGET], input width is at least 60% [TARGET] of the composer; at widths at most 480 px [TARGET], it occupies the full row. Restoring the old grid fails the same rendered geometry oracle. |
| Hostile content | A 300-character [TARGET] unavailable note with an unbroken suffix and a 2,000-character [TARGET] draft render together with the suggestion provenance and task/room/executor metadata. Bounds, pairwise overlap, horizontal overflow and actual note wrapping are checked. |
| Stable controls | Send retains its offset and dimensions within the composer when notes appear. The drawer can grow or scroll; its reserved scrollbar gutter prevents the controls shifting horizontally when scrolling begins. |
| Keyboard and motion | Native browser Tab advances from input to suggestion to Send. Normal and reduced-motion cases retain visible controls; reduced-motion computed transition durations must be zero [TARGET]. |
| Request failure | The mounted component retains the textarea node, draft, selection, focus and control nodes across an asynchronous suggestion failure; it invokes no Send handler. Notice wrapping and explicit grid placement must still be present. |

## Fail-first receipt

All 8 regression cases failed [MEASURED] on the original product CSS, before the
fix: rendered cases rejected insufficient input width, overflow, overlap and
notice placement; the asynchronous case rejected missing notice wrapping.

The old grid survives only in the rejected negative control, marked
`// A-U156:` in `composer.test.ts`. No existing legacy assertion pinned the old
grid, so no legacy assertion was amended.

The focused command `npx vitest run tests/unit/u156 tests/unit/u127 tests/unit/u118`
passed all 159 tests [MEASURED] after the fix. The full command
`npx vitest run tests/unit` passed 12,280 tests with 9 existing skips and zero
failures [MEASURED]. No pending U159 oracle was present [MEASURED].
`npx tsc --noEmit -p .` retained the same 16 baseline errors [MEASURED], with no
new errors in this unit. Both repository secret-scan commands passed [MEASURED].
