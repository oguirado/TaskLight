# ORACLE U07 (prompt pack)

Files: `helpers.ts`, `build.test.ts` (70 tests incl. versions), `versions.test.ts` (module-mocked), stub in `src/prompts/` (accept-all, hash `00000000`).
Red vs stub: 65/70 (5 green = true controls: constants, no-mutation, v1 no-fallback, lone-surrogate no-crash, purity); `tsc` clean for u07 and src/prompts.

| Case | Spec rule |
|---|---|
| Q1 cap_enforced + suffix/contiguity/marker-first-line, budget sweep | B9, B10, B11 |
| Q2 determinism, shuffled/reversed, frozen input, asc seq render | B1, B8 |
| Q3 newest clipped keeping tail; 1000 per-event cap | B10.1, B10.3 |
| Q4 BAD_BUDGET (100, 511, 7301, 9000, 1000.5, NaN); OVER_BUDGET (prev max @512; 7300 header via mocked pack) | B9 |
| Q5 hash shape, distinct, frozen, FNV vectors, canonical string, template edit changes hash (mocked) | B4, B3 |
| Q6 v9 fallback | B3 |
| Q7 private digest | B13 |
| Q8 cloud_eligible | B12 |
| Q9 delimiters, controls, `‹‹‹`/`›››`, kind/caption/digest/prev | B6 |
| Q10 EMPTY_DELTA, DUPLICATE_SEQ, BAD_INT, TOO_MANY_EVENTS, sorted errors | B8, B1 |
| Q11 vocab listed | B5 |
| Q12 digest order, drop whole, ids, limits | B13 |
| Q13 surrogates (sweep 512..760 mocked) | B10 |
| Q14 prev bounds | B7 |
| Q15 screenshot | B14 |
| layout, 5 tasks, exact result keys, single-turn, purity | B2, B5, section 1 |

## Ambiguities / AUSENTE
- Event/prev/digest line rendering format is AUSENTE; tests only assert presence and ordering.
- B6 does not list prev text or projectId for sanitisation; tests assert the delimiter-once invariant anyway (prev, digest projectId may alternatively reject).
- Whether per-event cap (step 1) alone adds `TRUNCATED` is unspecified; tests assert only `clippedChars >= 4000`.
- `PROMPT_PACKS` injection: no public API, so mocked tests use `vi.doMock("src/prompts/templates")` and assume build/hash import `PROMPT_PACKS` from `./templates`.
- Digest budget test assumes no "omitted" marker in digest (spec silent), so 3 entries fit exactly in the size of a 3-entry build.
- Test imports `PROMPT_LIMITS`/`DEFAULT_PROMPT_VERSION` from `limits.ts`; `TaskId` from schema.
- BAD_BUDGET / error `path` for budget, PRIVATE_TEXT path unspecified: not asserted.
- Text carrying `prompt_version`/`template_hash` (section 1) is not asserted (fields only).
- `src/schema` is currently a stub (empty enums/LIMITS): tests use literals except the B4 canonical test, which imports enums.

## Repair loop 1
Review: strategy/flights/U07/review_hydrogen_r0/REVIEW.md (HOLD). New file `repair1.test.ts` (15 tests, all FAIL on current impl; the 70 existing pass).
| Finding | Decision | Reason |
|---|---|---|
| B3 prototype-key version in buildPrompt (`toString`, `constructor`, `__proto__`, `hasOwnProperty`, `valueOf`) | ACCEPTED: tests | B3 says an absent version falls back to v1 + UNKNOWN_VERSION_FALLBACK; inherited keys are not packs. Output must equal the v1 output. |
| B4 templateHash with prototype-key version | ACCEPTED: tests | Same rule; hash must equal the v1 hash for all 5 tasks. |
| B5 enums hardcoded in templates.ts, not read from schema | REJECTED (untestable) | `src/schema` is an empty stub; a value test cannot tell the two apart. The B4 canonical-string test already pins the imports. Revisit after U05 freeze. |
| B10 reserve on i===0 / single event (false OVER_BUDGET, spurious clip) | REJECTED | B10.4 says "marker's space is reserved up front" and B9 defines OVER_BUDGET with the maximum marker included. The impl matches the spec; the review contradicts it. |
| B13 digest emits only headline / no LIMITS check on digest strings | REJECTED | A private entry with headline or next_action is already PRIVATE_TEXT (existing test Q7a), so no render path exists. B13 sets no length limits on digest strings. |
| Unbounded `event.kind` / digest strings -> OVER_BUDGET | REJECTED | The spec caps only event text (EVENT_TEXT_MAX), caption and prev; section 4 sanctions OVER_BUDGET without a rule to bound kind/digest strings. Spec gap, not a defect. |
| PROMPT_LIMITS runtime-mutable | REJECTED | Spec declares `as const` (type-level); only PROMPT_PACKS is required deep-frozen (Q5). |

## Repair loop 2
Review: strategy/flights/U07/review_hydrogen_r1/REVIEW.md (HOLD). New file `repair2.test.ts`.
| Finding | Decision | Reason |
|---|---|---|
| B5 STATUSES/ATTENTIONS hardcoded in templates.ts | ACCEPTED: tests (orchestrator decision) | U05 is now real; test mocks `src/schema` with disjoint `CAPSULE_STATUS`/`ATTENTION` and asserts each prompt lists exactly the exported values per task (stale real values must be absent). Supersedes the loop-1 rejection. |
| B8/B13 sparse holes skipped by forEach | ACCEPTED: tests | delta/entries holes are missing elements: `BAD_INPUT` at `delta[i]` / `entries[i]` (not path "" and not OVER_BUDGET). |
| Unbounded scan above MAX_EVENTS_IN / DIGEST_MAX_ENTRIES_IN | ACCEPTED: tests | Spec labels both as "input bound". Tests assert `TOO_MANY_EVENTS` / `BAD_INPUT` plus a bounded error list on 1,000,000-element inputs (no 999,999 duplicate errors). Error-count bound is a test-side reading of "input bound". |
| B13 private digest: PRIVATE_TEXT only for headline; double error BAD_INPUT+PRIVATE_TEXT on `headline: 123` | REJECTED | Spec fixes only the code (`PRIVATE_TEXT`) for a private entry carrying headline or next_action; error path and per-field multiplicity are unspecified (ORACLE: path not asserted). Existing Q7a already asserts the code. |
| templateHash("toString" as TaskId) prototype lookup | REJECTED (unobservable) | Impl already guards the version with `Object.hasOwn`; an inherited task key yields function without header/footer, i.e. the same empty strings as an absent task; no observable difference. TaskId is a closed union (spec has no rule for non-TaskId). |
| Stale `// STUB (oracle phase)` comments | REJECTED | Style only. |

## Repair loop 3
Review: strategy/flights/U07/review_sol/REVIEW.md (HOLD). New file `repair3.test.ts`.
| Finding | Decision | Reason |
|---|---|---|
| prompt_version / template_hash absent from string | ACCEPTED: tests | Spec 1 Purpose: "It carries `prompt_version` and `template_hash`". Tests: text contains both for all 5 tasks, version actually used on fallback, and budget (<= maxChars) still holds with identity present. |
| projectIds not rendered for capsule/screenshot | ACCEPTED: tests | `projectIds` = "ids actually present". Tests: id appears in text, differing ids give differing text, hostile id adds no delimiter (B6). |
| B5 missing EVENTS block (screenshot) / PREVIOUS STATE (digest) | REJECTED | Screenshot input has no events and digest input has no prev; B5 defines no content for these blocks. Requiring empty blocks would invent format; needs a spec amendment (AUSENTE). |
| Caption clip not reported (B10/B14) | ACCEPTED: tests | B10 "clippedChars counts removed characters. Any truncation adds TRUNCATED"; Truncation type is shared. Reading is broad (B10 sits in the event-delta section), so tests cover only the unambiguous case: 281/500-char captions report clippedChars and TRUNCATED; 280 does not. |
