# R52H fail-first oracle

The workspace spec contains one unnumbered R52H acceptance row. The numbers
below identify its clauses. Both reducers consume the same journal and
hand-derived checkpoints in `bridge/tests/property/pipeline_histories.json`. The TypeScript test for the
minimized history receives event rows from Python and evaluates them in
`foldPlan` against the frozen checkpoint.

| Case | Contract | Tests |
|---|---|---|
| 1 | Replay the opening, dependency edge, accepted diagnosis through oracle, terminal author, repair and replacement author. Repair retains old attempts and resets only the suffix. | `test_hand_derived_transition_checkpoints` and `matches the hand-derived %s checkpoint`, through `current_admit` |
| 2 | Detect acceptance of a late ADMIT referencing the old author run, including a reference carrying the replacement's binding Lamport. The current run can still be accepted. | `late_old_admit`, `current_admit` and `test_negative_controls_reach_and_fail_the_checkpoint_oracle` |
| 3 | Detect a dropped legacy resultless HOLD. A pipeline HOLD blocks the bound step. A task-level HOLD using `result_agent` and `result_run_id` remains in decision history. Reject the resultless ADMIT and the resultless task-level reference with `agent` and `run_id`. | `resultless_admit`, `pipeline_resultless_hold`, `legacy_resultless_hold` and `test_negative_controls_reach_and_fail_the_checkpoint_oracle` |
| 4 | Replay reordered physical rows and identical copies. An identical repair retry preserves the new accepted author. A conflicting retry reports `bad_op` with that state intact. | `test_reordered_duplicates_replay_at_each_checkpoint`, `replays reordered duplicates at each checkpoint`, `identical_retry` and `conflicting_retry` |
| 5 | Shrink a witnessed divergence to a replayable journal that retains the opening, both task parents, historical and current binding lineage, and accepted diagnosis through oracle. Stop when the original has no witness. | `test_shrink_preserves_a_minimal_replayable_late_admit_witness`, `replays the minimized late-ADMIT witness independently` and `test_shrink_stops_without_a_witnessed_failure` |

The shrink case uses the existing `shrink(events, fails)` entry point with a
predicate tied to the investigated event. The independent replay check then
requires the numbered generation, task IDs and dependency, accepted prefix
identities, terminal results, attempts and stale-decision rejection. Deleting
any further event must change those observations. Room parsing must consume
every retained record. Simplifying text or changing arrival order is allowed
when the witness and its observations survive.

The two injected fault controls are process-local journal adapters with
positive activation checks. The stale-reference adapter resolves the late
decision to the new run and reaches an actual ADMIT. The HOLD adapter drops
the task-level decision row and leaves the earlier pipeline HOLD visible.
Both then exercise the same independent assertions as the canonical replay.

Out of scope for this unit are C8 board rendering and task creation UI,
G's interface, recovery/checkpoint or writer durability, R52P burst
performance admission, and the common wave-exit and cross-family admission
gates. The oracle uses fixed journal timestamps and local replay.

