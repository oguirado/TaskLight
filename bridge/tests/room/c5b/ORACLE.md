# C5b relay oracle

The binding cases are in `.unit/SPEC.md`. The browser cases are mapped in `tests/unit/c5b/ORACLE.md`.

| Acceptance | Test methods in `test_relay_errors.py` |
| --- | --- |
| M1 checked prime, retained cursor, healthy-room isolation | `test_prime_fault_preserves_cursor_and_still_primes_healthy_room` |
| M1 startup reporting after hello, including a repair before polling | `test_startup_fault_reaches_native_wire_after_hello_even_if_room_is_repaired` |
| M1 checked poll, no prefix or cursor advance on failure, retry after repair | `test_poll_fault_stops_progress_and_recovers_from_last_good_cursor` |
| M1 checked replay, no completion on missing, nonregular, unreadable, corrupt or foreign records, including records before the cursor | `test_replay_fault_correlates_and_never_certifies_a_broken_journal`, `test_replay_refuses_unreadable_journal_without_leaking_error`, `test_replay_can_retry_a_repaired_journal` |
| M1 preserve readable empty, blank, and torn-tail rules | `test_empty_blank_and_torn_only_journals_stay_healthy`, `test_torn_tail_preserves_committed_prefix` |
| M1 preserve sanitizer and oversize gaps | `test_sanitizer_and_oversize_remain_gaps_among_delivered_events` |
| M1 adopted relay delivery rules, including stop, retry, a healthy peer, and undelivered diagnostics | `test_replay_event_send_failure_stops_failed_room`, `test_replay_gap_send_failure_stops_failed_room`, `test_replay_terminal_send_failure_surfaces_instead_of_certifying`, `test_poll_failed_send_retries_only_undelivered_progress`, `test_undelivered_read_fault_is_reported_before_later_completion` |
| M2 one versioned, room-scoped, content-free frame with replay-only `rid` and the closed code set | `test_prime_fault_preserves_cursor_and_still_primes_healthy_room`, `test_replay_fault_correlates_and_never_certifies_a_broken_journal`, `test_replay_refuses_unreadable_journal_without_leaking_error`, `test_other_checked_read_failure_uses_generic_code`, `test_invalid_checked_result_cannot_certify_replay` |
| Negative control · completion after failed read | `test_replay_fault_correlates_and_never_certifies_a_broken_journal` |
| Negative control · readable empty journal faults | `test_empty_blank_and_torn_only_journals_stay_healthy` |

Journal fixtures are temporary children of this test directory. Startup uses framed in-process stdin and stdout with a ready file descriptor. Permission and delivery failures are injected without relying on account permissions or timing. All checks use delivered frames or the next observable replay or poll. They make no assertion about the relay's private cursor representation. An exception outside a typed checked-read error or an invalid return from the checked reader is treated as a relay failure.

C5a MCP and CLI query behavior belongs to `bridge/tests/room/c5a/`. Draft store diagnostics, mapper diagnostics, and deadline or timer cases belong to C5c.
