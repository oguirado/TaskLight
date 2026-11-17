# U126 fail-first oracle

Status: independent tier-1 oracle; no implementation or ADMIT claim. The supplied specification is DRAFT, W3, KEEP, and DEFERRED after 30 Nov in the lean plan [CITED: `.unit/SPEC.md`]. Its complete Amendment B is binding. U123 is the amended integration dependency; U106 Diary preservation remains covered.

## Surface and execution gate

Only `tests/unit/u126/` is authored. Existing implementation surfaces are read-only here: `src/views/memory.ts`, `src/views/plan.ts`, and `src/app/agent_store.ts`. Reference owners remain untouched: `src/views/index.ts`, `src/views/types.ts`, `src/plan/reducer.ts`, `bridge/room/ext/export.py`, and `docs/HEADLESS.md`. No production stub, new dependency, stylesheet, operation, tool, or error code is introduced.

The positive gate is explicit assertions against independent fixtures and the actual Python `memory_history` tool. Its negative contrast is final-value-only history, conflated phase labels, skipped room validation, or leaked room history. Import, collection, subprocess, and fixture-admission errors are infrastructure failures, never successful fail-first evidence.

Run from the isolated repository root:

```sh
mkdir -p tests/unit/u126/.runtime/tmp
npm_config_cache=tests/unit/u126/.runtime/npm npx vitest run tests/unit/u126 --no-cache --configLoader native --maxWorkers 1 --fsModuleCachePath tests/unit/u126/.runtime/cache
npx tsc --noEmit -p .
```

The native configuration loader and explicit cache location keep caches away from shared dependencies. Tests use fake clocks, bounded subprocesses, denied network ports, and no sleeps. `python_oracle.py` creates and removes scratch `CW_HOME` directories only under this test directory. It reads the real handlers and CLI, compares journal bytes before and after, and rejects automatic Markdown-file creation. The CLI uses fixed argv with the documented JSON argument; no shell executes a rendered command.

## Numbered acceptance map

Test names below are the literal titles in the named files. Parameterized titles identify their concrete arguments at runtime.

| Spec case | Test file and names | Required observations |
|---|---|---|
| A1 | `history.test.ts`: `A1 shared fixture matches the actual Python memory_history tool`; `A1 plan exposes both accepted versions in Lamport order despite reversed timestamps`; `A1 M1 toWallVM carries selected room and history without an active plan`. `memory.test.ts`: `A1 A3 M3 renders native History with newest-first revision, author, timestamp and full text`. | `fixture.json` supplies the exact events and explicit expected versions to both implementations. Final text remains `new`; timestamps do not order versions. |
| A2 | `history.test.ts`: `A2 repeated event, repeated operation, stale revision and invalid operation stay excluded`; `A2 accepted op_id deduplication spans non-memory operation kinds`; `A2 rejected operations do not consume accepted operation identities`; `A2 same operation identity from different agents remains independently accepted`; `A2 first event-id occurrence wins over a changed duplicate payload`; `A2 equal Lamports use event id before reversing accepted versions`. | Replays, first event identity, accepted cross-kind `(agent,op_id)` identity, rejection, `stale_rev`, and `(lamport,id)` tie order match explicit expectations and Python. Invalid envelopes may be rejected at ingestion and must stay excluded. |
| A3 | `history.test.ts`: `A3 reverse arrivals and valid close/reopen preserve history at maxPerRoom=%i`; `A3 U123 compaction retains non-beat memory operations with maxPerRoom=1`; `A3 keeps exactly the newest 100 versions in server order per section`; `A3 M1 each section keeps its own history and final value`; `A3 A6 selected-room history is scoped before rendering and updates on room switch`; `A3 no selected room supplies no history or room identity`. `memory.test.ts`: `A3 M3 missing history metadata says History unavailable`; `A3 M3 missing section history differs from an explicitly empty retained array`. | Reverse arrival primes and invalidates the cache; close/reopen remains valid. Actual activity-beat compaction retains the memory events. Per-section retention, unavailable versus explicitly empty metadata, and room isolation are independent checks. |
| A4 | `memory.test.ts`: `A4 accepted hostile memory text is literal in both current and historical content`; `A4 Amendment B hostile history author and section label use text nodes`; `A4 malformed history %j never throws or fabricates versions`; `A4 Amendment B __proto__ section key is rejected without polluting history`; `A4 malformed inherited history never turns an absent own section into a version`; `A4 A6 M4 invalid or missing room %j has Command unavailable and no command`. `phase.test.ts`: `A4 Amendment B phase.label is literal in labels and chips`. | Literal markup creates no executable elements or requests. The exact hostile room from the spec produces no command. Malformed versions never fabricate revision, author, timestamp, or text. Prototype keys and inherited metadata cannot pollute other sections. |
| A5 | `phase.test.ts`: `A5 selecting Build leaves Current phase Discovery and independently labels the Build filter`; `A5 mounted Wall select/show-all preserves filtering, plan and revision (keyboard=%s)`; `M5 null/omitted phase selection %j means All phases`; `M5 unmapped identifiers current=%s selected=%s render Unknown`; `M5 resolves the current label from plan.phaseId rather than active flags or the filter`; `M5 preserves the existing delegated Show all phases owner without rendering a duplicate`. | Current and filter labels differ; `aria-current` and `aria-pressed` remain independent. Build filters to T02; the sole existing Show all phases control restores both cards without changing the input plan or revision. Mouse and modeled keyboard activation are exercised. |
| A6 | `memory.test.ts`: `A6 M4 demo produces exactly the documented command with only the documented JSON keys`; `A6 command is selectable and any textbox is read-only`; `A6 documented CLI returns the existing untrusted Markdown envelope without appending`; `A6 switching rooms replaces the command and removes previous room versions in the mounted Memory view`; `M4 validated boundary slug %s is the only substituted command value`; `M4 absent memory renders Command unavailable without an executable string`; `M4 a selected room can export memory even when it has no sections or active plan`. `readonly.test.ts`: `A6 M6 real controller interactions append no events and invoke no transport/provider ports`. | The command, fixed agent, JSON key set, guidance, selection, invalid-room fallback, CLI envelope, unchanged journal, absence of automatically saved Markdown, and mounted room switch are checked. Actual `link.post` and reviewer/provider-facing ports are spied across disclosure, copy, and filter actions. |
| A7 | `negative-controls.test.ts`: `A7 final-value-only history is detected by the same A1 assertion`; `A7 using the selected filter as the current phase is detected by the same A5 assertion`; `A7 skipped M4 slug validation is detected by the same invalid-command assertion`; `A7 unscoped room history is detected by the same selected-room assertion`; `A7 broken mutant infrastructure is explicitly rejected instead of counted as detection`. | Each targeted boundary mutation first passes a known-good calibration using the same assertion as the product test, then must produce the expected AssertionError. TypeError and setup failures are rejected as detection. Existing-suite and TypeScript evidence is recorded separately below. |

## Additional MUST coverage

| MUST | Tests beyond the acceptance map |
|---|---|
| M1 | Optional local structural test types preserve old callers; `M6 legacy callers may omit the additive history fields`. Selected-room metadata is asserted even with no active plan. |
| M2 | `M2 canonical history ignores a restrictive template override`; `M2 history does not refold every prefix or refold on cache hits`; `M2 cached history invalidates on a late arrival that unblocks a later revision`; `M6 cached reads preserve projection equivalence and isolate returned mutation`. The cold-fold bound allows a display fold and a separate canonical fold [TARGET: at most 2 calls]; warmed reads require no additional full fold. |
| M3 | `M3 each rendered section has its own History disclosure`; `M3 History summary is natively focusable and can be activated by the keyboard model`; `M3 historical text preserves full lines and selectable contents`; `M3 M6 preserves current text, revision explanation, author/time and required-empty flags`. |
| M4 | Exact `Memory export command` / `Command unavailable` copy, fixed `worker-a`, no download claim/control, selection and read-only semantics, configured-checkout/`CW_HOME`/Markdown/no-automatic-save guidance. |
| M5 | Visible text checks reject hidden/ARIA-hidden/inline-hidden labels. Unknown phase ids never borrow a label. The existing index-owned filter control is exercised, not replaced. |
| M6 | `M6 keeps the U106 Diary body and read-only task detail delegation intact`, controller transport/provider spies, unchanged event journal, optional DTO fields, projection equality, and preserved legacy suite runs. |

## Resolved ambiguities and limits

- Amendment B wins over the earlier dependency wording. This oracle does not waive U123 integration or a later admission gate.
- ISO-8601 UTC timestamps with or without zero fractional seconds, UTC-offset spelling, or the exact raw epoch fixture value are accepted. Local-time display alone is insufficient.
- The spec leaves malformed-history fallback wording open. Those cases require containment and no fabricated version; only truly absent metadata and supplied empty arrays have pinned distinct copy. Inherited section data is treated as absent, and the existing operation validator rejects the invalid `__proto__` section.
- A selectable command may use a read-only textbox or a selectable text element. The oracle does not prescribe a new CSS class, command transport, copy button, or historical-entry container.
- Both ingestion rejection and fold rejection exclude invalid operations. Only the valid stale-base operation specifically requires `stale_rev` in the retained projection.
- jsdom has no native Tab navigation or Enter default action. Keyboard tests check focusability/focus and dispatch key events, then model the uncancelled native activation. They do not claim real-browser keyboard or assistive-technology proof.
- Negative controls mutate independent public-boundary observations without editing production files. They prove that the frozen shared assertions reject the specified faulty behaviors. Actual source-mutant integration receipts remain AUSENTE until an implementation clears the positive gate; an already-red implementation is not a successful source-mutant integration receipt.

## Out of scope and stop rules

| Check | Status and gate |
|---|---|
| U123 compaction implementation, U106 Diary redesign | Owned by those units. This lane verifies retention and preserved rendering only; failures in their own suites are reported separately, not attributed to U126. |
| Historical I0 at `4528625` | AUSENTE: this isolated copy has no Git metadata. No historical checkout is inferred or modified. Current supplied-tree identity is pinned below. |
| Capsule at 390×844, 768×1024, 1440×900, and 200% zoom | AUSENTE [CITED: spec targets]. No capsule starts here. A later capsule must stop before launch at load5 ≥ 18 [CITED: `.unit/SPEC.md`]; absent load evidence cannot pass that gate. |
| Browser layouts, frame SHA-256 receipts, real keyboard, Diary/task-detail journey, fresh-clone tier-2 | AUSENTE. Unit DOM checks are tier-1 evidence only. ADMIT requires the specified fresh-clone tier-2 integration and visual receipts. |
| Source surface, transport additions, dependency additions, commit/push/deploy | No such action is authorized for this oracle lane. The outside-test content digest must remain equal to its baseline. |

The mandate is scoped to `.unit/SPEC.md` and the supplied isolated project corpus.

## Verification on the unmodified supplied implementation

All results below are [MEASURED]. The current baseline collects every test and fails only assertions for missing U126 behavior; there are no import, collection, fixture-admission, or subprocess failures. The independently calibrated negative-control file passes.

```text
Test Files  4 failed | 1 passed (5)
     Tests  54 failed | 21 passed (75)
```

| Verification | Result |
|---|---|
| U126 | 75 tests; 54 red, 21 green [MEASURED]. Missing retained-history seam/disclosures/export guidance and visible phase labels explain the red cases. |
| Existing affected suites: `tests/unit/u62`, `tests/unit/u94`, `tests/unit/u106`, `tests/unit/u113` | `Test Files  11 passed (11)`; `Tests  221 passed | 1 skipped (222)` [MEASURED]. The skip is pre-existing. |
| U123 dependency, separately | `Test Files  6 passed (6)`; `Tests  61 passed (61)` [MEASURED]. |
| U123 package baseline, separately | 22 failures [CITED: supplied context package]; historical package evidence, not the result of this isolated-copy run. |
| `npx tsc --noEmit -p .` | Exit 1 with the same 16 pre-existing diagnostics; zero errors in `tests/unit/u126/` [MEASURED]. |
| Existing corpus outside `tests/unit/u126/` | 1270 file identities unchanged [MEASURED], excluding dependency and interpreter-cache directories; aggregate SHA-256 `ff98792a84872730aea2c3d5b3db45e7a242b511a4926e89eff104baeb534dab` before and after [MEASURED]. |

## Frozen identities

SHA-256 values below are [MEASURED]. Test executable and fixture pins are frozen before any production authoring. The Markdown mapping is not self-hashed.

| Relative path | SHA-256 |
|---|---|
| `.unit/SPEC.md` | `13563b05aac65ae71372b73c7e0a932692c06f995cfe42ff583cd29980c5a02c` |
| `src/app/agent_store.ts` | `f9434d3e5edae334d931db9a79621cd98d0f56d1882c3ae4b43e21b0fa89d55d` |
| `src/views/memory.ts` | `ae94506cc86be09e4acdea2343c622da0722b061211dae65c00f7e9245c906bc` |
| `src/views/plan.ts` | `4029a32effb27b4b793d021fe8ca3afc6fa0c403896cba7cf198555165a5bfd5` |
| `src/views/index.ts` | `f7f79754dd1e687d0502e4871cac994e9ee9649a70a94e9dcf586b30dfd80517` |
| `src/views/types.ts` | `8d5b26903cac5025a61649151b18a5e0fad59d4306841dfc0ff838086fa97285` |
| `src/plan/reducer.ts` | `47bd592f51d30e827a867edd66e25f7b5dbdb4a0c5d9808163bfebb1184858f5` |
| `bridge/room/ext/export.py` | `b324e127a5e72023f090520190ad04b1f9b5edfd830bfd329d51a1f1cddd7e54` |
| `docs/HEADLESS.md` | `1c9d105d189054699662a30733215c0bd1ef2d4b8389c17f430b3152ef52d33b` |
| `tests/unit/u85/fixture.json` | `21c5b2f17cd3f6af1a60535e12e5b307c0ea1893b10707c2f4314d9f2170b138` |
| `tests/unit/u126/fixture.json` | `ea29e1cde1e091a3103df8d7848bee1ef054112c34e2bdb3e92176a236852ca3` |
| `tests/unit/u126/history.test.ts` | `5d2bf07ce76e43bffcd6ab31ec6b19ab44918a3170234b13c8d7c7c04e889be6` |
| `tests/unit/u126/memory.test.ts` | `fcd2845de954512dbabb81bc67d3e520adfd6bb030757c1c08d5b725880a9842` |
| `tests/unit/u126/negative-controls.test.ts` | `486f321c84d2e93057b6a1de0a5840781469c904ccd095b49c916de6f48b5db1` |
| `tests/unit/u126/oracle.ts` | `018bc2a77350fdff287c9cf18c4452b666d93c1ca94e48207d12001f284e7fd0` |
| `tests/unit/u126/phase.test.ts` | `28137da04c6200cd9c2568aa9956fb8cef4375b1e8ec708d072baedb2093d7f4` |
| `tests/unit/u126/python_oracle.py` | `ca9a59b175d69612d7e0d14bc1add842f95262d2a23181fd75e934ff97f7b60d` |
| `tests/unit/u126/readonly.test.ts` | `54cba981e44f0c2c6c8d39eaeae5828cde83daaba55b9eea87ef10bc9111c026` |
