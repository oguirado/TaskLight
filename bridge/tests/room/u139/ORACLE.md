# U139 durable lifecycle no-op identity oracle

The binding input is `.unit/SPEC.md`, read through its final line. It contains
no numbered acceptance list and no Amendment sections: AUSENTE — no inventar. The labels
below are oracle traceability labels for the existing clauses, not additional
product requirements. Fixture times and Lamport values are deterministic test
inputs [TARGET], not host measurements.

## Acceptance mapping

All names below are methods in `test_lifecycle_replay.py`.

| Case | Binding clause or preserved control | Tests |
| --- | --- | --- |
| A1 | A throttled no-op returns the existing result without refreshing lifecycle or appending a lifecycle event. | `test_a1_throttled_call_preserves_original_receipt_and_journal` |
| A2 | Persist successful no-op identity; recover the original result after the window and a crash before consumer completion. | `test_a2_crash_before_consumer_record_recovers_original_result`; `test_a2_retry_after_intervening_alive_keeps_original_result`; `test_a2_retry_after_run_supersession_keeps_original_result` |
| A3 | The delayed retry appends no journal event and preserves lifecycle evidence. | `test_a3_crash_retry_appends_no_journal_event` |
| H1 | The same successful no-op ID with a changed state is a payload conflict. | `test_h1_same_noop_id_changed_state_is_bad_op`; `test_h1_fold_rejects_changed_state_for_noop_id` |
| H2 | The same successful no-op ID with a changed `run_id` is a payload conflict. | `test_h2_same_noop_id_changed_run_id_is_bad_op`; `test_h2_fold_rejects_changed_run_id_for_noop_id` |
| N1 | Negative implementation: retain or restore the fold's early return before replay identity is saved. | `test_n1_fold_json_continuation_remembers_noop_result`; `test_n1_fold_history_replay_preserves_lifecycle`; both fold hostile tests |
| P1 | Preserved throttle behavior: a genuinely fresh ID is accepted at the existing window boundary. | `test_p1_fresh_id_at_window_boundary_is_new_event` |
| P2 | Preserved committed-ID replay still returns the original receipt without appending. | `test_p2_committed_id_replay_still_returns_original_result` |
| P3 | Preserved committed-ID payload conflicts remain rejected. | `test_p3_committed_id_payload_conflict_is_rejected` |
| HOOK_XPLAT | Preserve the original no-op receipt beyond the throttle window and leave the journal byte-identical when `O_DIRECTORY` is absent or the directory cannot be opened. A supported directory still gets synced after the receipt file. | `test_noop_receipt_without_o_directory`; `test_noop_receipt_when_directory_open_fails`; `test_noop_receipt_fsyncs_file_then_directory` |
| HOOK_XPLAT binary writes | Pass `O_BINARY` when opening the lifecycle journal for append. | `test_lifecycle_journal_append_opens_in_binary_mode` |

## Decisions and implementation independence

The caller's event identity is the lifecycle `op_id` (`alive-0002`), not the
server-generated journal envelope `id`. This follows
`bridge/room/ext/lifecycle.py` and the existing U132 public contract in
`bridge/tests/room/u132/test_lifecycle.py`.

Changed payloads must return `bad_op`, matching that existing exact-identity
contract; `not_conformant` is insufficient because replay identity is checked
before admission against the current lifecycle. Both rejection paths must
leave the journal and lifecycle unchanged.

Backend tests inspect real handler receipts, journal bytes, and public fold
results. They do not select a sidecar file, database, cache key, or replay-state
layout. `probe.py` calls the actual backend with synthetic server time, verifies
the original receipt, then uses `os._exit` before emitting a response or writing
a consumer completion record. A later call runs in another interpreter with the
same isolated home. Thus a process-local cache or consumer dedup record cannot
satisfy A2. This is a backend crash-gap oracle, not mailbox admission testing.

The direct fold tests pass valid public event envelopes to `apply_op_event` and
`fold_plan`, with unique envelope IDs and the same operation ID. They serialize
the projection before continuation, and assert observable replay results and
lifecycle evidence rather than private replay-map fields. They detect a
handler-only workaround even if backend tests turn green. The initial tree
already contains the N1 negative implementation, so no production-source
mutation is needed or permitted to demonstrate that negative control.

## Boundaries and stop rules

Every runtime directory is created beneath this test directory and removed by
cleanup. Network access is blocked in parent and probe; all lifecycle clocks are
fake. There are no sleeps, services, ports, provider calls, or unbounded loops.
The subprocess timeout is a watchdog, not a lifecycle clock. Deployment, first
alive, and actual throttling are asserted prerequisites. Unexpected setup,
import, process, or I/O errors invalidate the run; they are never counted as a
successful fail-first result. No skipped tests or fallback implementation is
used. Only assertion failures for the missing no-op identity qualify.

| Other-unit decision | Owner | U139 disposition |
| --- | --- | --- |
| Atomic plan-generation fencing | U140 | Out of scope; no failure claimed. |
| Terminal cleanup and transport parity | U141 | Out of scope; no failure claimed. |
| Terminal work refusal and run-aware work tools | U142 | Out of scope; no failure claimed. |
| Mailbox slice admission and enabling `slice:2` | U143 | Out of scope; HOLD is not changed. |
| Article containers, persona scores, visual-engine restrictions | Frontend and capsule units | Out of scope; no failure claimed. |

## Verification

Run stdlib discovery from the repository root with bytecode writes disabled:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/u139 -t .
```

The unchanged initial tree produced these stdlib discovery lines [MEASURED]:

```text
Ran 14 tests in 2.332s

FAILED (failures=10)
```

There are 10 red tests and 4 green preserved-behavior controls, with no errors or
skips [MEASURED]. All red outcomes are assertions about the missing replay
identity: the crash-gap retry returns Lamport 3 rather than 2, appends a journal
event, returns the wrong original result after later activity, or fails to reject
a changed payload as `bad_op`. Direct fold continuation also loses identity.
These synthetic Lamport results are observed test outcomes [MEASURED].

The existing `bridge/tests/room/u132/test_lifecycle.py` suite remains green:

```text
Ran 40 tests in 4.745s

OK
```

All 40 existing tests passed without failures, errors, or skips [MEASURED]. The
regression runner redirected only its temporary-directory location into this
unit's directory; existing test and product files were not edited. Broader
unrelated suites were not run. Runtime directories were cleaned up.

