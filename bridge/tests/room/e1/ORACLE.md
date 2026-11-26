# E1 fail-first oracle: a room that was never written is a healthy empty room

Scope: the native-host relay (`bridge/wall/room_relay.py`), `RoomRelay._read_sorted`, `prime` and `poll`.

| Rule | Test | Baseline (tree `7e2bb29` plus the uncommitted TLCLI, R52B and FIX_U157b work) |
| --- | --- | --- |
| E1-1 | `test_replay_of_a_room_never_written_is_healthy_and_empty`: with cursor 0 and no room directory, a replay ends with `room_synced` up to 0 and no fault | RED: `room_read_failed` |
| E1-2 | `test_prime_and_poll_of_a_room_never_written_do_not_fault_and_deliver_later_writes`: startup reports no fault, and the first write is delivered by the next poll | RED: fault at startup |
| E1-3 | `test_missing_journal_inside_an_existing_room_directory_still_faults`: the c5b contract is unchanged | GREEN (guard) |
| E1-4 | `test_nonzero_cursor_on_a_room_never_written_is_not_certified`: a cursor past events the host never saw is never certified | GREEN (guard) |

Why: after `python3 bridge/install.py --room <room> --apply` the room is allowlisted but has no
directory until the first write. The wall then showed "Can't read this workspace: Room data could
not be read.", and the page link does not request the room again after a read fault, so the first
plan never appeared without a reload.

A lost journal inside an existing room directory is a broken journal and keeps faulting. A cursor
other than 0 on a room without a directory is never certified.

## Amendment A-E1 (orchestrator, before review)

The first version of E1-2 asserted that a peer room's event is delivered by the first poll after
`prime()`. That contradicted the existing contract: `prime()` consumes existing events to set the
relay cursors and delivers nothing. The author flight met the assertion by changing `prime()`, which
re-delivers every peer room's history whenever a room is fresh. E1-2 now asserts the opposite: the
peer room's history is not delivered again. `prime()` is not part of this unit.

| File | SHA-256 before | SHA-256 after |
| --- | --- | --- |
| `test_fresh_room.py` | `c4b65ff7d6ae5618a124553684a0dde8f0a3d4d19b7b5b18ab0416e7854e3b3b` | `c537b5331c0f60f2ea72ffb6b2c0cebed4ffce9a9ef621bf82426b5418d27119` |

Baseline with the amended oracle (tree `7e2bb29` plus the uncommitted work): E1-1 and E1-2 RED,
E1-3 and E1-4 GREEN. A scratch copy with only the guard in `_read_sorted` passes E1-1 to E1-4 and
the c5b, c4m, wall_room, r52r, r52w2 and debt2a suites.
