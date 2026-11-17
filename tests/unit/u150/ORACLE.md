# U150 fail-first oracle

Status: **RED — missing product behavior demonstrated; review pending, not ADMIT.**

The complete supplied `.unit/SPEC.md` ends with the R42 Big Tech reproduction. It contains no numbered acceptance list and no Amendment sections. A1–A7 below are local traceability IDs for its requirements, not invented specification amendments. A8 pins the existing handle ownership contract. The final persona-evidence paragraph is included as binding scope.

Only `tests/unit/u150/helpers.ts`, `tests/unit/u150/continuity.test.ts`, and this document are added. Product code and shared tests are unchanged; `src/app/swarm_vm.ts` and `deriveSwarmViewModel` remain read-only. These tests target the behavior after U138p without implementing it.

## Requirement-to-test mapping

Parameterized suffixes below are literal test-name parameters. All names are in `continuity.test.ts`.

| Case | Source requirement and gate | Test names |
| --- | --- | --- |
| A1 | Named non-article fallback card; its nested controls survive opaque-article pruning. Reject the current article root. | `A1 fallback task has a named non-article root and preserves task identity`; `A1 fallback disclosure remains reachable after opaque-article pruning` |
| A2 | Restore workspace focus by identity through refresh and reordered, identically named workspaces. Preserve existing microtask state and avoid redirecting focus outside its owner. | `A2 focused workspace survives refresh with reorder=%s and duplicate display names` (false/true); `A2 a removed workspace never transfers focus to a different workspace`; `A2 a refresh leaves focus outside the Wall untouched`; `A2 preserved microtask focus and expansion survive refresh` |
| A3 | Restore focused Swarm metadata controls and expanded content independently of focus. Closed, unrelated disclosures remain closed. | `A3 expanded metadata and its focused control survive beat refresh with reorder=%s` (false/true); `A3 expanded metadata persists when focus belongs to another Wall control` |
| A4 | Preserve Swarm detail state and focus across beat and lifecycle refreshes. Reproduce R42: open T05, commit worker-a/T01 activity_beat, inspect again; retain T05 rather than redirecting to T07. Close and Escape must still return focus to the current T05 opener. | `A4 %s survives an unrelated agent lifecycle refresh` (metadata/task-detail); `A4 T05 detail and %s focus survive worker-a/T01 activity_beat` (region/close/trigger); `A4 refreshed Close task details still closes and returns focus to T05`; `A4 application refresh preserves T05 detail after committing a worker-a/T01 beat` |
| A5 | Announce agent-only lifecycle transitions in the same persistent polite status region, without focus theft. Reject unchanged status text. Replayed semantic state stays silent; existing task announcements remain. | `A5 wall: silent agent %s changes the persistent status without task activity`; `A5 swarm: silent agent %s changes the persistent status without task activity` (deployed/failed/finished); `A5 one refresh reports both silent agents whose lifecycles changed`; `A5 preserved task and microtask transitions still announce in the same status node` |
| A6 | Hostile sequence: fifty beat refreshes [CITED: supplied spec], unchanged semantic activity, no announcements or focus theft; retain expanded metadata/T05 detail. Reject loss at any refresh, rather than checking only the final frame. | `A6 fifty unchanged-semantic beats preserve %s focus and expansion without announcements` (workspace/metadata/task-detail); `A6 fifty beat-only refreshes remain silent and never steal external focus` |
| A7 | Negative: restoring delegated card-to-chat routing must fail the no-opener assertions for both fallback and plan-backed cards. Preserve explicit Messages (legacy) access and keyboard disclosures. | `A7 %s card body click cannot call the legacy task opener` (fallback/plan); `A7 Messages (legacy) still opens the selected fallback task explicitly`; `A7 fallback disclosure %j activation remains read-only` (Enter/Space) |
| A8 | Preserved ownership stop rule: destroyed handles ignore updates and scheduled work; detached status cannot announce or steal external focus. | `A8 destroyed Wall ignores updates and cannot steal focus or announce` |

## Re-pinned evidence

| Existing surface | Current coordinates | Finding exercised |
| --- | --- | --- |
| Fallback renderer | `src/views/index.ts:1074` | Creates the opaque article. |
| Focus descriptors and refresh | `src/views/index.ts:402`, `src/views/index.ts:421`, `src/views/index.ts:634` | Workspace/Swarm controls lack descriptors; descendants are replaced. |
| Persistent status and semantic comparison | `src/views/index.ts:358`, `src/views/index.ts:1410` | Status survives, but comparison covers task/microtask activity rather than agent-only lifecycle. |
| Read-only delegated click boundary | `src/views/index.ts:507` | Card-body chat routing is already removed; A7 protects that preserved behavior. |
| Swarm local detail state | `src/views/swarm.ts:59`, `src/views/swarm.ts:114`, `src/views/swarm.ts:198`, `src/views/swarm.ts:238` | Metadata and task detail state belong to newly rendered DOM; focus entry already works before refresh. |

## Determinism and limits

The oracle uses the real `mountWall`, `startAgentWall`, `toWallVM`, `deriveSwarmViewModel`, and `applyOp`. It imports existing fixture builders from `tests/unit/u118/fixtures.ts` and `tests/unit/u136/fixtures.ts`; no production imports or APIs are stubbed into existence. The application reproduction delivers a real `activity.beat` reducer result through the in-memory store read seam, then calls the real application refresh. It does not claim a backend or transport receipt.

All timers use the fake clock. Network constructors and fetch throw if called. Inputs are frozen; beat admission, changed beat timestamps, unchanged task states, and unchanged progress are checked before continuity assertions. Fixture precondition failures are failures, never skips. Mutation observers retain both asynchronously delivered and pending records, catching even repeated writes of identical status text. The hostile cases complete the full bounded sequence before asserting accumulated failures.

The pruning fixture models an accessibility-tree automation client's opaque-article pruning. It is a DOM contract check, not a live accessibility receipt. No focus implementation strategy, replacement tag, generated ID format, or lifecycle announcement sentence is prescribed. Lifecycle announcements must identify the affected agent and state; finished is included because the MUST covers agent lifecycle changes generally.

The negative delegated-handler mutation is not installed into product code: doing so would exceed the test-only write boundary. A7 spies on the public opener callback and rejects routing from card-body or header clicks; it is intentionally green on the current tree.

## Out of scope

| Owner/surface | Deferred checks |
| --- | --- |
| U146 / `src/views/swarm.ts` | Swarm root replacement, metadata ID generation, initial focus entry; this oracle consumes the existing renderer without changing it. |
| U148 / `src/views/plan.ts`; U149 / `src/views/agent_strip.ts` | Plan card ordering, microtask names/identities, strip records and caps. Plan-backed card clicks are tested only for the U150 negative routing requirement. |
| U147; U151; U152; U153; U155 | Hosted Models/narrator announcements, CSS density, navigation semantics, machine-operability documentation/receipts, and persona scoring. |
| `src/app/agent_wall.ts` follow-on | Carried debt: element validation of `store.plans()`/`store.events()`, stale `verdicts`/`accepted`/`reviewState`/`taskStates` eviction, synchronous `clock.setTimeout` re-entrancy, and legacy drawer focus. They exceed U150's product surface. |
| Backend and external verification | Mailbox slice admission, terminal-agent work refusal, no-plan lifecycle resources, deployed browser/AT-SPI behavior, rendered contrast, and actual screen-reader speech. Live receipts: AUSENTE — no inventar. |

## Verification

Run from the repository root:

```sh
npx vitest run tests/unit/u150 --no-cache --no-fsModuleCache --configLoader runner
npx tsc --noEmit -p .
npx vitest run tests/unit/u138/wall.test.ts tests/unit/u136/view.test.ts tests/unit/u136/detail.test.ts --no-cache --no-fsModuleCache --configLoader runner
```

The runner flags prevent configuration bundles and test caches from writing into shared dependencies. Verification output is captured in memory; no reporter artifacts are retained.

Measured on the unchanged product tree: **35 tests; 24 red; 11 green [MEASURED]**. Every red result is an assertion failure for opaque fallback cards, lost focus/expansion/detail, or unchanged agent-only status. No import, fixture-admission, or runtime failures occurred.

Exact summary:

```text
 Test Files  1 failed (1)
      Tests  24 failed | 11 passed (35)
```

The existing regression command reports `Tests  149 passed (149)` [MEASURED]. TypeScript retains its pre-existing 16 diagnostics [MEASURED], with no diagnostics in `tests/unit/u150` [MEASURED].

This oracle's mandate is limited to the supplied U150 specification and the cited repository surfaces.
