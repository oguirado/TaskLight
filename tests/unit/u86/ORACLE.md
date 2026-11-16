# U86 fail-first oracle

Specification status: DRAFT [TARGET]. Scope: plan cards open the selected task's executor conversation. The supplied specification was read through its final out-of-scope paragraph; it contains no Amendment sections.

## Acceptance-to-test map

Every name below is an `it` name, including the expanded values of parameterized cases. The two test modules use the real chat component. Wall integration also uses the real store, view-model builders, plan cards and delegated DOM events; recording wrappers preserve the actual mount handles.

| Acceptance | Test module | Test names |
| --- | --- | --- |
| A1 | `tests/unit/u86/wall_integration.test.ts` | `A1 real bare card opens and sends to the task assignee`; `A1 qualified callback opens and sends to the task assignee`; `A1 assigned history retains the room/executor rule without task filtering` |
| A2 | `tests/unit/u86/wall_integration.test.ts` | `A2 real unassigned card opens empty and disables every recipient action`; `A2 synthetic form submission cannot select a legacy neighbor`; `A2 captured onSend cannot post for an unassigned task`; `A2 captured onEscalate cannot post for an unassigned task`; `A2 captured Suggest cannot leak a notice into another selection`; `A2 captured drift acceptance cannot accept a neighbor's verdict`; `A2 negative control rejects a first-agent resolver choosing worker-b`; `A2 negative control rejects a first-agent resolver choosing worker-c` |
| A2 | `tests/unit/u86/composer.test.ts` | `A2 unassigned VM visibly identifies task/room/executor and disables Send and Suggest`; `A2 unassigned form submission cannot invoke onSend`; `A2 unassigned ctrlKey submission cannot invoke onSend`; `A2 unassigned metaKey submission cannot invoke onSend` |
| A3 | `tests/unit/u86/wall_integration.test.ts` | `A3 qualified identity selects its named room even while demo is displayed`; `A3 bare identity follows the latest rendered workspace only`; `A3 missing bare identity does not search another room`; `A3 switching tasks with one executor clears draft and notice; same-selection refresh preserves draft`; `A3 changing room clears the draft even when task and executor match` |
| A4 | `tests/unit/u86/wall_integration.test.ts` | `A4 reassignment before form cancels old submission and refreshes recipient`; `A4 reassignment before captured callback cancels old submission and refreshes recipient`; `A4 release before captured Send cancels instead of using a neighbor`; `A4 refresh after reassignment clears draft and notices`; `A4 closed plan closes the drawer and rejects retained Send`; `A4 missing plan closes the drawer and rejects retained Send`; `A4 missing task closes the drawer and rejects retained Send`; `A4 closed plan appearing before Send cancels without an explicit refresh`; `A4 missing plan appearing before Send cancels without an explicit refresh`; `A4 missing task appearing before Send cancels without an explicit refresh`; `A4 unavailable plan lookup rejects locally without throwing or posting` |
| A4, A6 | `tests/unit/u86/wall_integration.test.ts` | `A4/A6 invalid selection %j closes and guards callbacks`, expanded for `plan:ghost:T01`, `plan:demo:T99`, `plan:demo:T01:extra`, `plan::T01`, `plan:demo:`, `plan:demo:T1`, `agent:demo:missing`, the empty string, and `unknown` |
| A5 | `tests/unit/u86/composer.test.ts` | `A5 setDraft replaces whitespace verbatim, updates count and eligibility, and invokes no handler`; `A5 getDraft reads user edits and an ordinary update preserves the exact draft`; `A5 whitespace-only draft is retrievable but cannot send`; `A5 destroyed handle makes setDraft harmless, getDraft empty and destruction repeatable` |
| A6 | `tests/unit/u86/wall_integration.test.ts` | `A6 task title, history and draft stay literal and never auto-send` |
| A6 | `tests/unit/u86/composer.test.ts` | `A6 hostile title, message and setDraft render literal text without sending`; `A6 oversized setDraft stays editable and form cannot send`; `A6 oversized setDraft stays editable and ctrlKey cannot send`; `A6 oversized setDraft stays editable and metaKey cannot send`; `A6 setDraft at the exact UTF-8 limit sends once with trimming`; `A6 existing typed oversized input cannot bypass the limit through form or shortcuts`; `A6 preserved form and keyboard send trim text and suppress empty submissions`; `A6 sending state blocks submission and setDraft preserves the in-flight draft` |
| A7 | `tests/unit/u86/wall_integration.test.ts` | `A7 starts closed and remains closed through ordinary refresh`; `A7 legacy card routes to gemini-agent and explicit Close survives refresh`; `A7 step detail still expands without opening the drawer` |

## MUST coverage and failure meaning

| Requirement | Evidence |
| --- | --- |
| M1 | A1 real bare card and qualified callback, A3 displayed-workspace isolation, A4 invalid/missing/unavailable selections. Invalid selections are exercised after opening a valid legacy conversation, exposing retained-target fallback. |
| M2 | `assertTask` checks `data-open`, the public `AgentChatVM` fields, and visible text nodes for room/task/executor/title. A1 checks unchanged store events and no ingestion. The history case supplies events while `states()` returns an empty list. |
| M3 | A2 checks exact `Executor unassigned`, empty messages, `agent: ""`, `silent: false`, `sending: false`, inactive recipient controls, synthetic submission, and callbacks retained before selecting the task. Suggest and drift callbacks cannot alter a neighboring legacy selection. |
| M4 | A1/A3 exact wire objects; A3 task/room identity and draft lifecycle; A4 reassignment, release and closed/missing projections both on refresh and at submission. Release also clears notices and verdicts. |
| M5 / S1 | A5 checks both runtime methods, verbatim replacement/retrieval, counters, no callbacks, empty draft, user edits and repeatable destruction. Structural test-side types let absent additive members fail as assertions without adding compiler errors. |
| M6 | A6 tests literal title/message/draft rendering, UTF-8 boundary and oversized drafts, editable input, form and both keyboard modifiers, trimming, empty submissions and in-flight sending. |
| M7 | All authored files are under `tests/unit/u86/`. Existing production files and existing tests are unchanged. Regression, type and secret gates are recorded below. |

The assigned-card oracle starts with an open `demo/p1`, task `T01`, title `Export CSV`, assignee `worker-a`, and no legacy states. Its real card emits bare `T01`; the independent qualified entry uses `plan:demo:T01`. Both must open and post the exact `status?` request. The current controller fails the drawer-open assertion.

The wrong-recipient oracle shares `assertNoPost` across unassigned form/callback tests and the deliberately broken control. The control supplies candidate legacy states with either `worker-b` or `worker-c` first and substitutes a resolver that ignores the task identity and selects that first state. The resulting real controller Send posts to that neighbor; the identical no-wire assertion must throw. This proves the negative assertion detects either misroute without modifying production code or installing a replacement controller.

## Interpretation decisions

- The counter retains existing trimmed-send-byte semantics: `setDraft` and `getDraft` preserve all whitespace, while `  review\nthis  ` displays `11 / 4096` [TARGET]. The exact emoji overflow case displays `4100 / 4096` [TARGET].
- Task/room/executor identification must occur in visible text nodes; attributes alone cannot satisfy it. No new markup structure or selector is prescribed for those labels.
- Escalation and drift controls may be absent when their banners are absent. Any rendered recipient action must be disabled for rejected or unassigned selections. Send and Suggest are explicitly checked in the composer.
- There is no task/plan deletion operation in this scope. Removal tests change only the public `store.plan(room)` availability/projection seam; close, claim and release use real folded operations.
- Room/executor history is preserved, including older incoming, outgoing and verdict messages. No durable task-filtered history is required.
- Plan-generation replacement identity is outside U86. These tests do not impose a generation key beyond the selected room, task and assignee.

## Determinism and verification gates

`tests/unit/u86/helpers.ts` creates deterministic event IDs and lamports, validates fixture folding, and provides DOM input helpers. The wall uses `FakeAppClock` from `tests/unit/u37c/harness.ts`; asynchronous settling is a bounded microtask loop. Link/reviewer ports are in-memory fakes. New tests make no network calls and use no real timers. Every wall/chat handle is destroyed after its test.

| Gate | Required result | Negative contrast |
| --- | --- | --- |
| `npx vitest run tests/unit/u86` | Baseline fails only on missing U86 assertions; implementation must later pass all acceptance cases. | Missing S1 APIs, unopened plan drawers, or posts to a legacy neighbor fail assertions; no import failures or stubs are accepted. |
| First-agent control | Each substituted legacy target is rejected by the same no-wire assertion. | An oracle that accepts the wrong recipient makes the control fail. |
| `npx vitest run --project unit --exclude 'tests/unit/u86/**'` | Existing unit suites pass, including `tests/unit/u37c/agent_wall.test.ts` and `tests/unit/u42/wall_ui.test.ts`. | Any existing regression is a failed preservation gate. |
| `npx tsc --noEmit -p .` | No diagnostics in `tests/unit/u86/`; baseline diagnostics remain unchanged. | A diagnostic introduced by any new test is a failed gate. |
| Python plan/room suites and repository secret scans | Existing suites pass and secret scan reports no findings. | A regression or secret finding blocks integration. |
| Write boundary | Authored files remain under `tests/unit/u86/`. | Any production edit outside the declared surface is HOLD; this oracle authoring lane permits no production edits. |

Observed fail-first result: `Tests  49 failed | 7 passed (56)` [MEASURED]. All failures were `AssertionError` [MEASURED], caused by missing selection/lifecycle/composer behavior; imports and fixtures loaded successfully. Both first-agent negative controls and the preserved legacy/composer cases passed [MEASURED].

Existing unit project: `Tests  9360 passed | 2 skipped (9362)` [MEASURED]. TypeScript retains its baseline `16` errors [MEASURED], with no diagnostics in the new files [MEASURED].

Combined unit project: `Tests  49 failed | 9367 passed | 2 skipped (9418)` [MEASURED]; all failing tests are under `tests/unit/u86/` [MEASURED]. Python plan discovery passed `526` tests [MEASURED], and Python room discovery passed `210` tests [MEASURED]. Scanner negative controls passed [MEASURED], and the repository secret scan reported `0` findings [MEASURED].

## Out of scope

| Unit or feature | Treatment |
| --- | --- |
| U92 delivery/retry receipts | Not asserted and not reported as a U86 failure. |
| U93 liaison generation | Not asserted; only the S1 composer methods consumed by U93 are covered. |
| U99/U104 plan-generation identity | Not asserted and not reported as a U86 failure. |
| Durable task-filtered threads and read receipts | Not asserted; transport history stays scoped to room/executor. |
| S0 extension dispatch, S2 activity and S3 event cursor | Separate unit contracts; no extension stubs or protocol changes are introduced here. |

This oracle's mandate is limited to the supplied U86 specification and the cited repository surfaces.
