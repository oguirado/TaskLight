# U91 fail-first oracle

Authority: `.unit/SPEC.md`, including its final **Amendment B-U91**. Status: `STRATEGY_v10`, wave `B/B1`, pre-freeze [CITED]. The standalone `SEAMS.md` is AUSENTE in the supplied contract. Product implementation is outside this oracle-writing assignment.

The tests import only existing exports from `src/views/plan.ts`, `src/views/index.ts`, `src/views/types.ts`, `src/app/agent_store.ts`, and `src/plan/types.ts`. Additive activity, liveness, question, and synchronization fields are represented by structural fixture types. `src/app/activity.ts` is AUSENTE in this checkout [MEASURED]; no missing upstream module is imported or stubbed. Failure must be an assertion about observable U91 behavior, never a missing import.

## Acceptance mapping

Parameterized titles below identify the whole corresponding test family. All fixtures and thresholds in these tests are spec targets [TARGET].

| Acceptance | Test file and exact test title or parameterized title | Contract covered |
|---|---|---|
| A1 | `activity.test.ts`: `A1 task and microtask render %s with hidden symbol and state text`; `A1 accepted all-done has a distinct static completion symbol; cancellation never uses it`; `A1 completion evidence copy is truthful for $evidence`; `A1 blocked reason and missing upstream identity remain available`; `A1/M1 canonical %s maps through the frozen activity seam`; `A1/M1 preserved legacy mapping never invents evidence` | Every activity vocabulary row, decorative symbol, animation eligibility, completion/cancellation distinction, reasons, truthful evidence, canonical mapping and preserved identifiers. |
| A2 | `activity.test.ts`: `A2 freshness at %i maps to %s without changing canonical progress`. `freshness.test.ts`: `A2 inclusive boundary expires without another event and clears the related dot`; `A2 expiry preserves recorded partial completion, evidence, and committed step status`; `A2 published syncStale suppresses work with network=%s`; `A2 a synchronization-outcome update immediately stops existing animation and dots`; `A2 browser offline alone does not establish a stale host outcome`; `A2 a newer beat replaces the expiry deadline instead of expiring the current run early`; `A2 repeated updates do not accumulate expiry callbacks and destroy releases them`; `A2 leaving a workspace releases its expiry and animation` | Inclusive freshness, event-free expiry, published stale outcome, no browser-connectivity inference, unchanged progress, renewed deadlines, bounded timer ownership and destruction. |
| A3 | `activity.test.ts`: `A3 active child without live maps to unknown and an inactive dot`; `A3 done-plus-pending is idle execution with recorded partial progress`; `A3 a done task with no microtasks cannot establish done activity`; `A3 invalid or future beat timestamp %s cannot establish working`; `A3 another assignee's beat cannot activate the owner's ring or dot`; `A3 another room's working assignment does not activate the displayed-room dot`; `A3 cancelled canonical tasks preserve status without a completion tick`. `freshness.test.ts`: `A3 stale active work cannot animate even when its committed state remains active`; `A3 the oracle rejects the M9 stale-animation mutant`; `A3 a mixed done-and-pending task never spins or enables an assignee dot` | Negative activity controls, ownership, room isolation, malformed timestamps, empty completion, cancellation, and a discriminating stale-animation mutation. |
| A4 | `interactions.test.ts`: `A4 %j immediately filters and selects while preserving the current phase`; `A4 the selection handler and polite announcement run once per activation`; `A4 Show all phases clears viewing selection without changing canonical current phase`; `A4 current and selected phase are named as separate concepts`. `accessibility.test.ts`: `A4 authored CSS distinguishes aria-current from aria-pressed` | Immediate keyboard filtering, current versus selected semantics and styling, clear selection, callback and announcement cardinality. |
| A5 | `interactions.test.ts`: `A5 nonempty acceptance is available for %s, without detail or fabricated evidence`; `A5 %j toggles once through delegation and retains available outcome`; `A5 beat refresh preserves open acceptance and logical keyboard focus`; `A5 existing completion details retain expansion and focus during refresh`; `A5 expiry preserves acceptance expansion and focus at the failing interleaving`; `A5 keyboard Chat %j routes the VM id with recoverable trigger identity`. `accessibility.test.ts`: `A9 acceptance focus stays on its native trigger after keyboard activation` | Pending acceptance without detail, all activity displays, native button, labelled controlled panel, keyboard toggle cardinality, preserved outcome/evidence, expansion/focus across refresh and expiry, U86 routing and stable trigger identity. U92 drawer-close restoration is deferred below. |
| A6 | `agenda.test.ts`: `A6 generated Next includes only the pending eligible microtask`; `A6 supplied Next reconciles done and pending entries against current identities`; `A6 supplied Next loses eligibility immediately when its referenced microtask completes`; `A6 generated Next excludes %s work even with a pending child`; `A6 supplied Next cannot bypass %s eligibility`; `A6 an unknown microtask activity cannot enter Next merely because it is pending`; `A6 canonical %s prerequisite uses U88 readiness semantics`; `A6 a blocked task remains excluded even when dependencies are satisfied`; `A6 unknown task and microtask identities in supplied groups never leak`; `A6 a microtask from another task cannot be attached to a local task identity`; `A6 another workspace cannot enter generated or supplied displayed-room Next`; `A6 supplied items resolve canonical VM ids without bypassing microtask eligibility`; `A6 Now and Blocked preserve available work and dependency explanations` | Current identity reconciliation, completion/cancellation/archive/unknown exclusion, dependency readiness including cancelled and missing prerequisites, workspace isolation, no task-state shortcut, preserved explanations. |
| A7 | `interactions.test.ts`: `A7 explicit supplied task question creates Needs you and a keyboard conversation action`; `A7 reviewer needs_user is Review request with its reason, without operator authority`; `A7 unrelated room questions cannot create a task association or change ownership` | Directly supplied task question, distinct reviewer request, no inferred room association, no state or ownership mutation. |
| A8 | `content.test.ts`: `A8 hostile title, acceptance, outcome, reason and evidence remain literal text`; `A8 hostile acceptance on a pending microtask is visible without creating an image`; `A8 hostile question text and selector characters in event identity do not execute or throw`; `A8 hostile dependency identities render literally without selector exceptions`; `A8 hostile task/micro identities retain safe disclosure relationships across refresh`; `A8 malformed activity $name has an inert fallback without HTML or animation`. `activity.test.ts`: `A8 evidence and blocked reasons stay literal in mapped values` | Passive hostile content in every specified field, no injected DOM or handlers, safe identity handling, inert malformed activity and no throw. |
| A9 | `accessibility.test.ts`: `A9 CSSOM probe distinguishes reduced pseudo rules from normal rotation`; `A9 reduced motion leaves Working text with stationary rings and pseudo-elements`; `A9 reduced-motion authored declarations disable pseudo-element rotation`; `A9 repeated beats do not announce unchanged semantic activity`; `A9 working-to-unknown expiry announces once; repeated expired renders remain silent`; `A9 explicit semantic transition announces once without requiring a new phase selection`; `A9 acceptance focus stays on its native trigger after keyboard activation`; `A9 %s on task surface meets text contrast`; `A9 %s on task surface meets icon/focus contrast`; `A9 keyboard trigger has a visible focus outline from defined tokens` | Stationary reduced-motion activity, pseudo-element declarations, calibrated CSS probe, silent repeated beats, single transition announcements, keyboard focus, defined token contrast in each theme. |

## Binding amendment decisions

| Gap or ambiguity | Oracle boundary |
|---|---|
| U85 connection-field coordinate is AUSENTE. | Inject amended `syncStale` at the view boundary. Test initial and updated stale outcomes independently of `network` and `navigator.onLine`. Do not invent an `AgentStore` connection field. |
| The clock injection location is unspecified; existing `WallVM.now` is display text. | Use Vitest fake `Date.now` and fake `setTimeout` for deterministic observable behavior, without inventing a new mount argument or replacing the display field with a function. The inclusive deadline remains Working at `190000` ms [TARGET], and becomes unknown at `190001` ms [TARGET]. A refreshed deadline also retains its inclusive endpoint. |
| Durable task-question association is AUSENTE. | Supply `TaskVM.operatorQuestion` directly, as the amendment requires. No room-wide association or protocol is added. |
| Chat trigger argument layout is unspecified. | Require the first callback argument to retain `TaskVM.id`, including the `plan:${room}:${pt.id}` identity. Accept a recoverable selector/id among additional arguments or their options values; do not freeze an options-key spelling. Require stable trigger attributes and focus across view refresh. |
| Cancellation and dependency readiness. | Exercise U91's canonical-to-view mapping and Agenda output with current task identities. Cancelled upstream tasks satisfy dependencies; missing and pending upstream tasks do not. No fold/reducer implementation is tested or altered here. |
| Icon drawing technology is unspecified. | Require an aria-hidden decorative symbol with a visual representation, accompanying text, distinct completion/cancellation rendering, and the specified animation eligibility. Do not require a particular Unicode glyph, SVG path, or icon library. Exact rendered shape remains part of browser visual review. |
| jsdom cannot lay out pseudo-elements or apply a native reduced-motion preference. | Evaluate actual authored rules through CSSOM for normal and reduced motion; materialize selected motion declarations into a real element and snapshot its computed styles before removal. Calibrate the probe against normal and reduced controls. No browser, port, real timer, or network is used. Browser pixel, pseudo-element paint, and full rendered contrast verification remain integration gates. |
| Contrast token names are not newly prescribed. | Check the existing defined text, activity-icon, and focus tokens against the task surface in each theme. Text threshold is `4.5:1` [TARGET]; icon/focus threshold is `3:1` [TARGET]. No product token file is changed. |

## Mutation and non-vacuity

`freshness.test.ts` contains the required deliberately broken mutation in `A3 the oracle rejects the M9 stale-animation mutant`:

```css
.step[data-state="active"] .step-indicator::before {
  content: "";
  animation: stale-spin 1s linear infinite !important;
}
```

The duration is a test fixture [TARGET]. The CSS mutation exists only in memory. The same `expectStationary` assertion used by `A3 stale active work cannot animate even when its committed state remains active` must throw `Unexpected activity animation` for this mutation. A stationary positive control must first pass, preventing an always-failing detector from satisfying the mutation test. The mutation harness is green when it observes the required assertion failure; the ordinary stale-work regression is red on the checkout's legacy state-only animation.

All mounted handles are destroyed after each test; fake timers are cleared and globals restored. Time advances and update loops are bounded fixture operations [TARGET]. No product stub, fake implementation, production edit, tool call, or network request is part of the oracle.

## Verification record

Commands run from the project root. Cache writing is disabled, and console reporting avoids persisted test reports.

```sh
npx vitest run tests/unit/u91 --no-cache --reporter=dot
npx tsc --noEmit -p .
npx vitest run --project unit --exclude 'tests/unit/u91/**' --no-cache --reporter=dot
npx vitest run --project unit --no-cache --reporter=dot
```

The U91 oracle contains `128` tests [MEASURED]. Its exact test summary is:

```text
      Tests  93 failed | 35 passed (128)
```

That summary is [MEASURED]. All U91 failures are assertion failures [MEASURED], with no missing-module, failed-suite import, or unhandled-error failures [MEASURED]. Green cases pin preserved behavior, existing token contrast, and calibrated mutation/probe controls. Red cases identify missing U91 activity rendering/mapping, expiry, eligibility, attention, phase selection, detail accessibility, focus, or announcement behavior.

The cited integration baseline of `9360` Vitest passes and `16` TypeScript errors [CITED] is not a fresh green result. The initial existing-suite run reported:

```text
      Tests  80 failed | 9399 passed | 2 skipped (9481)
```

That summary is [MEASURED]. A controlled existing-suite repeat reported:

```text
      Tests  79 failed | 9400 passed | 2 skipped (9481)
```

That summary is [MEASURED]. The difference is recorded rather than interpreted as a U91 result. The remaining existing failures are in `tests/unit/u86/composer.test.ts`, `tests/unit/u86/wall_integration.test.ts`, `tests/unit/u87/contract.test.ts`, and `tests/unit/u88/dependencies.test.ts` [MEASURED]. The subsequent full suite retained exactly the same existing failing test identities [MEASURED]:

```text
      Tests  172 failed | 9435 passed | 2 skipped (9609)
```

That summary is [MEASURED]. TypeScript reports the same `16` baseline errors and `0` diagnostics in `tests/unit/u91/` [MEASURED]. Existing failing upstream oracles were not edited or represented as U91 failures.

## Deferred integration gates and stop rules

| Owner or gate | Scope boundary |
|---|---|
| U85 | Wiring the concrete landed synchronization outcome and preserving its synchronization notices requires the published upstream coordinate, currently AUSENTE. View-level stale suppression is tested here. An unverified field must not be guessed. |
| U86 | Composer `setDraft`/`getDraft` and drawer internals belong to U86. U91 tests only the existing `onOpenTask` routing boundary and trigger identity. |
| U88 | Canonical fold dependency behavior belongs to U88. U91 tests dependency consumption in mapping and Next eligibility, including cancelled and missing prerequisites. |
| U90 / S2 | `deriveActivity(task, micro, nowMs, opts?)`, with `opts?: { stale?: boolean; hasOperatorQuestion?: boolean }`, liveness fold ordering and `activity_beat` belong to U90. U91 tests observable consumption through existing exports; it must not rewrite either fold or import a fabricated helper path. |
| U92 | Restoring focus when the external Chat drawer closes, including `src/app/agent_wall.ts` and `src/agentsui/index.ts`, is outside the U91 surface. Verify after integration; do not report absent drawer-close behavior as a U91 test failure. |
| Browser visual review | Verify actual tick/cancellation shapes, pseudo-element paint, reduced-motion behavior, and rendered contrast in each theme after integration. CSSOM/token checks are not a browser pixel measurement. |
| Campaign integration | Retain the existing Vitest and TypeScript baselines, Python suites, clean secret scan, synchronization notices, chat routing, and unchanged MCP contracts. Python suites and repository secret-scan scripts were not rerun by this focused TypeScript oracle assignment. Their success is not claimed. |

Do not weaken assertions, modify the frozen files, fill missing upstream fields with guessed defaults, or count a missing import as a valid fail-first result. A missing prerequisite blocks only its dependent integration check. No reducer, store protocol, drawer internal, message receipt, liaison, archive, diary, memory, or question-association protocol change is authorized by this oracle.

## Frozen test manifest

Hashes below are [MEASURED]. They seal the executable tests and support code before product authoring. `ORACLE.md` is excluded from its own manifest to avoid a recursive hash. The author consumes these files read-only; any hash change requires a separately reviewed oracle revision.

| Repository-relative file | SHA-256 |
|---|---|
| `tests/unit/u91/accessibility.test.ts` | `5b030dbbc013af40e9ed5139bd2cde7ce73c66fd02d7cb53d0bd70fafa004c96` |
| `tests/unit/u91/activity.test.ts` | `ba3cb9b91515c2c124754d5bc2e9f35a5cb1fe18e1092f13672222718e826ed8` |
| `tests/unit/u91/agenda.test.ts` | `97f0c1af371994461a8a22045df4300df89e7ead543fc82a7583b71a67741323` |
| `tests/unit/u91/content.test.ts` | `69a783b41fa2e8fe9fe30b96dc5230bdf5c4be2572955491dc764479f82fc8a6` |
| `tests/unit/u91/css_probe.ts` | `9318d19f7515754b4d9ce9951cc299c1f26f2dfb311187e590f2fde12a0b543b` |
| `tests/unit/u91/fixtures.ts` | `f4fcd0344f33bc31e54b6869c4832fbace46b1f19b424e4cd37d1d82828183ac` |
| `tests/unit/u91/freshness.test.ts` | `c436942e49ab1f45c1ce18f0b2b9760c0a171ed8d9f500c41b0ecc4f33e695e5` |
| `tests/unit/u91/interactions.test.ts` | `e4dc5b4951f31307fe91cd8e8dcd1296ceb2016802dcf73efaefe822b7df2937` |

The mandate is limited to the supplied package and confirmed repository surfaces.
