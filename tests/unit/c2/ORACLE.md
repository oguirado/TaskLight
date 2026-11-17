# C2 TypeScript oracle

The full M1–M9 acceptance matrix, ambiguity decisions, negative controls, stop rules and exclusions are in [the Python oracle](../../../bridge/tests/room/c2/ORACLE.md).

`inventory.test.ts` imports only existing `deriveSwarmViewModel`, `foldPlan`, `applyOp`, `emptyProjection` and `validateOpShapeCode` product entry points. Shared input and expected rows live in `bridge/tests/room/c2/fixtures/inventories.json`; legacy fold snapshots live in `bridge/tests/room/c2/fixtures/legacy_fold.json`.

| Numbered acceptance | Test names |
|---|---|
| M1 | Lifecycle schema/parent suite, `legacy_*`, shared parent histories |
| M2 (A-C2a) | `shared_message_only_authors` excludes authors; `shared_assignee_only_member` retains only the assignee; `shared_fresh_deployment` retains taskless lifecycle agents; no-projection and foreign-room browser guards exclude authors/recipients |
| M3 | Every `shared_*` canonical row; `shared_working_current_and_counts`, `shared_counts_cover_all_owned_tasks` |
| M4 | State/freshness `shared_*` histories; `sync_disconnect_forces_unknown_before_working`, `terminal_status_survives_sync_disconnect` |
| M5 | Every `shared_*` totals invariant, including `shared_empty_room` |
| M6 | Tree/duplicate `shared_*` histories; `reordered_and_duplicated_events_produce_identical_inventory`, `does_not_mutate_events_or_projection` |
| M7 | `parity_*` reads real MCP output through the bounded Python test adapter; discovery/CLI/redaction checks are in Python |
| M8 | Every `shared_*` golden inventory and every `parity_*` actual Python/TypeScript comparison |
| M9 | Python documentation assertions; no duplicate browser test |

`parity_*` launches a bounded local Python test client and compares actual implementations. It does not compare either implementation to a second test-side inventory algorithm. Missing behavior is asserted explicitly, never hidden by a skip or an import of a proposed module. Clocks are supplied directly and no network or wall-clock waits are used.

```sh
npm test -- tests/unit/c2
```

A-C2a: membership is lifecycle records plus current or past task assignees from the fold. Authors, recipients, assignee-less claims and beats alone are excluded. The message-only guards now expect absence, while lifecycle/assignment behavior and all other tests stay unchanged. Shared expectations mark each author-only removal and recompute concrete totals without changing input events. Actual `parity_*` comparisons continue to reject a rule change in only one language.
