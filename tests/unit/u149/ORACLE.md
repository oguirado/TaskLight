# U149 fail-first oracle

## Authority and scope

`.unit/SPEC.md` is the binding specification. It ends with the carried-debt paragraph;
there are no Amendment sections or numbered acceptance cases in the supplied file.
The local A identifiers below number its requirements and preserved behavior without
claiming that the specification supplied those identifiers.

Only `tests/unit/u149/agent_strip.test.ts` and this map are added. The tests import
existing exports from `src/views/agent_strip.ts`; they do not mock or replace the
renderer. `src/app/swarm_vm.ts` and `deriveSwarmViewModel` remain read-only.

## Acceptance map

All test names below belong to `U149 agents strip and chip records`.
Parameterized names identify every expanded case in the test source.

| Case | Acceptance and negative contrast | Test names |
|---|---|---|
| A1 | Each displayed record is a native or ARIA list item belonging to a list. A paragraph-only record fails. | `A1 every displayed agent is a list item belonging to a semantic list` |
| A2 | Locate the same identity before and after reordering the hostile roster, with changed work and state. An absent or positional-only identity fails. | `A2 locates the same agent by stable identity after the hostile roster is reordered` |
| A3 | Text labels identify agent, harness, state, task, microtask, and beat; chip values have actual text separators. CSS spacing alone fails. | `A3 row explicitly labels %s and separates its value`; `A3 chip has text separators between identity, harness, and agent state` |
| A4 | Both strip and chip use Swarm wording: Deployed · no plan yet; Finished · open work; Failed · tasks released; Working · not registered by a harness. Terminal fixtures keep fresh Working activity and a beat, so activity cannot erase terminal lifecycle. | `A4 strip wording: deployed without a plan`; `A4 chip wording: deployed without a plan`; `A4 strip wording: finished with open work and a fresh beat`; `A4 chip wording: finished with open work and a fresh beat`; `A4 strip wording: failed after tasks were released with a fresh beat`; `A4 chip wording: failed after tasks were released with a fresh beat`; `A4 strip wording: working without harness registration`; `A4 chip wording: working without harness registration` |
| A5 | Preserve the global cap of five agents [CITED: .unit/SPEC.md]. The hostile roster has twelve agents across three exact swarm labels [CITED: .unit/SPEC.md], tested in forward and reverse order. A per-group cap fails. | `A5 global five-agent cap survives twelve agents across three reordered groups` |
| A6 | Keep exact swarm grouping and existing group ordering; absent swarm and literal Ungrouped remain separate groups. Merging those groups or mixing their members fails. | `A6 preserves exact swarm grouping, including absent versus literal Ungrouped` |
| A7 | Keep No current task, No active microtask, and No beat observed. Null is not observed zero. Preserve admitted second-floor formatting for actual age evidence. Rendering a null beat as 0s ago fails. | `A7 absent work and null beat stay explicit and never become an observed zero`; `A7 preserves observed beat age %i ms as %s` |
| A8 | Missing agent data preserves owner identity and Agent status unavailable without inventing activity or registration. | `A8 missing agent data keeps owner identity and Agent status unavailable` |
| A9 | Carried debt: beat output must be finite and nonnegative. Negative input, NaN, and either infinity must not leak into text. | `A9 carried debt never renders invalid beat age %s` |
| A10 | Carried debt: inherited activity keys and an unknown future key produce a nonempty textual fallback, never inherited objects/functions or raw invalid keys. | `A10 own-property guard gives a textual fallback for activity %s` |
| A11 | Carried debt: malformed activities have a total grouping/sorting fallback. All permutations of the same mixed urgency roster produce the same membership order. A missing bucket fallback that makes ordering depend on input order fails. | `A11 bucket fallback gives a permutation-invariant urgency order for activity %s` |
| A12 | Preserve the named, enabled Show all in Swarm navigation button and its existing swarm destination. | `A12 Show all in Swarm remains a named operable navigation control` |

## Interpretation boundaries

- Stable identity may use an identity-bearing DOM id, data attribute, accessible name,
  or labelled-by reference on the record. No new selector spelling or id format is
  required, and rerendered rows need not retain their DOM object identity. The test
  locates by identity before examining changed work, rather than using roster position.
- Native and explicit ARIA lists are accepted. Field label synonyms are accepted;
  punctuation or whitespace may separate labels and values. Existing row hooks only
  let preservation checks run against the current paragraph renderer.
- Chips lack a plan argument. The deployed/no-plan fixture therefore has no assigned
  tasks, while the corresponding strip snapshot also has absent plan progress.
- The debt paragraph does not prescribe an exact fallback word or numeric bucket.
  The oracle checks textual safety and permutation invariance rather than an internal
  implementation. For non-finite ages, either an honest absent-evidence label or a
  finite nonnegative clamped age is accepted. Valid observed ages retain legacy units.
- The roster and ages are fixed inputs. No network, real clock, timer, random source,
  port, asynchronous polling, or source mutation is used. Frozen hostile input also
  prevents sorting from silently modifying the caller's roster.

## Verification gates and stop rules

Run from the project root:

```sh
npx vitest run tests/unit/u149
npx tsc --noEmit -p .
npx vitest run tests/unit/u136 tests/unit/u138
```

The unmodified renderer must fail assertions for missing U149 behavior. An import,
transform, dependency, runtime setup error, absent tests, or all-green baseline is a
failed oracle precondition, never evidence of missing product behavior. Any diagnostic
in `tests/unit/u149/` or any new diagnostic elsewhere blocks acceptance of these tests.
Existing failures are compared with the pre-oracle baseline; they are not repaired here.
A regression in an existing suite blocks acceptance. No test is skipped to get green.

The negative per-group-cap and null-as-zero implementations are rejected by A5 and
A7 directly; these preservation checks may be green on the baseline. No product
mutation is performed in this test-only lane. Capsule, rendered contrast, live
accessibility-tree, and screen-reader receipts are AUSENTE — no inventar.

## Observed verification

The unchanged product produces the following exact summary [MEASURED]:

```text
 Test Files  1 failed (1)
      Tests  29 failed | 9 passed (38)
```

All red results are assertion failures for missing semantics, identity, labels,
separators, status wording, or carried debt [MEASURED]. Import/setup failures are
absent [MEASURED]. Green results preserve cap, grouping, honest absence, observed
age formatting, unavailable status, and the existing navigation control.

The relevant existing regression suites, `tests/unit/u136` and `tests/unit/u138`,
remain green: 407 tests across 12 files [MEASURED]. The project typecheck still exits
with its original 16 diagnostics [MEASURED]; complete diagnostic output is identical
to the pre-oracle baseline, with no errors in `tests/unit/u149/` [MEASURED].
The inspected renderer, Swarm view, view model, and test/compiler configuration
hashes remain unchanged [MEASURED].

## Out of scope

- U138p: Wall chat routing and legacy Messages interactions in `src/views/index.ts`
  and `src/views/plan.ts`; its author/admission dependency is not certified here.
- U146/U148: opaque-article pruning, task-card structure, task-versus-agent projection,
  and nested task or microtask controls in `src/views/swarm.ts` and `src/views/plan.ts`.
- U150: Wall refresh, live announcements, focus persistence, and workspace navigation.
- U151: strip grid, density, responsive CSS, themes, motion, and contrast in
  `styles/plan.css`, `styles/views.css`, and `styles/tokens.css`.
- U152/U153/U155: navigation redesign, full application selector/ARIA receipts,
  accessibility-tree automation client integration, and persona capsules.
- Backend lifecycle admission and generation fencing, mailbox transports, and
  `deriveSwarmViewModel` changes belong to their respective units.

These boundaries are exclusions, not U149 product failures. This oracle is scoped
only to the supplied specification and the cited existing workspace sources.
