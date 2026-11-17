# U110 fail-first oracle

Status: FAIL_FIRST; target: STRATEGY_v11, W1, baseline I0. Product implementation and
candidate diff: AUSENTE. Contract: `.unit/SPEC.md`, including binding Amendments B
and C. The only product file introduced here is the `room_send(args: dict) -> dict`
stub in `bridge/room/ext/send.py`; its body raises `NotImplementedError("U110 stub")`.

Every Python case first sends the valid, no-plan A2 question through the actual
entry point. This shared executable precondition deliberately exposes the stub
exception before checking discovery, validation or transport behavior. It is not
caught, skipped, xfailed or substituted. Subsequent assertions become executable
when a candidate implements the entry point. Unrelated errors are not accepted
as a fail-first receipt.

All test modules below live in `bridge/tests/room/u110/`. Test names are literal
unittest methods. The TypeScript file is `tests/unit/u110/room_event.test.ts`.

| Acceptance | Tests |
| --- | --- |
| A1 | `Protocol.test_a1_fresh_mcp_and_cli_discover_identical_descriptor`; `test_a1_descriptor_matches_closed_typed_request`; `test_a1_repeated_load_and_send_reload_do_not_duplicate_tools`; `test_a1_missing_module_and_dependency_error_semantics`; `test_a1_removing_send_is_detected_negative_control` |
| A2 | `Protocol.test_a2_mcp_to_cli_replay_without_plan_and_exact_wrapper`; `test_a2_inbox_preserves_reference_evidence_and_address`; `test_m7_shared_dispatch_wraps_handler_exactly_once` |
| A3 | `References.test_a3_ack_question_then_answer_changes_open_questions`; `test_a3_ack_handoff_succeeds_but_answer_handoff_fails`; `test_a3_missing_malformed_unknown_and_cross_room_references`; `test_a3_non_message_targets_are_rejected_for_every_message_act`; `test_a3_question_and_handoff_optional_re_is_preserved`; `test_c2_addressed_ack_and_answer_require_target_recipient`; `test_c2_answer_can_follow_ack_to_question_and_closes_root`; `test_c2_multi_ack_chain_is_resolved_without_rewriting_re`; `test_c2_ack_chain_to_handoff_unknown_or_other_room_is_bad_re`; `test_c2_cyclic_ack_chain_is_refused_with_bounded_process`; `test_c1_legacy_post_still_rejects_ack_to_question`; `test_c2_answer_and_ack_reject_other_message_kinds`; `test_c2_unaddressed_legacy_question_needs_no_recipient_match` |
| A4 | `Protocol.test_a4_hostile_text_stays_passive_and_lifecycle_free`; `test_m7_transport_error_wrappers_are_preserved`; `Validation.test_a4_only_coordination_acts_are_accepted`; `test_a5_required_and_closed_request_shape` |
| A5 | `Validation.test_a5_required_and_closed_request_shape`; `test_a5_room_and_agent_slug_boundaries`; `test_a5_null_optional_fields_are_bad_args`; `test_a5_text_is_measured_in_utf8_bytes`; `test_a5_text_type_empty_and_encoding_errors`; `test_a5_operation_identity_boundaries`; `test_a5_evidence_correct_digest_and_entry_limit`; `test_a5_evidence_schema_and_digest_negative_control`; `test_a5_evidence_path_exclusions_and_symlinks`; `test_a5_evidence_file_size_boundary`; `test_m5_legacy_path_list_evidence_is_preserved`; `test_c3_structural_evidence_refusal_precedes_writer_lock` |
| A6 | `Durability.test_a6_same_identity_returns_original_durable_receipt`; `test_a6_payload_conflicts_are_bad_op_without_append`; `test_a6_evidence_object_key_order_and_empty_defaults_are_canonical`; `test_a6_existing_replay_precedes_disk_digest_verification`; `test_a6_identity_is_scoped_by_room_and_sender`; `test_c4_cross_kind_identity_conflicts_include_existing_room_events`; `test_m6_omitting_identity_does_not_persist_a_synthetic_identity`; `test_a6_competing_processes_and_restart_persist_one_message`; `test_a6_duplicate_fixture_negative_control_rejects_non_deduplicated_history` |
| A7 | `Durability.test_a7_capacity_rejects_new_message_but_not_existing_replay`; `test_a7_receipt_follows_real_journal_fsync`; `test_a7_fsync_failure_rolls_back_and_retry_is_not_cached` |

| MUST / amendment | Coverage |
| --- | --- |
| M1 | A1 discovery, descriptor, real loader, missing modules, dependency errors and repeated loading/reload |
| M2 | A1 closed schema; A4/A5 strict runtime shape, required keys, slugs and allowed acts |
| M3 | A5 UTF-8 byte boundaries, scalar types, surrogate rejection, operation IDs and unchanged journals on refusal |
| M4 | A3 reference existence, room/kind/address checks, retained `to`/`re`, answer-driven status |
| M5 | A5 exact evidence objects, lowercase digest, computed hash mismatch control, path exclusions, limits and legacy path lists |
| M6 | A6 top-level identity, sender/room scoping, canonical payload conflicts, process races/restart and replay before hash/cap rejection |
| M7 | A2 exact single `untrusted` wrapper and transport parity; A4 literal text, no secondary process/composer, no lifecycle fields; existing adapter error wrappers |
| M8 | A7 original room cap, valid near-cap journal, real fsync observation and exact rollback after injected failure |
| B1 / C2 | Same-room question or acyclic ack chain to one; cycles, broken chains and handoff roots refused |
| B2 / C5 | Optional null maps to `bad_args`; empty/whitespace text maps to `bad_op` |
| B3 / C3 | Typed evidence only; final symlink, nonregular/FIFO, oversized file, credential and real CW_HOME exclusions |
| B4 / C4 | Canonical `(to, act, text, re ?? null, evidence ?? [])`; existing replay before disk hash and capacity; cross-kind identity conflict including planning operation identity |
| B5 / C1 | Legacy `post` rejects ack-to-question; typed path accepts it. `bridge/tests/room/test_post.py:130` is preserved |
| B6 | Multi-byte overflow, symlink evidence, cross-room identity reuse, missing answer reference and digest negative control |
| C5 | Repeated send reload exercises registration guard; inbox asserts `id/to/re/act/evidence`; fsync failure cannot poison replay |

## Resolved interpretation

- Amendment C supersedes the original handoff-only ack rule for `room_send`.
  `answer.re` may follow ack chains; the root question closes only after answer.
  Recipient authorization compares the sender with the immediate target's `to`.
- Non-message reference targets are refused for every typed message act, including
  optional references on questions/handoffs. Multi-link and cyclic fixtures are
  imported journal data, not permission to create ack-to-ack through this API.
- Existing `read_inbox` returns `events` whose text is renamed `untrusted_text`.
  Its envelope is preserved; only `room_send` requires the exact top-level
  `{"untrusted":{"ok":true,"id":...,"lamport":...}}` result.
- Optional `re`, `evidence`, `op_id` nulls are `bad_args`. Descriptor-level object
  errors are tested at the handler. The adapters retain their existing JSON-RPC
  invalid-params / CLI bad-args behavior for nonobject transport arguments.
- Evidence structural checks precede locking. A replay with a still-regular file
  whose bytes changed returns the original receipt before rehashing; new identity
  with that obsolete digest is refused. Evidence object key order is immaterial;
  absent and empty evidence canonicalize together. Evidence array order is not
  declared interchangeable by this oracle.
- Amendment C restricts TypeScript checks to `src/agents/types.ts:23` (`RoomEvent`).
  That existing boundary is expected green; no new TS product API is invented to
  force a failure. Python is the fail-first implementation acceptance gate.

## Determinism and stop rules

Python uses stdlib unittest only. Direct calls use a fixed clock. Scratch homes,
regular files, symlinks, FIFO and bounded cap fixtures live under this test
folder and are cleaned up. No test opens a network connection or starts a timer;
worker coordination uses a process barrier, not sleeps. Subprocess deadlines are
hang bounds. Child processes communicate over stdio and are reaped on cleanup.
Socket calls in the direct handler fail immediately. No provider is invoked.

A1's in-memory module-removal control must cause the discovery assertion to
reject the result. A5 flips a computed digest and requires `bad_evidence` with
unchanged journal. A6's duplicate-history control must cause the same uniqueness
assertion used on real concurrent/restarted history to reject duplicates.
The candidate's actual disabled-dedup source mutant cannot be generated here:
editing implementation is outside this oracle task. Candidate mutation receipts
must bind the frozen oracle hashes and candidate diff hash before acceptance;
this receipt is AUSENTE and is not represented as passed.

Correctness failures BLOCK acceptance. Expected stub errors establish only
FAIL_FIRST, never product acceptance. Changed or missing error text is a failed
oracle gate. Typecheck diagnostics in these test files BLOCK this oracle;
unrelated baseline diagnostics remain separately reported.

| Boundary [CITED: `.unit/SPEC.md`] | Value |
| --- | --- |
| Text UTF-8 bytes | 4,096 |
| Operation ID characters | 8–64 |
| Evidence entries | at most 8 |
| Evidence regular-file bytes / room cap | 8 MiB |
| Digest characters | 64 lowercase hexadecimal |
| Concurrency correctness budgets | zero duplicate identities; zero receipts before fsync |

## Deferred / out of scope

| Item | Status / owner |
| --- | --- |
| U115 `room-concurrency` benchmark, quiet-window protocol, p50/p95/p99, peak RSS, fixture hash and journal-size telemetry | OUT_OF_SCOPE: U115 benchmark; no latency limit supplied. Timing is INCONCLUSIVE at load5 >= 18 [CITED: spec]; correctness remains BLOCK |
| U136 unanswered-question display | OUT_OF_SCOPE: U136; storage `status().open_questions` is covered here |
| U117 integration, human receipt display, lifecycle reporting, authentication and transport redesign | OUT_OF_SCOPE |
| Reconciliation of `bridge/tests/room/test_post.py:130` | OUT_OF_SCOPE: independently authorized integration change; C1 preserves this legacy rejection |
| Candidate source mutants and candidate diff receipt | AUSENTE: implementation candidate not supplied; no acceptance claim |

`receipt.json` records the measured fail-first run, public relative file hashes
and unavailable candidate receipt explicitly. The mandate is limited to
`.unit/SPEC.md`, its cited workspace code and the allowed U110 oracle paths.
