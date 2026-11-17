# U140 fail-first oracle

## Binding corpus and interpretation

The complete `.unit/SPEC.md` was read. A numbered acceptance list is
**AUSENTE — no inventar**; final Amendment sections are
**AUSENTE — no inventar**. The acceptance labels below are traceability labels
for its explicit requirements, oracle, hostile input and negative control.
They do not claim to reproduce missing specification numbering.

The mandate is limited to `.unit/SPEC.md` and the supplied U140 corpus.

## Acceptance mapping

All test names below are in `bridge/tests/room/u140/test_fencing.py`.

| Case | Requirement or acceptance interpretation | Test names |
| --- | --- | --- |
| A1 | A matching `expected_opened_lamport` admits a valid write; compare `opened_lamport`, even when plan `rev` differs. | `BackendFencing.test_a1_matching_generation_not_plan_rev_single`, `BackendFencing.test_a1_matching_generation_not_plan_rev_batch` |
| A2 | An old generation after reopen refuses the whole request with no append or projection change. Fresh generation still succeeds afterward. | `BackendFencing.test_a2_stale_generation_zero_appends_single`, `BackendFencing.test_a2_stale_generation_zero_appends_batch` |
| A3 | A forged future generation also fails equality and appends nothing. | `BackendFencing.test_a3_forged_future_zero_appends_single`, `BackendFencing.test_a3_forged_future_zero_appends_batch` |
| A4 | Reopen between pre-read and writer-lock acquisition; stale request is rejected without appending. Includes the dispatcher path. | `BackendFencing.test_a4_reopen_between_preread_and_commit_single`, `BackendFencing.test_a4_reopen_between_preread_and_commit_batch`, `DispatcherFencing.test_a4_dispatcher_reopen_between_preread_and_commit` |
| A5 | Hostile overlapping writers share an expected generation while another writer reopens. Both stale requests and a subsequent forged future request refuse without an append. | `BackendFencing.test_a5_two_overlapping_writers_and_reopener_single`, `BackendFencing.test_a5_two_overlapping_writers_and_reopener_batch` |
| A6 | The backend writer lock remains held through journal write and fsync. | `BackendFencing.test_a6_lock_held_through_commit_single`, `BackendFencing.test_a6_lock_held_through_commit_batch` |
| A7 | Omitting the argument preserves existing appends, identified replay and dispatcher results. | `BackendFencing.test_a7_omitted_preserves_append_and_replay_single`, `BackendFencing.test_a7_omitted_preserves_append_and_replay_batch`, `DispatcherFencing.test_a7_dispatcher_mutations_without_fence_keep_legacy_behavior`, `DispatcherFencing.test_a7_plan_create_without_fence_keeps_legacy_result` |
| A8 | Existing plan-mutation dispatcher requests forward the optional fence: matching succeeds, stale fails, current generation then succeeds with otherwise valid revisions. | `DispatcherFencing.test_a8_dispatcher_task_add`, `DispatcherFencing.test_a8_dispatcher_task_update`, `DispatcherFencing.test_a8_dispatcher_task_claim`, `DispatcherFencing.test_a8_dispatcher_task_release`, `DispatcherFencing.test_a8_dispatcher_microtask_add`, `DispatcherFencing.test_a8_dispatcher_microtask_set`, `DispatcherFencing.test_a8_dispatcher_plan_phase`, `DispatcherFencing.test_a8_dispatcher_plan_close` |
| A9 | Preserve the mailbox stop rule: configured `slice:1` advertises no planning/activity/work delivery; `slice:2` still refuses startup. | `MailboxBoundary.test_a9_slice_one_keeps_planning_held`, `MailboxBoundary.test_a9_slice_two_still_refuses_startup` |
| A10 | Negative implementation: equality checked only before entering the backend writer. The same race assertion must turn red on that implementation. | `NegativeControlCalibration.test_a10_preread_only_single_is_detected`, `NegativeControlCalibration.test_a10_preread_only_batch_is_detected` |

## API gaps resolved narrowly

- The spec names the argument but does not prescribe a new API. Existing
  `store.post` and `store.post_ops` receive it as an optional keyword, and the
  existing plan-mutation dispatcher tools receive it as an optional argument.
  No new helper, event metadata, persisted field, response shape or error code
  is required. The tests do not require it on `plan_create`: the meaning of an
  expected generation during initial plan creation is unspecified.
- Omission means the key is absent. Explicit null, malformed types, missing or
  closed-plan generation policy, and replay-versus-fence precedence are
  unspecified and are not assigned invented requirements.
- The current configuration parser requires an explicit `slice`; the boundary
  fixture uses `slice:1`, rather than imposing a new missing-key default.
- Reopening uses valid cancellation, close and open operations through the real
  store, not direct journal replacement. Every stale assertion snapshots the
  journal bytes, Lamport head and folded projection after the legitimate
  reopener commits, excluding that writer's legitimate appends from the check.
- Deterministic nested lock-entry callbacks overlap the writer calls with
  separate real lock descriptors. The reopener commits before either pending
  writer acquires the lock. This exercises the specified ordering without
  threads, sleeps or dependence on operating-system scheduling. It does not
  claim a process-stress or probabilistic concurrency receipt.
- Lock-through-commit observations use an independent real descriptor and a
  bounded fake retry clock. Existing lock and I/O boundaries are observation
  seams; the tests impose no location or name for the new comparison helper.

## Negative control and non-vacuity

The negative controls install test-local wrappers that accept the keyword,
compare it before acquisition, discard it, and invoke the real unchanged
backend. A matching write first succeeds. Reopening at lock entry then makes
the unguarded backend append into the successor plan, and the shared race
assertion fails. The calibration tests catch that expected assertion; a green
calibration means the mutant was detected, not that fencing exists.

Guarded success precedes stale/future refusals, so rejecting every request as
an unknown argument cannot satisfy the oracle. Missing keyword support is
reported as an assertion failure rather than an uncaught `TypeError`.
Legacy controls independently validate all dispatcher fixture arguments,
including ownership before microtask updates. No product module is mocked
into providing the missing fencing feature during acceptance tests.

## Scope and stop rules

Only `bridge/tests/room/u140/` is written. The inspected production surfaces
`bridge/room/store.py` and `bridge/room/app.py` remain unchanged.
Fixtures and transient runtime data stay beneath the test directory and are
cleaned up. Clocks and generated event identities are deterministic; network
calls and actual sleeps are forbidden. No worker, provider, GUI, deployment
or mailbox polling loop is launched.

Out of scope, and not counted as U140 failures:

| Unit | Separate requirement and surface |
| --- | --- |
| U139 | Durable lifecycle no-op identity in `bridge/room/ext/lifecycle.py` and `bridge/plan/fold.py`. |
| U141 | Terminal cleanup parity and resumability in `bridge/room/hook.py`, `bridge/room/ext/lifecycle.py` and `bridge/room/ext/cleanup.py`. |
| U142 | Work-tool generation/run identity and terminal admission in `bridge/room/ext/acquire.py`. |
| U143 | Enabling mailbox activity/planning/work delivery in `bridge/room/family.py` and `bridge/room/family_envelope.py`; production admission remains HOLD [CITED: supplied package]. |

## Verification

From the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/u140 -t .
```

Current unchanged-product run: **29 tests, 21 red, 8 green, 0 errors** [MEASURED].
The exact unittest verdict is `FAILED (failures=21)` [MEASURED].
The failures identify unsupported `expected_opened_lamport` on both backend
writers and unknown dispatcher arguments. Legacy, mailbox boundary and
negative-control calibration tests are green. This is a fail-first oracle,
not an implementation, ADMIT, or runtime end-to-end acceptance receipt.

Existing U121 storage regressions: **126 tests passed, 0 failures, 0 errors**
[MEASURED]. Their temporary directories were confined beneath this oracle
directory for the run. Hash checks of the inspected production files and the
spec found no changes [MEASURED].
