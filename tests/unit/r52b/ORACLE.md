# R52B Agents board oracle

The binding row B in `.unit/SPEC.md` has no numbered subcases. The labels below index its acceptance clauses and the visible parity requirement.

| Acceptance | Test in `tests/unit/r52b/board_errors.test.ts` |
| --- | --- |
| B.1 Cold local failure with a healthy peer | `shows cold inventory as unavailable with a safe read alert and no peer bubbles` |
| B.2 Local failure after an unverified preview | `discards a readable but unverified Wall preview when the Agents read fails` |
| B.3 Local failure after a verified snapshot. Retain same-room bubbles and totals with visible stale text | `retains only verified same-room bubbles and totals with a visible stale label` |
| B.4 Unavailable inventory suppresses zero totals and healthy empty copy | `suppresses normal empty copy and zero totals after a verified empty read` plus the cold and unverified cases |
| B.5 Peer replay leaves the local fault visible. Successful same-room recovery restores current inventory | `stays faulted after peer replay and restores current inventory after same-room recovery` |
| B.6 Visible parity with a transport read failure, including hostile error text | `shows cold inventory as unavailable with a safe read alert and no peer bubbles` plus the snapshot cases. The fixed alert and inventory states follow C5b M5 and M6. |

The fixture uses the production hosting, link, store and views with fake time and port traffic. The affected room's local read is the injection point. A live registration in the Wall strip before the room's replay completes establishes the unverified preview. The recovery fixture keeps the local failure active through the peer terminal and restores readable local data for the affected room's replay. Assertions use the rendered Agents board.

C5b relay and extension validation and transport-only recovery are covered by the frozen C5b suite. Missing terminals, retry cursors and timer cleanup belong to R52S. Expanded diagnostics and mapper audits belong to C5c. The paired performance protocol applies to performance units.
