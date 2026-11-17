# U127 fail-first oracle

Status: **ORACLE FROZEN; product unchanged; admission HOLD**. This is an oracle for `.unit/SPEC.md`, including binding Amendment B. Running this oracle ahead of implementation does not clear M1 or authorize a product writer.

Specification SHA-256 [MEASURED]: `a43934fdd215330f2966051d49a9f7a982425a102839898d06a122a649313d70`.

Inspected integration surface SHA-256 [MEASURED]: `dcc27d37b962d01dd535579e6d8d2802ce0defa00561c34cf9e041d9896eedcb`. The digest concatenates each relative filename, a NUL, its bytes and a NUL, in this order: `.unit/SPEC.md`, `styles/tokens.css`, `styles/views.css`, `styles/agents.css`, `styles/model_selector.css`, `styles/plan.css`, `styles/wall.css`, `styles/swarm.css`, `styles/narrator.css`, `src/views/sync_notice.ts`, `src/views/index.ts`, `src/app/agent_wall.ts`. A Git revision for this isolated copy is AUSENTE; this digest identifies inspected content without claiming a sealed candidate integration.

Only `tests/unit/u127/` is written. Production imports resolve to existing modules. `browser.ts` is test infrastructure, not a product stub. `fixtures.ts` calls `renderSwarmView`, `renderNarrator`, `createModelSheet` and `createSyncNotice`; fixed view models supply no inference or transport. Legacy Diary/detail hooks supplement the rendered controls. CSS is read from the actual stylesheets, in hosted order, with `styles/narrator.css` included explicitly for its isolated surface.

Run from the repository root:

```sh
npx vitest run tests/unit/u127 --no-cache
npx vitest run tests/unit/u106 tests/unit/u112 tests/unit/u136 --no-cache
npx tsc --noEmit -p .
```

`--no-cache` prevents test-result writes outside the assigned directory. Offline Chromium is required for rendered assertions; `U127_BROWSER` may choose an installed executable. Pipe transport opens no server or listening port. Page requests are blocked; background networking is disabled. Browser animation playback is frozen; fixture code uses no sleeps, real timers, network services or wall-clock inputs. Browser profiles are created and removed within this test directory. Browser execution failure is a failed precondition, never evidence that a mutant was detected.

## Numbered acceptance mapping

Test names below are literal titles or parameterized title prefixes. `styles.test.ts` uses real browser computed styles and geometry; `sync_notice.test.ts` uses the real component in a DOM environment. A source assertion never substitutes for rendered A1/A2/A3 evidence.

| Acceptance [CITED: spec] | Tests | Boundary / gate |
|---|---|---|
| A1 | `A1 resolves all eight aliases in the rendered %s theme`; `M2/B2 %s has no raw colour literals`; `M7/B4 state, blocker and provenance text has a nonzero contrasting box in %s`; `A6 negative M2 detects an independent legacy palette with the A1 oracle` | Default, light and dark aliases are compared as computed colours. Distinct canonical perturbations expose coincidentally equal raw palettes and wrong mappings. Empty/cyclic values fail. Reload persistence through the existing theme mechanism is an external integration HOLD. |
| A2 | `A2 uniform unclipped focus after Tab and scroll: %s`; `A6 negative M3 detects accent focus and the wrong offset with the A2 oracle` | Actual keyboard Tab reaches task open/close, metadata, narrator, Models trigger/select/radio/close and preserved phase/legacy controls. The oracle checks outline width/style/colour/offset, nonzero geometry and ancestor/viewport clipping. Full route activation and Models focus return are U118/U125 integration preconditions, not U127 failures. |
| A3 | `A3 %s makes all duration tokens zero throughout the application`; `A3/B1 %s overrides root, descendant and pseudo-element decorative durations`; `A3 preserves ordinary motion without either preference`; `A3 negative base-only override retains derived additions and is rejected by the same oracle` | Independently exercises class on app root, class on document root, and the actual emulated OS preference. Registered time probes resolve duration tokens independently of animation overrides. Normal inline root/descendant declarations and later pseudo-element rules challenge the required important overrides. Working remains visible. The negative removes reduced-motion rules, restores the base-only class rule and retains derived additions. |
| A4 | `A4 displays the exact valid Lamport interval and status/live-region attributes`; `A4 repeating the same signature creates no duplicate, replacement or live-region mutation`; `A4 unknown range says replay required; only update([]) detaches and a new gap can reattach`; `M6 sorts room/range text and deduplicates equivalent reordered input without mutating callers` | Preserves `SyncFault`, `SyncNotice`, `createSyncNotice(parent)`, exact text, caller immutability, sorting, signature deduplication, polite status region and recovery-only removal. |
| A5 | `A5 renders the entire markup-like room literally, without images, handlers or recovery controls`; `A5 retains an unbroken 120-character room verbatim`; `A5/B4 120-character rooms, Swarm and Models wrap at %ix%i, reflow scale %i`; `A5/B5 %s preserves uncertainty without asserting an invalid excluded interval`; `A5 incomplete interval uses existing replay uncertainty: %j` | Literal hostile markup, long room/task/agent/provider text, page/subtree scroll widths, reachable Models close control and invalid ranges. Reflow scale is a viewport proxy; it does not claim browser UI zoom evidence. |
| A6 | All named `A6 negative M2`, `A6 negative M3`, `A6 negative M5`, `A6 negative M6` tests; the `A3 negative base-only override` test; regression and typecheck commands above | Mutants exist only in test-local CSS/DOM. The same palette/focus/motion/spacing/overflow/uncertainty predicates reject them after fixtures execute. Freeze and fail-first observations are recorded below. Missing prerequisites and external evidence remain HOLD; no skipped test is called a pass. |

## MUST coverage and stop rules

| MUST [CITED: spec] | Oracle / treatment |
|---|---|
| M1 admission and scope | **HOLD** until U106, U118, U125, U126, U135 and U136 are ADMIT, or an explicit amended gate scope exists. Independent current admission evidence is AUSENTE. `styles/narrator.css` and Swarm/detail renderers are present in this copy; presence is not ADMIT. Reject product changes outside the stated surface. `styles/agents.css` allows token aliases only; geometry/composer/behaviour remain outside U127 authorization. These are review/integration gates, not fabricated unit failures. |
| M2 canonical colours | A1 plus raw-colour assertions on `styles/swarm.css` and `styles/narrator.css`. All legacy mappings are listed in `fixtures.ts`; existing legacy consumers are loaded. |
| M3 focus | A2 tests computed `2px solid var(--c-focus)` with `2px` offset [TARGET: spec]. Tests establish keyboard focus through Tab and inspect scrolling geometry. |
| M4 motion | A3 and Amendment B important-override challenges cover root, descendants and pseudo-elements. No app-setting click target or settings UI is invented. |
| M5 spacing and geometry | `M5/B4 %s spacing above 2px uses the scale or a justified optical exception`; `A6 negative M5 detects raw spacing; a declaration-local optical justification is allowed`; responsive drawer bounds tests; `M5 preserves separate wide Diary time/body columns`; hostile overflow tests and their negative. Spacing aliases are expanded through the existing token definitions; scale references are permitted. Optical justification must be nonempty and immediately beside the declaration. `styles/agents.css` is loaded as the geometry reference and excluded from spacing rewrites. |
| M6 truthful uncertainty | A4/A5; `M6 has the stable .sync-notice styling hook`; `M6 owns .sync-notice styling in the existing view stylesheet`; `M6 theme changes do not clear or replace component uncertainty`; negative fabricated-recovery/disappearance and innerHTML substitutions. Component theme survival does not stand in for route ownership. No dismiss or retry is authorized. |
| M7 product meaning | Rendered nonzero, colour-distinct state/blocker/provenance text; preserved U106/U112/U136 suites. `deriveSwarmViewModel` remains unchanged. Provider binding, transport, journal, lifecycle and tool contracts are outside this writer's surface; preserve `not_conformant`, `claimed_by_other`, `stale_rev` and `firebase-hybrid`. No composer, terminal, human-to-agent interaction, or Delivered-to-Received gate is added. |

The spacing threshold is strictly greater than `2px` [CITED: Amendment B]; small border/outline geometry is not spacing. Percentage layout and `auto` are not pixel literals. Retained optical exceptions require a declaration-local reason, not a stylesheet-wide waiver.

The invalid-range amendment does not prescribe exact error/fallback wording. Resolution: a malformed interval must leave visible uncertainty and the literal room, without presenting `excluded Lamport` as a truthful interval. The oracle permits alternate uncertainty wording. Invalid means reversed bounds, negative bounds, fractional bounds, non-finite numbers or an unsafe integer. Partial ranges retain the existing replay-required wording. A new validation API is not required.

The drawer comparison checks responsive right/bottom/left placement, width and maximum height against the loaded chat drawer with equivalent content. It does not require identical natural heights or internal padding. Long-content checks inspect positive boxes and `scrollWidth <= clientWidth` [CITED: Amendment B], not source declarations alone.

## External capsule acceptance mapping

These are U114 tier-2 integration checks. They are **HOLD / out of this unit's autonomous fixture scope**, not failed product tests and not green checks.

| Capsule step [CITED: spec] | Local supporting tests | Outstanding external evidence |
|---|---|---|
| 1: Swarm landing, task details and meaning | A2 task controls; M7 text boxes | Fresh-clone launch, selected landing view and complete route activation. |
| 2: Wall → Diary → Memory → Models | Diary columns; Models geometry/reachability | Real navigation, Memory content and Models trigger focus return through U118/U125. |
| 3: keyboard, dark toggle, reload | A1 computed themes; A2 Tab | Full-route keyboard traversal and persistence through reload. |
| 4: independent reduced-motion triggers | All A3 tests | Repeated route traversal in the capsule; no fabricated setting-control selector. |
| 5: controlled gap and recovery | A4/A5 and M6 component lifetime | External gap injection, cross-route notice survival and stream-driven recovery. No in-product fault control. |

The capsule still needs `390×844`, `768×1024`, `1440×900` and actual `200%` browser zoom [TARGET: spec], with integration identity, steps and frame SHA-256. These receipts are AUSENTE. Half-width/half-height reflow probes cannot clear that gate. U105/U107/U117 repairs, new navigation/settings UI, Memory-history implementation, narrator inference, accessibility redesign, windowing and benchmarks remain out of scope.

## Fail-first record

The unmodified integration produces assertion failures for independent palettes, focus offsets/colours, nonzero reduced-motion durations, raw spacing, narrow-view sync overflow, Models maximum-height mismatch, missing notice styling and false invalid Lamport intervals. Import/runtime errors or fixture timeouts are not accepted as these detections.

Before adding this oracle, affected U106/U112/U136 regression results were `Test Files  16 passed (16)` and `Tests  336 passed (336)` [MEASURED]. TypeScript baseline: `16` existing diagnostics, none in `tests/unit/u127/` [MEASURED]. The baseline belongs to this isolated copy; no zero-error typecheck or full-suite success is claimed.

Final U127 result [MEASURED]:

```text
 Test Files  2 failed (2)
      Tests  36 failed | 32 passed (68)
```

All failures are assertions about missing behaviour; no import failure, runtime fixture error, timeout or skipped case is accepted. The negative controls execute and pass. Focus failures identify the Swarm/narrator offset and Models accent colour. Motion failures identify nonzero resolved duration tokens and decorative durations under the independent triggers. Narrow hostile overflow is traced to the unstyled uncertainty notice; Models differs from the reference drawer in maximum height.

After adding the oracle, U106/U112/U118/U135/U136 regressions report `Test Files  24 passed (24)` and `Tests  550 passed (550)` [MEASURED]. TypeScript still reports the same `16` diagnostic locations and codes, with `0` diagnostics in the new files [MEASURED].

This oracle and its conclusions are limited to the supplied specification and inspected repository surfaces.
