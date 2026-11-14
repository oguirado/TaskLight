# U34 oracle (agent state, planning contract, drift review)

Run: `npx vitest run tests/unit/u34`. Stubs: `src/agents/types.ts` (spec types plus `FoldRoomResult`), `src/agents/index.ts` (nine functions throwing `U34 stub`). Baseline: 116 tests, 111 RED (stub), 5 green by design (reference FNV-1a self-checks x4, export-names check). Static scans carry a "not a stub" guard. `tsc --noEmit` is clean for `src/agents` and `tests/unit/u34`.

## Test map

| File | Spec rule | Pinned behaviour |
|---|---|---|
| fixture.ts | A1 | two agents (claude, codex), plan v1 -> v2, steps, answered + open question, close; seeded PRNG (mulberry32), shuffle, helpers |
| fold.test.ts | A1, A9 | exact states for the fixture; 60 + 50 + 50 seeded permutations (also with junk and duplicates), lamport ties by id, versioning/previous, carry-over by identical text, out-of-range steps, questions/answers, close, 29 invalid-event kinds each counted once, hostile inputs |
| plans.test.ts | A2, A3, A4 | `contractHash` equals in-file reference FNV-1a over canonical JSON for 3 fixed inputs (+ published vectors for the reference itself); 22-row diff table; 15-row rules table |
| prompt.test.ts | A5 | content, diff included, JSON instruction, untrusted-data line, quoted data, schema shape, <= 6000 chars for huge inputs, surrogate safety at many offsets |
| review.test.ts | A6 | device/cloud success, 17 bad-output kinds x 2 diffs -> rules, rejection (Error, non-Error, sync throw), malformed port results, timeout default 8000 / custom, late answer ignored, abort signal, called once, no leftover timers |
| taskvm.test.ts | A7, A8, A9 | `silentAgents` boundary/sort/closed; field mapping; 21-row status x attention table; `next`; hostile and inconsistent states |
| static.test.ts | A9 | no `innerHTML`, `eval(`, `new Function`, `Function(`; raw spec regex; no network/DOM/firebase |

## Judgement calls (flag if the spec owner disagrees)

- J1 `foldRoomWithStats` returns `{ states, invalid }` (spec only says "a counted return variant"); `FoldRoomResult` added to types.ts.
- J2 Outcomes and took travel with the state when a step is carried over by identical text.
- J3 Validity: required id/room/agent/act (string), lamport (finite integer), ts (finite number), text (string); act in the closed set (own-property check); optional `re`/`to` must be strings; `plan` act needs `{title, steps non-empty, text strings}`; `step` act needs `{index integer >= 0, state enum}`. Length caps of U33 (80/120/4096) and `re` existence are NOT enforced by the tests. Lamport 0 / negative left unpinned.
- J4 Non-array input to `foldRoom` returns `[]`. Output sorted by agent name; state key is (room, agent), tests use one room.
- J5 `contractHash` hashes the UTF-8 bytes of the canonical JSON (spec does not say bytes vs UTF-16 units); `undefined` accept is omitted.
- J6 `driftRules`: `state.contract` is the plan under review (the one the step states belong to); removed text is looked up there; unknown text counts as pending. Edits of done/active steps are drift (amended in repair loop 2, A2-U34r2): A4's "edits of `pending` steps -> `on_track`" implies edits of `active`/`done` steps are not on_track, and they are treated like removals of such steps (`drift`). Edits of `pending` steps stay `on_track`; edits of `blocked` steps stay unpinned.
- J7 `diffPlans`: an edit also requires the new text to be absent from prev (the literal spec rule would turn removing a middle step into an edit of its neighbour). Added/removed keep next/prev order.
- J8 Prompt quotes titles, step texts and accept as `JSON.stringify` strings; the untrusted line must contain "untrusted", "data" and "instruction".
- J9 `toTaskVM` summary truncation is surrogate-safe.
- J10 A plan-less, fresh, open agent is `running` (zero steps are not "all done").
- J11 When every step is done `next` is `"Waiting for a plan"` (literal spec). A verdict `drift` on a `done` task gives `high`, `needs_user` always gives `now`.
- J12 `reviewDrift(port, prev, next, opts)` has no `state`, so fallback verdicts are only pinned where state is irrelevant: addition -> `on_track`, reorder -> `needs_user`, removal -> `needs_user` or `drift`. Port prompt/schema must equal `buildDriftPrompt` of `diffPlans(prev, next)`. Timer is cleared after an answer (`vi.getTimerCount() === 0`).
- J13 Unpinned: `updated`, `source` and default `accent` of `TaskVM` (only shape checked); `took` exposed on `StepVM.took`.

## Repair loop 1

Regression tests for the five BLOCKING findings of `strategy/flights/U34/REVIEW_1.md`, all in `review1.test.ts`.

| describe | Finding | Encoded behaviour |
|---|---|---|
| REVIEW_1 B1 | malformed optional payload crashes (`evidence: {}`, `plan: {title, steps: 1}`, wrong-typed `step`) | 14 malformed events (+ JSON round trip): `foldRoom` and `foldRoomWithStats` never throw; valid events around them still fold (event ignored or bad field dropped) |
| REVIEW_1 B2 | NUL-joined state keys collide | `(room "a\0b", agent "c")` and `(room "a", agent "b\0c")` give 2 states in both orders |
| REVIEW_1 B3 | equal lamport and id, different payloads, order-dependent | plan and step duplicates with conflicting payloads fold to equal results for both input orders (any deterministic tie-break) |
| REVIEW_1 B4 | whole-prompt slice drops contract / untrusted wrapping | 10,000-char previous title plus PREVIOUS_SENTINEL / NEXT_SENTINEL steps: prompt <= 6000 chars, both sentinels and the untrusted-data line survive (fields truncated individually) |
| REVIEW_1 B5 | `silentAgents(..., 0)` treated as inclusive | threshold 0: `lastSeen === now` gives [], `now - 1` gives the agent; explicit threshold 5 boundary strictly greater |

### Oracle amendment A1-U34r1 (13 Nov)
`taskvm.test.ts` "custom threshold" asserted inclusive `>=` at age == threshold, contradicting A7 (strict `>`) and review1 B5; corrected to `[]` at exactly 600 ms and `["b"]` at 601 ms. `review1.test.ts` non-null assertions added for tsc.

## Repair loop 2

Regression tests for the four BLOCKING findings of `strategy/flights/U34/REVIEW_2.md` (finding 5, cross-room answers, is non-blocking known debt and is not pinned), all in `review2.test.ts`.

| describe | Finding | Encoded behaviour |
|---|---|---|
| REVIEW_2 B1 | non-string `accept` accepted; deep `accept` overflows `canon` | plan steps with `accept` number / object / array / boolean / null / object nested 10,000 levels (built iteratively): event ignored and counted once, surrounding events still fold, `foldRoom`, `foldRoomWithStats` and `contractHash` of folded contracts never throw; shallow bad values also do not throw in a direct `contractHash` call |
| REVIEW_2 B2 | depth-limited sort key ties events that differ only deep in extra fields | two/three events with identical id and lamport and differing extra `payload` (deep, 50 levels, array, shallow): deep-equal fold output for every input order |
| REVIEW_2 B3 | edits of active/done steps return `on_track` | `diffPlans` + `driftRules`: edit of an `active` or `done` step -> `drift` (never `on_track`, reason 1..140 chars); edit of a `pending` step stays `on_track`; mixed edits with an active one are `drift` (J6 amended) |
| REVIEW_2 B4 | finite but out-of-range timestamp makes `toISOString` throw | `toTaskVM` with `nowMs` = MAX_VALUE, -MAX_VALUE, 8.64e15 + 1, -8.64e15 - 1 and `lastSeen` out of Date range never throws and returns a TaskVM (`updated` may be empty) |

Baseline against the HOLD implementation: 34 tests, 26 RED, 8 green (guards that already hold: shallow `contractHash`, shallow tie-break, `diffPlans` shape, pending edits, out-of-range `lastSeen`).

## Oracle amendment A-U38
SPEC_U38 V3: when no model produced content, `toTaskVM` reports `source: { kind: "rules", ms: 0 }` (done-step detail and task source). `taskvm.test.ts` A8: step detail source is `rules`/0 and the task `source.kind` may be `device|cloud|rules`.

## Oracle amendment A-U42 (TaskVM status / next / close summary)

U42 demo polish changes A8 `toTaskVM`: status `done` now requires `closed` (all steps done but not closed is `running`,
so the rail "running" counter counts every task in progress); `next` is "Waiting for a plan" only without a contract,
"Completed"/"Stopped" when closed, "Waiting for the next step" when all steps are done but the agent is still open;
a `<CODE> (rc N)` close becomes a human summary and the raw code moves to the last resolved step's detail (or note).
`foldRoom`: a `plan` after `close` starts a new task (closed cleared, fresh step states, no `previous`).
Amended in `taskvm.test.ts`: row "all steps done, fresh, not closed" (now running/low, plus a closed row), the two
"verdict ... while done" rows (state now closed), and J11 (now "Waiting for the next step"). New tests: `tests/unit/u42/`.
