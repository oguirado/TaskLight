# R52E lifecycle rejection oracle

The spec has one acceptance row. The table numbers its clauses for reference.
Each reducer reads `bridge/tests/property/lifecycle_cycle.json` independently
and compares its public projection with the hand-written expected values.
Fixture timestamps are fixed. The tests require no workers, network, or timers.

| Case | Contract | Python test | TypeScript test |
|---|---|---|---|
| 1 | Reject the event that closes the cycle with the server's `bad_args` receipt, including the event ID, Lamport and operation ID. The first deployment and its edge survive, and the rejected agent stays absent. | `test_rejects_parent_cycle_with_server_receipt` | `rejects a parent cycle with the server receipt` |
| 2 | Accept the valid parent chain, retain each parent link and its run ID, and emit no rejection. | `test_accepts_valid_parent_chain` | `accepts a valid parent chain` |
| 3 | Both cycle tests fail if both reducers emit the same wrong code. Changing the cycle receipt to `bad_op` leaves each test comparing against the literal `bad_args` in the fixture. | `test_rejects_parent_cycle_with_server_receipt` | `rejects a parent cycle with the server receipt` |

Case 1 covers the hostile parent graph. Its first event deliberately references
an as-yet unregistered parent, consistent with the existing server contract.
The valid chain uses the same registration order and ends at a root.

R52H repair histories, their late ADMIT and resultless decision vectors, and
the shrink stop rule are out of scope. The binding test-location amendment
keeps `tests/unit/c8/` frozen. The parity report's separate non-terminal
`result` mismatch and the performance measurement protocol are outside this
acceptance row.
