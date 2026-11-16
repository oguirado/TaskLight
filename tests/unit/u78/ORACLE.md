# U78 fail-first oracle

Authority: `.unit/SPEC.md`, status R28. The supplied file ends after A7; Amendment sections are absent. Product files are read-only; all additions are confined to `tests/unit/u78/`.

## Acceptance map

| Case | Test file | Test names / coverage |
| --- | --- | --- |
| A1 / M1 | `interactions.test.ts` | `toggles the CSS root light → dark → light and reports the current theme`; `a fresh mount restores the persisted dark choice`; `blocked storage reads and writes do not disable visible switching`; `hostile stored text cannot become a theme or executable markup`; `dark tokens differ for wall, sidebar and card surfaces` |
| A2 / M2 | `interactions.test.ts` | `opens inline setup instructions with a copyable --room command and docs link; Escape closes`; `Close dismisses the help panel without creating a workspace or posting` |
| A3 / M3 | `interactions.test.ts` | `a never-settling verdict stops checking by ten seconds, with a Chrome/flags hint and Rules active`; `Suggest while unavailable displays inline feedback and never posts`; parameterized `status %s opens the existing Models sheet via its public handler` (Nano and Rules); `destroy cancels pending feedback and leaves no UI after the timeout` |
| A4 / M4 | `interactions.test.ts` | `Build filters phase sections, is pressed, and Show all restores the full list`; `Discovery retains a distinct current marker when Build is selected` |
| A5 / M5 | `interactions.test.ts` | parameterized `excludes done and closed legacy work; cancelled=$cancelled field=$field` (header/workspace, done/closed and cancelled); `an open legacy card is counted until its close event arrives` |
| A6 / M6 | `content.test.ts` | parameterized `%s preserves newlines and wraps long words`; `%s has no reading-width cap on text or its panel` (Memory and Diary) |
| A7 / M7 | `content.test.ts` | `memory metadata labels revision, author and time together`; `hostile memory metadata remains literal text`; parameterized `Archive labels unknown duration and %s task count` (singular/plural); `legacy Archive count labels the actual steps field` |
| M8 | verification commands below | Existing unit project excludes only the intentionally red U78 tests; TypeScript must add no diagnostics in `tests/unit/u78/`. |

## Harness and interpretation

- `helpers.ts` mounts the real `startAgentWall`, `createAgentStore`, `toWallVM` and `mountWall`. Existing public harness helpers in `tests/unit/u67/helpers.ts` provide the bundled template and valid op events. No new production API or module is assumed.
- Events have fixed identities, Lamport order and timestamps. Vitest fake timers back the injected `Clock`; the never-settling reviewer has no I/O. Unexpected fetch calls throw. All UI handles and timers are cleaned up.
- The `close_task` MCP tool emits the existing room event `act: "close"`; the fixture uses that event, verifies the folded legacy `closed` flag, and never invents a `close_task` room act.
- Cancellation uses `task.set` with `state: "cancelled"`; task completion uses `micro.set`. Every fixture op must fold without rejection. Four open tasks means the five v2 tasks minus the completed task, excluding the closed legacy card.
- Light is the existing stylesheet default. Arbitrary persisted text is untrusted; it cannot become a theme or markup. Storage exceptions must still permit visible toggling.
- Status activation uses the existing `WallHandlers.onOpenModels` contract to reach the existing selector. Selector internals and provider acquisition belong to other units. No cloud or device model is invoked.
- Phase filtering may remove or hide sections. The current marker accepts accessible current text or `aria-current`; it is independent of the selected chip's `aria-pressed`. Refresh must retain the user's selection.
- jsdom loads the actual `styles/*.css` files. Theme assertions inspect computed custom properties; layout assertions inspect the actual text/ancestor styles. They do not depend on pixel geometry. The app-wide content maximum is allowed; narrower reading caps on the content panels are rejected.
- A plain selectable `code`, `pre`, `input` or `textarea` command containing `--room` counts as copyable; no unspecified clipboard API is required.
- Memory metadata must include revision, author and time in the requested readable order. An Archive `taskCount` is labeled tasks; fallback `steps` is labeled steps. Unknown duration is not rendered as a measured zero.

## Scope and stop rules

- U67 template resolution, canonical hash parity and missing-band repair are out of scope; the existing starter resolver is used as a fixture precondition.
- MCP transport, native host configuration changes, installer execution, model inference quality, Firebase wiring and live browser/device checks are out of scope. Workspace help must not create rooms or post events; unavailable Suggest must not post.
- The supplied U78 spec declares no additional stop rules. Fixture rejection, missing imports, uncaught errors or real I/O would invalidate this oracle; only missing-behavior assertions are acceptable red results.
- Existing `tests/unit/u62/memory_a11y.test.ts` test `O9 memory panels enforce reading width through the existing token` pins the earlier reading-width design. U78 M6 explicitly requests full content width. This oracle follows U78; reconciling that older assertion during implementation is outside this test-only write surface.

## Verification

Run from the repository root:

```sh
npx vitest run tests/unit/u78
npx vitest run --project unit --exclude "tests/unit/u78/**"
npx tsc --noEmit -p .
```

The U78 run must be red on assertions describing absent UI behavior. Preserved theme tokens, safe text rendering, current-phase identity, model callback routing and destroy behavior may remain green. Existing unit suites must remain green. Repository-wide TypeScript diagnostics outside the new files are baseline defects and must be reported separately, not attributed to U78.
