# U35 oracle (agent chat panel, drift and silence states)

Run: `npx vitest run tests/unit/u35`. Stubs: `src/agentsui/index.ts` throws `U35 stub`; `styles/agents.css` is `/* U35 stub */`; `src/agentsui/types.ts` is the exact spec types. Baseline: 258 tests (it.each expanded), 256 RED, 2 green (type-export check and the compile-time type-contract test, satisfied by the stub types by design). Static scans carry "not a stub" guards, so they cannot pass vacuously. `tsc --noEmit` is clean for `src/agentsui` and `tests/unit/u35` (other units have pre-existing errors).

Validation: the suite was run once against a throw-away reference implementation and CSS (258/258 green), then the stubs were restored. Note this implies a mutation-free sanity check only.

## Test map

| File | Spec rules | Pinned behaviour |
|---|---|---|
| structure.test.ts | C1, C2 | section/header/h2/close markup, aria-label "Close chat", child order header, banners, log, form; ol role=log aria-live=polite; li.chat-msg[data-from] with span.chat-from ("You", agent name, "Gemini Nano"), p.chat-text, time.chat-at; composer order textarea, suggest, send; `Message to <agent>` label; copy strings; update re-render; hostile strings (5 payloads) literal in text, attributes, banners, lists, draft; identical element skeleton hostile vs benign; frozen VM not mutated |
| send.test.ts | C3 | enablement (empty, whitespace, sending); UTF-8 byte boundary at 4,096 with ASCII, e-acute, emoji, CJK and mixed strings; counter `"<n> / 4096"` and `data-over`; trimmed text sent once, textarea cleared; submit event guards (empty, over, sending); Ctrl/Meta+Enter once; plain/Shift/Alt+Enter and Ctrl+a do not submit |
| suggest.test.ts | C4 | onSuggest; suggestion drafted only into an empty textarea (mount and update), exact note text, never auto-sent, never overwrites a non-empty or edited draft, empty string is absent |
| banners.test.ts | C5, C6 | silent text variants, escalate one-shot (stays disabled while silent stays true, re-enabled after false then true); drift banner per verdict (`drift`, `needs_user`; `on_track` shows nothing), lists omitted when empty, 3 source notes, accept button, coexistence order |
| lifecycle.test.ts | C7, C8 | scroll pinning with stubbed scroll props on the log instance; draft and focus survive update; no listener duplication; destroy empties host, idempotent, no-op afterwards, detached nodes inert; add/removeEventListener spy (AbortSignal-aborted counts as removed); remount |
| keyboard.test.ts | C9 | digits 1-4 without modifier stop at the textarea (and are not default-prevented); with ctrl/meta/alt, other keys, Ctrl+Enter, other elements, keyup/keypress all still bubble |
| invalid.test.ts | C8 | 26 malformed VMs for mount and update, non-objects, inherited keys (`constructor`, `__proto__`, `toString`) in `from`, drift verdict and source, no "undefined"/"null"/function source in text, missing handlers |
| static-source.test.ts | C2 | no innerHTML, outerHTML, insertAdjacentHTML, document.write, eval(, new Function, string timers, DOMParser; no firebase/network; types.ts exports; `@ts-expect-error` type contract |
| styles.test.ts | Styles | agents.css real, contract selectors, bubble alignment/tint/gradient, no hex/rgb/hsl/named colours, no ids, no !important, every `var(--x)` in tokens.css (read at test time) or agents.css, durations only via `var(--motion-duration)`, reduced-motion block |

## Judgement calls (spec silent or ambiguous)

1. Draft and counter updates are driven by the textarea `input` event; tests set `.value` then dispatch `input`.
2. The chat is the single child of `host`; the `ol.agent-chat-log` element instance is reused across `update()` (needed for scroll preservation and for the spec's per-instance stubs).
3. Agent label uses the message's `agent` field; `re` is not rendered or tested (AUSENTE in spec).
4. `time.chat-at` text equals `at` verbatim.
5. Counter and limit use the trimmed text (as send enablement does); counter tests use untrimmed-safe strings except one explicit trim test.
6. Scroll: "at bottom" tested only at distance 0, "away" only at 40 px or more; tolerance between is unspecified.
7. The suggest/accept/escalate/close buttons are `type=button`; the note and counter live anywhere inside the section (counter inside the form).
8. A suggestion that cannot be drafted (non-empty textarea) leaves no assertion on the note; empty-string suggestion counts as absent; `silentFor` empty string is not tested.
9. Escalate one-shot: the second click is tested by dispatching a click on the disabled button; jsdom delivers it, so the implementation must also guard in its handler.
10. Banner text is matched with `textContent` containment (banner also holds buttons); source note element type is free.
11. C9 modifiers tested: ctrl, meta, alt; shift is not tested. Only `keydown` on the textarea is stopped; stopping is bubble-phase `stopPropagation` (a document capture listener cannot be blocked).
12. Malformed `drift.verdict` values other than `drift`/`needs_user` may render nothing; only "no throw, no leaked function text" is required. Non-string list entries are not asserted.
13. CSS: `primary` must appear in the user-bubble rule (primary tint), agent bubble must not use it; the nano rule must contain `gradient`. Named-colour scan covers a short keyword list. The token test fails while `styles/tokens.css` has no custom properties (U36 not landed); token names are never hard-coded.
14. Add/remove spy test uses `window.EventTarget.prototype`; listeners registered with an `AbortSignal` that is aborted by `destroy()` count as removed.

## Repair loop 1

Source: `strategy/flights/U35/REVIEW_1.md` (HOLD, three BLOCKING findings). File: `review1.test.ts` (regression only; earlier oracle files untouched).

1. C3 double send: `onSend` synchronously calls `handle.update()` with the same `suggestion`. One native click on `button.chat-send` (via `.click()` and via a dispatched `MouseEvent`) and one Ctrl/Meta+Enter must call `onSend` exactly once; the restored suggestion stays in the textarea and is not auto-sent. A second deliberate click sends again. Required fix: the form `submit` listener is the only native button-send path.
2. C9 modifiers: digits 1-4 with Shift, Alt, Ctrl or Meta must reach a document `keydown` listener; plain digits 1-4 must not and must not be default-prevented. Required fix: add `!e.shiftKey` to the guard. Supersedes ORACLE note 11 ("shift is not tested").
3. DISP_03 handler failures: for each of `onSend`, `onSuggest`, `onEscalate`, `onAcceptDrift`, `onClose`, a returned rejected Promise (cast through `unknown`) and an async throwing function must raise no `process` `unhandledRejection`; a synchronous throw must neither escape `dispatchEvent` nor reach `window` `error`. Ctrl+Enter send is covered too. Later activations must still invoke the handler (escalate is excluded from the repeat check: it is one-shot by C5).
4. Notes: `Event.isTrusted` is never redefined. Rejection detection needs real timers (flush = microtasks + 15 ms timeouts). jsdom reports listener exceptions through `window` `error`, which the sync-throw tests spy on.
