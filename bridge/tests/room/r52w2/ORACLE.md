# R52W2 waiter oracle

The binding W+ row in [.unit/SPEC.md](../../../../.unit/SPEC.md) is unnumbered. The case numbers below map its acceptance clauses and the measurement amendment to verification.

| Case | Acceptance | Verification |
| --- | --- | --- |
| 1 | After a checked no-match with unchanged effective templates, ordered heartbeat-only growth advances the head with zero repeat folds [TARGET]. A valid idle wait ends at its deadline. | `test_ordered_heartbeat_extensions_advance_head_without_repeat_folds` |
| 2 | A relevant extension following a heartbeat needs the complete checked snapshot and full fold. Compare the entire reply, with an exclusive cursor, every matching run, parent and parent run at the event, any result, and the actual head. Repeating the same cursor replays the same rows. | `test_heartbeat_then_matches_preserve_runs_parents_and_exclusive_cursor` |
| 3 | Explicit `deployed` and `alive` requests return the complete nonterminal rows and head after a previously empty wait. | `test_explicit_nonterminal_states_still_return_complete_replies` |
| 4 | An out-of-order deployment physically appended after an existing terminal and logically before the cursor can admit that terminal. Use a full checked snapshot and replay. | `test_late_deployment_before_cursor_can_admit_an_existing_terminal` |
| 5 | A replacement with the same effective template ID invalidates the earlier no-match. Test both a concurrent heartbeat append and fixed journal bytes. The new template changes the admission of an existing terminal. | `test_replaced_template_invalidates_heartbeat_skip`, `test_replaced_template_invalidates_no_match_with_identical_journal` |
| 6 | A same-inode prefix rewrite with heartbeat growth can change an existing event's parent. A previously torn record can become a match when completed. Replay the full checked inputs in both cases. | `test_same_inode_rewrite_with_heartbeat_growth_can_change_parent`, `test_termination_of_a_torn_record_makes_a_match_visible` |
| 7 | A malformed or foreign committed record before the cursor fails closed, even if a heartbeat grows the same inode and the old journal tail is intact. The tool error contains only the established code and safe detail. | `test_malformed_committed_row_before_cursor_cannot_hide_behind_growth`, `test_foreign_committed_row_before_cursor_cannot_hide_behind_growth` |
| 8 | A room that vanishes after it was observed fails with a sanitized read error before the deadline. | `test_previously_observed_room_vanishing_is_a_sanitized_error` |
| 9 | A never-created room times out empty with cursor zero [TARGET] and creates no room. | `test_never_created_room_times_out_without_creating_storage` |
| 10 | The concurrent fixture must improve aggregate waiter CPU by at least 20% [TARGET]. The cold/full and invalidated CPU paths and peak RSS stay within 10% [TARGET] of matched control. | [measure_waiter_churn.py](../../bench/measure_waiter_churn.py) |

The unit calls the registered `wait_agents` through `bridge/room/app.py` with real journal bytes and a bounded virtual clock. It observes the authoritative `fold_plan` only for the replay requirements. Expected replies are written independently of the folder or waiter's implementation. The template-only case uses a prior `plan.open` and a lifecycle terminal with the same operation ID. Replacing the template invalidates the old plan operation, releases the ID during replay, and admits the terminal even if the journal stamp is unchanged.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/r52w2 -t .
```

## Paired measurements

Run the benchmark from the oracle checkout with the baseline root, candidate root, and pinned cap fixture supplied explicitly.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m bridge.tests.bench.measure_waiter_churn \
  --baseline PATH_TO_BASELINE --candidate PATH_TO_CANDIDATE \
  --cap-fixture PATH_TO_PINNED_JOURNAL
```

Run five fresh process pairs per workload [TARGET], alternating starting sides. Concurrent waiters share the same journal within each trial. The runner checks complete replies and matching runtime, fixture hashes, scratch device, resolved templates, and journal cap. It records per-waiter CPU and monotonic intervals, load, available memory, and peak RSS. The cold/full metric is total CPU and the invalidated-path metric starts at publication of the late deployment. The gate uses the median of the paired relative CPU and peak RSS differences.

The required cap fixture SHA-256 is `af82737d7e67970859f1148a3b65960344050ea12b4f7e62ab93d9ae48730aa0` [CITED]. The pinned bytes are AUSENTE in this checkout. The existing near-cap generator produces different bytes. A missing or mismatched fixture stops the measurement before any timed trials.

## Out of scope

- Frozen R52W directory substitution, unreadable journal, and cold journal corruption cases. Their existing oracle still owns them.
- C3c snapshot coverage and cursor clipping. C6 argument validation, transport parity, result admission, inventory, and browser behavior.
- R52 units G completion admission, S sync terminal recovery, P projection performance, H repair histories, D public resume workflow, and A import authority.
- Common wave-exit and cross-family admission gates.
