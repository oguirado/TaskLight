# U146 fail-first oracle

## Spec basis and numbering

The supplied `.unit/SPEC.md` has no numbered acceptance list and no Amendment
sections. A1–A8 below number its explicit MUST, oracle, hostile and negative
clauses for traceability; they do not add a new product contract.

| Case | Binding clause | Test names in `oracle.test.ts` |
| --- | --- | --- |
| A1 | Replace `article.swarm-card` with a named non-article container. | `A1 cards use a non-article container and never the article role`; `A1 each card has an explicit accessible name containing its agent identity` |
| A2 | Metadata IDs use agent identity instead of a sequence. | `A2 metadata IDs survive an equivalent render after intervening renders`; `A2 metadata IDs follow identities through reordering and changing activity`; `A2 replacing an agent identity does not reuse the previous metadata target ID` |
| A3 | Move focus into task detail on open. | `A3 opening detail by %s moves focus inside that detail` — pointer, Enter, Space, card pointer |
| A4 | Keep Escape return. | `A4 Escape returns to the exact %s trigger among duplicate agent names` — T01, T02 |
| A5 | Add no chat or terminal controls. | `A5 summaries, metadata and opened details expose no chat or terminal controls` |
| A6 | Emit the article and stop descending; every task and metadata button survives. | `A6 opaque-article pruning retains every task and metadata button: %s` — ordinary, duplicate and markup-like names, registration only |
| A7 | Survive duplicate agent names across swarm labels and markup-like names. | `A7 duplicate names across swarm labels have distinct independently operable metadata targets`; `A7 metadata identity remains stable for duplicate and markup-like names across rerenders`; `A7 markup-like names remain literal and inert in cards, metadata and detail` |
| A8 | Negative implementation: restore the article. | `A8 negative control restoring %s hides nested controls but emits the article` — native article, explicit article role; A1 and A6 reject a production article regression |

## Choices left open by the spec

- No exact container tag, new role, ID prefix, serialization or hashing scheme is
  prescribed. Cards need an explicit agent name through `aria-label` or valid
  `aria-labelledby` references and must not expose the article role.
- Agent identity is scoped by the exact swarm label when names repeat. Metadata
  IDs must resolve uniquely and remain associated with the same identity across
  rerenders, ordering and activity changes. The tests compare identities rather
  than requiring their spelling to appear inside an ID.
- Focus may land on the existing detail container or any descendant. Escape is
  tested separately, placing focus inside the detail first, so missing focus
  entry cannot obscure preserved focus return.
- Native button keyboard activation uses the existing deterministic fixture
  helper because jsdom does not synthesize its browser default action.
- The pruning fixture in `pruning.ts` emits an opaque article and omits all its
  descendants. Its negative controls mutate only an in-memory fixture. Product
  retention checks require nonempty expected control sets and compare the exact
  rendered controls, including registration-only metadata.

## Boundaries and stop rules

Only `tests/unit/u146/` is written. Product imports already exist; there are no
stubs or speculative imports. The shared fixture builders are imported from
`tests/unit/u136/fixtures.ts`; `deriveSwarmViewModel` in `src/app/swarm_vm.ts`
is read-only. Relevant existing regression suites are
`tests/unit/u136/view.test.ts`, `tests/unit/u136/detail.test.ts` and
`tests/unit/u138/swarm.test.ts`. The inspected product surface is
`src/views/swarm.ts` and `styles/swarm.css`.

Fake time, frozen input and synchronous DOM interaction keep the tests bounded.
No network, browser, real timers or external services are used. Missing cards,
missing controls and unresolved ARIA references fail assertions; an empty tree
cannot pass by comparing empty control sets. Import, collection or setup errors
are invalid oracle evidence and stop acceptance. Existing TypeScript diagnostics
must be compared with the pre-oracle baseline; any diagnostic in these files
blocks completion. Production changes, commits, pushes and deployments are
outside this oracle lane.

Out of scope: U148 plan-backed task cards, U149 agent strip, U150 Wall refresh
focus/expansion continuity and lifecycle announcements, and U153's global
selector/empty-accessibility-tree receipt gate. Live CDP, raw AT-SPI, rendered
contrast and screen-reader receipts are AUSENTE — no inventar. The DOM pruning
fixture is structural evidence, not a captured accessibility tree. Package
receipts F15, F16, S15 and F8 are not rerun or used as passing evidence here.

## Measured verification

`npx vitest run tests/unit/u146 --no-cache --configLoader runner` exits nonzero
with assertion failures in the missing behavior, without import, collection or
setup errors. The test count is 20 [MEASURED]:

```text
 Test Files  1 failed (1)
      Tests  12 failed | 8 passed (20)
```

The red assertions identify article roots, missing explicit card names,
sequence-based metadata IDs, missing detail focus entry and pruned controls.
The green cases preserve Escape return, independent metadata disclosures,
literal hostile text, read-only controls and calibrated article negatives.

The cited legacy suites pass 91 tests [MEASURED]. A combined run of those
suites and this oracle confirms the legacy suites remain green [MEASURED]:

```text
 Test Files  1 failed | 3 passed (4)
      Tests  12 failed | 99 passed (111)
```

`npx tsc --noEmit -p .` retains the same 16 existing diagnostics [MEASURED]
as the pre-oracle baseline, with byte-identical diagnostic output and no
errors in `tests/unit/u146/`. Its nonzero exit is baseline behavior, not a
passing whole-project typecheck.
