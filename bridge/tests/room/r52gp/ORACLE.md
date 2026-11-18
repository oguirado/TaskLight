# R52GP completion admission oracle

The binding row and test-location amendment in `.unit/SPEC.md` govern this
oracle. The spec has no numbered acceptance list, so the case numbers below
follow the row and the cited R52G review items 1–3.

| Case | Acceptance | Tests in `test_completion_admission.py` |
| --- | --- | --- |
| 1 | Journal admission refuses generic completion of an unbound step and a repaired step with accepted history. | `test_single_refuses_unbound_micro_completion`, `test_single_refuses_repaired_micro_completion` |
| 2 | Direct `task.set(state="done")` is refused with no completed microtasks through both journal writers. | `test_task_set_cannot_mark_a_unit_done_with_no_completed_steps` |
| 3 | An invalid middle member leaves bytes, Lamport and the board unchanged. Both same-task edits commit with a legal middle member at the next Lamports. | `test_mixed_batch_refuses_unbound_middle_without_committing_edits`, `test_mixed_batch_refuses_repaired_middle_without_committing_edits` |
| 4 | A matching `unit_decide` ADMIT completes a freshly bound repaired step in one append. A finished result alone leaves it unaccepted. | `test_bound_admit_advances_a_repaired_step` |
| 5 | An isolated bypass makes the generic completion refusal assertions fail. | The case 1 and case 3 tests under the bypass below |

Every refusal checks journal bytes, the board's Lamport head and the entire
`plan_get` projection. The mixed batches use the current task revision for the
first edit and the predicted middle member's revision for the final edit. The
legal control preserves those revisions and operation IDs. The shared C8 fixture
uses a fake clock and deterministic event IDs, rejects real waits and network
calls and bounds room operations. Scratch journals live in this test directory.

For the bypass contrast, run the same oracle with completion admission skipped
in memory for generic `micro.set(state="done")` writes. The single and mixed
batch refusals in cases 1 and 3 must fail on unexpected admission. The direct
task-state refusal and the matching decision remain positive controls.

Store repair after R, earlier R52G replay and lock coverage, C8b artifact and
import authority, and performance measurements belong outside this oracle.
The binding amendment keeps `bridge/tests/room/r52g/` frozen.
