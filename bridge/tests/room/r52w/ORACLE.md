# R52W waiter integrity oracle

The binding W row in `.unit/SPEC.md` gives acceptance clauses without numbers. The numbers below identify those clauses for traceability.

| Case | Acceptance | Test in `test_wait_integrity.py` |
| --- | --- | --- |
| 1 | A never-created room times out with no events and cursor zero. | `test_never_created_room_times_out_empty` |
| 2 | A directory in place of the journal is a sanitized error on the first read or during the wait. | `test_directory_substitution_is_a_journal_error`, `test_directory_substitution_during_wait_is_a_journal_error` |
| 3 | An unreadable journal is a sanitized error. | `test_unreadable_file_is_a_sanitized_journal_error` |
| 4 | A foreign committed row is a sanitized error even if a local terminal can be returned. | `test_foreign_committed_row_is_a_journal_error` |
| 5 | A cursor past the foreign row still produces a sanitized error. | `test_foreign_committed_row_before_cursor_is_a_journal_error` |
| 6 | A terminal keeps its parent agent and parent run at the event. The parent filter uses that history. | `test_all_runs_keep_their_parent_at_the_event` |
| 7 | Every matching run remains waitable in Lamport order. A verdict-only result still replays under A-C6b. | `test_all_runs_keep_their_parent_at_the_event` |
| 8 | The cursor is exclusive, the same cursor replays the same rows, and a later append is visible from the previous head. | `test_exclusive_cursor_and_stateless_replay` |

The oracle calls registered `wait_agents` through `bridge/room/app.py`. Journal failures must use the tool error channel with no journal path, raw I/O detail, or foreign data. The spec leaves the error code, message, and reader open. The permission fixture injects a file-open failure for the journal regardless of process privileges. A virtual clock and operation budget bound the wait. A broken read must never return a successful timeout, cursor, or partial batch.

## Out of scope

- C3c snapshot coverage and cursor clipping.
- C6 lifecycle result admission, result-file limits, inventory and browser parity. The existing C3c and C6 suites cover legacy waiter argument, cursor and transport behavior.
- R52 units G (completion admission), S (sync terminal recovery), P (projection performance), H (repair histories), D (public resume workflow), and A (import authority).
- The common wave-exit gate and cross-family review.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/r52w -t .
```
