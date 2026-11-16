# U74 diagnosis and oracle

## Evidence boundary

The oracle loads `fixtures/plan/capsule_c2b.events.jsonl` unchanged, ingests every event using `createAgentStore({ templates: resolveStarterTemplate })`, maps `store.plans()` through the exported hosted mapper `buildPlanSnapshots`, and runs `createPlanWiring` with the real `createPlanAi` and unavailable providers. It forwards verdicts and briefs with the same keys as `hosting/src/main.ts`, projects using `toWallVM`, and renders using `mountWall`.

The reported initial brief `Next: none; 0 blocked` does **not** reproduce in this checkout. Before behavioral fixes, the fixture already yields `Next: T01 Write the product brief; T02 waits for T01; T03 waits for T02` from rules. Its original hosted cause is AUSENTE — no inventar. The fixture assertion remains an ordinary passing regression test; it is not falsely presented as a reproduced failure.

## Confirmed causes and bounded fixes

- `src/app/plan_wiring.ts:184`: `toBriefInput` copied all dependencies into `waitsFor`, even completed dependencies. Readiness could be true while `waitsFor` still excluded a task from rules selection. The negative control completes T01's microtasks through real operations: before the fix it gives `Next: none; T02 waits for T01; T03 waits for T02`; afterward T02 is next and only T03 waits. Filter completed dependencies before deriving readiness; missing dependencies still wait.
- `src/views/index.ts:438` and `src/views/index.ts:531`: workspace needs badges and focus used scheduling attention/status, ignoring the plan reviewer. T02 waits but its verdict is `on_track`; T03 has no microtasks and its verdict is `needs_user` under `src/planai/rules.ts:38`. Only T03 belongs in focus. A shared selector now uses `needs_user` for plan tasks and deduplicates task identity. Legacy selection behavior is retained.
- `src/views/index.ts:547`: focus showed `project`, which `src/app/agent_store.ts:685` supplies from the shared plan title for unassigned tasks. Distinct T02 and T03 therefore appeared identical. Focus now shows the task id and title for plan tasks. This is a rendering fix; changing the store's project field is unnecessary.
- `src/app/plan_snapshots.ts:6`, `hosting/src/main.ts:345`: extract the original pure mapping for direct regression coverage. Snapshot mapping behavior is preserved.

No confirmed cause requires an `agent_store.ts` edit; no expected-failure exemption is needed.

## Verification

Tests were written before behavioral fixes. Red run [MEASURED]: `Test Files  1 failed (1)` and `Tests  3 failed | 1 passed (4)`. Failures cover false focus membership, completed dependency selection, and focus ignoring reviewer changes. Additional assertions cover identity deduplication, distinct task labels, badges, idle tasks needing input, and pending verdict exclusion.

Requested regression command:

```sh
npx vitest run tests/unit/u74 tests/unit/u63 tests/unit/u64 tests/unit/u62 tests/unit/u61 tests/unit/u67
```

Green run [MEASURED]: `Test Files  27 passed (27)` and `Tests  541 passed (541)`.

TypeScript baseline and final project checks both have the same count of pre-existing diagnostics outside the permitted surface [MEASURED]. Exact final summary lines [MEASURED]:

```text
Project: exit 1; 16 diagnostics; 0 in touched files
Hosted entry: exit 1; 8 diagnostics; 0 in touched files
```

The project check uses `npx tsc --noEmit -p .`. Because the project configuration includes only `src` and `tests`, the hosted entry was also checked explicitly with matching compiler options. No existing tests or store implementation were edited.
