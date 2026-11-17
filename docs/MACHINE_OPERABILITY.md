# Machine-operability contract

TaskLight exposes DOM identity hooks and native controls for an accessibility-tree
automation client. These hooks describe the rendered snapshot; they do not establish
room authorization, plan generation or committed backend state. Hooks are not authentication.
Workspace and agent identities remain caller-asserted within the existing trust boundary.
Use the documented MCP, CLI or channel operations for committed work.

## Scope and acquisition

Find the mounted `.app[data-view][data-workspace]`, assert its `data-view` and
`data-workspace` against the intended selection, and stop if either differs or is
empty. Require a unique app within the intended mount. Scope subsequent queries
to that app and qualify hook families with the actual identity values. Family
selectors enumerate records; they are not singleton queries.

Before activation, require a unique qualified target. An absent or ambiguous target
fails the check; never take the first match, an ordinal, a matching title in another
workspace, or an unrelated fallback. After navigation, workspace selection or refresh,
reacquire the app, records, accessible nodes and geometry. Cached DOM references and
coordinates are not durable identity.

The values below are illustrative fixture identities, not reserved production IDs.
For dynamic values, compare attribute values directly or escape them for the relevant
CSS context. Do not interpolate untrusted identity text into a selector or markup.

## Wall selectors

| Public hook | Qualified target and scope | Availability and limits |
| --- | --- | --- |
| `.app[data-view][data-workspace]` | The mounted app, with the expected view and workspace values asserted | An empty workspace value does not prove a selected workspace. |
| `button[data-nav]` | Within the active app, for example `button[data-nav="wall"]` | Qualify with the intended view value; the family contains multiple buttons. Views include Wall, Agenda, Diary, Archive, Memory and Swarm. |
| `button[data-wsid]` | Within the app, for example `button[data-wsid="alpha"]` | Select the intended workspace, then reacquire the app and verify its workspace value. Counts in a button name may change. |
| `[data-task-id]` | Within the active app, `.task[data-task-id="T01"]` selects the task card | Descendant controls and legacy message controls can share the local task ID. Require the `.task` qualifier and verify the current plan. |
| `[data-task-vm-id]` | Within the app, `.task[data-task-vm-id="plan:alpha:T01"]` selects a plan-backed card | Use the rendered view-model identity; do not manufacture it from a presumed format. This hook also occurs on controls outside cards. |
| `button.step-row[data-micro-id]` | Within the selected card, `button.step-row[data-micro-id="T01.M01"]` | A disclosure button exists when that microtask has a detail panel. The current read-only branch does not expose this button or its microtask hook. |
| `[data-phase-id]` | Within the app, `button[data-phase-id="P01"]` selects a phase control | Phase containers also carry this attribute. A bare phase query is ambiguous; qualify by element and intended phase. |
| `[data-plan-id]` | Within the app, `[data-plan-id="plan-alpha"]` selects the current plan band | Require the expected plan ID; a missing plan does not authorize selection of another plan. This is not a generation fence. |
| `button[aria-controls="model-sheet"]` | The unique Models opener inside the app | The associated dialog has ID `model-sheet` and can be mounted outside the app. Resolve that relationship in the document. |
| `[id="step-T01.M01"]` | Within the selected task card, the disclosure panel with that literal ID | Available for a microtask with details. Use the literal attribute selector: `#step-T01.M01` interprets the dot as a class separator. |

When `T01` occurs in both `alpha` and `beta`, selecting a workspace must change the
app's workspace value and the qualified card's view-model identity. Reacquire the
card after each switch and assert both identities before operating a microtask.
Matching the repeated local ID or title alone is insufficient. A missing disclosure
on a read-only microtask is an availability limit, not permission to activate a
different row.

All required hook families are retained with qualified scope. No required selector
is dropped; bare task, phase and view-model families are not advertised as unique
operation targets.

## Swarm card hooks

The U146 implementation in `src/views/swarm.ts` uses named non-article cards and
identity-derived metadata relationships.

| Hook or relationship | Acquisition and expected behavior |
| --- | --- |
| `.swarm-card[role="group"]` | Enumerate within the active app in Swarm view. The accessible name is `Agent · <agent> · <swarm>`, with `Ungrouped` for an absent swarm label. Scope by the exact swarm/agent identity, not the agent name alone. |
| `button.swarm-metadata-toggle[aria-controls]` | Within the selected card, the native button is named `Agent details · <agent>`. It updates `aria-expanded` and the target's hidden state. |
| `.swarm-metadata-content[id]` | Metadata ID is `swarm-metadata-` followed by `encodeURIComponent(JSON.stringify([swarm ?? null, agent]))`. Resolve the toggle's actual `aria-controls` value and validate this identity; do not use render order. An absent swarm label differs from the literal label `Ungrouped`. |
| `.swarm-card[data-actionable="true"]` | Indicates a card with a current task and its task-detail control; this is not an authorization flag. |
| `button.swarm-task-open` | Within the selected actionable card, the button is named `View task <task-id>`. Scope to the card because another agent or workspace can repeat the task ID. |
| `.swarm-detail[role="region"]` | The open detail is named `Task details · <task-id>` and has `tabindex="-1"`. It is appended outside the card; reacquire it within the active app and require uniqueness. |
| `button.swarm-detail-close` | Within the open detail, `Close task details` closes it and returns focus to its trigger. Escape has the same focus-return behavior. |

For repeated agent names across swarm labels, identify the metadata target using
its encoded identity pair, then locate its containing card. Require uniqueness of
the card and its toggle. Accessible names aid operation but do not replace this
identity check. Markup-like names must remain text. Beat age, activity, counts and
render order are observations, not identity components.

## Accessibility and focus expectations

Interactive card descendants must remain reachable after opaque-article pruning.
The pruning rule emits an article and stops descending through it. A named
non-article container preserves its descendants; naming an article alone does not
remove that boundary. Native detail and metadata buttons must survive the transform.
Read-only records must remain readable without being turned into artificial controls.
Task state, agent lifecycle, activity, dependencies and missing liveness need textual
representations independent of color.

Swarm currently implements named non-article groups. Opening its task detail moves
focus into the named region; closing it or pressing Escape returns focus to the
originating control while it remains mounted. Metadata toggles expose their expansion
state and a resolvable controlled container. Verify focus entry, keyboard operation
and return in each supported live client; source code alone is not a live receipt.

The current plan-backed renderer in `src/views/plan.ts` still creates `article.task`,
and its no-detail microtask branch lacks `data-micro-id`. Plan-backed and fallback
card changes, stable microtask naming, refresh focus continuity and navigation
semantics belong to U148–U152. This contract does not claim those changes have
landed or that nested task controls survive pruning today. A receipt that loses
required controls fails, even if their DOM selectors resolve.

Every ARIA ID reference must resolve uniquely in the document, including hidden
panels and dialogs mounted outside the app. Audit each whitespace-separated token
in `aria-activedescendant`, `aria-controls`, `aria-describedby`, `aria-details`,
`aria-errormessage`, `aria-flowto`, `aria-labelledby` and `aria-owns`. Reject empty
references, missing IDs and duplicate target IDs. Recheck after opening disclosures,
opening Models, switching workspaces and refreshing; card scoping cannot repair
ambiguous document-wide ID relationships.

## Independent receipt gate

Keep raw CDP, pruned CDP and AT-SPI receipts separate. A successful raw CDP capture
does not establish success for the pruned representation or AT-SPI. Preserve each
lane's capture, target expectations and verdict independently; correlate the same
workspace, view, plan and agent/task identities without merging their evidence.

| Receipt lane | Evidence required |
| --- | --- |
| Raw CDP | The browser's full accessibility tree with actual document content, required role/name targets, relationships and observed operation results. DOM geometry and selector checks supplement this receipt. |
| Pruned CDP | The automation client's transformed tree, with the pruning rule recorded. Show whether the same required controls survived opaque-article pruning and remained operable. Preserve the raw capture separately. |
| AT-SPI | Actual renderer document exposure and its accessible roles, names, states and children. A normalized adapter result must be distinguished from the raw platform capture; DOM attributes do not prove platform exposure. |

An empty accessibility tree is a failed precondition, never a pass. An absent tree,
a missing receipt, or browser/application shell exposure without document content
also yields `failed_precondition`: stop that lane before content assertions. Enable
and verify renderer accessibility before retrying. Do not treat missing evidence as
an empty successful audit.

Require a nonempty acceptance list with nonblank target names. With document content
available, missing required controls, ambiguous selectors, broken ARIA relationships
or incorrect focus behavior yield `fail`. Record `pass` only for the individual lane
whose targets and operations were verified. Unsupported or unavailable lanes remain
unverified; another lane cannot supply their evidence.

## Oracle and evidence limits

`tests/unit/u153/` holds the frozen DOM oracle and shared pruning fixture. It covers
qualified selector uniqueness, repeated `T01` across workspace switches, document-wide
ARIA references, separate receipt verdicts, empty-tree rejection and opaque-article
pruning. Duplicate targets, broken references and an always-pass gate are negative
controls. Synthetic normalized trees and the DOM pruning surrogate are test evidence,
not live captures or a production accessibility adapter.

Live raw CDP receipt: AUSENTE. Live pruned CDP receipt: AUSENTE. Live AT-SPI receipt:
AUSENTE. Rendered geometry, contrast, zoom behavior and screen-reader utterances
remain unverified until captured in their appropriate lane. Passing the unit oracle
does not grant a live interoperability verdict.

This contract is limited to the U153 oracle and the inspected TaskLight renderer
surface; it establishes no additional backend authority or authentication mechanism.
