# U165 scroll and task detail oracle

Authority: `.unit/SPEC.md`, including its complete acceptance requirements. The
provided spec ends with the negative controls; Amendment sections are AUSENTE.
The numbered acceptance cases are M1 through M6 [CITED].

| Case | Test names in this directory | Gate and negative contrast |
| --- | --- | --- |
| M1 | `navigation.test.ts`: `M1 <root>: <entry> navigation resets the root after all restored focus`; `M1 view update from <from> to <to> resets without a navigation focus descriptor` | Changed views finish at the root start. A focus seam changes the offset during each restored focus, so resetting before the last focus cannot pass. Omitting the reset fails. |
| M2 | `navigation.test.ts`: `M2 <root>: a <view> snapshot refresh preserves nonzero root scroll`; `M2 a real activity beat preserves root scroll in <view>`; `M2 selecting the current view through <entry> preserves root scroll` | Same-view snapshots, admitted reducer beats and reselection keep the seeded offset. Resetting on every render fails. |
| M3 | `details.test.ts`: `M3 reduced-motion=<preference>: <input> focuses without scrolling, then aligns the selected section start` | Mouse, Enter and Space focus the selected connected section with `preventScroll: true`, then align that same section with `block: "start"`. Removing alignment or focus suppression fails. Reduced motion cannot request smooth behavior. |
| M4 | `details.test.ts`: `M4 beat reopening with <target> focus never aligns a detached section` | A real beat replaces and reopens the selected detail, preserving region, Close or trigger focus and the document offset. Alignment records connectivity at invocation time; an unguarded call while detached fails. |
| M5 | `details.test.ts`: `M5 Escape after <input> opening closes details and returns to the selected trigger`; `M5 Escape after beat reopening restores the fresh trigger`; `M5 task-title identity and preventScroll focus survive a same-view beat` | Escape closes the selected detail and restores its current trigger. Wall title restoration retains identity and `preventScroll: true`. Losing either legacy behavior fails. |
| M6 | `details.test.ts`: `M6 scrollIntoView <absence>: <input> opening still works without an exception` | A deleted or undefined alignment API does not prevent mouse, Enter or Space opening. Both direct and DOM event-listener exceptions are observed. Calling a missing method fails. |

## Scope and interpretation

- The scrolling root is tested both as an explicit `scrollingElement` distinct
  from `documentElement`, and through null and undefined fallback values.
- Navigation uses the existing mouse, tab-arrow and numeric shortcut routes,
  plus renderer updates to the remaining views. A callback that selects the
  current view is still a same-view render.
- M3 specifies section focus, call ordering and start alignment, rather than
  layout coordinates or a particular DOM insertion strategy. Inline alignment,
  exact call count and default-motion behavior are not prescribed. Instant,
  automatic or omitted behavior is accepted; smooth behavior is accepted only
  when reduced motion is not requested.
- M4 rejects calls made while detached; it does not prescribe the renderer's
  internal guard expression or prohibit a connected call that preserves M2.
- There is no additional hostile-text, malformed-VM or stop-rule acceptance
  list in this spec. Existing input hardening belongs to U136; legacy keyboard
  semantics belong to U146/U159; broader continuity belongs to U150. Those
  suites stay unchanged. Other campaign units, Firebase setup and visual
  viewport verification are outside this headless oracle.

## Execution discipline

`helpers.ts` reuses existing fixture builders and the production reducer and
renderer. Browser focus, scrolling and media preference seams make JSDOM
deterministic without replacing product modules. Fake clocks remain frozen;
refresh loops are bounded; network entry points throw and are checked unused.
Every mounted Wall is destroyed and browser seams are restored after each case.

Run `npx vitest run tests/unit/u165 --no-cache --no-fsModuleCache` and
`npx tsc --noEmit -p .`. Cache switches keep execution read-only outside this
directory. Product code and pre-existing test suites must remain unchanged.

Fail-first observation [MEASURED]:

```text
Test Files  2 failed (2)
     Tests  20 failed | 37 passed (57)
```

Failures belong exclusively to M1 (missing root reset) and M3 (missing
`preventScroll: true` detail focus and missing section alignment). They are
assertion failures, rather than import or setup errors. M2/M4/M5/M6 are green.
Typecheck diagnostics match the pre-oracle baseline exactly: 16 pre-existing
errors and no diagnostics in this directory [MEASURED].

Existing unit-suite regression check, excluding this deliberately red oracle
[MEASURED]:

```text
Test Files  412 passed (412)
     Tests  12434 passed | 9 skipped (12443)
```

Command: `npx vitest run --project unit --exclude 'tests/unit/u165/**'
--no-cache --no-fsModuleCache --maxWorkers=2`.

The mandate is limited to `.unit/SPEC.md`, the cited view code and the existing
fixture and regression surfaces reused by this oracle.
