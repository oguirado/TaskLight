# C5b extension and Agents oracle

The binding cases are in `.unit/SPEC.md`. The Python relay cases are mapped in `bridge/tests/room/c5b/ORACLE.md`. The test names below omit the suite and MUST prefixes.

| Acceptance | Test file and names |
| --- | --- |
| M2 forwarding, both public codes, replay request routing and healthy-room independence | `extension_errors.test.ts` · `forwards live %s unmodified to subscribers`, `restores the requester rid without suppressing another room's completion` |
| M2 hostile wire input and code normalization | `extension_errors.test.ts` · `normalizes an unknown hostile code (correlated=%s)`, `ignores malformed, unknown, and unowned fault frames` |
| M3 admitted room and outstanding room/request pair, including stale port and changed hello membership | `board_errors.test.ts` · `shows a correlated cold fault without borrowing another room's inventory`, `ignores foreign rooms, invalid frames, and a rid outstanding only for another room`, `ignores a room removed from current hello membership and frames from a previous port` |
| M4 replay start after fault, cursor at or before last good, final page in the current port for the affected room | `board_errors.test.ts` · `rejects an otherwise matching completion for a replay started before the fault`, `stays faulted across hello, reconnect, wrong or partial completion and clears on a later qualifying replay` |
| M5 cold inventory unavailable, no peer snapshot, warm inventory and totals retained with visible stale text | `board_errors.test.ts` · `shows a correlated cold fault without borrowing another room's inventory`, `retains the last good room snapshot with a visible stale label and fixed sync text`, `hides empty copy and zero totals when the previous healthy snapshot was empty` |
| M5 healthy empty room | `board_errors.test.ts` · `gives a healthy replayed empty room its normal empty state` |
| M6 fixed alert text for both codes, hostile fields do not render | `board_errors.test.ts` · `shows a correlated cold fault without borrowing another room's inventory`, `retains the last good room snapshot with a visible stale label and fixed sync text` |
| Negative control · extension drops `room_sync_error` | `extension_errors.test.ts` · `forwards live %s unmodified to subscribers` |
| Negative control · link accepts a room outside hello | `board_errors.test.ts` · `ignores a room removed from current hello membership and frames from a previous port` |
| Negative control · hello alone clears a fault | `board_errors.test.ts` · `stays faulted across hello, reconnect, wrong or partial completion and clears on a later qualifying replay` |
| Negative control · faulted board shows no agents or all-zero totals | `board_errors.test.ts` · `hides empty copy and zero totals when the previous healthy snapshot was empty`, `shows a correlated cold fault without borrowing another room's inventory` |

The extension preserves known fault frames with the page's original `rid` on correlated replies, matching the existing request-routing contract. The board tests use the production hosting, link, store and view with fake ports and timers. The recovery case accepts either a replay from zero or a replay at or before the last good cursor, with a terminal page following qualifying replay traffic. A cached empty inventory still suppresses zero totals while faulted.

The expanded draft's store and mapper diagnostics and deadline or timer checks belong to C5c. The reduced C5b cases do not require the draft's explicit checked-empty marker, proof-of-coverage protocol, or added transport and callback diagnostics. The existing `tests/unit/u161/store.test.ts` and `tests/unit/u161/hosting.test.ts` cover template-generation and interval-gap behavior.
