# U94 TypeScript oracle

Status: fail-first DOM/text/style-rule oracle. The final Amendment B-U94 controls
this surface. See `bridge/tests/room/u94/ORACLE.md` for complete MUST/acceptance
mapping, upstream gaps, negative controls and stop rules.

| Acceptance | Test names / disposition |
| --- | --- |
| A1 | Python `ExportContract` and `Discovery`; no TypeScript transport requirement. |
| A2 | Python `HistoryContract`; history UI transport is out of scope. |
| A3 | Python empty-room/history tests; no TypeScript persistence requirement. |
| A4 | Python `Arguments`; no tool validation duplicated in the view. |
| A5 | Python `FileExport` calls the amended direct routine; native CLI wiring is a separate integration unit. |
| A6 | `memory.test.ts`: visible revision copy/explanation, literal HTML/Markdown/newlines/selectable text and absent metadata; required-empty and existing bounds. `styles.test.ts`: line-preserving/selectable Memory rules. |
| A7 | `memory.test.ts`: plan archive `Duration unknown`, `3 tasks`, singular task/legacy steps, generic archive labels/Restore, bounded Diary text. `styles.test.ts`: Memory wrapping/no clipping, explicit narrow Diary stacking, archive wrapping/controls and no CSS-generated labels. Each DOM/style case runs in both themes. Rendered checks at 320/1280 CSS pixels [TARGET] are deferred to U95. |
| A8 | Python executable current-only-history and missing-newline mutants run the actual A2/A1 assertion methods. No production mutation. |

Tests import only existing view exports. They do not create replacement labels,
new dispatch seams, or new TypeScript stub files. Memory retains its existing
bounds; Diary retains its exported outcome bound. Missing revision metadata is
introduced as a runtime fixture despite the current static `MemorySectionVM`
requiring `rev`; it must not turn into zero or an undefined label.

The responsive test requires an explicit finite pixel `max-width` that covers
320 but excludes 1280 CSS pixels [TARGET]. The spec supplies no exact breakpoint,
so its implementation value is not frozen. CSS assertions inspect rules and DOM
text/focusability; they do not prove rendered size, overflow, theme contrast or
native keyboard activation. Restore focus and click dispatch are regression
checks; actual keyboard traversal belongs to U95.

Run `npx vitest run tests/unit/u94 --no-cache` and `npx tsc --noEmit -p .` from the
repository root. Existing UI behavior may pass; missing readable revision copy
and responsive/readability styles must fail with direct assertions. Import/type
errors or fixture failures are invalid red and must be corrected before freeze.
