# U71 fail-first oracle

Specification: `.unit/SPEC.md`; status: R27 W3, wave B.
The provided spec ends at A4 and contains no Amendment sections.
Only `bridge/tests/room/u71/` and `bridge/room/_lock.py` are authored here.

Run from the repository root:

```sh
python3 -m unittest discover -s bridge/tests/room/u71 -t .
```

## Acceptance mapping

| Case | Tests in `test_lock.py` | Gate and negative control |
| --- | --- | --- |
| A1 | `test_a1_windows_store_post` | Fresh subprocess hides `fcntl`, injects fake `msvcrt`, imports the store, posts and reads an event, and records lock then unlock on the same descriptor and byte zero. An unconditional Unix import fails. |
| A2 | `test_a2_no_backend_fails_closed` | Hide both backends; adapter import must raise a meaningful `ImportError`. Successful import fails the gate. |
| A3 | `test_a3_two_process_posts` | Linux only: probe the real adapter, release two child writers through stdin gates, post fifty events each, and verify one hundred events, distinct IDs, strictly increasing Lamports and equal author counts. Child failure, timeout, malformed events or lost writes fails the gate. |
| A4 | `test_a4_store_has_no_fcntl_import` | AST rejects direct and from-style `fcntl` imports, including aliases; comments and strings are not imports. |

## MUST mapping

| Requirement | Tests or verification |
| --- | --- |
| M1: POSIX flags and backend precedence through importlib | `test_m1_posix_exclusive_and_unlock`, `test_m1_importlib_prefers_fcntl`, `test_m1_posix_errors_propagate` |
| M1: Windows byte-zero lock and unlock, restore cursor, empty lock file | `test_m1_windows_byte_zero_and_position`, `test_m1_windows_empty_lockfile` |
| M1: retry until acquired | `test_m1_windows_retries_contention_without_waiting`: fake contention exceeds a single retry; fake sleep prevents real waiting. |
| M1: restore cursor on unlock failure | `test_m1_windows_unlock_error_restores_position` |
| M2: adapter used at all four existing calls | `test_m2_both_store_paths_lock_and_unlock`: spies require adapter acquisition/release for both `post` and `post_ops`. |
| M2: acquisition failure prevents writes, release and descriptor leaks | `test_m2_acquisition_failure_never_writes_or_unlocks` |
| M2: finally release on critical-section failure and rollback | `test_m2_critical_failure_releases_both_paths`: injected fsync error preserves `RoomError` with code `internal`, leaves no event and releases both paths. |
| M2: existing unlock OSError suppression | `test_m2_unlock_oserror_is_preserved`: completed posts remain successful on both paths. |
| M3 | A2 above. |
| M4 | Existing `bridge/tests/room`, `bridge/tests/plan`, `bridge/tests/wall_room` suites are regression gates. Discovering the room tree includes this intentionally red oracle; run legacy room tests separately to distinguish expected U71 failures. |

## Interpretation and boundaries

- Four lock sites mean the acquisition/release pairs in `post` and `post_ops`.
- Backend choice is verified in fresh interpreters, independently of host platform.
- The spec supplies no retry delay or maximum retry count. Tests impose neither:
  contention is finite, backend attempts are deterministic, and sleep is mocked.
- The spec does not define which permanent Windows acquisition errors to retry.
  No additional permanent-error policy or invalid-descriptor contract is imposed
  on that backend. POSIX error propagation follows its specified delegation.
- Cursor restoration applies to failed unlocks as well as successful operations.
- Process timeouts are bounded deadlock guards, not timing assertions. No network,
  sleeps or real clocks are used by the oracle. Posting clocks are fixed.
- Valid batch input uses `fixtures/plan/templates.v1.json` with the documented
  `templates` keyword, retaining actual plan validation and avoiding another
  unit's template-discovery behavior.
- A3 probes the real adapter before launching children, so an absent implementation
  produces `NotImplementedError("U71 stub")` rather than a misleading legacy pass.
- Adapter tests fail on that stub. A1, A2, A4 and adapter-wiring checks also expose
  pre-existing import, fail-closed and integration gaps; they must retain those
  independent assertions rather than artificially forcing a stub exception.
- `bridge/room/hook_claude.py`, native-host registration, launchers, model/ctx
  stores, MCP encoding, demos and the unrelated strategy portfolio U71 are outside
  this unit's M1-M4 and A1-A4. Audit-table findings for those surfaces are not
  failures of this oracle.
