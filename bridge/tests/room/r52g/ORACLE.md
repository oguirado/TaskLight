# R52G completion admission oracle

The binding acceptance row in `.unit/SPEC.md` supplies the cases below. The numbered acceptance list and Amendment sections referenced in the assignment are absent from that file. The numbers here follow the clauses of the binding row.

| Case | Binding acceptance clause | Tests in `test_completion_admission.py` |
| --- | --- | --- |
| 1 | A matching decision completes a bound step in one append. The terminal result alone leaves the step unaccepted. | `test_bound_step_completes_on_matching_admit` |
| 2 | Single admission refuses ordinary writes that mark protected work done. | `test_microtask_tool_refuses_protected_completion`, `test_single_journal_post_refuses_protected_micro_set`, `test_single_task_set_refuses_exposing_legacy_completion` |
| 3 | Batch admission refuses protected completion. An invalid final member leaves journal bytes, Lamport and board state intact. The valid prefix can subsequently commit at the next Lamport. | `test_batch_is_atomic_when_final_micro_set_completes_bound_step`, `test_batch_is_atomic_when_final_task_set_exposes_legacy_completion` |
| 4 | Single and batch admission consult the current plan under the journal lock. | `test_single_admission_uses_plan_at_lock_acquisition`, `test_batch_admission_uses_plan_at_lock_acquisition` |
| 5 | Ordinary tasks retain completion and unblock behavior through both writers. | `test_ordinary_task_completion_and_unblocking_remain_legal` |
| 6 | Committed legacy completions remain readable, retain their generic state and confer no pipeline acceptance. | `test_committed_legacy_generic_completion_replays_as_history` |
| 7 | Exact identified retries return committed acknowledgements without appending. Reusing the identifier with changed content is refused. | `test_bound_step_completes_on_matching_admit`, `test_exact_identified_legacy_single_replays_and_changed_payload_refuses`, `test_exact_identified_legacy_batch_replays_and_changed_payload_refuses` |

The immediate refusal cases use valid requests from the unit owner. `task.set` uses `state: null` with a current revision to clear an explicit block on a unit whose committed legacy rows would make it appear done. The batch prefix edits a sibling task. The lock cases bring a prepared competing commit into view at acquisition, keeping the target ID the same across the plan change. They use the real journal lock without waiting for another thread. The shared fixture supplies a fake clock, bounded execution and stop rules for waits and network access. Refusal is asserted through the room error contract with no requirement on its specific code or wording.

The wave-exit gate, independent C8/C8p review, C8b import authority, and units S, P, W, H, D and A are outside this oracle. The existing `test_generic_completion_and_task_level_decision_do_not_unlock_spec` in `bridge/tests/room/c8x/test_pipeline.py` expects a fresh generic pipeline completion to be admitted. Its predecessor assertion can instead be exercised with a committed legacy completion when updating that fixture for R52G.
