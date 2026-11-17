# U134 fail-first oracle

Source: `.unit/SPEC.md`, read in full through binding Amendments B and C.
Status: STRATEGY_v11_A1, W3; DRAFT. Production consumer: HOLD pending admission.
This package changes tests and command/envelope stubs only.

Run from the repository root:

```sh
python3 -m unittest discover -s bridge/tests/family -t .
```

## Acceptance map

Method names below are in `bridge/tests/family/`. Generated vector methods are
ordinary independent unittest cases, not subtests hidden behind an early error.

| Spec case | Test names | Boundary and dependency status |
| --- | --- | --- |
| A1 | `EnvelopeOracle.test_a1_deployment_without_plan_and_exact_operation_identity`; `RecoveryOracle.test_a1_identical_redelivery_has_same_result_event_and_journal`; `MailboxOracle.test_a1_missing_u132_refuses_consumer` | Adapter lifecycle routing, exact receipt, room without plan, durable replay, and missing-lifecycle refusal. Real lifecycle commit/fold is owned by U132. |
| A2 | `RecoveryOracle.test_a2_crash_after_commit_before_dispatch_return`; `test_a2_crash_before_receipt_rename`; `test_a2_crash_after_receipt_rename`; `test_a2_throttled_alive_crash_before_receipt_uses_original_noop_result`; `test_a2_process_death_journal_commit`; `test_a2_process_death_after_receipt_rename`; `test_a2_process_death_noop_before_receipt` | Deterministic fault cuts plus actual process termination without Python cleanup, followed by explicit lock recovery and cache-free restart. No-op outcomes must survive a changed backend outcome. |
| A3 | `RoutingOracle.test_a3_preserve_backend_code_not_conformant`; `test_a3_preserve_backend_code_claimed_by_other`; `test_a3_preserve_backend_code_stale_rev`; `test_a3_preserve_backend_code_bad_evidence`; `test_slice_one_disables_microtask_update` | Transport code/detail preservation and slice gating are in scope. Real T02/T01 dependency checks, T02.M01 activation, executor-b ownership, claim fences and MCP/CLI parity are OUT OF SCOPE: U109/backend authority. They are not simulated as proof of backend correctness. |
| A4 | `RoutingOracle.test_activity_is_held_without_atomic_backend_generation_fence`; `test_slice_one_disables_task_update`; `EnvelopeOracle.test_reject_activity_generation_missing`; `test_reject_activity_generation_boolean`; `test_reject_activity_generation_zero` | Adapter must HOLD activity and existing-plan mutations. Actual close/reopen with reused T01, successor-state immutability and atomic `stale_rev` through commit are OUT OF SCOPE until backend `expected_opened_lamport` fencing exists. Pre-read fencing is never accepted as a substitute. |
| A5 | `RecoveryOracle.test_a5_changed_content_after_response_consumption_returns_bad_op`; `test_a5_unread_valid_receipt_is_not_overwritten_on_conflict`; `test_a5_changed_pending_identity_is_bad_op_without_journal`; `EnvelopeOracle.test_strict_json_*`; `test_reject_*`; `test_a5_filename_identity_mismatch`; `test_a5_traversal_in_identity_uses_safe_filename`; `test_above_byte_cap_is_rejected_before_dispatch`; `MailboxOracle.test_a5_*`; `test_reject_symlink_component_*`; `test_invalid_endpoint_*`; `test_invalid_request_filename_*` | Changed identities, malformed/duplicate/non-finite JSON, unknown kinds, traversal, symlinks at each component, hardlinks, FIFO/directory entries, replacement races and byte cap. Private canaries remain within disposable test fixtures. |
| A6 | `MailboxOracle.test_a6_private_room_checked_before_dispatch`; `test_a6_unconfigured_source_before_replay`; `test_a6_authorization_is_rechecked_after_completed_delivery`; `test_a6_room_authorization_is_rechecked_before_replay`; `test_a6_missing_config_refuses_before_replay`; `test_empty_allowlist_never_allows_*`; `test_invalid_configuration_*`; `RoutingOracle.test_capabilities_checks_room_membership`; `test_capabilities_checks_source_membership` | Source and room authorization precede replay/dispatch. Missing or invalid config cannot use a fallback. Empty allowlists deny every request or refuse startup. |
| A7 | `MailboxOracle.test_a7_existing_consumer_lock_is_never_reclaimed`; `test_a7_exclusive_consumer_creation_rejects_racer`; `RecoveryOracle.test_a7_completed_identity_survives_request_and_response_deletion`; `test_a7_receipt_publication_is_fsynced_before_request_deletion`; `test_a7_receipt_file_fsync_failure`; `test_a7_receipt_directory_fsync_failure`; `test_pending_fsync_failure_stops_before_dispatch` | Exclusive create, no automatic stale takeover, durable identity retention, file/rename/directory ordering and retryable durability failures. |
| A8 | `CursorOracle.test_a8_partial_batch_is_not_read_before_writer_commit`; `test_a8_paged_reads_match_room_events_modulo_revision`; `test_a8_filtered_reads_preserve_event_identity_op_and_cursor`; `test_a8_future_cursor_requests_resync`; `test_empty_room_has_no_created_journal_or_events_lock`; `test_reads_never_request_backend_long_poll` | A deterministic writer schedule exposes a partial prefix until lock acquisition. Shared cursor semantics are compared exactly after removing adapter `revision`. Backend batch commit/replay internals remain backend-owned. |
| A9 | `OracleCalibration.test_a9_premature_success_is_rejected`; `test_a9_published_success_then_crash_is_rejected`; `test_a9_wrong_lamport_is_rejected`; `test_a9_unrelated_event_at_same_lamport_is_rejected`; `RecoveryOracle.test_a9_success_receipt_has_committed_journal_witness`; `RoutingOracle.test_a9_socket_denied_sweep_requires_no_external_process` | Calibration rejects premature success, a wrong cursor and an unrelated event at the same cursor. Every consumer test denies socket creation and external subprocess execution. |

## MUST map

| Requirement | Oracle coverage | Scope limitation |
| --- | --- | --- |
| M1 | Missing-U132 refusal; fenced activity and Slice 2 remain disabled. | U109, U121, U132 ADMIT receipts and their discovery mechanism are AUSENTE from the public spec. No admission flag, filename or exported probe is invented. |
| M2 | Empty one-shot sweep, explicit endpoint, configuration vectors, addressed-spool isolation, fake polling and invalid poll arguments. | Daemon behavior is excluded. |
| M3 | `EnvelopeOracle` strict JSON, closed schema, identity/type boundaries, cursor/generation requirements and passive strings. | No undocumented Python parser interface is assumed. |
| M4 | Fixed lifecycle mapping, injected immutable identities, capabilities, read mapping and disabled Slice 2 tools. | Enabled Slice 2 routing awaits backend admission; no replacement planner is implemented in tests. |
| M5 | No adapter-held mutation lock; activity/Slice 2 HOLD; lifecycle without a plan; exit does not dispatch planning completion. | Atomic backend fencing, actual ownership/dependency/evidence semantics and close/reopen races are OUT OF SCOPE, not test failures attributed to U134. |
| M6 | Allowlists before replay, private-room canaries, descriptor-relative race, nonregular/hardlinked requests, symlink components and bounded reads. | Source and agent remain caller-asserted. Authentication is excluded. |
| M7 | Exact amended op_id, canonical-order retry, durable pending identity, changed-content conflicts, no-op recovery and retained completed identities. | Journal replay and typed lifecycle durability are backend contracts supplied by the controlled dispatcher. |
| M8 | Exact receipt envelope, untrusted wrapper, preserved backend codes, transient internal retry, safe malformed filename, exclusive ownership and fsync ordering. | Error publication does not establish durable mutation success. |
| M9 | `CursorOracle`, journal-witness calibration and mutation-lock prohibition. | Rebuilding real plan/task/microtask/activity/lifecycle projections belongs to their backend units. |
| M10 | This file supplies a neutral acceptance map and recovery assumptions. | `docs/FAMILY_CHANNEL.md` is outside this assignment's write surface. Its configuration/publication/slices/receipts/crash/lock/trust content and neutral terminology require documentation review; missing documentation is not reported as an adapter test failure. |

## Resolved ambiguities and deliberate limits

- The only specified entry point is `python3 -m bridge.room.family drain`.
  Python exported names and signatures are AUSENTE. Tests execute the module with
  `runpy`; both product files contain only a documented `U134 stub` seam. No
  invented `drain`, parser, admission or recovery Python API becomes a contract.
- The controlled `bridge.room.app.dispatch` boundary supplies committed lifecycle
  results and actual shared `room_events` behavior. Ready-consumer cases are
  conditional adapter contracts after dependency admission, not evidence of ADMIT.
  The fixture advertises its lifecycle contract through existing application
  tool metadata. Missing-lifecycle and missing-generation-fence tests retain HOLD.
  A production admission receipt format must be specified by the admitting units.
- Amendment C overrides the earlier exchange layout and op_id: only `spool/`
  exchanges messages; `config.json`, `consumer.lock`, `state/` stay recipient-owned.
  Amendment B's explicit `dedup/` identity file is retained; serialized metadata
  keys and digest encoding are not prescribed by these tests.
- `op_id` is `fam-` plus the first 44 hexadecimal SHA-256 characters [TARGET] of
  UTF-8 source, NUL, target, NUL, id. Identical retries tolerate JSON key/whitespace
  changes; changed content is `bad_op`, including a pending operation with no event.
- Invalid spool entries are removed or quarantined with exit 0 [TARGET]. Startup
  and ownership refusal use 2 [TARGET]; I/O/recovery failure uses 3 [TARGET].
  An unread valid receipt is preserved on conflict. A transient `internal` result
  must not become a terminal replay entry.
- Polling is explicitly interpreted as repeated sweeps separated by the requested
  positive interval, ending cleanly with exit 0 [TARGET] on KeyboardInterrupt.
  Amendment B requires a definition but does not supply one. Polling tests use a
  fake clock and fake sleep; no elapsed-time behavior is asserted.
- Capabilities uses the same required room/agent fields and source/room allowlists
  as other envelopes. It exposes only enabled kinds and a protocol/health result
  under the preserved untrusted wrapper. It never invokes a planning tool.
- The Slice 2 choice retains U119 and includes `work.acquire`/`work.report` in the
  disabled-kind tests. Its positive routing and backend mutations remain HOLD.
  `plan_opened` is forbidden on `plan_create`, required on `task_add` and
  `microtask_add`; activity and existing-plan operations require a positive,
  non-boolean generation. Runtime atomic validation is backend-owned.
- Crashes use syscall fault cuts and true child process death. Retry discards both
  family module caches. Explicit lock recovery occurs only after the child is
  known dead. The process-join watchdog is a bounded deadlock guard, not a product
  timer or latency assertion. No network, port allocation or external model call
  is used. Runtime fixtures and temporary evidence stay under this test package.

## Hardening and external gates

`HardeningOracle.test_family_drain_1k_has_no_duplicate_mutations_or_receipt_disagreement`
checks 1,000 requests [TARGET], reverse publication order, stable request/response
hashes, the existing room cap and unchanged journal on redelivery. The functional
oracle has no latency threshold. Actual wall time, peak RSS, quiet-window load and
journal-byte measurements for `family-drain-1k` remain an external admission run;
the stub run cannot supply those measurements. Comparative latency budget:
AUSENTE — no inventar. Timing is INCONCLUSIVE at load5 >= 18 [CITED: spec §Hardening].

Daemon, authenticated identity, external-envelope translation, automatic lock
takeover, storage rotation, UI work and backend repairs are OUT OF SCOPE.

## Confirmed code coordinates

| Authority | Relative coordinates |
| --- | --- |
| Shared dispatcher and errors | `bridge/room/app.py:502`, `:901`, `:1162`, `:1173` |
| Writer lock, replay and durability | `bridge/room/store.py:799`, `:818`, `:877`; `bridge/room/_lock.py:39` |
| Lifecycle gap and registry | `bridge/room/ext/lifecycle.py:3`; `bridge/room/ext/__init__.py:19` |
| Activity and cursor authority | `bridge/room/ext/activity.py:8`; `bridge/room/ext/events.py:94`, `:123` |
| Generation, claims and dependencies | `bridge/plan/fold.py:320`, `:334`, `:625`, `:630`, `:632` |
| Containment | `docs/MCP.md:24` |

This oracle is limited to the supplied specification and confirmed workspace code.
