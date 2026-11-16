# U92 fail-first oracle

The complete `.unit/SPEC.md`, including its final Binding Amendments, was read
and pinned before test authoring. Its SHA-256 is
`4a1f008335e42afba8b67cf4c4053e865e81266e0a1db73b2423acbca38dc0cd`
[MEASURED]. The seals below freeze the test sources before production
implementation. No production source or stub was changed.

Run from the repository root:

```sh
npx vitest run tests/unit/u92 --cache=false
npx tsc --noEmit -p .
```

`--cache=false` keeps verification from writing a test cache outside this
directory. All fixtures and expected receipt values below are [TARGET].

## Acceptance map

Names containing `%s` or `%j` identify parameterized test names; the variants
are stated explicitly. `chat.test.ts` and `wall.test.ts` are relative to this
directory.

| Case | Executable test names | Coverage |
| --- | --- | --- |
| A1 | `chat.test.ts`: `A1 %s retains the raw draft while submitting trimmed text` (form, ctrlKey, metaKey); `A1/A2/A3/A4 exposes delivery metadata and literal status: %j`. `wall.test.ts`: `A1 captures the unchanged wire request and creates Sending with an opaque local id before post`; `A1 blocks a trimmed-equal pending re-submit through %s` (form, ctrlKey, metaKey); `M6 direct repeated Send callbacks cannot bypass the pending-message guard`; `A1 exact plan:demo:T01 selection sends only to its assignee and retains its draft`. | Captured `{room:"demo",to:"executor-a",text:"Explain this"}`, retained raw `"  Explain this  "`, page-local nonempty client id, Sending before posting, unchanged wire arguments, duplicate suppression. Exact plan selection is prerequisite-gated as explained below. |
| A2 | `wall.test.ts`: `A2 successful acknowledgement retains both receipt values, keeps its client id and clears only the unchanged draft`; `A2 success preserves a newer raw composer edit: %j` (`new draft`, `Explain this `); `A2 %s reconciles by event id without losing the receipt or merging equal text` (journal-before-receipt, receipt-before-journal); `M4 positive integer Lamport %s is accepted and displayed` (1, 42); `A2/A7 replacing via setDraft protects even a raw-equal draft from acknowledgement clearing`. | Delivered with `e-receipt` and Lamport `42`, stable client id, conditional raw-draft clearing, both echo orderings, repeated refresh, distinct equal-text event. Setter replacement check is prerequisite-gated. |
| A3 | `chat.test.ts`: `A3/A7 failed entries provide a focusable native Retry and emit the original client id`. `wall.test.ts`: `A3 a confirmed rejection retains the draft and renders literal failure with Retry`; `A3 keyboard Retry resends the captured request, keeps one bubble/id and preserves edited text`; `M6 synchronous double Retry and unknown client ids cannot issue extra posts`; `M6 direct Retry for a task that is no longer selected is a no-op`; `A3 %s task disables Retry, explains the mismatch and guards direct callback invocation` (reassigned, unassigned). | Failed plus literal `bad_request`, captured request on Retry, native button and keyboard focus, same bubble/id, synchronous guard, no posting to either assignee after mismatch. Reassignment/release cases are prerequisite-gated. |
| A4 | `wall.test.ts`: `A4 times out at LINK_LIMITS.POST_TIMEOUT_MS with unknown delivery, no Retry and no automatic resend`; `A4 negative control: deliberately mapping timeout to failed is rejected by the same acceptance assertion`; `A4 %s is unknown, never Failed or Delivered, and never auto-retried` (timeout, stopped, error); `A4 malformed result (%s) becomes unknown with unexpected_result`; `A4 a post that %ss becomes unknown with unexpected_result` (throw, reject). `chat.test.ts`: `A4/M6 %s never enables Retry`. | Real AgentLink with fake runtime port and fake clock, timer boundary, retained draft, no automatic resend, no Retry for unknown, direct Retry guard, malformed receipts and nack results, thrown/rejected post. |
| A5 | `wall.test.ts`: `A5 late settlement %j leaves another task's draft/status alone and restores the originating record` (success, bad_request, timeout); `A5 switching rooms while sending isolates drafts and outgoing records`; `A5 close/reopen restores %s and its draft without resending` (sending, failed, unknown, delivered); `A5 destroyed wall ignores late %s without DOM mutations or exceptions` (success, rejection, throw); `A5 unassigned task stays Executor unassigned and cannot fall back to a neighboring agent`; `A5 task-scoped records remain separate for tasks sharing the same assignee`; `A5 plan selection and captured recipient survive room changes before settlement`. | In-flight task/room changes, retained failure/unknown, receipt restoration, close/reopen, no updates after destruction. Exact plan/unassigned/shared-assignee cases are prerequisite-gated. |
| A6 | `chat.test.ts`: `A6 renders hostile message and failure code as literal text nodes`; `A6 renders a hostile receipt id literally`; `A6 %s blocks whitespace and over-limit UTF-8 without truncating a valid boundary draft` (form, ctrlKey, metaKey). `wall.test.ts`: `A6 hostile draft and returned error remain literal end to end`; `M4/M7 a nonempty hostile receipt id is accepted as data and rendered literally`. | Literal `<img src=x onerror=alert(1)>` and `<svg onload=alert(1)>`, no executable nodes, whitespace rejection, emoji UTF-8 boundary without truncation. |
| A7 | `chat.test.ts`: `A7 setDraft/getDraft preserve raw text, never send, and retain destroyed-handle semantics`; `A7 repeated identical VM updates do not duplicate messages`; `A7 delivery transitions are polite and unchanged history is not announced again`; `A3/A7 failed entries provide a focusable native Retry and emit the original client id`; `M7 long receipts wrap and native Retry has a visible keyboard focus rule`; `M7 long event ids have wrapping styles without truncating receipt text`. `wall.test.ts`: `M7 restoring records on task switch and drawer reopen emits no delivery announcements`; `A2/A7 replacing via setDraft protects even a raw-equal draft from acknowledgement clearing`. | Preserved S1 before/during sending and after destroy, stable repeated rendering, polite transitions, silent restoration, keyboard access, focus styling and long receipt wrapping. S1 checks are prerequisite-gated. |

Additional MUST checks are `M2 legacy messages acquire no inferred receipt,
read status or Retry`, `M6 genuinely edited pending text creates a distinct
submission instead of globally locking Send`, and `M5 %s preserves newer
composer edits as well as the captured message text` (bad_request, timeout).
No test requires a client-id format or a transport idempotency guarantee.

## Negative control and failure gates

The A4 negative-control test first applies `assertUnknown` to the actual
timeout result. Only after that passes does it deliberately replace
`state:"unknown"` with `state:"failed",code:"timeout"` in the captured VM,
render that mutant, and require the same assertion to throw. This is an
explicit timeout-to-failed mutation without editing production code. A broken
baseline cannot pass merely because an assertion in the control throws.

Every running U92 failure is an assertion failure [MEASURED]. There are no
import errors, missing-module failures, suite-collection failures or unhandled
exceptions [MEASURED]. The baseline clears the composer before acknowledgement,
discards PostResult, supplies no local outgoing records, and renders no delivery
metadata. Those are the intended red gates. No stub exports are required.

## Prerequisites and scope

U86 is **AUSENTE** in this checkout: the public AgentChatHandle has neither
`setDraft` nor `getDraft`, and the existing controller does not resolve
`plan:demo:T01` [MEASURED]. The suites named `U86 prerequisite: preserved S1
(out of scope when absent)` and `U86-dependent plan integration (out of scope
while prerequisite is absent)` use `describe.skipIf` based on the actual public
handle seam. They automatically activate once S1 exists. This prevents another
unit's missing behavior from being reported as a U92 failure. Their tests still
encode the exact frozen method names, plan selection ids and contracts.

The remaining controller tests use already supported legacy task selections
with the same room, executor and submitted text. They use the real store,
controller, views and chat; recording wrappers only observe public VM updates
and callbacks. They do not supply a replacement task resolver. Journal replay
uses a controlled `store.events(room)` feed so the exact nonempty receipt id
`e-receipt` can be exercised independently of the store's stricter ingestion
id validation. This changes no shared-store implementation or transport.

Read receipts/persistent task threads (U104), plan-generation identity (U99),
liaison inference/automatic sending (U93), durable outboxes, transport changes,
server-side deduplication and idempotency are out of scope. No read, answered
or applied status is inferred from Delivered. Existing tool argument/result
contracts remain untouched.

All async waits are bounded microtask drains. Clock-driven cases use the
existing FakeAppClock/PagePort harness and `LINK_LIMITS.POST_TIMEOUT_MS`.
No live network, ports, model calls or real timer delays are used. jsdom does
not synthesize native keyboard default actions: keyboard Retry checks focus
and Enter key events, followed by the browser-equivalent native button click
with `detail:0`. Polite-announcement checks observe textual live-region
mutations, accepting a separate status region or a silenced history region;
they do not claim to run a screen reader. CSS checks inspect wrapping and
keyboard-focus styling without requiring browser pixel layout.

## Binding amendment decisions

| Issue | Oracle rule |
| --- | --- |
| Outcome validity | Nonempty string event id and integer Lamport >= 1; missing/empty/non-string nack code and other malformed results become unknown with `unexpected_result`. Unknown code is checked in the VM; its visible detail remains optional. |
| Pending duplicate versus edited submission | Compare trimmed text to suppress repeats, including whitespace-only differences. Genuinely different text can create another record while a previous record is pending. Set sending synchronously before posting or retrying. |
| Success clearing | Compare the current raw draft to the captured raw draft. Preserve even a raw-equal replacement made through S1 `setDraft`. |
| Retry mismatch | Require the originating task/room and current assignee to match; check both the disabled/absent native button and direct callback guard, with an added visible explanation in `.chat-delivery`. No exact explanation wording is imposed. |
| Announcements | Actual delivery transitions are polite. Unchanged VM updates, task restoration and drawer reopening must not announce existing records again. |

## Verification record

The targeted fail-first run reports [MEASURED]:

```text
Test Files  2 failed (2)
     Tests  69 failed | 7 passed | 8 skipped (84)
```

The skipped cases are the U86 prerequisites described above. Green checks
preserve existing validation, legacy message semantics and destroyed-wall
settlement behavior.

Before authoring, the existing unit project reported [MEASURED]:

```text
Test Files  4 failed | 296 passed (300)
     Tests  79 failed | 9400 passed | 2 skipped (9481)
```

The existing project was already red. A subsequent run excluding this directory
reported `80 failed | 9399 passed | 2 skipped (9481)` [MEASURED], including an
additional U87 contract failure; it is not counted as a U92 oracle failure.
Production files were not edited. TypeScript reports the same existing
16 diagnostics, at the same source coordinates and error codes, before and
after authoring; none originates in `tests/unit/u92` [MEASURED].

The relevant existing regressions in `tests/unit/u35`, `tests/unit/u37c`,
`tests/unit/u38`, `tests/unit/u42` and `tests/unit/u61` report
`Test Files  42 passed (42)` and `Tests  732 passed (732)` [MEASURED].
An isolated `tests/unit/u87/contract.test.ts` run also fails on the existing
U87 stub without importing any U92 test [MEASURED]. The hashes of
`src/app/agent_wall.ts`, `src/app/agent_link.ts`, `src/agentsui/index.ts`,
`src/agentsui/types.ts` and `styles/agents.css` are unchanged from the
pre-authoring measurements [MEASURED].

## Frozen source seals

SHA-256 values [MEASURED]; paths are relative to the repository root.

| Path | SHA-256 |
| --- | --- |
| `tests/unit/u92/helpers.ts` | `30d2290c2564f3673596e26ebf81350eec715af9fb61b0f9082936227f5934ce` |
| `tests/unit/u92/chat.test.ts` | `9b22cb372c5c45e5214ea153032ca70176ae466e0c533e1f7959e134b19787ba` |
| `tests/unit/u92/wall.test.ts` | `6f405d1611c3a0011e90855eea25503975711fc9b475eeea325d15f05ddad13c` |

The oracle mandate is scoped to the supplied U92 spec, its binding amendments,
the frozen seams and the confirmed repository surfaces.
