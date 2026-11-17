# U106 independent fail-first oracle

Spec status: DRAFT. Source: `.unit/SPEC.md`, including binding Amendments A and B.
The oracle imports existing production exports and changes no production files.
Its initial expected failures are assertion failures for missing time/body anatomy,
missing metadata containment, and missing Diary shrink/wrap declarations.
A passing unit suite is advisory and does not grant ADMIT or satisfy the capsule gate.

## Acceptance-to-test map

Parameterized names below expand over `microtask` and `memory` where indicated.

| Acceptance | Test file and names | Coverage |
| --- | --- | --- |
| A1 | `diary.test.ts`: `A1 full %s entry has ordered time/body cells and exact body content` | Exact supplied fixture; day heading, kind, direct time/body children, title/outcome/metadata/evidence body order, duration then author, literal supplied text. |
| A2 | `diary.test.ts`: `A2 %s entry retains an empty time cell and populated body`; `A2 %s entry omits absent optional containers without inventing values`; `A2 %s entry omits empty optional containers`; `A2 optional metadata for %s > $label preserves body order and omits absent spans` | Both entry kinds, missing time, absent/empty optionals, author-only, duration-only, and no-metadata permutations. |
| A3 | `diary.test.ts`: `A3 hostile %s fields are literal passive text in their designated elements`; `A3 hostile %s content remains inside the body except day and time`; `A3 long unbroken %s title/outcome/evidence retain bounded literal content`; `A3 outcome text preserves supplied newlines and spaces` | Literal title/outcome/author/evidence plus Amendment B hostile time/day/duration; no parsed payload elements, event attributes, links, or alert call. Long title/evidence remain complete; outcome retains its existing slice. Browser wrapping remains a capsule obligation. |
| A4 | `diary.test.ts`: `A4 $label yields only the empty-state message without throwing`; `A4 mixed null/valid %s entries survive group and entry filtering`; `A4 $label preserves exact outcome/duration slices and evidence prefix`; `A4 repeated days preserve first-seen group order and entry/evidence order`; `A4 malformed builder input %j is contained`; `A4 the render boundary contains throwing group/entry accessors`; `A4 amendments preserve microtask/memory entries without synthesizing lifecycle entries` | Empty/non-array/null-only inputs, malformed group filtering, mixed null/valid entries, below/at/over existing limits, first-seen day order, stable entry/evidence order, non-throwing boundaries, no synthesized lifecycle entries. |
| A5 | `diary.test.ts`: `A5 structure oracle accepts a control and rejects its unwrapped mutation (at=%j)`; the production A1 and A2 structural tests above | A conforming disposable DOM control first passes the same structural assertion; removing its body wrapper makes that assertion throw. Run the production A1/A2 tests on the unchanged implementation to obtain fail-first assertion failures. Source-level candidate mutation and browser defect evidence belong to integration verification. |

## MUST and amendment coverage

| Requirement | Oracle coverage |
| --- | --- |
| M1 | A1/A2 use the same strict direct-child anatomy assertion as the A5 control. An empty time cell is required. |
| M2 | A1/A2 verify container tags, content order, metadata permutations, both kinds, day headings, entry order and evidence order. |
| M3 | `layout.test.ts`, parameterized over `light` and `dark`: `M3/B2 body and immediate children have explicit zero minimum widths`; `M3/B2 body and all content wrap unbroken text anywhere`; `M3 preserves the wide grid and a narrow time/body stack`; `M3 preserves outcome whitespace and token colors`; `M3 body content has no clipping, ellipsis or forced non-wrapping`; `M3 added shrink/wrap overrides stay within Diary`. |
| M4 | A3 passive-text assertions and A4 constant-relative boundary tests retain `PLAN_VIEW_LIMITS.OUTCOME_MAX`, `TOOK_MAX`, and `EVIDENCE_MAX`. |
| M5 | A2 omission cases and A4 empty/malformed/accessor cases. Accessor exceptions are contained; no continuation or empty-state copy is invented for the exceptional path. |
| M6 | The targeted suite must be red on the initial implementation for assertion reasons; A5 independently tests oracle discrimination. Existing regression suites and TypeScript diagnostics must be compared with their baseline. Capsule admission remains external. |
| A-U106-1 and Amendment B item 1 | Author belongs inside `p.entry-meta` in `.entry-body` whenever nonempty; empty/absent author is omitted. |
| A-U106-2 and Amendment B item 3 | A4 confirms exact input entry cardinality and kinds, with no generated `deployed`, `finished`, or `failed` entry. A3/A4 also cover the added hostile, long-token and mixed-null fixtures. |
| Amendment B item 2 | M3 declaration tests; actual scrolling and rectangle checks remain with U114. |

## Interpretation and verification boundaries

- An optional metadata container exists only when duration or author has nonempty
  text. Missing author is not replaced with a fabricated slug.
- Body children means immediate element children for the explicit `min-width`
  requirement. Wrapping also covers nested metadata spans and evidence items;
  normal CSS inheritance of `overflow-wrap` is accepted.
- CSS probes use the mandated public DOM shape, independently of the renderer, so
  the current missing wrapper cannot conceal missing layout declarations. These
  fixtures do not replace or stub production exports.
- The A5 mutation is confined to a disposable DOM node because this assignment
  permits only test-directory writes. Its positive control prevents a vacuous
  rejection test; the same assertion directly rejects the production defect.
- The no-lifecycle requirement prevents synthesis from valid microtask/memory
  input; it does not add a protocol rule about unsupported input kinds.
- Runtime malformed fixtures cross the typed boundary deliberately. No new
  model fields or production signatures are required. Fixtures have fixed text,
  bounded sizes and a fake clock; network calls and pending timers are rejected.
- No assertion uses jsdom scroll widths or rectangles as browser-layout evidence.

## External numbered checks: out of scope for this test-only assignment

| Spec check | Status and owner |
| --- | --- |
| Capsule check 1 | OUT OF SCOPE — U114 prepares and completes an assigned dependency-ready task through shipped tools, then verifies the hosted Diary and supplied metadata. |
| Capsule check 2 | OUT OF SCOPE — U114 opens the no-time fixture and checks actual body placement. A2 provides only the unit structure oracle. |
| Capsule check 3 | OUT OF SCOPE — U114 verifies hostile/long-path/memory fixtures, both themes, the specified viewports and browser zoom, non-overlapping rectangles, no clipping and `document.documentElement.scrollWidth <= window.innerWidth`; also legacy Diary, Memory and archive rendering. |
| Capsule check 4 | OUT OF SCOPE — U114 records fresh initial, candidate and integration evidence bound to their identities. Historical receipts do not substitute for a new failing capsule. Only the orchestrator issues ADMIT. |
| Hardening check | OUT OF SCOPE — U115 owns `diary-scroll-10k`, fixture hash, percentile timings and peak RSS in a quiet window. No latency budget is asserted and no optimization is introduced. |

Capsule launch/build commands and hardening results: AUSENTE — no inventar.
Lifecycle production belongs to U136 through U132; broader token consolidation
belongs to U127. These are not failing U106 unit checks.

## Reproduction and freeze

Run from the repository root with installed dependencies and network disabled:

```sh
npx vitest run tests/unit/u106 --no-cache
npx tsc --noEmit -p .
npm test -- --no-cache
```

The initial targeted test run must contain assertion failures for the missing
behavior, with no import errors. Compare TypeScript diagnostics before and after:
pre-existing diagnostics elsewhere are not new oracle errors. The complete unit
run must retain the existing green tests while exposing the intentional oracle
failures. Disabling test caching avoids generating repository cache artifacts.

Freeze the completed oracle before production authoring, retaining the digest in
the external verification result rather than a self-referential manifest:

```sh
sha256sum tests/unit/u106/ORACLE.md tests/unit/u106/diary.test.ts tests/unit/u106/layout.test.ts
sha256sum tests/unit/u106/ORACLE.md tests/unit/u106/diary.test.ts tests/unit/u106/layout.test.ts | sha256sum
```

This mandate is limited to the supplied spec and the isolated project surfaces.
