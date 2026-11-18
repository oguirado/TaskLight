# R52L acceptance oracle

The binding spec has one acceptance row, unit L, with no numbered cases.
The table assigns numbers to its checks for traceability. The test location
amendment assigns this suite to `bridge/tests/room/r52l/`.

| Case | Test | Verification and negative contrast |
| --- | --- | --- |
| 1. Process-list iteration raises after escalation | `test_iteration_eio_preserves_cancelled_leader_outcome` | Deliver `EIO` from directory iteration after yielding a leader entry. Escaping the CLI or losing the cancelled leader's outcome fails. |
| 2. Process record read raises after escalation | `test_record_read_eio_preserves_cancelled_leader_outcome` | Open a descendant's stat record successfully and raise `EIO` when reading it. Escaping the CLI or losing the cancelled leader's outcome fails. |
| 3. Unavailable-inspection control | `test_unavailable_inspection_preserves_cancelled_leader_outcome` | Raise `ENOENT` when opening the process list. This mirrors `test_missing_proc_still_kills_and_reaps_cancelled_group` in `bridge/tests/room/cld2/test_supervise.py` with the same nonzero leader exit as the fault cases. |
| 4. Actual exit, cancellation reason, reaping, and signal stop rule | All tests | The leader exits with its chosen status after TERM and the descendant keeps escalation necessary. The CLI returns that status and emits exactly one `failed` event with `wall_timeout`, after escalation and reaping. A signal attempt after reaping fails even if the kernel would reject it. |
| 5. Positively observed live descendant | `test_observed_live_descendant_keeps_leader_waitable` | Report a live same-group descendant after SIGKILL, then let it exit on the virtual clock. Reaping the leader or emitting the terminal event while the descendant is live fails. |

The virtual process fixture exercises `tasklight run` with bounded fake
time and no network. The assertions allow inspection retries and do not
require a particular helper return value or polling interval.

Performance measurement applies to performance units. Late-result polling,
wave launch and recovery belong to other units. The R52L production surface
is `bridge/room/ext/supervise.py`.
