# C4m browser replay oracles

The [room oracle](../../../bridge/tests/room/c4m/ORACLE.md) maps all acceptance cases. This directory covers case 4 and its browser regression component in case 5.

| Case | Vitest test | Rejecting contrast |
|---|---|---|
| 4. Replay across the old journal ceiling | `replays real paged frames from zero and a saved cursor across the old journal ceiling` | The old writer refuses the next plan. Omitting an original event, accepting a stale replay identifier, losing the gap, advancing a wrong cursor, or reducing the history with the wrong opening template fails. |
| 4 and 5. Browser compatibility | `preserves template resolution, gaps and terminal certification on a legacy journal` | A refused delivery must produce `room_sync_error` with no terminal `room_synced`. Successful pages preserve event IDs and `rid/upto/more`. |

The Python fixture reads the actual on-disk journal. The fake page port translates relay request identifiers into page request identifiers and delivers the frames to the production link and store. The fixture lowers only the relay frame-size budget to elicit a genuine `room_gap` from a valid heartbeat. The replay loop has a fixed page budget and uses no network or wall-clock polling.

Browser retention changes, transport changes and snapshot replay are out of scope.
