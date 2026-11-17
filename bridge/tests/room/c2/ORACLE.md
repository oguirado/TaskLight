# C2 fail-first oracle

Authority: SPEC_C2 M1–M9 and amendment A-C2a. A-C2a replaces M2 membership with lifecycle records (any state/run) plus current or past task assignees from the fold. Authors, recipients, claims that never produce an assignee, and beats alone do not establish membership. Tests import existing product entry points.

## Acceptance map

Python names below are methods in `test_inventory.py`. Shared names have the Python prefix `test_shared_` and the TypeScript prefix `shared_`. Every shared history also has an actual cross-language `parity_` test in `tests/unit/c2/inventory.test.ts`.

| Acceptance | Python tests | TypeScript tests and shared histories |
|---|---|---|
| M1 optional parent schema, retained unresolved metadata, legacy replay, hooks, self/cycle rejection | `test_m1_discovery_exposes_optional_parent_fields`, `test_m1_valid_parent_schema_boundaries`, `test_m1_parent_run_only_is_optional_not_a_pair_requirement`, `test_m1_parent_survives_persistence_and_replay`, `test_m1_duplicate_parent_lifecycle_is_idempotent`, `test_m1_self_parent_is_bad_args_without_append`, `test_m1_two_agent_cycle_is_bad_args_without_append`, `test_m1_transitive_cycle_is_bad_args_without_append`, `test_m1_parent_graph_is_scoped_to_room`, `test_m1_hostile_parent_agent_is_rejected_without_append`, `test_m1_hostile_parent_run_is_rejected_without_append`, `test_m1_parent_survives_mcp_lifecycle_admission`, `test_m1_generic_hook_bootstraps_and_preserves_parents`, `test_m1_claude_lifecycle_cli_preserves_parents`, `test_m1_all_existing_histories_fold_byte_identically`, `test_m1_legacy_hook_still_bootstraps_without_parent_fields` | `accepts_each_optional_parent_field_and_both_syntax_boundaries`, `rejects_hostile_parent_agent_syntax`, `rejects_hostile_parent_run_syntax`, `keeps_unresolved_parent_metadata_in_fold_and_replay`, `rejects_self_parent_without_mutating_input_projection`, `rejects_transitive_parent_cycle_after_admitting_unresolved_edges`, all `legacy_` cases; `unresolved_parent`, `tree_first_seen_order`, `parent_arrives_after_child` |
| M2 (A-C2a) lifecycle members and current/past folded assignees; authors/recipients alone excluded; no-plan lifecycle membership | `test_m2_journal_authors_of_nonplanning_acts_are_absent`, `test_m2_plan_step_answer_and_ack_authors_are_absent`, `test_m2_claimant_remains_a_member_after_releasing_work`, `test_m2_rejected_call_does_not_register_an_agent` | `message_only_authors`, `assignee_only_member`, `fresh_deployment`, `excludes_message_only_authors_when_projection_is_absent`, `ignores_foreign_room_authors_and_message_recipients`; planner-only authors excluded from work histories |
| M3 agent fields, owned current work and aggregate counts | Every shared history passes `assert_contract`; exact golden rows except the documented partial assertions below | `working_current_and_counts`, `counts_cover_all_owned_tasks`, `dependency_waiting_beats_idle`; every shared inventory checks all mandatory fields |
| M4 state precedence and valid current-run freshness | All matching shared histories; `test_m4_terminal_precedes_owned_work_and_ignored_beats`, `test_m7_now_omitted_uses_controlled_server_clock` | `fresh_deployment`, `fresh_alive`, `freshness_inclusive_boundary`, `stale_alive_is_unknown`, `stale_deployed_is_unknown`, `explicit_finished_survives_staleness`, `explicit_failed_survives_staleness`, `redeploy_resets_terminal`, `active_work_without_beat_is_unknown`, `working_becomes_unknown_not_finished`, `dependency_waiting_beats_idle`, `staleness_beats_dependency_waiting`, `dependency_waiting_precedes_fresh_beat`, `ignored_retired_beat_cannot_refresh`, `redeploy_does_not_reuse_old_beat`, `future_beat_is_not_valid_evidence`, `sync_gap_is_unknown`, `sync_disconnect_forces_unknown_before_working`, `terminal_status_survives_sync_disconnect` |
| M5 exhaustive totals and sum invariant | `assert_contract` on every shared history, including the empty room | `assertContract` on every shared history, including `empty_room` |
| M6 first-seen roots, nested children, sorted child labels, stable replay | `test_m6_replay_is_stable_after_reloading_and_reordering_input`; shared `tree_first_seen_order`, `parent_arrives_after_child`, `duplicate_delivery_is_stable` | Same shared histories; `reordered_and_duplicated_events_produce_identical_inventory`, `does_not_mutate_events_or_projection` |
| M7 MCP discovery, supplied/omitted clock, CLI JSON parity, redaction seam | `test_m7_tool_discovery_room_and_optional_now`, `test_m7_cli_call_and_mcp_return_identical_json`, `test_m7_now_omitted_uses_controlled_server_clock`, `test_m7_hostile_arguments_fail_without_mutating_journal`, `test_m7_inventory_text_uses_wall_redaction_rules_without_write_redaction`; all reads assert journal bytes unchanged | Each `parity_` history invokes the actual MCP transport through `inventory_probe.py` |
| M8 browser/Python identical inventories | `test_shared_*` executes the real MCP inventory against the shared data | All `shared_*` and `parity_*` tests use the same fixed-clock JSON; the parity tests compare actual Python and TypeScript canonical inventories |
| M9 MCP and hook documentation, bootstrap correction | `test_m9_mcp_documents_agents_list`, `test_m9_hooks_document_both_parent_fields`, `test_m9_hooks_remove_stale_bootstrap_claim`; real legacy and parent hook bootstrap tests | Documentation is checked in Python, not duplicated in TypeScript |

## Data and transport seams

- `fixtures/inventories.json` is the shared, passive corpus. `fixtures/legacy_fold.json` freezes canonical serialized output for existing lifecycle histories, including rejected operations and replay receipts. It never updates its own expectations at test runtime.
- `support.py` wraps existing MCP `tools/call`, CLI `call`, lifecycle admission and room journals. `inventory_probe.py` is a test-only client of the actual implementation, not a substitute inventory implementation. No proposed product module is imported.
- The canonical comparison retains exactly M3 agent fields and M5 totals. Extra UI fields and transport metadata are ignored. The existing browser entry remains `deriveSwarmViewModel`; no new TypeScript export is prescribed.
- All new runtime directories are temporary children of this test directory and are cleaned up. Python bytecode writing is disabled for test subprocesses. Network sockets and real sleeps are forbidden. Hook budgets and server clocks are fake; no listening ports or timers are needed. Differential subprocesses have bounded time and output.

## Resolved ambiguities

- `now` is epoch milliseconds, matching journal `ts`, existing browser `nowMs`, and heartbeat storage [CITED: `bridge/room/store.py`, `src/app/swarm_vm.ts`]. The expiry boundary remains fresh at exactly 90 seconds [TARGET]; one millisecond [TARGET] beyond it is stale.
- A new deployment is `registered` until new-run evidence arrives; it does not reuse the previous run's beat or terminal state. Stale deployment is `unknown`. Active owned work without a valid current-run beat is `unknown`; fresh taskless `alive` is `idle`.
- Both parent fields are independently optional. `bad_args` is required specifically for self-parent and cyclic admission. Invalid syntax must be rejected atomically; its unspecified error code is not frozen.
- `children` labels are lexically sorted, while row traversal follows first-seen sibling order. An unresolved parent remains metadata and does not manufacture a member. A late parent moves its existing child into the tree; root ordering uses the root's own first appearance.
- Current work is the sole active microtask in the fixtures, or the owned dependency-blocked task with a null microtask. Counts aggregate all currently owned tasks. No tie-breaking rule for multiple active tasks is invented.
- The spec does not assign first-seen/last-seen coordinates to assignees who never wrote an event. `assignee_only_member` therefore asserts membership plus structural invariants and actual cross-language equality, without inventing those coordinates.
- The ignored/future-beat fixtures freeze state and run identity, leaving unspecified diagnostic timestamps open. Cross-language equality still compares all mandatory fields for these histories.
- An internal Lamport hole and an explicit browser disconnect exercise C2's sync-gap precedence. Durable checkpoint recovery and sync error UI are outside this unit.
- The U163 structured sanitizer is AUSENTE in this workspace. The inventory-specific output test uses the existing Wall `bridge.wall.emit.redact` result as its expected text, with no copied pattern list, and requires raw journal preservation. It does not prescribe an unavailable sanitizer function name or import layout.

## Negative controls and stop rules

| Mutation or invalid input | Discriminating test |
|---|---|
| A-C2a: build membership only from assignees | `fresh_deployment`, `fresh_alive`, taskless parent histories |
| A-C2a: count authors, recipients, assignee-less claims or beats alone | Inverted M2 author tests, `message_only_authors`, `assignee_only_member`, browser guards and unchanged membership regression suites |
| Infer completion from staleness | `stale_alive_is_unknown`, `working_becomes_unknown_not_finished` |
| Drop parent fields on admission or replay | Parent schema, replay and hook tests; shared tree histories |
| Change only the TypeScript inventory rule | Actual `parity_*` comparisons against the Python inventory |
| Count recipient-only names | `message_only_authors`, foreign-room/recipient browser guard |
| Refresh from an ignored old-run beat | `ignored_retired_beat_cannot_refresh` |
| Let dependency waiting lose to a fresh beat | `dependency_waiting_precedes_fresh_beat` |
| Accept a self-parent, cycle or hostile parent syntax | Admission tests require refusal and byte-identical journal |
| Reuse unknown-tool errors as validation success | Hostile inventory inputs first require advertised `agents_list` |

Import, collection, fixture-construction or runtime errors stop oracle admission; only assertion failures about missing C2 behavior constitute the intended red state. There are no skips, expected failures, stubs or silent fallback implementations.

## Out of scope

| Unit | Excluded acceptance |
|---|---|
| C1 | Automatic native session/sub-agent adapters, launcher supervision and visibility latency |
| C3 | `orchestrator_snapshot`, compact-context budgets and changes-since cursors |
| C4 | Journal rotation, checkpoints and recovery beyond the journal cap |
| C5 | Rendering sync errors and repairing transport faults; C2 unknown-state precedence is covered |
| C6/C7/C8 | Agent waiting APIs, result artifacts and campaign planning templates |
| V1 | Bubble rendering, layout, keyboard interaction and visual testing |
| U163 | All unrelated tools/resources/prompts/exports, sanitizer-failure matrix and server version; only C2 inventory output is tested here |

## Run

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/c2 -t .
npm test -- tests/unit/c2
```

Verification counts and final summaries are recorded after running the tests; the frozen product expectations remain independent of those measurements.

## Verified fail-first result

| Suite | Total | Assertion failures | Passing | Exact final summary |
|---|---|---|---|---|
| New Python C2 | 56 [MEASURED] | 51 [MEASURED] | 5 [MEASURED] | `FAILED (failures=51)` [MEASURED] |
| New TypeScript C2 | 74 [MEASURED] | 60 [MEASURED] | 14 [MEASURED] | `Tests  60 failed \| 14 passed (74)` [MEASURED] |
| Existing Python u132/u139/u158 | 83 [MEASURED] | 0 [MEASURED] | 83 [MEASURED] | `OK` [MEASURED] |
| Existing TypeScript u109/u132/u138 | 476 [MEASURED] | 0 [MEASURED] | 476 [MEASURED] | JSON reporter: `numPassedTests: 476`, `numFailedTests: 0` [MEASURED] |

The new suites have no import, collection or runtime errors, skips or pending cases [MEASURED]. All failing TypeScript results are `AssertionError` [MEASURED]; the Python summary contains failures only [MEASURED]. Legacy folds and syntax rejection controls remain green. The focused existing suites above were run; a full repository suite was not claimed.

TypeScript reports no diagnostics under `tests/unit/c2/`; the rest of the existing tree has 17 diagnostics [MEASURED]. A content digest covering existing source, docs and tests outside the permitted C2 directories is unchanged after verification [MEASURED]. Temporary runner reports and caches were removed.

## A-C2a membership repair

A-C2a inverts only the two author-membership Python tests and message-only browser guards. Shared fixture inputs are unchanged; each amended expectation carries an `amendment` field. Author-only `zeta`/`alpha` rows are removed from `message_only_authors`; author-only `planner` is removed from the following expectations, with concrete totals recomputed: `working_current_and_counts`, `assignee_only_member`, `active_work_without_beat_is_unknown`, `working_becomes_unknown_not_finished`, `dependency_waiting_beats_idle`, `staleness_beats_dependency_waiting`, `counts_cover_all_owned_tasks`, `dependency_waiting_precedes_fresh_beat`. The partial `assignee_only_member` expectation retains `worker`. All other tests and fixture contracts remain unchanged.
