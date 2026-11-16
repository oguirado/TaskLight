# U36 oracle (Wall UI v2 views)

Run: `npx vitest run tests/unit/u36`. Stubs: `src/views/index.ts` throws `U36 stub`, `styles/views.css` is the comment `/* U36 stub */`, `styles/tokens.css` is still the U20 stub (the spec makes U36 replace it). Baseline: 365 tests, 363 RED, 2 green (the type-export / `mountWall`-export checks, which the stubs satisfy by design). Static negative scans carry a "not a stub" guard so they cannot pass vacuously. `tsc --noEmit` is clean for `src/views` and `tests/unit/u36`.

CSS tests were also run against `design/tokens.css` + `design/components.css` copied into a scratch tree: 19/24 green; the 5 reds are exactly the adaptations the spec demands (2 hex literals in components.css, `--motion-duration` missing, `--dur-*` not derived from it, no `[data-theme="light"]`/`--color-*` blocks for U20 compatibility).

## Test map

| File | Tests | Spec behaviour pinned |
|---|---|---|
| structure.test.ts | 32 | B1 (.app tree, root `data-*`, `documentElement` untouched through mount/update/click/destroy, rail/topbar/status markup), B3 (4 nav buttons, `aria-keyshortcuts`, `kbd.nav-key`, `aria-current`, one section per view, click -> `onView`, controlled), B13 (theme toggle calls only `onThemeToggle()`, sets no `data-theme`) |
| workspaces.test.ts | 15 | B4 (button per workspace, `aria-current`, `data-accent/lens`, `.ws-lens` text and counts, `.ws-running`/`.ws-needs` presence + `aria-label`, archived excluded, `.rail-heading-meta`, `onWorkspace`, `onNewWorkspace`) |
| wall.test.ts | 24 | B5 (selection, attention sort now>high>low>none stable, no input mutation, article attrs, status labels x6, progress label / `aria-valuenow` rounding / 0 steps / `--p`) |
| steps.test.ts | 31 | B6 (button vs div rows, `aria-controls` resolution + uniqueness, notes, hidden state text x4, Finished/Took only when present, Evidence, chip, toggle of `aria-expanded`/`hidden`/`data-open`, expansion survives `update()` incl. reorder and view round-trip) |
| focus.test.ts | 17 | B7 (eyebrow singular/plural, item markup, which tasks qualify, first blocked/active step, hidden outside Wall / when empty, archived and other workspaces excluded) |
| agenda-diary.test.ts | 22 | B8 (group order, per-workspace filtering, empty groups omitted, archived excluded, pill labels), B9 (archived history included, day grouping, descending `at_ms`, ties keep input order, time from `at`, only done+detail, entry markup) |
| archive-source.test.ts | 24 | B10 (scope filter, counts singular/plural, `aria-pressed`, `onArchiveScope`, `.archived-ws` only in `all`, `onRestore(id)`), B11 (chip labels, `data-source`, `.source-ms` in task, step, diary, archive) |
| keyboard.test.ts | 36 | B12 (keys 1-4, other keys inert, ctrl/meta/alt/shift, input/textarea/select/contenteditable incl. `""` and `plaintext-only`, `contenteditable=false` still works, listener on `host.ownerDocument`, two instances) |
| lifecycle.test.ts | 21 | B14 (update re-renders, one `.app`, frozen VM, no handler duplication, `addEventListener`/`removeEventListener` spies on `host.ownerDocument` and on `EventTarget.prototype`, destroy empties host, post-destroy no-ops, double destroy) |
| safety.test.ts | 46 | B2 (6 hostile payloads x 4 views: same element tree as benign text, tag whitelist, no `on*`/`src`/`javascript:`; literal text per field; hostile ids; entities not decoded; `update()` safe) |
| invalid.test.ts | 63 | B15 (unknown workspace, `^[a-z]{1,16}$` rule for accent/status incl. boundaries 16/17, garbage VMs never throw, unknown refs skipped) |
| static-views.test.ts | 10 | B2 static scan of `src/views/**/*.ts` (innerHTML, outerHTML, insertAdjacentHTML, document.write, eval(, new Function) + no firebase/sync/network + exported names |
| styles.test.ts | 24 | Styles section: views.css colour only via custom properties, defined vars only, no `!important`, no `#id`, no remote URL, durations via `--motion-duration`, `prefers-reduced-motion`; tokens.css light/dark name parity, `--motion-duration`, U20 compatibility |

## Judgement calls (flag if the spec owner disagrees)

- J1 Prototype as tie-breaker: where the spec is silent the tests follow `final/render.js`: titles Wall/Agenda/Diary/Archive, `p.view-sub` contains `vm.now`, brand "Context Wall", article `id` = task id (needed by `href="#<id>"`), `aria-labelledby` -> `h2.task-title`, `.source-icon` present.
- J2 B7 "`<status lower-case>`": read as the pill label lower-cased (`needs input`, `in progress`), per the prototype, not the raw key `waiting`. Without a blocked/active step the text is only asserted to be non-empty and to contain the label.
- J3 B4/B7 counts exclude archived tasks everywhere (prototype), including `.rail-heading-meta`.
- J4 B6 done step without `detail`: spec only defines done+detail. Pinned only: no control may point at a missing panel and the hidden state text still says Done.
- J5 B6 "Expansion survives `update()` for the same task id and step index" is read as a keyed state that also survives a trip through another view (Wall -> Agenda -> Wall) and a re-sort.
- J6 B12 "a modifier": `shiftKey` counts as a modifier (prototype only checks ctrl/alt/meta). `contenteditable` is detected from the attribute (jsdom has no `isContentEditable`); `"false"` is not editable.
- J7 B15 pattern rule is spec-bound to accent/status. For attention, lens, step state and source kind only the safety half is pinned (attribute absent or `^[a-z]{1,16}$`).
- J8 B14 "removes every listener": checked by recording all `EventTarget.prototype.add/removeEventListener` calls; listeners on nodes inside the host subtree are exempt (they die with the nodes), everything else (document, window, host itself) must be gone after `destroy()` and must not grow with `update()`.
- J9 B15 unknown workspace: only "empty wall + first workspace has `aria-current`" is pinned; the value of `data-workspace`/`data-lens` on `.app` is left open.
- J10 Progress fill: `--p` is asserted through `style.getPropertyValue("--p") === "<pct>%"` (MARKUP: width from `--p`). Inline `style` is thus allowed for this one property only.
- J11 tokens.css parity is layout-agnostic: colour names (`--c-*`, `--e-*`, `--color-*`) from `:root` plus `[data-theme=light]` rules must equal those of `[data-theme=dark]` (and of the `:not([data-theme=light])` media rule when present). A separate test keeps the U20 `[data-theme=light|dark]` + `--color-*` contract.
- J12 Durations: a `--dur-*` token counts as "derived" if its definition (transitively) references `var(--motion-duration)`; literal times outside the reduced-motion block fail.

## AUSENTE (not tested)
Copy beyond the strings listed above (network text wording, "Toggle theme", Restore label), responsive layout, visual contrast, `hidden` CSS behaviour in a real browser, handler exceptions.

## Repair loop 1 (cross-family review, 13 Nov)
`review1.test.ts` adds regressions for the five BLOCKING findings:
| Test | Finding | Spec |
|---|---|---|
| R1 | Inherited keys (`constructor`, `toString`, `__proto__`, `hasOwnProperty`) used as status/attention/step state crash label lookups | B15 |
| R2 | JSON-produced objects with `toString: null` throw in string conversion | B15 |
| R3 | Two mounted walls share panel ids; expansion must resolve within the clicked step and ids must be instance-unique | B6 |
| R4 | Keys typed in descendants of `contenteditable="true"` must be ignored; a `contenteditable="false"` island is not editing | B12 |
| R5 | Unknown `vm.workspace`: no workspace-scoped content even if tasks carry that id | B15 |

## Oracle amendment A-U38
- V3 (`archive-source.test.ts` B11 "ms is rendered verbatim"): a chip with ms 0 means no model ran and renders label "Rules" with no `.source-ms`; model chips still render `<ms> ms` (cloud 123456 ms checked).
- V2 (`wall.test.ts` B5 "0 steps"): label "0 of 0 steps", aria-valuenow 0, and no `.progress-fill` element.

### Oracle amendment A-R16 (14 Nov): product renamed to Tasklight (operator ruling R16); brand text asserted as "Tasklight".

### Oracle amendment A-R16b (14 Nov): brand capitalization "TaskLight" per operator.
- A-U51 (14 Nov): B15 unknown source kind now expects the "Rules" chip with no latency (SPEC_U51 §4, U38 V3); previously "5 ms".
