# R52S sync deadline oracle

The acceptance row in .unit/SPEC.md is unnumbered. Numbered cases and amendments are AUSENTE in that file. The identifiers below map its individual clauses to tests in sync_deadline.test.ts.

| Oracle case | Acceptance | Test name |
| --- | --- | --- |
| S1 | Deliver a prefix, lose the terminal, expire on a fake clock, show stale inventory and keep verified bubbles. | shows stale inventory and retains the verified bubble until replay completes |
| S2 | Release the expired room/request and retry from the recovery cursor. | releases the expired replay and retries from the last verified coverage |
| S3 | A terminal for another room cannot clear the fault. | keeps the fault when another room completes a valid replay |
| S4 | A terminal for the expired request cannot clear the fault. | keeps the fault when the expired request completes late |
| S5 | A terminal from the previous port cannot clear the fault even with the current room/request pair. | ignores a matching terminal from the previous port |
| S6 | A continuation cannot clear the fault. A complete matching same-room replay can. | keeps the fault through a continuation until its final page arrives, releases the expired replay and retries from the last verified coverage |
| S7 | An unknown room and a malformed terminal cannot clear the fault. | keeps the fault when a foreign room is supplied, keeps the fault when a terminal with nonboolean more arrives |
| S8 | Disconnect cancels an outstanding replay deadline. Ordinary reconnect remains available. | cancels an in-flight deadline on disconnect and preserves reconnect |
| S9 | Stop cancels an outstanding replay deadline. Late traffic has no effect. | cancels an in-flight deadline on stop |
| S10 | A healthy replay still completes normally. | accepts an on-time terminal without a later fault or retry |

The fixture separates verified coverage from the cursor advanced by a partial replay. The inherited C5b M4 contract allows recovery from zero or another cursor at or before the last good cursor. The retry can already be on the wire or follow a normal snapshot-triggered sync on the same port. The fake clocks advance to scheduled work with a finite step limit. The spec gives no deadline duration or retry cadence. The disconnect, stop and timely completion controls also run green on the baseline. The timeout tests exercise those same boundaries once replay deadlines exist.

Relay, native host, and extension fault propagation, cold-room handling, and the existing board's general error rendering are covered by C5b/C5br. Relay read integrity, waiter deadlines, orchestration recovery, and browser paint are outside R52S. The oracle runs in the isolated copy. Campaign-wide gates and cross-family admission apply to a later production candidate.
