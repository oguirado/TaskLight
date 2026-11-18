# R52R checked read oracle

The R row in `.unit/SPEC.md` has an unnumbered acceptance list. The case numbers below follow that list. The binding amendment places the tests in `bridge/tests/room/r52r/` and the paired benchmark in `bridge/tests/bench/measure_checked_prefix.py`.

| Case | Acceptance | Test or gate | Rejecting contrast |
| --- | --- | --- | --- |
| 1 | Seed validation through `read_checked`. | `test_warm_recent_cursor_skips_decoding_a_validated_prefix` | A second recent read decodes the same marked complete prefix row. |
| 2 | Bind the proof to the room, current validation rules and the entire complete prefix of the captured bytes. | `test_a_proof_cannot_authorize_the_same_bytes_in_another_room`, `test_unchanged_bytes_require_current_validation_rules`, `test_proof_cannot_certify_rows_from_a_different_capture`, and cases 6 and 10. | Wrong-room reuse, stale validation rules, a digest from one capture applied to another, or a digest that misses interior changes allows an invalid result. |
| 3 | Recheck readability on every call. | `test_warm_permission_loss_is_a_read_failure` | Warm metadata or a saved proof bypasses a current file-open denial. |
| 4 | Skip decoding only when the cursor covers the complete prefix maximum. | `test_warm_recent_cursor_skips_decoding_a_validated_prefix`, `test_older_cursor_and_prefix_maximum_keep_earlier_physical_rows` | Always decoding misses the fast path. Using a last-seen Lamport or reusing a proof below its maximum drops an eligible physical row. |
| 5 | Bound retained proofs. | `test_room_churn_preserves_checked_replay_on_revisit`, paired peak RSS, and source review of the finite retention bound. | A cache hit or an eviction changes replay, peak RSS exceeds the paired gate, or the implementation has no finite retention bound. Churn exercises replay under pressure without setting the capacity. |
| 6 | An interior rewrite followed by growth matches whole checked replay. | `test_interior_rewrite_plus_append_can_move_a_row_above_cursor` | Inode, growth, and bytes near the old end can stay eligible while a changed interior Lamport must become visible. |
| 7 | Truncate and regrow matches whole checked replay. | `test_truncate_and_regrow_reads_changed_prefix` | A stale proof drops a rewritten record after the same inode grows past its former size. |
| 8 | Replacement matches whole checked replay. | `test_atomic_replacement_does_not_reuse_stale_validation` | A replacement at the same pathname hides a committed foreign row. |
| 9 | Permission loss keeps the checked read error. | `test_warm_permission_loss_is_a_read_failure` | A denied open yields data, an empty success, or raw I/O details. |
| 10 | A committed foreign or malformed row fails even below the requested cursor. | `test_hidden_foreign_row_after_interior_rewrite_and_growth_fails_closed`, `test_hidden_malformed_row_after_interior_rewrite_and_growth_fails_closed` | Boundary-only validation fails to detect a foreign room, invalid UTF-8, malformed JSON or a Boolean Lamport. |
| 11 | A newly completed torn tail enters checked replay. | `test_valid_torn_tail_becomes_visible_when_completed`, `test_invalid_torn_tail_fails_when_completed_even_past_cursor` | A torn row becomes visible early, stays hidden after completion, or bypasses checked validation once committed. |
| 12 | An older cursor preserves whole checked replay. | `test_older_cursor_and_prefix_maximum_keep_earlier_physical_rows` | Reusing the recent view drops eligible history. |
| 13 | Preserve physical order, duplicates and caller mutation isolation. | `test_warm_reads_preserve_physical_order_duplicates_and_nested_values` | Sorting, deduplicating, or sharing nested data among rows or calls changes the result. |
| 14 | The frozen cap benchmark meets the time and RSS gates. | `measure_checked_prefix.py` | A fixture mismatch or unequal replies blocks comparison. A warm cap median above 20 ms [TARGET], median paired gain below 35% [TARGET], or median paired cold, invalidated or RSS overhead above 10% [TARGET] fails. |

The correctness cases use fixed records and real journals under the test directory. The decoding check observes the existing JSON decoder without assuming cache names or proof layout. The rules check substitutes the existing operation validator for one call. The permission check injects denial at the journal open regardless of process privileges. The capture check swaps between two invalid journals on reopen, so either captured view must fail without publishing partial data.

The benchmark takes the frozen journal as input and requires SHA-256 `af82737d7e67970859f1148a3b65960344050ea12b4f7e62ab93d9ae48730aa0` [CITED] before sampling. It times only the public checked read or the pre-R52R full control. Each workload runs five [TARGET] alternating fresh process pairs on the same scratch device with matching runtime, initial and timed journal digests, cursor and cap. Checked reads use wire-shape validation without template inputs. The benchmark records raw intervals, load, available memory and process peak RSS. The correctness suite uses no timers.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/r52r -t .
python3 -B -m bridge.tests.bench.measure_checked_prefix --fixture path/to/frozen-cap-events.jsonl
```

## Out of scope

C4m capacity, reserved bytes, writer locking, fsync, retry receipts, and frozen historical benchmark fixture changes remain covered by C4m. Event-page caching, waiter integrity, relay and browser replay, plan projection, checkpointing and journal repair remain separate units. The benchmark checks checked-read output and time.
