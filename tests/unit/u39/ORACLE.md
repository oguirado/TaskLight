# U39 oracle (fail-first)

Targets: `src/router/{types,tokenize,table,score,route,nano,index}.ts` (function stubs throw `U39 stub`; types/constants final). Spec: `specs/SPEC_U39.md`. Files: `router.test.ts`, `nano.test.ts`, `static.test.ts`, `fixtures.ts`, `golden.jsonl` (68 rows: 56 main + 12 off-topic control, ES+EN, accents and not).
Result: 182 tests, 147 red (all `U39 stub`), 35 green by design (constants, golden fixture shape, static guards). `tsc` has no errors in `tests/unit/u39` or `src/router`.

## Coverage
A1-A11 plus: top-2 near-tie abstention, Nano called only when stages 0-1 abstain (and never for text > MAX_TEXT), answer must be in the fixed enum incl. `abstain`, 400 ms timeout via fake timers (timers cleaned, late answer ignored), never rejects (port rejects/throws/garbage, hostile events, bad tier), determinism, hostile strings (~45 incl. surrogates, 1 MB, proto names), static check (no innerHTML/eval/new Function, no firebase/*, no console/storage/network, no Date/random, no redefinition of effectiveMode/createHybrid).

## Judgement calls (confirm or amend)
- J1 Stage 0 `act=plan` with a `plan` body = "existing contract" (routeEvent has no state) -> `plan_change/exact`.
- J2 `act=verdict` with text containing `needs_user` -> `escalate/exact`.
- J3 `@<agent-id>` in text -> `ask_agent`, `agent` = id, `stage=exact`.
- J4 `ANCHORS` in fixtures (6 texts, ES/EN) must be `OK` at stage lexical against the shipped `ROUTE_TABLE`; the table author must cover them. Table must have a rule for every target except `inbox` and >= 7 rules.
- J5 Non-OK decisions always have `target="inbox"`, a `reason` (ERROR excepted), integer ppm fields, 64-hex `tableHash`.
- J6 Constants live in `score.ts` (re-exported from index); `ROUTE_TABLE` in `table.ts`; Nano helpers `buildConstraint()`, `buildClassifierPrompt(text)`, `parseLabel(text)` (exact enum match, no trimming/case folding, else null).
- J7 Mode = `effectiveMode(SOURCE_FLOORS.agent[tier], "PREFER_ON_DEVICE")` from `src/lens/floors` (tests compare to it). Under a mode that forbids cloud, `IN_CLOUD` -> `privacy_cloud`.
- J8 Text > `MAX_TEXT` or absent/invalid port result -> no OK from Nano; port is not called for oversize text.
- J9 Nano label `inbox` is not pinned (only the other 6 targets must give `OK/stage=nano`); `source` is copied from the port.
- J10 A11 mutants cannot run in vitest; non-vacuity is pinned by a true-tie fixture (margin 0), accent pairs that differ bytewise, and anchors that must answer. Run the mutants (MIN_MARGIN_PPM=0, no NFKD) against the real code.
- J11 Hash is canonical over key order, not rule order (rule-order invariance is tested on decisions only).
- J12 The Nano port is injected; U39b (`route` TaskId) is not needed by these tests.
